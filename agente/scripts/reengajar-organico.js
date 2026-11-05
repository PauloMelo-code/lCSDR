// Abordagem ATIVA da Tina aos leads do "Funil Orgânico".
//
// Regra do WhatsApp oficial (Meta): só dá pra mandar mensagem livre pra quem
// interagiu nas últimas 24h. Então este script SÓ aborda os leads do Funil
// Orgânico cujo último INBOUND foi <24h (janela aberta) — sem precisar template.
// Re-engaja com uma abertura e libera a Tina pra qualificar quando o lead responder.
//
// Anti-colisão: pula quem tem humano atendendo (última saída de humano recente).
//
// Uso (no container do lcsdr):
//   node scripts/reengajar-organico.js            → DRY-RUN (só lista quem seria abordado)
//   node scripts/reengajar-organico.js --send     → envia de verdade (rate-limited)
import 'dotenv/config';
import fetch from 'node-fetch';
import { db } from '../src/db/index.js';
import { GHL } from '../src/ghl/client.js';
import { upsertContactFromGHL, recordOutbound } from '../src/agent/contactService.js';
import { sendText } from '../src/agent/messenger.js';
import { claimToIaTina, resolvePipeline } from '../src/ghl/opportunities.js';

const SEND = process.argv.includes('--send');
const STAGE = resolvePipeline().stageOrganico; // Funil Orgânico: ORGANICO_STAGE_ID ou o padrão único de opportunities.js
const DELAY_MS = Number(process.env.REENGAJAR_DELAY_MS || 4000);
const REQUIRED_TAG = (process.env.GHL_TAG_REQUIRED ?? 'tina-liberada').toLowerCase();
const WINDOW_MS = 24 * 3600 * 1000;
const AUTO = new Set(['workflow', 'campaign', 'bulk_actions', 'bulk', 'automation']);

const B = 'https://services.leadconnectorhq.com';
const H = { Authorization: 'Bearer ' + process.env.GHL_API_TOKEN, Version: (process.env.GHL_API_VERSION || '2021-07-28'), Accept: 'application/json' };

// Primeiro nome "limpo": rejeita vazio, número/telefone, símbolo, 1 letra;
// capitaliza (JESSILDE/jessilde -> Jessilde). null = sem nome usável.
const NOMES_GENERICOS = new Set(['lead', 'cliente', 'contato', 'whatsapp', 'wpp', 'instagram', 'lc', 'teste', 'test', 'novo', 'aluno', 'autor', 'off-line', 'offline', 'online', 'dr', 'dra']);
function firstName(raw) {
  let first = String(raw || '').trim().split(/\s+/)[0] || '';
  // tira emoji/símbolo das BORDAS (ex.: "🌸Mara" -> "Mara", "⛔Off-line" -> "Off-line")
  first = first.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
  if (first.length < 2) return null;
  if (/\d/.test(first)) return null;        // tem dígito (telefone/lixo)
  if (NOMES_GENERICOS.has(first.toLowerCase())) return null; // placeholder/título/status
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}
function opener(raw) {
  const p = firstName(raw);
  return `Oi${p ? ', ' + p : ''}! Aqui é a Tina, do Grupo LC 😊\n\nVi que em algum momento você teve interesse em dar vida ao seu livro com a gente. Como está esse seu projeto hoje? Quero entender em que fase você está pra te indicar o melhor próximo passo.`;
}

async function fetchOrganico() {
  const out = [];
  let page = 1;
  while (page <= 15) {
    const u = `${B}/opportunities/search?location_id=${process.env.GHL_LOCATION_ID}&pipeline_stage_id=${STAGE}&status=open&limit=100&page=${page}`;
    const r = await fetch(u, { headers: H });
    const j = await r.json();
    const ops = j.opportunities || [];
    if (!ops.length) break;
    out.push(...ops);
    if (ops.length < 100) break;
    page++;
  }
  return out;
}

// { lastInboundMs, humanLast } a partir da conversa do GHL
async function convInfo(contactId) {
  try {
    const cv = await GHL.searchConversations(contactId);
    const conv = cv?.conversations?.[0] || cv?.[0];
    if (!conv?.id) return { lastInboundMs: 0, humanLast: false };
    const m = await GHL.getMessages(conv.id, { limit: 15 });
    let ms = m?.messages?.messages || m?.messages || m || [];
    ms = [...ms].sort((a, b) => new Date(b.dateAdded || b.createdAt || 0) - new Date(a.dateAdded || a.createdAt || 0));
    const lastIn = ms.find(x => (x.direction || '').toLowerCase() === 'inbound');
    const lastOut = ms.find(x => (x.direction || '').toLowerCase() === 'outbound');
    const lastInboundMs = lastIn ? new Date(lastIn.dateAdded || lastIn.createdAt || 0).getTime() : 0;
    const humanLast = !!lastOut
      && !!(lastOut.userId || lastOut.user_id)
      && !AUTO.has(String(lastOut.source || '').toLowerCase())
      && (!lastIn || new Date(lastOut.dateAdded || 0) > new Date(lastIn.dateAdded || 0));
    return { lastInboundMs, humanLast };
  } catch {
    return { lastInboundMs: 0, humanLast: false };
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = Date.now();

const ops = await fetchOrganico();
console.log(`\nFunil Orgânico (open): ${ops.length} oportunidade(s)\n`);

let elegiveis = 0, enviados = 0, fora24h = 0, humano = 0, semFone = 0;
for (const o of ops) {
  const c = o.contact || {};
  const cid = o.contactId || c.id;
  const name = c.name || c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || o.contactName || o.name || '';
  const phone = c.phone || '';
  if (!cid || !phone) { semFone++; continue; }

  const info = await convInfo(cid);
  if (now - info.lastInboundMs > WINDOW_MS) { fora24h++; continue; }   // janela 24h fechada
  if (info.humanLast) { humano++; continue; }                          // humano atendendo

  elegiveis++;
  const fn = firstName(name);
  console.log(`${SEND ? '✅ ENVIAR' : '• (dry)'} ${(name || '(sem nome)').slice(0, 22).padEnd(22)} | saudação: "Oi${fn ? ', ' + fn : ''}!" | ${phone}`);

  if (SEND) {
    try {
      const ghlC = await GHL.getContact(cid);
      const local = upsertContactFromGHL(ghlC);
      const txt = opener(local.name || name);   // nome autoritativo do contato no GHL
      await sendText(local, txt);
      recordOutbound(local.id, { author: 'ia', content: txt });
      if (REQUIRED_TAG && REQUIRED_TAG !== 'false') { try { await GHL.addTag(cid, REQUIRED_TAG); } catch {} }
      // Reivindica o lead pra raia da Tina (move a opp pro IA Tina). Sem isso,
      // o filtro "raia da Tina" bloquearia a resposta dele (opp em Funil Orgânico).
      await claimToIaTina(local).catch(() => {});
      db.prepare("UPDATE contacts SET stage='pre_qualificando', ai_paused=0, ai_paused_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(local.id);
      db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'reengajamento_organico', ?)`).run(local.id, JSON.stringify({ stage: STAGE }));
      enviados++;
      await sleep(DELAY_MS);
    } catch (e) {
      console.error('  ❌ falhou', name, '-', e.message);
    }
  }
}

console.log(`\n──────── resumo ────────`);
console.log(`Elegíveis (interagiu <24h, sem humano): ${elegiveis}`);
if (SEND) console.log(`Enviados: ${enviados}`);
console.log(`Pulados — fora da janela 24h: ${fora24h} | humano atendendo: ${humano} | sem telefone: ${semFone}`);
if (!SEND) console.log(`\n(DRY-RUN) Rode com --send pra disparar de verdade.`);
