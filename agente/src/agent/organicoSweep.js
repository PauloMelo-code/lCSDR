// VARREDURA do Funil Orgânico — puxa DIRETO do GHL os leads ESPERANDO resposta e
// (opcional) responde. É a fonte única de verdade da lógica, usada por:
//   - scheduler.js (automática, periódica, env-gated) — safety-net contra apagão/
//     webhook que falha, pra os leads não ficarem parados;
//   - scripts/recuperar-organico-ghl.js (manual, dry-run + --send).
//
// Responde SÓ quem passa em TODAS as guardas (mesmas do webhook ao vivo):
//   - ESPERANDO (última msg da conversa é do LEAD, ninguém respondeu depois);
//   - último inbound < 24h (regra da Meta);
//   - EXCLUSIVAMENTE na raia da Tina (contactExclusivelyInTinaLane) — nada vivo
//     em outra coluna/pipeline (não rouba lead de closer);
//   - NENHUM SDR ativo na janela (SDR_ACTIVE_HOURS, default 12h) — não sobrescreve.
// Idempotente: quem responde (handleOpportunityStage) tem cooldown de 12h, então
// rodar de novo NÃO re-responde o mesmo lead. A resposta é sempre reação a um
// inbound do lead (nunca outbound frio).
import fetch from 'node-fetch';
import { GHL } from '../ghl/client.js';
import { contactExclusivelyInTinaLane, resolvePipeline } from '../ghl/opportunities.js';
import { logger } from '../utils/logger.js';

const B = 'https://services.leadconnectorhq.com';
const AUTO = new Set(['workflow', 'campaign', 'bulk_actions', 'bulk', 'automation']);

function sdrActiveMs() {
  const h = Number(process.env.SDR_ACTIVE_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 12) * 3_600_000;
}

async function fetchOrgOpps() {
  if (!process.env.GHL_API_TOKEN || !process.env.GHL_LOCATION_ID) return [];
  const H = { Authorization: 'Bearer ' + process.env.GHL_API_TOKEN, Version: (process.env.GHL_API_VERSION || '2021-07-28'), Accept: 'application/json' };
  // Coluna Funil Orgânico: ORGANICO_STAGE_ID ou o padrão único de opportunities.js (o
  // mesmo do GHL_TINA_OWNED_STAGES).
  const ORG_STAGE = resolvePipeline().stageOrganico;
  const out = [];
  for (let page = 1; page <= 15; page++) {
    const r = await fetch(`${B}/opportunities/search?location_id=${process.env.GHL_LOCATION_ID}&pipeline_stage_id=${ORG_STAGE}&status=open&limit=100&page=${page}`, { headers: H });
    if (!r.ok) break;
    const j = await r.json();
    const ops = j.opportunities || [];
    if (!ops.length) break;
    out.push(...ops);
    if (ops.length < 100) break;
  }
  return out;
}

// { esperando, lastInboundMs, sdrAtivo } — ou null se sem conversa/erro.
async function convState(cid) {
  try {
    const cv = await GHL.searchConversations(cid);
    const conv = cv?.conversations?.[0] || cv?.[0];
    if (!conv?.id) return null;
    const m = await GHL.getMessages(conv.id, { limit: 30 });
    let ms = (m?.messages?.messages || m?.messages || m || [])
      .filter(x => !/ACTIVITY|OPPORTUNITY/i.test(String(x.messageType || x.type || '')) && (x.body || x.message || '').trim());
    ms.sort((a, b) => new Date(a.dateAdded || a.createdAt || 0) - new Date(b.dateAdded || b.createdAt || 0));
    if (!ms.length) return null;
    const last = ms[ms.length - 1];
    const lastIn = [...ms].reverse().find(x => (x.direction || '').toLowerCase() === 'inbound');
    const lastInboundMs = lastIn ? new Date(lastIn.dateAdded || lastIn.createdAt || 0).getTime() : 0;
    const now = Date.now();
    const limite = now - sdrActiveMs();
    const sdrAtivo = ms.some(x => {
      const uid = x.userId || x.user_id || x.sentBy?.id;
      if ((x.direction || '').toLowerCase() !== 'outbound' || !uid) return false;
      if (AUTO.has(String(x.source || '').toLowerCase())) return false;
      return new Date(x.dateAdded || x.createdAt || 0).getTime() >= limite;
    });
    return { esperando: (last.direction || '').toLowerCase() === 'inbound', lastInboundMs, sdrAtivo };
  } catch { return null; }
}

// Varre o Funil Orgânico. Retorna { total, esperando, foraRaia, sdrAtivo, fora24h,
// elegiveis: [{cid, nome}], respondidos }. Se send=true E respondFn fornecida,
// responde até `max` elegíveis (com delayMs entre eles). respondFn(cid) é injetada
// (handleOpportunityStage) pra evitar dependência cíclica com webhook.js.
export async function sweepOrganico({ send = false, max = 12, delayMs = 6000, respondFn = null } = {}) {
  const ops = await fetchOrgOpps();
  const now = Date.now();
  const res = { total: ops.length, esperando: 0, foraRaia: 0, sdrAtivo: 0, fora24h: 0, elegiveis: [], respondidos: 0 };
  for (const o of ops) {
    const cid = o.contactId || o.contact?.id;
    if (!cid) continue;
    const cs = await convState(cid);
    if (!cs || !cs.esperando) continue;
    res.esperando++;
    if (cs.lastInboundMs && (now - cs.lastInboundMs) > 24 * 3_600_000) { res.fora24h++; continue; }
    if (cs.sdrAtivo) { res.sdrAtivo++; continue; }
    if (!(await contactExclusivelyInTinaLane({ ghl_contact_id: cid }))) { res.foraRaia++; continue; }
    res.elegiveis.push({ cid, nome: o.contact?.name || o.name || cid });
  }
  res.pulouRecheck = 0;
  if (send && respondFn && res.elegiveis.length) {
    for (const a of res.elegiveis.slice(0, max)) {
      // RE-CHECK anti-colisão: revalida o estado JUSTO ANTES de enviar. Entre a
      // leitura inicial e agora (loop com delay), o webhook AO VIVO ou um humano pode
      // ter respondido esse lead — aí ele deixa de estar "esperando". Sem isso, a
      // varredura mandaria uma 2ª resposta (msg duplicada pro lead). Consulta fresca
      // no GHL fecha o gap read→send.
      const cs = await convState(a.cid);
      if (!cs || !cs.esperando || cs.sdrAtivo) { res.pulouRecheck++; continue; }
      try {
        await respondFn(a.cid);
        res.respondidos++;
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      } catch (e) {
        logger.warn({ err: e.message, cid: a.cid }, 'sweep organico: falha ao responder lead');
      }
    }
  }
  return res;
}
