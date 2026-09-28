import express from 'express';
import { db } from '../db/index.js';
import { GHL, downloadAttachment } from '../ghl/client.js';
import { verifyGHLSignature } from '../ghl/webhookSig.js';
import { logger } from '../utils/logger.js';
import { transcribeAudioBuffer } from '../utils/transcribe.js';
import {
  upsertContactFromGHL, recordInbound, recordOutbound, countMessagesToday,
} from '../agent/contactService.js';
import { generateTinaReply } from '../agent/tina.js';
import { describeImageBuffer } from '../agent/tina-gemini.js';
import { sendSequence, sendText, preferredChannel, isTinaSentMessage } from '../agent/messenger.js';
import {
  pauseIA, resumeIA, scheduleFollowup, handleSDRReply,
  markQualifiedAndHandoff, markDisqualified, applyTinaTags,
} from '../agent/handoff.js';
import {
  schedulingEnabled, getNextSlots, slotsContextBlock, bookSlot, recordOffer,
  upcomingAppointment, NO_SLOTS_CONTEXT, calendariosParaServico,
} from '../agent/scheduling.js';
import { bookSearchEnabled, searchBookLink } from '../agent/bookSearch.js';
import { contactOppOutsideTinaLane, moveLeadToIaTina, claimToIaTina, resolvePipeline, contactInIaTinaLane, contactOppInReentrada, contactWorkedByOtherTeam, contactExclusivelyInTinaLane, closeSdrOppOnBooking, contactIsConvertedCustomer } from '../ghl/opportunities.js';
import { liveHandoff } from '../agent/queue.js';
import { notifyAgendamento, notifyLiveHandoff, notifyIaTinaForaJanela } from '../agent/notify.js';
import { withContactLock } from '../utils/contactLock.js';
import { attributionEnabled, enrichContactAttribution } from '../agent/attribution.js';

const router = express.Router();
const MAX_KB = Number(process.env.MAX_ATTACHMENT_KB || 200);
const MAX_MSGS_DAY = Number(process.env.MAX_MESSAGES_PER_CONVERSATION_PER_DAY || 40);

// Identifica o tipo real de um anexo pelos MAGIC BYTES (assinatura do arquivo).
// O GHL serve mídia do WhatsApp sem extensão na URL e sem content-type, então
// não dá pra confiar só na URL. Retorna { kind: 'image'|'audio'|'pdf'|null, mime }.
function sniffAttachment(buf) {
  if (!buf || buf.length < 12) return { kind: null, mime: null };
  const b = buf;
  const ascii = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  // imagens
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { kind: 'image', mime: 'image/jpeg' };
  if (b[0] === 0x89 && ascii(1, 'PNG')) return { kind: 'image', mime: 'image/png' };
  if (ascii(0, 'GIF8')) return { kind: 'image', mime: 'image/gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { kind: 'image', mime: 'image/webp' };
  if (b[0] === 0x42 && b[1] === 0x4D) return { kind: 'image', mime: 'image/bmp' };
  // PDF
  if (ascii(0, '%PDF')) return { kind: 'pdf', mime: 'application/pdf' };
  // áudio (OBS: WAV e WEBP são ambos RIFF — diferencia pelo bloco em offset 8)
  if (ascii(0, 'OggS')) return { kind: 'audio', mime: 'audio/ogg' };
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return { kind: 'audio', mime: 'audio/wav' };
  if (ascii(0, 'ID3')) return { kind: 'audio', mime: 'audio/mpeg' };
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return { kind: 'audio', mime: 'audio/mpeg' };
  if (ascii(4, 'ftyp')) return { kind: 'audio', mime: 'audio/mp4' }; // m4a/aac
  return { kind: null, mime: null };
}

// Idempotência de webhook: GHL pode reentregar o mesmo evento mais de
// uma vez (timeout, retry). Sem dedup, a Tina processa 2x e responde 2x.
function alreadyProcessed(source, messageId) {
  if (!messageId) return false;
  const result = db.prepare(
    'INSERT OR IGNORE INTO processed_webhook_ids (source, message_id) VALUES (?, ?)'
  ).run(source, String(messageId));
  return result.changes === 0; // 0 = duplicata (UNIQUE bateu)
}

// === Webhook principal do GHL ===
// GHL → Settings → Webhooks: POST https://seu-dominio/webhook/ghl
// Eventos: InboundMessage, OutboundMessage
router.post('/ghl', async (req, res) => {
  // 1) Valida assinatura se GHL_WEBHOOK_SECRET configurado
  const sig = verifyGHLSignature(req, req.rawBody || JSON.stringify(req.body || {}));
  if (!sig.ok) {
    logger.warn({ reason: sig.reason }, 'webhook GHL rejeitado por assinatura');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const rawBody = req.body || {};

  // GHL Workflow webhook tem 2 formatos possíveis:
  //   1. Flat: { type, contactId, body, ... }
  //   2. Custom Data aninhado: { contact: {...}, customData: { type, contactId, body, ... } }
  // Fazemos merge dos 2 — o customData tem prioridade.
  const customData = rawBody.customData || {};
  const event = {
    ...rawBody,
    ...customData,
    // Dados do contato podem vir em rawBody.contact.* ou no nível raiz
    contactId: customData.contactId || rawBody.contactId || rawBody.contact_id || rawBody.contact?.id || rawBody.id,
  };

  const kind = event.type || event.event || 'unknown';

  // Log mais verboso: se kind=unknown, mostra o body completo pra debug
  if (kind === 'unknown') {
    logger.warn({ rawBody, customData }, '[webhook GHL] kind=unknown — body completo pra debug');
  } else {
    logger.info({ kind, contactId: event.contactId, id: event.messageId || event.id }, '[webhook GHL]');
  }

  db.prepare('INSERT INTO events_log (kind, payload) VALUES (?, ?)')
    .run(`webhook_${kind}`, JSON.stringify(rawBody).slice(0, 8000));

  // 2) Responder rápido (GHL tem timeout ~10s). Processa assíncrono.
  res.status(200).json({ ok: true });

  try {
    // Dedup: se o GHL reentregar o mesmo message_id, ignora silenciosamente
    const msgId = event.messageId || event.id;
    if ((kind === 'InboundMessage' || kind === 'OutboundMessage') && alreadyProcessed('ghl', msgId)) {
      logger.info({ kind, messageId: msgId }, 'webhook GHL: evento duplicado, ignorando');
      return;
    }

    if (kind === 'InboundMessage') {
      await handleInbound(event);
    } else if (kind === 'OutboundMessage') {
      await handleOutbound(event);
    } else if (kind === 'ContactCreate') {
      await handleContactCreate(event);
    } else if (IA_TINA_TRIGGER_KINDS.includes(kind)) {
      await handleOpportunityStage(event);
    } else {
      logger.debug({ kind }, 'webhook não tratado');
    }
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack, kind }, 'erro processando webhook');
    db.prepare('INSERT INTO events_log (kind, payload) VALUES (?, ?)')
      .run('error', JSON.stringify({ err: err.message, kind }).slice(0, 8000));
  }
});

async function handleContactCreate(event) {
  const ghlContactId = event.contactId || event.id;
  if (!ghlContactId) return;
  try {
    const contact = await GHL.getContact(ghlContactId);
    upsertContactFromGHL(contact);
  } catch (err) {
    logger.warn({ err: err.message, ghlContactId }, 'contact create: falha ao buscar');
  }
}

// Tag de WHITELIST: só atende contatos com essa tag (durante teste pra
// não atropelar produção). Em produção, setar GHL_TAG_REQUIRED=false ou
// vazio pra desabilitar a whitelist (Tina passa a atender todos).
const REQUIRED_TAG = (process.env.GHL_TAG_REQUIRED ?? 'tina-liberada').toLowerCase();
const REQUIRED_TAG_ENABLED = REQUIRED_TAG && REQUIRED_TAG !== 'false' && REQUIRED_TAG !== '';

// Tag que, se presente no contato GHL, faz a Tina NÃO responder.
// Plano A (manual): time aplica/remove a tag pra pausar/reativar.
// Plano B (automático): o checkHumanResponded() abaixo detecta SDR respondendo
// e pausa sozinho.
const PAUSE_TAG = (process.env.GHL_TAG_PAUSAR_TINA || 'tina-pausada').toLowerCase();

// Tags de ORIGEM bloqueadas: se o contato tiver QUALQUER uma delas, a Tina
// NÃO responde. Decisão Lilian: a Tina não atende leads do FORMULÁRIO DO SITE,
// só Meta + WhatsApp. Configurável por env (CSV), ex:
//   GHL_TAG_BLOCK=lc-lca,lc-lce,form-site
// Vazio = nenhum bloqueio por origem.
const BLOCK_TAGS = (process.env.GHL_TAG_BLOCK || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function extractTags(ghlContact) {
  const raw = ghlContact?.tags || [];
  return raw.map(t => (typeof t === 'string' ? t : (t?.name || ''))).map(s => s.toLowerCase()).filter(Boolean);
}

// DETECÇÃO AUTOMÁTICA DE HUMANO RESPONDENDO
// GHL não tem trigger nativo de "Outbound Message Sent", então antes da Tina
// responder, perguntamos pro GHL: a última mensagem outbound da conversa foi
// enviada por um humano (tem userId)?
//
// ATENÇÃO — fail mode catastrófico se mal calibrado:
//   Se o PIT do GHL atribui userId em todas as mensagens enviadas via API
//   (alguns tokens fazem isso), a Tina classifica a PRÓPRIA resposta como
//   "humano" e pausa SOZINHA logo após mandar a primeira mensagem.
//
// Por isso, esta detecção é OFF por padrão e tem 2 sanity checks:
//   1. AUTO_HUMAN_DETECTION_ENABLED=true no env pra ativar
//   2. O userId tem que bater com um SDR conhecido em sdr_users.ghl_user_id
//      (cruzamento com nossa base; se não bate, assume API e não pausa)
//   3. A mensagem outbound do GHL tem que ser mais nova que o nosso
//      contacts.last_outbound_at (com tolerância de 5s), senão foi nossa
// OPT-IN (default OFF). Faz 2 chamadas ao GHL por mensagem (latência) e, se mal
// calibrado, pode classificar a própria msg da Tina como humana e pausá-la.
// O caminho LIMPO de detecção de humano é o webhook de OutboundMessage
// (handleOutbound), event-driven e sem esse risco. Ligar só se necessário:
// AUTO_HUMAN_DETECTION_ENABLED=true (precisa link-ghl-users rodado).
const AUTO_HUMAN_DETECTION = process.env.AUTO_HUMAN_DETECTION_ENABLED === 'true';

// Filtro LEAD NOVO vs. JÁ EM ATENDIMENTO (pedido do Gabriel: o GHL não filtra
// reentrada). Default ON. Só roda no PRIMEIRO contato (Tina nunca respondeu o
// lead) e checa se a conversa do GHL já tem saída de um humano. Falha aberto.
const SKIP_IN_ATTENDANCE = process.env.SKIP_LEADS_IN_ATTENDANCE !== 'false';
// Janela: só conta como "em atendimento" se o humano falou nos últimos N dias.
// Evita bloquear lead FRIO antigo (humano falou há meses, lead sumiu e voltou —
// é oportunidade nova pra Tina). Configurável; 0/negativo = sem janela (qualquer idade).
const ATTENDANCE_DAYS = Number(process.env.SKIP_ATTENDANCE_DAYS || 30);
// Janela em HORAS pra considerar um humano "atendendo AGORA" (opt-in). Se setada
// (>0), tem PRECEDÊNCIA sobre SKIP_ATTENDANCE_DAYS: um consultor que falou há MAIS
// que isso é tratado como "largou o lead" → a Tina assume o atendimento. Se ele
// voltar a responder DENTRO da janela, a Tina pausa de novo (handback — precisa
// AUTO_HUMAN_DETECTION_ENABLED=true). Ex.: SKIP_ATTENDANCE_HOURS=2.
const ATTENDANCE_HOURS = Number(process.env.SKIP_ATTENDANCE_HOURS || 0);
// Janela (ms) em que uma saída de humano ainda conta como "atendendo agora".
// Horas têm precedência; senão cai nos dias (default 30). 0 = sem janela.
function humanActiveWindowMs() {
  if (ATTENDANCE_HOURS > 0) return ATTENDANCE_HOURS * 3600_000;
  return ATTENDANCE_DAYS > 0 ? ATTENDANCE_DAYS * 864e5 : 0;
}

// MODO "atende TODOS menos Reentrada" (leads de anúncio caem no Funil Orgânico e
// a Tina precisa atender + mover pra coluna dela). Quando ON: ignora o whitelist
// da tag (atende sem `tina-liberada`), PULA quem tem opp aberta em Reentrada (time
// re-trabalhando), e MOVE o lead atendido pra IA Tina (claimToIaTina). Também
// IGNORA o gate "em atendimento" de 30 dias — lead de anúncio VOLTA com mensagem
// antiga de humano (Lilian/Equipe LC) e era barrado à toa. Mantém o bloqueio por
// origem (BLOCK_TAGS) e a pausa (tina-pausada).
// ⚠️ Como solta o "em atendimento", a proteção contra colisão com humano fica na
// DETECÇÃO EM TEMPO REAL — ligue JUNTO `AUTO_HUMAN_DETECTION_ENABLED=true` (pausa
// quando um SDR conhecido respondeu recente).
const ATTEND_EXCEPT_REENTRADA = process.env.TINA_ATTEND_EXCEPT_REENTRADA === 'true';

// PROTEÇÃO REENTRADA — DEFAULT ON (independente do modo acima e da whitelist): a
// Tina NUNCA assume lead com opp ABERTA numa stage de Reentrada (o time está
// re-trabalhando). Sinal forte e barato de colisão. Desligar só com
// SKIP_REENTRADA_OPP=false. Stages consideradas = GHL_BLOCK_OPP_STAGES (ver
// scripts/listar-stages.js pra pegar os ids dos funis do time).
const SKIP_REENTRADA_OPP = process.env.SKIP_REENTRADA_OPP !== 'false';

// A Tina é DONA da raia de entrada (Funil Orgânico / IA Tina): responde o lead
// IMEDIATAMENTE, mesmo que um consultor tenha dado um 1º toque, e REASSUME na hora
// se ele voltar a mandar msg depois de uma pausa. Ela só larga o lead quando a opp
// SAI da raia dela (movida pra Proposta/Aguardando/Reentrada/outro pipeline) — aí o
// time levou o lead adiante de verdade. Opt-in (TINA_OWNS_ENTRY_LANE=true, default
// off). Guarda: só vale pra lead EXCLUSIVAMENTE na raia (contactExclusivelyInTinaLane).
const OWNS_ENTRY_LANE = process.env.TINA_OWNS_ENTRY_LANE === 'true';
// Mesmo dona da raia, a Tina NÃO sobrescreve um consultor que ESTÁ atendendo: se um
// SDR mandou msg dentro da "janela de SDR ativo", ela cede. Default 12h — se o
// consultor realmente mandou mensagem, dá tempo dele tocar; só depois desse tempo de
// silêncio dele a Tina assume. Lead SEM nenhum toque de consultor → Tina responde na
// hora. Configurável: SDR_ACTIVE_HOURS (horas) ou SDR_ACTIVE_MINUTES (min, precede).
const _sdrMin = Number(process.env.SDR_ACTIVE_MINUTES);
const _sdrHrs = Number(process.env.SDR_ACTIVE_HOURS);
const SDR_ACTIVE_MS =
  (Number.isFinite(_sdrMin) && _sdrMin > 0) ? _sdrMin * 60_000
  : (Number.isFinite(_sdrHrs) && _sdrHrs > 0) ? _sdrHrs * 3_600_000
  : 12 * 3_600_000; // default 12h

// Sources que são AUTOMAÇÃO (não atendimento humano), mesmo tendo userId — o
// GHL carimba o dono do workflow/campanha no userId. Confirmado em prod: msg
// de workflow vem com userId preenchido.
const AUTO_SOURCES = new Set(['workflow', 'campaign', 'bulk_actions', 'bulk', 'automation']);

// True se a conversa do GHL tem uma saída RECENTE de um HUMANO. Discriminador
// confirmado em prod (jun/2026): humano envia com `userId` preenchido (Tina via
// API sempre vem com userId NULL). Excluímos sources de automação (workflow/
// campanha), que também trazem userId. Saídas antigas (fora da janela) não
// contam — lead esfriou e a Tina pode reabordar.
async function conversationAlreadyInAttendance(ghlContactId, windowMs) {
  if (!process.env.GHL_API_TOKEN) return false;
  try {
    const convResp = await GHL.searchConversations(ghlContactId);
    const conv = convResp?.conversations?.[0] || convResp?.[0];
    if (!conv?.id) return false;
    const msgsResp = await GHL.getMessages(conv.id, { limit: 25 });
    const msgs = msgsResp?.messages?.messages || msgsResp?.messages || msgsResp || [];
    if (!Array.isArray(msgs) || !msgs.length) return false;
    const win = windowMs != null ? windowMs : humanActiveWindowMs();
    const limiteMs = win > 0 ? Date.now() - win : 0;
    return msgs.some(m => {
      const dir = (m.direction || '').toLowerCase();
      const uid = m.userId || m.user_id || m.sentBy?.id;
      const src = String(m.source || '').toLowerCase();
      if (dir !== 'outbound' || !uid) return false;   // só humano tem userId; Tina = null
      if (AUTO_SOURCES.has(src)) return false;         // workflow/campanha não é humano atendendo
      if (!limiteMs) return true;                      // sem janela → qualquer idade conta
      const ts = new Date(m.dateAdded || m.createdAt || m.date || 0).getTime();
      return ts ? ts >= limiteMs : false;              // sem data confiável → não bloqueia (lado seguro p/ atender)
    });
  } catch (err) {
    logger.warn({ err: err.message, ghlContactId }, 'falha checando atendimento prévio; segue normal');
    return false;
  }
}

function isKnownSdrUserId(userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT id FROM sdr_users WHERE ghl_user_id = ?').get(String(userId));
  return Boolean(row);
}

async function lastOutboundWasHuman(ghlContactId, localContact) {
  if (!AUTO_HUMAN_DETECTION) return false;
  if (!process.env.GHL_API_TOKEN) return false;
  try {
    const convResp = await GHL.searchConversations(ghlContactId);
    const conv = convResp?.conversations?.[0] || convResp?.[0];
    if (!conv?.id) return false;
    const msgsResp = await GHL.getMessages(conv.id, { limit: 10 });
    let msgs = msgsResp?.messages?.messages || msgsResp?.messages || msgsResp || [];
    if (!Array.isArray(msgs) || !msgs.length) return false;

    // Ordena por dateAdded/createdAt desc client-side pra não depender da API
    msgs = [...msgs].sort((a, b) => {
      const da = new Date(a.dateAdded || a.createdAt || a.date || 0).getTime();
      const db_ = new Date(b.dateAdded || b.createdAt || b.date || 0).getTime();
      return db_ - da;
    });

    const lastOut = msgs.find(m => (m.direction || '').toLowerCase() === 'outbound');
    if (!lastOut) return false;

    // === DETECÇÃO POR PROCEDÊNCIA (discriminador primário) ===
    // O GHL carimba TODA saída (inclusive a da Tina via API) com o userId do DONO
    // do contato — então userId NÃO distingue Tina de humano. O único sinal
    // confiável é a procedência: se ESTE messageId foi enviado pela própria Tina
    // (registrado em tina_sent_msgs no envio), não é humano.
    const outId = lastOut.id || lastOut.messageId || lastOut._id;
    if (outId && isTinaSentMessage(outId)) return false;

    // Automação (workflow/campanha) também não é atendimento humano.
    if (AUTO_SOURCES.has(String(lastOut.source || '').toLowerCase())) return false;

    const userId = lastOut.userId || lastOut.user_id || lastOut.sentBy?.id;

    // Confirmação secundária (janela de transição): saídas que a Tina mandou ANTES
    // deste recurso não estão no tina_sent_msgs. Pra não tratar essas como humano,
    // só conta como humano se o userId for de um SDR conhecido — senão é API/Tina.
    // (A partir do deploy, o caso comum já é resolvido pela procedência acima.)
    if (!isKnownSdrUserId(userId)) {
      logger.debug({ userId }, 'saída sem procedência Tina e userId não é SDR conhecido — assumindo API');
      return false;
    }

    // Recência (modo cooldown, opt-in via SKIP_ATTENDANCE_HOURS): se o consultor
    // conhecido falou há MAIS que a janela ativa, ele "largou" o lead → a Tina
    // assume (não pausa). Só pausa se a última fala dele foi recente (handback).
    // Sem SKIP_ATTENDANCE_HOURS, mantém o comportamento antigo (pausa por qualquer idade).
    if (ATTENDANCE_HOURS > 0) {
      const outTs = new Date(lastOut.dateAdded || lastOut.createdAt || 0).getTime();
      if (outTs && (Date.now() - outTs) > ATTENDANCE_HOURS * 3600_000) {
        logger.debug({ ghlContactId, outTs }, 'consultor falou fora da janela ativa — Tina assume');
        return false;
      }
    }

    // Sanity 2: outbound do GHL é mais nova que nossa última outbound?
    // Se o timestamp do GHL é igual/menor ao nosso last_outbound_at + 5s,
    // foi a Tina mesmo que enviou.
    if (localContact?.last_outbound_at) {
      const ghlTs = new Date(lastOut.dateAdded || lastOut.createdAt || 0).getTime();
      const localTs = new Date(localContact.last_outbound_at).getTime();
      if (ghlTs <= localTs + 5_000) {
        return false;
      }
    }
    return true;
  } catch (err) {
    logger.warn({ err: err.message, ghlContactId }, 'falha checando última mensagem; segue sem pausar');
    return false;
  }
}

// RECLAIM: a Tina REASSUME um lead que foi pausado por um consultor (ai_paused=1).
// Fecha o gap do "handback": sem isso, uma vez pausado, o lead ficava travado pra
// sempre. Chamado no gate de ai_paused, quando o lead VOLTA a mandar mensagem —
// então a Tina só responde a uma deixa do próprio lead (nada de outbound proativo).
// Guardas SEMPRE exigidas:
//   - lead NÃO genuinamente fechado (desqualificado/agendado/qualificado);
//   - lead EXCLUSIVAMENTE na raia da Tina (TODAS as opps abertas em Funil Orgânico/
//     IA Tina) — se houver QUALQUER negócio vivo em outra coluna (Proposta/Follow Up/
//     outro pipeline/Reentrada) NÃO reassume (multi-opp: não rouba lead de closer).
// Quando reassume:
//   - TINA_OWNS_ENTRY_LANE: IMEDIATO (a Tina é dona da raia; não espera o consultor
//     sumir — ela responde na hora). É o modo que a LC quer pro Funil Orgânico.
//   - senão (modo cooldown SKIP_ATTENDANCE_HOURS): só reassume se NENHUM humano
//     estiver ativo na janela (consultor "sumiu").
async function maybeReclaimLead(fresh, ghlContactId) {
  if (!OWNS_ENTRY_LANE && ATTENDANCE_HOURS <= 0) return false;               // feature desligada
  if (['desqualificado', 'agendado', 'qualificado'].includes(fresh.stage)) return false;
  // Reunião futura JÁ marcada (por humano ou Tina — o stage local não vê as marcadas
  // por consultor) → lead fechado, não reassume (caso Gabriel: Bruna marcou 16h e a
  // Tina voltou oferecendo 10h/14h).
  if (await upcomingAppointment(fresh)) return false;
  if (!(await contactExclusivelyInTinaLane(fresh))) return false;            // negócio vivo fora da raia
  // NÃO sobrescreve SDR ativo: cede se um consultor mandou msg dentro da janela.
  // Dono da raia → janela CURTA (SDR ativo AGORA); cooldown → janela longa (SDR sumiu).
  const activeWin = OWNS_ENTRY_LANE ? SDR_ACTIVE_MS : humanActiveWindowMs();
  if (await conversationAlreadyInAttendance(ghlContactId, activeWin)) return false;
  resumeIA(fresh.id, OWNS_ENTRY_LANE ? 'raia_tina_reassume' : 'consultor_sumiu_reclaim');
  // Volta o lead pro fluxo de qualificação (estava 'handoff' por causa da pausa).
  db.prepare(`UPDATE contacts SET stage = CASE WHEN stage IN ('handoff','em_atendimento') THEN 'pre_qualificando' ELSE stage END WHERE id = ?`).run(fresh.id);
  try {
    db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'ia_reclaim_lead', ?)`)
      .run(fresh.id, JSON.stringify({ ghlContactId, mode: OWNS_ENTRY_LANE ? 'owns_lane' : 'cooldown' }));
  } catch {}
  logger.info({ contactId: fresh.id, ghlContactId, ownsLane: OWNS_ENTRY_LANE }, 'lead na raia da Tina — Tina reassume');
  return true;
}

// =====================================================================
// CONTINUIDADE quando o TIME move o card pra coluna "IA Tina"
// =====================================================================
// O time arrasta o card pra coluna IA Tina pra dizer "Tina, assume e dá
// continuidade a esse lead". A Tina puxa a conversa do GHL pro histórico local,
// lê o contexto e manda uma retomada — DESDE QUE a janela de 24h do WhatsApp
// esteja aberta (a Meta não deixa iniciar conversa fria sem template).
//
// Pré-requisitos:
//  1) IA_TINA_CONTINUATION_ENABLED=true no .env (opt-in, igual aos outros gates).
//  2) O GHL precisa MANDAR o evento de mudança de stage pra cá. Recomendado:
//     Gabriel cria um Workflow no GHL — Trigger "Pipeline Stage Changed" (filtro:
//     stage = IA Tina) → Action "Webhook" POST p/ /webhook/ghl com customData
//     incluindo type (default aceito: OpportunityStageUpdate / IaTinaAssumir),
//     pipelineId, pipelineStageId, contactId e id da oportunidade.
const IA_TINA_CONTINUATION = process.env.IA_TINA_CONTINUATION_ENABLED === 'true';
// Tipos de evento que disparam a continuidade (o nome exato do evento nativo do
// GHL varia; configurável por env. O handler ainda filtra pelo stage IA Tina).
const IA_TINA_TRIGGER_KINDS = (process.env.IA_TINA_TRIGGER_KINDS
  || 'OpportunityStageUpdate,OpportunityStatusUpdate,IaTinaAssumir')
  .split(',').map(s => s.trim()).filter(Boolean);
// Anti-loop: a PRÓPRIA Tina, ao mover/criar a opp na IA Tina, grava
// ia_tina_self_moved_at + ia_tina_self_moved_opp. O eco do webhook dessa
// movimentação é ignorado por CASAMENTO DE OPP ID (forte) dentro de um TTL
// generoso (cobre atraso/retry de entrega do GHL, que pode passar de 10 min).
// Sem opp id no payload, cai no TTL temporal puro.
const SELF_MOVE_TTL_MS = Number(process.env.IA_TINA_SELF_MOVE_TTL_MIN || 30) * 60_000;
// Cooldown: não re-aborda o mesmo lead em continuidade dentro de N horas (cobre
// retries do GHL e re-arrasto do card). Re-arrasto legítimo dias depois funciona.
const CONTINUATION_COOLDOWN_MS = Number(process.env.IA_TINA_CONTINUATION_COOLDOWN_H || 12) * 3600_000;
const WHATSAPP_WINDOW_MS = 24 * 3600 * 1000;

// Gatilho interno (vira o "turno do usuário" só se a conversa não terminou já
// com o lead). Bracket sinaliza que NÃO é fala do lead — mesma convenção de
// [áudio transcrito] / [SDR humano respondeu] já usada no histórico.
const CONTINUATION_TRIGGER = '[gatilho interno do sistema, NÃO é mensagem do lead: o time te encaminhou este lead agora pra você dar continuidade ao atendimento]';
const CONTINUATION_CONTEXT = `## CONTINUIDADE DE ATENDIMENTO (importante)
O time ACABOU de te encaminhar este lead pra você dar continuidade. Leia TODO o histórico acima e:
- Se o lead deixou uma pergunta ou ficou esperando resposta, responda do ponto onde parou.
- Se a conversa esfriou, retome de forma calorosa e natural. NÃO se reapresente como se fosse o primeiro contato se já houve conversa antes.
- NUNCA repita uma mensagem que já foi enviada no histórico.
- Seja breve e siga o fluxo normal de qualificação. Se ainda não há histórico nenhum, faça uma abertura calorosa.`;

// SQLite guarda DATETIME (CURRENT_TIMESTAMP) como 'YYYY-MM-DD HH:MM:SS' em UTC.
// True se `dt` está dentro de `ms` a partir de agora.
function withinMs(dt, ms) {
  if (!dt) return false;
  const t = new Date(String(dt).replace(' ', 'T') + 'Z').getTime();
  return Number.isFinite(t) && (Date.now() - t) < ms;
}

// Eco da própria movimentação da Tina? Forte = o opp id do evento bate com o que
// ela acabou de mover/criar. Opp DIFERENTE dentro do TTL → NÃO é eco (é outra
// opp, provável movimento do time). Sem opp id comparável → conservador (eco
// dentro do TTL). Isso fecha o furo do guard puramente temporal: um eco/retry do
// GHL que chega depois do TTL mas com o MESMO opp id ainda é reconhecido.
function isSelfMoveEcho(row, oppId) {
  if (!row || !withinMs(row.ia_tina_self_moved_at, SELF_MOVE_TTL_MS)) return false;
  if (row.ia_tina_self_moved_opp && oppId) return String(row.ia_tina_self_moved_opp) === String(oppId);
  return true;
}

// Puxa a conversa do GHL pro banco local (pra Tina ter o histórico REAL ao
// retomar — inclusive o que um humano falou) e devolve o timestamp (ms) do
// último INBOUND (pra checar a janela de 24h). Só importa inbound (lead) e
// outbound HUMANO (sdr): a saída da própria Tina já é local, re-trazer
// duplicaria. Dedup por ghl_message_id OU por (direção + conteúdo) já existente.
// Preserva o timestamp original (normalizado p/ o formato do SQLite) pra
// ordenar certo com as mensagens nativas.
async function syncConversationFromGHL(contact) {
  try {
    const cv = await GHL.searchConversations(contact.ghl_contact_id);
    const conv = cv?.conversations?.[0] || cv?.[0];
    if (!conv?.id) return { lastInboundMs: 0, imported: 0 };
    const m = await GHL.getMessages(conv.id, { limit: 50 });
    let ms = m?.messages?.messages || m?.messages || m || [];
    if (!Array.isArray(ms)) ms = [];
    ms = [...ms].sort((a, b) =>
      new Date(a.dateAdded || a.createdAt || 0) - new Date(b.dateAdded || b.createdAt || 0));

    let lastInboundMs = 0, imported = 0;
    for (const x of ms) {
      const dir = (x.direction || '').toLowerCase();
      if (dir !== 'inbound' && dir !== 'outbound') continue;
      const ts = new Date(x.dateAdded || x.createdAt || 0).getTime();
      if (dir === 'inbound' && ts) lastInboundMs = Math.max(lastInboundMs, ts);

      const body = typeof x.body === 'string' ? x.body
        : (typeof x.message === 'string' ? x.message : '');
      const text = (body || '').trim();
      if (!text) continue; // pula mídia-only / sem texto

      const uid = x.userId || x.user_id || x.sentBy?.id;
      const isHuman = !!uid && !AUTO_SOURCES.has(String(x.source || '').toLowerCase());
      // Saída sem userId = Tina via API (já está local) → não reimporta.
      if (dir === 'outbound' && !isHuman) continue;
      const author = dir === 'inbound' ? 'lead' : 'sdr';

      const gid = x.id || x.messageId;
      const dup = db.prepare(
        `SELECT 1 FROM messages WHERE contact_id = ? AND (
            (ghl_message_id IS NOT NULL AND ghl_message_id = ?) OR
            (direction = ? AND TRIM(content) = ?)
         ) LIMIT 1`
      ).get(contact.id, gid ? String(gid) : ' ', dir, text);
      if (dup) continue;

      const createdAt = ts ? new Date(ts).toISOString().slice(0, 19).replace('T', ' ') : null;
      db.prepare(
        `INSERT INTO messages (contact_id, ghl_message_id, direction, author, content, content_type, created_at)
         VALUES (?, ?, ?, ?, ?, 'text', COALESCE(?, CURRENT_TIMESTAMP))`
      ).run(contact.id, gid ? String(gid) : null, dir, author, text, createdAt);
      imported++;
    }
    return { lastInboundMs, imported };
  } catch (err) {
    logger.warn({ err: err.message, contactId: contact.id }, 'falha sincronizando conversa do GHL p/ continuidade');
    return { lastInboundMs: 0, imported: 0 };
  }
}

// Handler do evento "opp mudou de stage". Age SÓ quando a opp foi pra coluna
// IA Tina do pipeline da Tina, e a movimentação NÃO foi da própria Tina.
export async function handleOpportunityStage(event) {
  // Gate de produção (opt-in). O script de varredura passa _force:true pra rodar
  // a continuidade em lote sem depender do flag (ação manual e explícita).
  if (!IA_TINA_CONTINUATION && !event._force) return;
  const { pipelineId, stageIaTina } = resolvePipeline();
  if (!stageIaTina) return;

  // Normaliza (o GHL varia muito o nome dos campos entre webhook e REST).
  const stageId = event.pipelineStageId || event.stageId || event.pipeline_stage_id
    || event.opportunity?.pipelineStageId || event.opportunity?.stageId || null;
  const oppPipelineId = event.pipelineId || event.opportunity?.pipelineId || null;
  const oppId = event.opportunityId || event.opportunity?.id || event.id || null;
  // ATENÇÃO: event.contactId tem fallback p/ rawBody.id (que num evento de opp é o
  // ID DA OPORTUNIDADE) — não confiar cegamente. Prioriza contato aninhado/explícito.
  let ghlContactId = event.contact?.id || event.opportunity?.contactId || event.contact_id || null;
  if (!ghlContactId && event.contactId && event.contactId !== oppId) ghlContactId = event.contactId;

  // O tipo dedicado 'IaTinaAssumir' vem de um Workflow do GHL JÁ FILTRADO pra a
  // coluna IA Tina → confia no filtro do GHL e DISPENSA o pipelineStageId (que o
  // GHL nem sempre expõe como merge field). Pros eventos NATIVOS de stage, exige
  // que tenha ido pra coluna IA Tina do pipeline da Tina.
  const trusted = String(event.type || '') === 'IaTinaAssumir';
  if (!trusted) {
    if (!stageId || stageId !== stageIaTina) return;
    if (oppPipelineId && pipelineId && oppPipelineId !== pipelineId) return;
  }
  if (!ghlContactId) {
    logger.warn({ oppId, kind: event.type }, 'evento IA Tina sem contactId resolvível — ignorando');
    return;
  }

  // ANTI-LOOP: se a PRÓPRIA Tina acabou de mover esta opp, ignora o eco (imune ao
  // quirk do PIT carimbar userId). Checagem barata antes de hidratar/locar.
  const known = db.prepare('SELECT id, ia_tina_self_moved_at, ia_tina_self_moved_opp FROM contacts WHERE ghl_contact_id = ?').get(ghlContactId);
  if (isSelfMoveEcho(known, oppId)) {
    logger.info({ ghlContactId, contactId: known.id, oppId }, 'movimentação IA Tina foi da própria Tina (anti-loop), ignorando');
    return;
  }

  // Hidrata o contato do GHL (nome, phone, TAGS).
  let ghlContact;
  try {
    ghlContact = await GHL.getContact(ghlContactId);
  } catch (err) {
    logger.warn({ err: err.message, ghlContactId }, 'continuidade IA Tina: falha ao buscar contato');
    return;
  }
  const tags = extractTags(ghlContact);

  // Bloqueios duros vencem o move: origem bloqueada (Lilian) e pausa explícita.
  if (BLOCK_TAGS.length && BLOCK_TAGS.find(t => tags.includes(t))) {
    logger.info({ ghlContactId }, 'continuidade IA Tina: lead de origem bloqueada, ignorando');
    return;
  }
  if (tags.includes(PAUSE_TAG)) {
    logger.info({ ghlContactId }, 'continuidade IA Tina: lead com tag de pausa, ignorando');
    return;
  }

  const contact = upsertContactFromGHL(ghlContact);

  // Lead JÁ TEM reunião futura (marcada por quem for) → não re-engaja pra agendar
  // de novo (caso Gabriel 16/07: já tinha 16h com a Andressa e a Tina retomou
  // oferecendo 10h/14h). Vale pra varredura, recuperação e continuidade.
  if (await upcomingAppointment(contact)) {
    logger.info({ ghlContactId, contactId: contact.id }, 'continuidade IA Tina: lead já tem reunião futura — não re-engaja');
    return;
  }

  // CLIENTE CONVERTIDO: mesmo que um workflow mova o card pra IA Tina, a Tina NÃO
  // reassume quem já é cliente (venda ganha em outro pipeline) — caso Luana, campanha
  // reativou cliente antigo. A continuação ignora a whitelist, então a guarda vem aqui.
  if (await contactIsConvertedCustomer(contact)) {
    logger.info({ ghlContactId, contactId: contact.id }, 'continuidade IA Tina: cliente já convertido — Tina não assume');
    return;
  }

  // O move PRA IA Tina É a autorização do time → garante a tag de liberação
  // (senão o whitelist barraria as próximas mensagens do lead).
  if (REQUIRED_TAG_ENABLED && !tags.includes(REQUIRED_TAG)) {
    try { await GHL.addTag(ghlContactId, REQUIRED_TAG); } catch {}
  }

  await withContactLock(contact.id, async () => {
    const fresh = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
    if (!fresh) return;

    // Re-checa anti-loop e cooldown DENTRO do lock (fecha corrida entre o eco da
    // própria Tina / retries simultâneos).
    if (isSelfMoveEcho(fresh, oppId)) return;
    if (withinMs(fresh.ia_tina_continuation_at, CONTINUATION_COOLDOWN_MS)) {
      logger.info({ contactId: fresh.id }, 'continuidade IA Tina em cooldown, ignorando');
      return;
    }

    // Puxa a conversa real do GHL pro histórico local + pega o último inbound.
    const { lastInboundMs } = await syncConversationFromGHL(fresh);

    // Janela de 24h do WhatsApp (só restringe no canal oficial GHL/Meta). Usa o
    // MAIOR entre o inbound vindo do GHL e o last_inbound_at LOCAL — esse é
    // autoritativo e sobrevive a falha de leitura do GHL; senão um hiccup de API
    // (ou um inbound sem timestamp) fecharia a janela à toa e dispararia um
    // alerta "fora da janela" falso.
    const localInboundMs = fresh.last_inbound_at
      ? new Date(String(fresh.last_inbound_at).replace(' ', 'T') + 'Z').getTime() : 0;
    const effInboundMs = Math.max(lastInboundMs || 0, Number.isFinite(localInboundMs) ? localInboundMs : 0);
    const windowOpen = effInboundMs && (Date.now() - effInboundMs) < WHATSAPP_WINDOW_MS;
    if (preferredChannel() === 'ghl' && !windowOpen) {
      logger.info({ contactId: fresh.id, effInboundMs }, 'continuidade IA Tina: fora da janela 24h, avisando time');
      // Deixa a Tina pronta pra assumir quando o lead responder (reabre a janela).
      db.prepare(`UPDATE contacts SET ai_paused = 0, ai_paused_at = NULL,
          stage = CASE WHEN stage IS NULL OR stage IN ('novo','desqualificado','handoff','agendado') THEN 'pre_qualificando' ELSE stage END,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(fresh.id);
      await notifyIaTinaForaJanela(fresh).catch(() => {});
      return;
    }

    // Gera a retomada. extraContext instrui a retomar do ponto onde parou.
    const result = await generateTinaReply({
      contact: fresh,
      incomingText: CONTINUATION_TRIGGER,
      extraContext: CONTINUATION_CONTEXT,
    });
    if (result.llm_failed) {
      logger.warn({ contactId: fresh.id }, 'continuidade IA Tina: IA indisponível (LLM caiu), não envia');
      return { ok: false, reason: 'ia_indisponivel' };
    }
    const items = result.split && result.split.length ? result.split : [result.reply];
    const temTexto = items.some(i => (typeof i === 'string' ? i : i?.text || '').trim());
    if (!temTexto) {
      logger.warn({ contactId: fresh.id }, 'continuidade IA Tina: LLM não gerou texto, abortando');
      return;
    }

    const sent = await sendSequence(fresh, items);
    if (!sent) {
      // Nada saiu (falha de envio/canal — ex.: Meta rejeitou apesar do pré-check).
      // NÃO grava outbound fantasma, NÃO queima o cooldown e avisa o time pra dar
      // o toque manual (senão o card fica "atendido" e o lead, mudo).
      logger.warn({ contactId: fresh.id }, 'continuidade IA Tina: nenhuma mensagem enviada (falha de envio), avisando time');
      await notifyIaTinaForaJanela(fresh).catch(() => {});
      return;
    }
    for (const item of items) {
      const txt = typeof item === 'string' ? item : (item?.text || '');
      if (txt) recordOutbound(fresh.id, { author: 'ia', content: txt, usage: result.usage });
    }

    // Marca continuidade + libera a Tina + ajusta funil/stage/qualificação.
    db.prepare(`UPDATE contacts SET
        ia_tina_continuation_at = CURRENT_TIMESTAMP,
        ai_paused = 0, ai_paused_at = NULL,
        funnel = COALESCE(?, funnel),
        stage = COALESCE(?, CASE WHEN stage IS NULL OR stage IN ('novo','desqualificado','handoff','agendado') THEN 'pre_qualificando' ELSE stage END),
        qualification_score = ?,
        qualification_notes = COALESCE(?, qualification_notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(
        result.funnel || null,
        result.stage || null,
        result.qualification_score || fresh.qualification_score || 0,
        result.qualification_notes || null,
        fresh.id,
      );
    try { await applyTinaTags(fresh, result); } catch {}

    // Roteamento: se a Tina JÁ encaminhou/qualificou/desqualificou NESTE turno de
    // retomada (o lead tinha deixado um pedido pendente), respeita a ação — mesma
    // lógica do handleInbound. Senão ela "fala" o handoff mas nada acontece até o
    // lead responder. Sem book_slot aqui: a continuidade não injeta horários no
    // contexto, então um book_slot seria alucinação (não marca).
    try {
      const SCHED = schedulingEnabled();
      if (result.handoff_mode === 'agora') {
        const lh = await liveHandoff(fresh).catch(() => ({ ok: false }));
        await markQualifiedAndHandoff(fresh, result, { pause: true }).catch(() => {});
        db.prepare(`UPDATE contacts SET ai_paused = 1, ai_paused_at = CURRENT_TIMESTAMP, stage = 'em_atendimento', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(fresh.id);
        await notifyLiveHandoff(fresh, { consultant: lh?.consultant, funnel: result.funnel || fresh.funnel }).catch(() => {});
      } else if (result.handoff_mode === 'agendar' && SCHED) {
        db.prepare(`UPDATE contacts SET stage = 'agendando', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(fresh.id);
        db.prepare('UPDATE followups SET sent = 1 WHERE contact_id = ? AND sent = 0').run(fresh.id);
        await markQualifiedAndHandoff(fresh, result, { pause: false }).catch(() => {});
      } else if (result.handoff || result.stage === 'qualificado') {
        await markQualifiedAndHandoff(fresh, result, { pause: false }).catch(() => {});
      } else if (result.stage === 'desqualificado' || result.end_conversation) {
        await markDisqualified(fresh, result).catch(() => {});
      } else {
        // Ainda qualificando → PUXA pra coluna IA Tina (raia dela). No-op se já
        // estiver lá (caso do webhook); move o pendente do Funil Orgânico pra IA Tina.
        await claimToIaTina(fresh).catch(() => {});
      }
    } catch (err) {
      logger.error({ err: err.message, contactId: fresh.id }, 'continuidade IA Tina: falha no roteamento pós-retomada');
    }

    try {
      db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'ia_tina_continuation', ?)`)
        .run(fresh.id, JSON.stringify({ oppId, bubbles: items.length }));
    } catch {}
    logger.info({ contactId: fresh.id, oppId }, 'continuidade IA Tina enviada');
  });
}

async function handleInbound(event) {
  const ghlContactId = event.contactId || event.contact_id;
  if (!ghlContactId) return;

  // 1) Hydrata contato do GHL (pega nome, phone, email, TAGS)
  let ghlContact;
  try {
    ghlContact = await GHL.getContact(ghlContactId);
  } catch (err) {
    logger.error({ err: err.message, ghlContactId }, 'não consegui buscar contato no GHL');
    ghlContact = { id: ghlContactId };
  }

  const tags = extractTags(ghlContact);

  // 1.2) RASTREAMENTO DE ANÚNCIO (Click-to-WhatsApp → UTM): copia a atribuição que a
  // GHL já captura (adId, nome do anúncio, URL, ctwaClid; +campanha/conjunto se
  // META_ADS_TOKEN) pros campos UTM. Roda ANTES das travas de tag — pra TODO lead de
  // anúncio, mesmo os que a Tina NÃO responde (whitelist/bloqueio/pausa retornam abaixo).
  // Idempotente (skipIfFilled: pula se o campo já está preenchido, sem tocar no banco),
  // fire-and-forget e fail-open: nunca bloqueia nem quebra a Tina.
  if (attributionEnabled()) {
    enrichContactAttribution(ghlContactId, { contact: ghlContact, skipIfFilled: true })
      .then(r => {
        // CORRIDA: em alguns leads o GHL grava o attributionSource DEPOIS do webhook
        // do 1º inbound — e lead de anúncio que manda só 1 mensagem nunca gera outro
        // inbound pra corrigir. Retry único em 2 min com contato fresco resolve.
        if (r?.skipped === 'sem-atribuicao-de-anuncio') {
          setTimeout(() => {
            enrichContactAttribution(ghlContactId, { skipIfFilled: true }).catch(() => {});
          }, 120_000);
        }
      })
      .catch(() => {});
  }

  // 1.4) WHITELIST: durante teste/staging, Tina só atende quem TEM a tag tina-liberada.
  // Sem essa verificação, qualquer lead importado no GHL recebe resposta automática.
  if (REQUIRED_TAG_ENABLED && !ATTEND_EXCEPT_REENTRADA && !tags.includes(REQUIRED_TAG)) {
    logger.info({ ghlContactId, required: REQUIRED_TAG }, 'contato sem tag de liberação, Tina não responde');
    return;
  }

  // 1.45) BLOQUEIO POR ORIGEM: Tina não atende leads de origem bloqueada
  // (ex: formulário do site). Só Meta + WhatsApp. Lilian, jun/2026.
  if (BLOCK_TAGS.length) {
    const hit = BLOCK_TAGS.find(t => tags.includes(t));
    if (hit) {
      logger.info({ ghlContactId, blockedBy: hit }, 'lead de origem bloqueada (ex: form do site), Tina não responde');
      return;
    }
  }

  // 1.5) Checa tag de pausa manual (Plano A) — time aplicou tag pra assumir
  if (tags.includes(PAUSE_TAG)) {
    logger.info({ ghlContactId, tag: PAUSE_TAG }, 'tag de pausa presente, Tina não responde');
    return;
  }

  const contact = upsertContactFromGHL(ghlContact);

  // 1.5a) OUTRO TIME — DEFAULT ON (sempre, independente do modo/whitelist): a Tina
  // NUNCA assume lead que outro time está trabalhando — opp ABERTA em Reentrada OU
  // num pipeline diferente do dela (Closers/Editorial/Pré-Vendas 2.0...). Foi o
  // caso reportado: ela atendeu e marcou reunião pra lead de reentrada, atropelando
  // o consultor. Lead de anúncio (só opp no Funil Orgânico dela) passa normal.
  if (SKIP_REENTRADA_OPP && await contactWorkedByOtherTeam(contact)) {
    logger.info({ ghlContactId, contactId: contact.id }, 'lead de outro time/Reentrada, Tina não assume');
    try {
      db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'skip_reentrada', ?)`)
        .run(contact.id, JSON.stringify({ ghlContactId }));
    } catch {}
    return;
  }

  // 1.55) FILTRO LEAD NOVO vs. EM ATENDIMENTO (Gabriel não consegue filtrar
  // reentrada no GHL). Só no PRIMEIRO contato da Tina (ela nunca respondeu este
  // lead): se a conversa do GHL já tem saída de um humano, o lead JÁ estava em
  // atendimento → a Tina não assume. Não atrapalha conversas que ela já toca.
  if (SKIP_IN_ATTENDANCE && !ATTEND_EXCEPT_REENTRADA && !contact.last_outbound_at) {
    if (await conversationAlreadyInAttendance(ghlContactId)) {
      // EXCEÇÃO: a Tina assume IMEDIATO se o lead está na raia dela — coluna IA Tina
      // (autorização explícita do time) OU, com TINA_OWNS_ENTRY_LANE, EXCLUSIVAMENTE no
      // Funil Orgânico/IA Tina — MAS, em qualquer dos casos, só se NENHUM SDR estiver
      // atendendo AGORA: se um consultor mandou msg nos últimos SDR_ACTIVE_MINUTES, a
      // Tina CEDE o turno (não sobrescreve consultor ativo). O 1º toque antigo (fora
      // dessa janela curta) não impede a Tina de assumir.
      if ((await contactInIaTinaLane(contact)
           || (OWNS_ENTRY_LANE && await contactExclusivelyInTinaLane(contact)))
          && !(await conversationAlreadyInAttendance(ghlContactId, SDR_ACTIVE_MS))) {
        logger.info({ ghlContactId, contactId: contact.id }, 'lead na raia da Tina (IA Tina/Funil Orgânico) — Tina assume imediato');
        try {
          db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'ia_tina_assume_em_atendimento', ?)`)
            .run(contact.id, JSON.stringify({ ghlContactId }));
        } catch {}
        // NÃO retorna — segue pro fluxo normal de resposta/qualificação.
      } else {
        logger.info({ ghlContactId, contactId: contact.id }, 'lead já estava em atendimento humano (conversa pré-existente), Tina não assume');
        // Log auditável: pra você acompanhar quantas vezes o filtro atuou e
        // checar se não está bloqueando lead que devia atender (resumo-dia).
        try {
          db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'skip_em_atendimento', ?)`)
            .run(contact.id, JSON.stringify({ ghlContactId }));
        } catch {}
        handleSDRReply(contact.id, null);
        return;
      }
    }
  }

  // 1.56) GATE POR COLUNA — DESLIGADO por padrão (LANE_GATE_ENABLED=true p/ ligar).
  // A varredura (jun/2026) mostrou que a COLUNA da opp é um sinal RUIM: leads de
  // anúncio/form VOLTAM com opp velha em Follow Up/Closers, então bloquear por
  // coluna barraria os próprios leads de anúncio que a Tina precisa atender. A
  // proteção de colisão correta é por MENSAGEM (consultor respondeu recente — ver
  // lastOutboundWasHuman / AUTO_HUMAN_DETECTION abaixo).
  if (process.env.LANE_GATE_ENABLED === 'true' && !contact.ai_paused) {
    const oppHit = await contactOppOutsideTinaLane(contact);
    if (oppHit) {
      logger.info({ ghlContactId, contactId: contact.id, stage: oppHit.pipelineStageId }, 'lead fora da raia da Tina (opp em funil do time), Tina não assume');
      try {
        db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'skip_fora_raia', ?)`)
          .run(contact.id, JSON.stringify({ stage: oppHit.pipelineStageId }));
      } catch {}
      return;
    }
  }

  // NOTA: NÃO bloquear por assignedTo. O GHL auto-atribui o lead a um consultor
  // já na ENTRADA (round-robin), então assignedTo vem preenchido em todo lead
  // novo — bloquear por isso faria a Tina não responder NINGUÉM. A detecção de
  // humano real é feita por lastOutboundWasHuman (checa se alguém de fato
  // RESPONDEU) e/ou pelo webhook de OutboundMessage (handleOutbound).

  // 1.6) DETECÇÃO AUTOMÁTICA (Plano B) — verifica se humano respondeu pelo GHL
  // antes da Tina. Default OFF (env AUTO_HUMAN_DETECTION_ENABLED=true pra ligar).
  // Tem sanity checks contra falso positivo do PIT — ver lastOutboundWasHuman.
  if (await lastOutboundWasHuman(ghlContactId, contact)) {
    logger.info({ ghlContactId, contactId: contact.id }, 'humano respondeu pelo GHL, pausando Tina automaticamente');
    handleSDRReply(contact.id, null);
    return; // recordInbound será feito pelo handler comum no próximo ciclo
  }

  // 2) Classifica tipo de mensagem (texto, áudio, imagem, PDF)
  //    GHL envia em `messageType` (WhatsApp/SMS/Email/FB/IG/GMB) e conteúdo em `body` + `attachments`.
  const msgType = (event.messageType || '').toLowerCase();
  let rawBody = event.body ?? event.message ?? '';
  let attachments = event.attachments || [];

  // O GHL às vezes manda o conteúdo como OBJETO (áudio/anexo estruturado), não
  // como string nem no array `attachments`. Loga a estrutura real (pra mapear)
  // e tenta extrair a URL/mídia de dentro dele.
  if (rawBody && typeof rawBody === 'object') {
    logger.info({ ghlContactId, bodyObj: rawBody, keys: Object.keys(rawBody) }, 'body veio como OBJETO (provável áudio/anexo) — inspecionando');
    const cand = rawBody.attachments || rawBody.media || rawBody.url || rawBody.audio
      || rawBody.file || rawBody.attachmentUrl || rawBody.fileUrl || rawBody.link;
    if (Array.isArray(cand)) attachments = attachments.concat(cand);
    else if (cand) attachments = attachments.concat([cand]);
    rawBody = typeof rawBody.text === 'string' ? rawBody.text
      : typeof rawBody.body === 'string' ? rawBody.body
      : typeof rawBody.caption === 'string' ? rawBody.caption : '';
  }
  const body = typeof rawBody === 'string' ? rawBody : String(rawBody || '');

  let content = body;
  let content_type = 'text';
  let attachment_url = null;

  // Detecta attachments por URL (GHL manda array de strings URL ou objetos)
  const attachList = attachments.map(a => typeof a === 'string' ? { url: a } : a);
  // tipo declarado pelo GHL no objeto do anexo (varia: type/mimeType/contentType)
  const attType = a => String(a.type || a.mimeType || a.contentType || a.format || '').toLowerCase();
  const byExt = re => attachList.find(a => re.test(a.url || ''));
  const byType = re => attachList.find(a => re.test(attType(a)));

  // 1ª passada: classifica por extensão/type declarado pelo GHL
  let pdfAtt = byExt(/\.(pdf|docx?|odt)(\?|$)/i) || byType(/pdf|msword|officedocument|document/);
  let imageAtt = byExt(/\.(jpe?g|png|gif|webp|bmp)(\?|$)/i) || byType(/image/);
  let audioAtt = byExt(/\.(ogg|opus|mp3|m4a|wav|amr|aac|mpeg)(\?|$)/i) || byType(/audio|voice|ptt/);

  let kind = pdfAtt ? 'pdf' : imageAtt ? 'image' : audioAtt ? 'audio' : null;
  const primaryUrl = (pdfAtt || imageAtt || audioAtt || attachList[0])?.url || null;

  // 2ª passada: o GHL frequentemente serve a mídia SEM extensão e SEM type
  // (ex.: nota de voz e imagem do WhatsApp). Aí baixa e identifica pelos
  // MAGIC BYTES (assinatura do arquivo). Acaba com a confusão imagem↔áudio.
  let attBuf = null, attMime = null;
  if (attachList.length && !kind && primaryUrl) {
    try {
      attBuf = await downloadAttachment(primaryUrl);
      const s = sniffAttachment(attBuf);
      kind = s.kind; attMime = s.mime;
      logger.info({ ghlContactId, kind, mime: attMime, len: attBuf?.length }, 'anexo ambíguo — tipo por magic bytes');
    } catch (err) {
      logger.error({ err: err.message, ghlContactId }, 'falha ao baixar anexo pra sniff');
    }
  }

  // PDF → bloquear (não analisar via IA, delegar à leitura crítica)
  if (kind === 'pdf') {
    attachment_url = primaryUrl;
    recordInbound(contact.id, {
      content: `[lead enviou arquivo: ${primaryUrl}]`,
      content_type: 'pdf_blocked',
      ghl_message_id: event.messageId || event.id,
      attachment_url,
    });
    const txt = 'Opa, análise de arquivo a gente faz na etapa de leitura crítica com a equipe. Me conta em texto: o livro já está finalizado ou ainda está em processo?';
    await sendText(contact, txt).catch(err => logger.error({ err: err.message }, 'send fail'));
    recordOutbound(contact.id, { author: 'ia', content: txt });
    return;
  }

  // Áudio → baixa (com auth GHL) e transcreve (Whisper)
  if (kind === 'audio') {
    attachment_url = primaryUrl;
    logger.info({ ghlContactId, attCount: attachList.length }, 'mensagem detectada como ÁUDIO, transcrevendo');
    try {
      const buf = attBuf || (primaryUrl ? await downloadAttachment(primaryUrl) : null);
      const transcript = buf ? await transcribeAudioBuffer(buf) : null;
      // ⚠️ Quando NÃO dá pra ouvir, o marcador tem que INSTRUIR a Tina a avisar o
      // lead (pedido da LC 25/09: "se a Tina não pode ouvir áudio, é importante
      // avisar o lead para não enviar"). Antes vinha só "[falha na transcrição]" e
      // ela respondia como se nada tivesse chegado — o lead mandava áudio de novo.
      content = transcript
        ? `[áudio transcrito] ${transcript}`
        : '[o lead mandou um ÁUDIO e você NÃO conseguiu ouvir. Peça desculpas com naturalidade, explique que por aqui você não consegue ouvir áudios e peça pra ele escrever o mesmo por texto. NÃO ignore o áudio nem finja que entendeu.]';
    } catch (err) {
      logger.error({ err: err.message }, 'falha baixando/transcrevendo áudio');
      content = '[o lead mandou um ÁUDIO e você NÃO conseguiu ouvir. Peça desculpas com naturalidade, explique que por aqui você não consegue ouvir áudios e peça pra ele escrever o mesmo por texto. NÃO ignore o áudio nem finja que entendeu.]';
    }
    content_type = 'audio_transcript';
  }

  // Imagem → descreve com a visão do Gemini (a Tina "lê" capa de livro, print, etc.)
  if (kind === 'image') {
    attachment_url = primaryUrl;
    logger.info({ ghlContactId, attCount: attachList.length }, 'mensagem detectada como IMAGEM, descrevendo (visão)');
    try {
      const buf = attBuf || (primaryUrl ? await downloadAttachment(primaryUrl) : null);
      const mime = attMime || (buf ? sniffAttachment(buf).mime : null) || 'image/jpeg';
      const desc = buf ? await describeImageBuffer(buf, mime) : null;
      const legenda = body.trim() ? ` Legenda do lead: "${body.trim()}"` : '';
      content = desc ? `[imagem] ${desc}${legenda}` : (body || '[lead enviou uma imagem]');
    } catch (err) {
      logger.error({ err: err.message }, 'falha ao descrever imagem');
      content = body || '[lead enviou uma imagem]';
    }
    content_type = 'image';
  }

  recordInbound(contact.id, {
    content,
    content_type,
    ghl_message_id: event.messageId || event.id,
    attachment_url,
  });

  // === Lock por contato ===
  // Serializa LLM call + send + update por contactId. Sem isso, 2 mensagens
  // do mesmo lead em < 1s rodam 2 chamadas LLM paralelas que leem o mesmo
  // histórico e respondem coisas conflitantes (resposta duplicada).
  await withContactLock(contact.id, async () => {
    // Re-lê dentro do lock — estado pode ter mudado enquanto esperava
    const fresh = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
    if (!fresh) return;

    // 3) Se IA está pausada (SDR assumiu), só registra — A MENOS que a Tina possa
    // REASSUMIR (consultor sumiu > janela e lead ainda na raia dela). Nesse caso
    // despausa e segue pro fluxo normal pra responder ESTE inbound do lead.
    if (fresh.ai_paused) {
      if (await maybeReclaimLead(fresh, ghlContactId)) {
        Object.assign(fresh, db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id));
      } else {
        logger.info({ contactId: contact.id }, 'IA pausada, registrando sem responder');
        scheduleFollowup(contact.id, 'silencio_sdr');
        return;
      }
    }

    // 4) Proteção de custo
    if (countMessagesToday(contact.id) > MAX_MSGS_DAY) {
      logger.warn({ contactId: contact.id }, 'limite diário atingido, pausando IA');
      pauseIA(contact.id, 'limite_mensagens_dia');
      return;
    }

    // 5) AGENDAMENTO, fase 2: se o lead está em modo "agendando", puxa os
    // horários livres mais próximos do calendário do GHL e injeta no contexto
    // pra Tina oferecer. Mais cedo possível, pra não esfriar o lead.
    let extraContext = null;
    // ⚠️ TURNO CEGO (causa raiz dos casos Juliete 20/08 e Silvia 23/08): o stage só
    // vira 'agendando' NO FIM deste handler (linha ~1193), depois da resposta já ter
    // saído. Ou seja, no turno em que o lead PEDE pra agendar ("prefiro agendar,
    // amanhã 11h30 pode ser?") a Tina ainda respondia SEM lista de horários — e sem
    // lista não existe nem a regra que a proíbe de inventar. Resultado: ela aceitava
    // o horário que o lead propôs, dizia "confirmei", não preenchia book_slot, e nada
    // era criado na agenda nem avisado no grupo. Por isso 'qualificado' entra aqui:
    // é o stage em que o lead está quando responde "quero agendar".
    if (schedulingEnabled() && ['agendando', 'qualificado'].includes(fresh.stage)) {
      // leque de horários (manhã/tarde, próximos dias) pra atender pedidos
      // específicos do lead sem inventar. A Tina oferece os mais cedo por padrão.
      // Leitura crítica e curso NÃO vão pros closers — só Gabriel e Bruna (LC 25/09).
      // Usa o serviço já identificado no contato (ou o da última nota de qualificação).
      const apenasCalendarios = calendariosParaServico(fresh.service_recommended || fresh.funnel_service || null);
      if (apenasCalendarios) logger.info({ contactId: fresh.id }, 'serviço de leitura crítica/curso — agenda restrita a Gabriel e Bruna');
      const slots = await getNextSlots(8, { spread: true, apenasCalendarios });
      if (slots.length) {
        extraContext = slotsContextBlock(slots);
        recordOffer(fresh.id, slots);  // guarda qual closer tem cada horário
      } else {
        // Sem horário disponível: AVISA a Tina explicitamente. Antes ficava só o
        // logger.warn e ela era chamada SEM lista nenhuma — e, proibida pelo prompt
        // de dizer que a agenda não abriu, INVENTAVA horário e dizia "agendei"
        // (caso Juliete 20/08). Agora recebe ordem de não prometer e fazer handoff.
        extraContext = NO_SLOTS_CONTEXT;
        logger.warn({ contactId: fresh.id }, 'agendando mas sem free-slots — Tina orientada a NAO prometer horario');
      }
    }

    // 6) Gera resposta da Tina
    const result = await generateTinaReply({ contact: fresh, incomingText: content, extraContext });

    // IA INDISPONÍVEL (LLM sem crédito/caiu): NÃO manda o fallback genérico e NÃO
    // faz handoff — senão o lead recebe "deixa eu te conectar..." e uma automação
    // do GHL empurra pra Reentrada. Só registra e reagenda; quando a IA voltar, a
    // Tina retoma no próximo contato/follow-up.
    if (result.llm_failed) {
      logger.error({ contactId: fresh.id, reason: result.handoff_reason }, 'IA indisponível (LLM caiu) — não responde nem move o lead');
      try {
        db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'ia_indisponivel', ?)`)
          .run(fresh.id, JSON.stringify({ reason: result.handoff_reason || null }));
      } catch {}
      scheduleFollowup(fresh.id, 'retomar_script');
      return;
    }

    // 6.9) E-MAIL DO LEAD (regra LC 16/07: sempre pedir e-mail antes de agendar).
    // A Tina extrai em result.lead_email; aqui salva no GHL + local. Fail-open.
    if (result.lead_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(result.lead_email).trim())) {
      const mail = String(result.lead_email).trim().toLowerCase();
      if (mail !== (fresh.email || '').toLowerCase()) {
        GHL.updateContact(ghlContactId, { email: mail }).catch(err =>
          logger.warn({ err: err.message, contactId: fresh.id }, 'falha salvando lead_email no GHL'));
        try { db.prepare('UPDATE contacts SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mail, fresh.id); } catch {}
        logger.info({ contactId: fresh.id }, 'e-mail do lead capturado pela Tina e salvo');
      }
    }

    // 7) AGENDAMENTO, fase 3: o lead confirmou um horário → marca no GHL.
    let booked = null;
    if (schedulingEnabled() && result.book_slot) {
      // ANTI DOUBLE-BOOKING: se o lead JÁ tem reunião futura (um consultor
      // marcou manualmente, ou a própria Tina já marcou antes), NÃO cria outra.
      const existing = await upcomingAppointment(fresh);
      if (existing) {
        logger.warn({ contactId: fresh.id, existingStart: existing.startTime, existingId: existing.id }, 'lead já tem reunião futura — evitando double-booking');
        booked = { ok: false, alreadyBooked: true, existing };
      } else {
        booked = await bookSlot(fresh, result.book_slot);
        if (!booked.ok) {
          logger.error({ contactId: fresh.id, err: booked.error }, 'book_slot falhou, mantém agendando');
        }
      }
    }

    // 7.5) BÔNUS: lead deu o título do livro → busca o link e anexa a
    // confirmação (a Tina nunca inventa link, quem busca é o sistema).
    let items;
    if (booked && booked.alreadyBooked) {
      // Evitamos double-booking: a resposta do LLM provavelmente "confirmou" o
      // agendamento — substitui por um aviso de que o lead já tem horário.
      const primeiro = (fresh.name || '').trim().split(/\s+/)[0];
      items = [`Perfeito${primeiro ? ', ' + primeiro : ''}! Vi aqui que você já tem um horário reservado com a nossa equipe ✅ Em breve o especialista confirma os detalhes com você. Qualquer coisa até lá, é só me chamar!`];
    } else {
      items = result.split && result.split.length ? result.split : [result.reply];
      if (bookSearchEnabled() && result.search_book) {
        const found = await searchBookLink(result.search_book);
        if (found && found.link) {
          items.push(`Consultei aqui pelo título e encontrei esse: ${found.link} 😊 Confere se é esse mesmo o seu livro?`);
          db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'book_found', ?)`)
            .run(fresh.id, JSON.stringify({ query: result.search_book, link: found.link }));
        } else {
          items.push('Não consegui localizar pelo título aqui. Você pode me mandar o link de vendas do seu livro?');
        }
      }
    }

    // 7.5) TRAVA DE DATA: o texto da Tina TEM que bater com o dia que foi marcado.
    // O prompt sozinho não segura — ❌ CASO REAL (01/09): a lista dizia "quarta-feira,
    // 09/09 às 10:30" e ela escreveu "amanhã, quarta-feira, às 10h30"; o lead esperou
    // no dia seguinte e a reunião estava 8 dias depois. O código já tem a data certa
    // (booked.label) na mão, só não usava. Se a reunião NÃO é hoje/amanhã e o texto
    // diz "hoje"/"amanhã", troca a última bolha por uma confirmação com a data real.
    // ⚠️ o padrão NÃO pode terminar em \b: em JS o "ã" não é caractere de palavra, então
    // /amanhã\b/ NUNCA casa com "amanhã as 10h". Usa lookahead de letra, e aceita a
    // forma sem acento ("amanha"), que o modelo escreve na prática.
    const REL = /(?:^|[^a-zA-ZÀ-ÿ])(hoje|amanh[ãa])(?![a-zA-ZÀ-ÿ])/i;
    if (booked?.ok && booked.label && !/^(hoje|amanh[ãa])(?![a-zA-ZÀ-ÿ])/i.test(booked.label)) {
      const idx = items.map(x => (typeof x === 'string' ? x : x?.text || '')).findLastIndex(t => REL.test(t));
      if (idx >= 0) {
        const primeiro = (fresh.name || '').trim().split(/\s+/)[0];
        const certo = `Fechado${primeiro ? ', ' + primeiro : ''}! Agendei para **${booked.label}** e já reservei esse horário só pra você. Você vai receber a confirmação no seu e-mail. Até lá! 😊`;
        logger.warn({ contactId: fresh.id, label: booked.label, textoErrado: String(items[idx]).slice(0, 120) }, 'Tina falou hoje/amanhã mas a reunião é outro dia — texto corrigido pelo sistema');
        items[idx] = certo;
        try {
          db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'data_corrigida', ?)`)
            .run(fresh.id, JSON.stringify({ label: booked.label }));
        } catch {}
      }
    }

    // 8) Envia resposta(s)
    // ⚠️ TURNO MUDO: estas duas guardas existiam SÓ no caminho de continuidade
    // (linhas ~653-667). No fluxo principal o retorno do sendSequence era ignorado,
    // então uma bolha vazia — ou um envio que falhou — deixava o lead em silêncio
    // absoluto E gravava outbound fantasma (o sistema achava que tinha respondido).
    // ❌ CASO REAL (02/09): a Tina simplesmente não respondeu o lead que perguntava
    // de novo sobre a reunião, e nada alertou o time.
    const temTexto = items.some(i => (typeof i === 'string' ? i : i?.text || '').trim());
    if (!temTexto) {
      logger.warn({ contactId: fresh.id }, 'TURNO MUDO: LLM não gerou texto — nada a enviar, avisando time');
      try { db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'turno_mudo', ?)`).run(fresh.id, JSON.stringify({ motivo: 'sem_texto' })); } catch {}
      await notifyIaTinaForaJanela(fresh).catch(() => {});
      return;
    }
    const sent = await sendSequence(fresh, items);
    if (!sent) {
      // Nada saiu de verdade (falha de canal). NÃO grava outbound fantasma: senão o
      // card fica "atendido" e o lead, mudo — e o follow-up nem dispara direito.
      logger.warn({ contactId: fresh.id }, 'TURNO MUDO: nenhuma mensagem enviada (falha de envio), avisando time');
      try { db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'turno_mudo', ?)`).run(fresh.id, JSON.stringify({ motivo: 'falha_envio' })); } catch {}
      await notifyIaTinaForaJanela(fresh).catch(() => {});
      return;
    }
    for (const item of items) {
      const txt = typeof item === 'string' ? item : (item?.text || '');
      if (txt) recordOutbound(fresh.id, { author: 'ia', content: txt, usage: result.usage });
    }

    // 9) Atualiza estado do contato
    // service_recommended é gravado pra durar entre os turnos: os horários são
    // buscados ANTES da resposta do LLM, então o roteamento de agenda (leitura
    // crítica/curso só com Gabriel e Bruna) precisa do serviço do turno anterior.
    if (result.funnel || result.stage || result.service_recommended) {
      db.prepare(`
        UPDATE contacts
        SET funnel = COALESCE(?, funnel),
            stage = COALESCE(?, stage),
            qualification_score = ?,
            qualification_notes = COALESCE(?, qualification_notes),
            service_recommended = COALESCE(?, service_recommended),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        result.funnel || null,
        result.stage || null,
        result.qualification_score || fresh.qualification_score || 0,
        result.qualification_notes || null,
        result.service_recommended || null,
        fresh.id
      );
    }

    // 10) Etiquetas tina-* no GHL (interesse, agenda, dúvida-curso, temperatura)
    await applyTinaTags(fresh, result);

    // 11) Roteamento final
    const SCHED = schedulingEnabled();

    if (booked && booked.alreadyBooked) {
      // Lead JÁ tinha reunião futura (consultor marcou, ou a Tina já marcou).
      // Não duplica: pausa, marca como agendado, registra. NÃO notifica de novo.
      db.prepare(`
        UPDATE contacts SET ai_paused = 1, ai_paused_at = CURRENT_TIMESTAMP,
          stage = 'agendado', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(fresh.id);
      db.prepare('UPDATE followups SET sent = 1 WHERE contact_id = ? AND sent = 0').run(fresh.id);
      db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'double_booking_evitado', ?)`)
        .run(fresh.id, JSON.stringify({ existingStart: booked.existing?.startTime || null, existingId: booked.existing?.id || null }));

    } else if (booked && booked.ok) {
      // Reunião marcada: pausa IA, notifica o time, encerra a parte da Tina.
      db.prepare(`
        UPDATE contacts SET ai_paused = 1, ai_paused_at = CURRENT_TIMESTAMP,
          stage = 'agendado', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(fresh.id);
      db.prepare('UPDATE followups SET sent = 1 WHERE contact_id = ? AND sent = 0').run(fresh.id);
      // Fecha o card do Pré-Vendas (SDR) pra não ficar aberto e virar duplicado
      // (a automação de reentrada do GHL pegava o card aberto). Fire-and-forget.
      closeSdrOppOnBooking(fresh).catch(() => {});
      await notifyAgendamento(fresh, { label: booked.label, iso: result.book_slot, funnel: result.funnel || fresh.funnel, calendarId: booked.calendarId });

    } else if (result.course_help === 'aluno' && result.end_conversation) {
      // CASO ESPECIAL: aluno com dúvida de curso NÃO é "desqualificado".
      db.prepare(`
        UPDATE contacts SET ai_paused = 1, ai_paused_at = CURRENT_TIMESTAMP,
          stage = 'handoff', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(fresh.id);
      db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'handoff_aluno', ?)`)
        .run(fresh.id, JSON.stringify({ to: 'cursos@lcagencia.com.br' }));

    } else if (result.funnel === 'publicar' && result.end_conversation && (result.handoff || result.stage === 'qualificado') && !result.handoff_mode && !result.book_slot) {
      // PUBLICAÇÃO: orçamento vai pro e-mail editorial@, não pro agendamento.
      // Encerra a parte da Tina (handoff por e-mail), pausa pra não ficar dialogando.
      //
      // ⚠️ EXIGE end_conversation (regra LC 04/09). Sem ele, esta branch capturava o
      // turno em que a Tina ACABOU de perguntar "falar agora ou agendar?" — porque
      // nesse turno handoff_mode é null POR DEFINIÇÃO (o lead ainda não respondeu) e
      // o prompt manda marcar handoff:true junto com a pergunta. Ela se auto-pausava
      // no meio da própria pergunta e nunca mais respondia; o reclaim também não
      // salvava, porque o card já tinha sido movido pra fora da raia dela.
      // ❌ CASO REAL (Ailton, 20/08): perguntou "prefere falar agora ou agendar?",
      // se desligou, e as duas respostas do lead morreram sem resposta.
      // Sem end_conversation, cai na branch de "qualificou mas não escolheu ainda",
      // que mantém a IA ATIVA pra receber a escolha no próximo turno.
      db.prepare(`
        UPDATE contacts SET ai_paused = 1, ai_paused_at = CURRENT_TIMESTAMP,
          stage = 'handoff', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(fresh.id);
      db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'handoff_publicar', ?)`)
        .run(fresh.id, JSON.stringify({ to: 'editorial@lcagencia.com.br' }));
      await markQualifiedAndHandoff(fresh, result, { pause: true }).catch(() => {});

    } else if (result.handoff_mode === 'agora') {
      // FALAR AGORA: passa pro próximo consultor da fila, avisa o time e pausa
      // a Tina (humano assume a conversa na hora).
      const lh = await liveHandoff(fresh).catch(err => {
        logger.error({ err: err.message }, 'liveHandoff falhou'); return { ok: false };
      });
      await markQualifiedAndHandoff(fresh, result, { pause: true }).catch(() => {});
      db.prepare(`
        UPDATE contacts SET ai_paused = 1, ai_paused_at = CURRENT_TIMESTAMP,
          stage = 'em_atendimento', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(fresh.id);
      await notifyLiveHandoff(fresh, { consultant: lh?.consultant, funnel: result.funnel || fresh.funnel });

    } else if (result.handoff_mode === 'agendar' && SCHED) {
      // AGENDAR: entra em "agendando", MANTÉM a IA ativa pra puxar horários e marcar.
      db.prepare(`UPDATE contacts SET stage = 'agendando', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(fresh.id);
      db.prepare('UPDATE followups SET sent = 1 WHERE contact_id = ? AND sent = 0').run(fresh.id);
      await markQualifiedAndHandoff(fresh, result, { pause: false }).catch(err =>
        logger.error({ err: err.message }, 'markQualifiedAndHandoff (agendando) falhou'));

    } else if (result.handoff || result.stage === 'qualificado') {
      // Lead qualificou mas ainda NÃO escolheu agora/agendar (Tina acabou de
      // perguntar "falar agora ou agendar?"). Grava a qualificação e mantém a
      // IA ATIVA pra receber a escolha no próximo turno.
      await markQualifiedAndHandoff(fresh, result, { pause: false }).catch(err =>
        logger.error({ err: err.message }, 'markQualifiedAndHandoff (escolha) falhou'));

    } else if (result.stage === 'desqualificado' || result.end_conversation) {
      await markDisqualified(fresh, result);

    } else {
      // Tina atendendo → PUXA o lead pra coluna "IA Tina" (raia dela), pro time ver
      // quem ela está tocando. Com TINA_OWNS_ENTRY_LANE ou detecção de humano LIGADA
      // (ou modo atende-menos-Reentrada), MOVE a opp existente (claimToIaTina) já no
      // 1º contato, sem esperar classificar o funil — é o "puxar pra IA Tina" que o
      // time pediu. Sem esses modos, só CRIA pra lead novo com funil (moveLeadToIaTina)
      // pra não roubar lead do time. O guard de Reentrada/outro-pipeline/opp-fechada
      // dentro do claimToIaTina protege (nunca puxa lead que o time está tocando).
      if (ATTEND_EXCEPT_REENTRADA || OWNS_ENTRY_LANE || result.funnel || fresh.funnel) {
        if (ATTEND_EXCEPT_REENTRADA || OWNS_ENTRY_LANE || AUTO_HUMAN_DETECTION) await claimToIaTina(fresh).catch(() => {});
        else await moveLeadToIaTina(fresh).catch(() => {});
        // Tagueia o lead como "da Tina" (tina-liberada) ao assumir — marcador pra
        // ele ser reconhecido como dela nas próximas mensagens. Idempotente: só a
        // 1ª vez (nas próximas, `tags` já inclui a tag e pula).
        if ((ATTEND_EXCEPT_REENTRADA || OWNS_ENTRY_LANE) && REQUIRED_TAG_ENABLED && !tags.includes(REQUIRED_TAG)) {
          await GHL.addTag(ghlContactId, REQUIRED_TAG).catch(() => {});
        }
      }
      scheduleFollowup(fresh.id, 'silencio_lead');
    }
  });
}

function mapMessageType(incoming) {
  // GHL exige o mesmo canal da conversa. Mapa seguro.
  const t = (incoming || '').toLowerCase();
  if (t.includes('whats')) return 'WhatsApp';
  if (t.includes('sms'))   return 'SMS';
  if (t.includes('email')) return 'Email';
  if (t === 'fb' || t.includes('facebook')) return 'FB';
  if (t === 'ig' || t.includes('instagram')) return 'IG';
  return 'WhatsApp';  // default pra LC (canal principal)
}

async function handleOutbound(event) {
  const ghlContactId = event.contactId || event.contact_id;
  if (!ghlContactId) return;

  const contact = db.prepare('SELECT * FROM contacts WHERE ghl_contact_id = ?').get(ghlContactId);
  if (!contact) return;

  // Se veio com userId, foi humano do GHL (UI ou mobile) quem respondeu.
  // Quando a gente envia via API com PIT, o GHL NÃO preenche userId → não entra aqui.
  const humanUserId = event.userId || event.user_id;
  if (humanUserId) {
    // Tenta linkar com SDR local (se já conhecemos o ghl_user_id)
    const sdr = db.prepare('SELECT id FROM sdr_users WHERE ghl_user_id = ?').get(humanUserId);
    handleSDRReply(contact.id, sdr?.id || null);
    recordOutbound(contact.id, {
      author: 'sdr',
      content: event.body || event.message || '',
      sdr_id: sdr?.id || null,
    });
    logger.info({ contactId: contact.id, humanUserId }, 'SDR humano assumiu via GHL — IA pausada');
  }
}

export default router;
