// Notificação de agendamento pro time (grupo/contato no GHL).
//
// O próprio GHL já dispara notificação nativa ao criar o appointment, mas a
// LC pediu um aviso no grupo. Env-gated e não-bloqueante: se AGENDA_NOTIFY_
// CONTACT_ID não estiver setado, só registra no events_log.

import { db } from '../db/index.js';
import { GHL } from '../ghl/client.js';
import { UAZAPI } from '../uazapi/client.js';
import { calendarName, slotModality, expediente } from './scheduling.js';
import { logger } from '../utils/logger.js';

// Rótulo do aviso conforme a MODALIDADE do calendário em que caiu (a roleta mistura
// pré-atendimento por telefone com reunião de closer). Sem calendarId — caso do
// "quer falar agora", que não tem horário marcado — cai no modo global antigo.
const agendaLabel = (calendarId) => {
  const m = slotModality(calendarId);
  return { titulo: m.avisoTitulo, quem: m.avisoQuem };
};

// Funil em rótulo amigável pro time.
function funnelLabel(f) {
  return {
    escrever: 'Escrita / desenvolvimento do livro',
    publicar: 'Publicação',
    divulgar: 'Divulgação / Assessoria de Imprensa',
  }[f] || (f || '—');
}

// Resumo rápido pro consultor se situar antes de assumir a conversa.
function resumoLead(contact, funnel) {
  const linhas = [`🎯 Interesse: ${funnelLabel(funnel || contact.funnel)}`];
  const notas = (contact.qualification_notes || '').trim();
  if (notas) linhas.push(`📋 Contexto: ${notas}`);
  return linhas.join('\n');
}

// Grupo interno do time no WhatsApp (JID uazapi, ex.: "1203...@g.us"). O
// WhatsApp oficial (Meta) é 1:1 e NÃO posta em grupo; o número uazapi participa
// do grupo e manda os avisos. Setar UAZAPI_NOTIFY_GROUP no .env pra ativar.
const NOTIFY_GROUP = process.env.UAZAPI_NOTIFY_GROUP || '';

// Manda o aviso pro grupo do time via uazapi (não-bloqueante).
async function notifyGroupUazapi(text) {
  if (!NOTIFY_GROUP || !process.env.UAZAPI_TOKEN) return;
  try {
    await UAZAPI.sendText(NOTIFY_GROUP, text);
  } catch (err) {
    logger.error({ err: err.message }, 'falha ao avisar grupo via uazapi');
  }
}

// Aviso opcional via contato GHL (caminho antigo; só se AGENDA_NOTIFY_CONTACT_ID).
async function notifyContactGHL(msg) {
  const notifyId = process.env.AGENDA_NOTIFY_CONTACT_ID;
  if (!notifyId || !process.env.GHL_API_TOKEN) return;
  try {
    await GHL.sendMessage({ contactId: notifyId, message: msg, type: 'WhatsApp' });
  } catch (err) {
    logger.error({ err: err.message }, 'falha ao notificar contato GHL');
  }
}

// Aviso de "lead quer falar" pro time / consultor da vez.
// ⚠️ O texto depende do EXPEDIENTE. Antes era sempre "🔥 Lead quer falar AGORA —
// assumir o quanto antes", inclusive sábado à noite, pra lead a quem a Tina já
// tinha dito "te chamamos na segunda" (Icá, 21/09: "no FDS a Tina mandou bastante
// 'Lead quer falar AGORA' mesmo sendo final de semana. Tá certo isso?").
export async function notifyLiveHandoff(contact, { consultant, funnel }) {
  const exp = expediente();
  try {
    db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'live_handoff_notify', ?)`)
      .run(contact.id, JSON.stringify({ consultant: consultant?.name || consultant?.userId || null, funnel, foraExpediente: !exp.aberto }));
  } catch (err) {
    logger.error({ err: err.message, contactId: contact.id }, 'falha ao registrar aviso de live handoff');
  }

  const nome = contact.name || 'Lead';
  const tel = contact.phone || '';
  const quem = consultant?.name || '(próximo da fila)';
  const chegou = new Intl.DateTimeFormat('pt-BR', {
    timeZone: process.env.GHL_TIMEZONE || 'America/Sao_Paulo',
    weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
  const msg = exp.aberto
    ? `🔥 *Lead quer falar AGORA*\n`
      + `👤 Lead: ${nome}${tel ? ` (${tel})` : ''}\n`
      + `👨‍💼 ${agendaLabel().quem}: ${quem}\n`
      + `${resumoLead(contact, funnel)}\n`
      + `\n⚡ Assumir a conversa no WhatsApp o quanto antes.`
    : `🌙 *Lead pediu contato — FORA do expediente*\n`
      + `👤 Lead: ${nome}${tel ? ` (${tel})` : ''}\n`
      + `👨‍💼 ${agendaLabel().quem}: ${quem}\n`
      + `${resumoLead(contact, funnel)}\n`
      + `🕘 Chegou: ${chegou}\n`
      + `\n➡️ Retomar ${exp.proxima}. A Tina já avisou o lead que o atendimento é de seg a sex, ${exp.faixa}.`;

  await notifyGroupUazapi(msg);
  await notifyContactGHL(msg);
}

// Aviso quando o time encaminhou um lead pra Tina (arrastou o card pra coluna
// IA Tina) MAS a janela de 24h do WhatsApp está FECHADA — a Tina não pode
// iniciar conversa fria (regra da Meta), então o time precisa dar o 1º toque.
// Quando o lead responder, a Tina assume sozinha. Não-bloqueante.
export async function notifyIaTinaForaJanela(contact) {
  try {
    db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'ia_tina_fora_janela', ?)`)
      .run(contact.id, JSON.stringify({ phone: contact.phone || null }));
  } catch (err) {
    logger.error({ err: err.message, contactId: contact.id }, 'falha ao registrar ia_tina_fora_janela');
  }

  const nome = contact.name || 'Lead';
  const tel = contact.phone || '';
  const msg = `⚠️ *Lead encaminhado pra Tina, mas fora da janela de 24h*\n`
    + `👤 ${nome}${tel ? ` (${tel})` : ''}\n`
    + `A Tina não pode iniciar a conversa (regra do WhatsApp: só responde quem falou nas últimas 24h).\n`
    + `👉 Alguém do time precisa dar o primeiro toque. Quando o lead responder, a Tina assume automaticamente.`;

  await notifyGroupUazapi(msg);
}

export async function notifyAgendamento(contact, { label, iso, funnel, calendarId }) {
  // Registra sempre no log interno
  try {
    db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'reuniao_agendada', ?)`)
      .run(contact.id, JSON.stringify({ label, iso, funnel, calendarId }));
  } catch (err) {
    logger.error({ err: err.message, contactId: contact.id }, 'falha ao registrar evento de agendamento');
  }

  const nome = contact.name || 'Lead';
  const tel = contact.phone || '';
  const consultor = calendarName(calendarId);
  const lbl = agendaLabel(calendarId);
  const msg = `🗓️ *${lbl.titulo}*\n`
    + `👤 Lead: ${nome}${tel ? ` (${tel})` : ''}\n`
    + (consultor ? `👨‍💼 ${lbl.quem}: ${consultor}\n` : '')
    + `🕐 Quando: ${label}\n`
    + `${resumoLead(contact, funnel)}`;

  await notifyGroupUazapi(msg);
  await notifyContactGHL(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// RESUMO DIÁRIO (placar do dia) pro grupo do time no WhatsApp.
// Mesmas definições do painel (Visão geral / dashboard.js) pros números baterem.
// Disparado pelo scheduler quando RESUMO_DIA_ENABLED=true (ver scheduler.js).
// "Dia" = dia de Brasília: as queries usam date(...,'-3 hours') (o server roda em
// UTC), então o placar conta o dia certo em qualquer hora de disparo.
// ─────────────────────────────────────────────────────────────────────────────

// "Equipe assumiu" HOJE — MESMA regra do dashboard (dashboard.js, time_assumiu):
// leads distintos com QUALQUER sinal de entrega ao time (stage handoff/
// em_atendimento — o sinal mais confiável — OU evento de handoff OU SDR respondeu).
function timeAssumiuHoje() {
  return db.prepare(`
    SELECT COUNT(DISTINCT cid) c FROM (
      SELECT id cid         FROM contacts   WHERE stage IN ('handoff','em_atendimento') AND ghl_contact_id NOT LIKE 'playground-%' AND date(created_at,'-3 hours')=date('now','-3 hours')
      UNION
      SELECT contact_id cid FROM events_log WHERE kind IN ('live_handoff','handoff_publicar','handoff_aluno') AND date(created_at,'-3 hours')=date('now','-3 hours')
      UNION
      SELECT contact_id cid FROM messages   WHERE author='sdr' AND date(created_at,'-3 hours')=date('now','-3 hours')
    )
  `).get()?.c || 0;
}

// Monta o texto do resumo do dia (formatado pro WhatsApp).
export function buildResumoDiaText() {
  const data = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  // atendeu/conversaram: exclui playground (igual ao painel) pros números baterem.
  const atendeu = db.prepare(`
    SELECT COUNT(DISTINCT m.contact_id) c FROM messages m JOIN contacts c ON c.id = m.contact_id
    WHERE m.author='ia' AND c.ghl_contact_id NOT LIKE 'playground-%' AND date(m.created_at,'-3 hours')=date('now','-3 hours')
  `).get()?.c || 0;
  const agendou = db.prepare(`SELECT COUNT(*) c FROM events_log WHERE kind='reuniao_agendada' AND date(created_at,'-3 hours')=date('now','-3 hours')`).get()?.c || 0;
  const timeAssumiu = timeAssumiuHoje();
  const leadsHoje = db.prepare(`
    SELECT COUNT(DISTINCT m.contact_id) c FROM messages m JOIN contacts c ON c.id = m.contact_id
    WHERE m.direction='inbound' AND c.ghl_contact_id NOT LIKE 'playground-%' AND date(m.created_at,'-3 hours')=date('now','-3 hours')
  `).get()?.c || 0;

  // Encerrados no dia (pedido do Gabriel, 25/08: "seria legal um relatório de
  // quantos ela declinou no dia"). Soma os dois caminhos de encerramento: negativa
  // do lead (desqualificado) e silêncio total depois dos follow-ups.
  const encerrados = db.prepare(`
    SELECT COUNT(DISTINCT contact_id) c FROM events_log
    WHERE kind IN ('encerrado_sem_resposta','lead_desqualificado')
      AND date(created_at,'-3 hours')=date('now','-3 hours')
  `).get()?.c || 0;

  const linhas = [
    `📊 *Resumo da Tina — ${data}*`,
    ``,
    `🤖 Atendidos: *${atendeu}* ${atendeu === 1 ? 'lead' : 'leads'}`,
    `🗓️ Agendados: *${agendou}* ${agendou === 1 ? 'reunião' : 'reuniões'}`,
    `👤 Equipe assumiu: *${timeAssumiu}* ${timeAssumiu === 1 ? 'lead' : 'leads'}`,
    `🔒 Encerrados: *${encerrados}* ${encerrados === 1 ? 'atendimento' : 'atendimentos'}`,
  ];

  // Reuniões de hoje por consultor (rodízio) — só se houver.
  const ag = db.prepare(`SELECT payload FROM events_log WHERE kind='reuniao_agendada' AND date(created_at,'-3 hours')=date('now','-3 hours')`).all();
  if (ag.length) {
    const porConsultor = {};
    for (const r of ag) {
      let p = {}; try { p = JSON.parse(r.payload); } catch {}
      const nome = calendarName(p.calendarId) || '(a definir)';
      porConsultor[nome] = (porConsultor[nome] || 0) + 1;
    }
    linhas.push(``, `🗓️ *Reuniões por consultor:*`);
    for (const [k, v] of Object.entries(porConsultor)) linhas.push(`   • ${k}: ${v}`);
  }

  linhas.push(``, `👥 Conversaram hoje: ${leadsHoje}`, ``, `_Detalhes e outros períodos no painel._`);
  return linhas.join('\n');
}

// Envia o resumo do dia pro grupo do time. Retorna true só se realmente enviou
// (grupo+token configurados e uazapi aceitou) — o scheduler usa isso pra só
// marcar como "enviado hoje" quando deu certo.
export async function sendResumoDiaGroup() {
  if (!NOTIFY_GROUP || !process.env.UAZAPI_TOKEN) {
    logger.warn('resumo diário: UAZAPI_NOTIFY_GROUP/UAZAPI_TOKEN ausentes — não enviado');
    return false;
  }
  try {
    await UAZAPI.sendText(NOTIFY_GROUP, buildResumoDiaText());
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'falha ao enviar resumo diário pro grupo');
    return false;
  }
}
