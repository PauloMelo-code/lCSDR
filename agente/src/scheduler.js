import { db } from './db/index.js';
import { GHL } from './ghl/client.js';
import { resumeIA, closeLeadNoResponse } from './agent/handoff.js';
import { recordOutbound } from './agent/contactService.js';
import { markTinaSent } from './agent/messenger.js';
import { sendResumoDiaGroup, notifyAgendamentoTravado } from './agent/notify.js';
import { sweepOrganico } from './agent/organicoSweep.js';
import { upcomingAppointment } from './agent/scheduling.js';
import { contactWorkedByOtherTeam } from './ghl/opportunities.js';
import { handleOpportunityStage } from './routes/webhook.js';
import { logger } from './utils/logger.js';

const TICK_MS = 60_000; // 1 min

// Horas de silêncio APÓS o último follow-up até ENCERRAR o card do lead (regra LC
// 25/08: sem isso o atendimento morto fica aberto pra sempre na coluna da Tina —
// ~600 cards acumulados). 0 desliga o encerramento automático.
const CLOSE_HOURS = Number(process.env.FOLLOWUP_CLOSE_HOURS ?? 48);

// Processa follow-ups vencidos: lead/SDR em silêncio → IA retoma com mensagem leve.
// IMPORTANTE: processa só 1 follow-up por contato por tick. Mesmo que o banco
// tenha 5 follow-ups acumulados, manda só 1 mensagem e marca todos como sent.
async function processFollowups() {
  const due = db.prepare(`
    SELECT f.*, c.id as contact_id, c.ghl_contact_id, c.name, c.phone, c.ai_paused, c.stage, c.last_inbound_at
    FROM followups f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.sent = 0 AND f.due_at <= datetime('now')
      AND f.id = (
        SELECT MIN(id) FROM followups
        WHERE contact_id = f.contact_id AND sent = 0
      )
    LIMIT 20
  `).all();

  for (const f of due) {
    try {
      // Defensa em camadas: marca TODOS os follow-ups pendentes do contato como
      // sent ANTES de processar. Garante que mesmo se algo der erro depois,
      // não vai disparar duplicado.
      db.prepare('UPDATE followups SET sent = 1 WHERE contact_id = ? AND sent = 0').run(f.contact_id);

      // Se já foi desqualificado, agendado, qualificado (handoff feito) ou
      // está em handoff, NÃO manda follow-up. Risco era a Tina mandar
      // "dei uma sumida" pra lead que o Closer humano está atendendo.
      if (['desqualificado', 'agendado', 'qualificado', 'handoff'].includes(f.stage)) {
        continue;
      }

      // Defesa em camadas: se a IA está pausada (qualquer motivo), nem retoma.
      // Só caminho legítimo de follow-up é silencio_lead com IA não-pausada.
      if (f.ai_paused) continue;

      // Lead JÁ TEM reunião futura no GHL (marcada por humano — o stage local não
      // vê) → não cutuca ("você ainda tem interesse?" pra quem já marcou é ruim).
      if (await upcomingAppointment({ id: f.contact_id, ghl_contact_id: f.ghl_contact_id })) continue;

      // OUTRO TIME: o follow-up não tinha NENHUMA guarda de dono — só olhava stage,
      // ai_paused e reunião futura. Uma vez agendada a linha, ela disparava mesmo com
      // o lead já na coluna de um closer humano. ❌ CASO REAL (Rodrigo, 27/08): o lead
      // estava no pipeline dos Closers e recebeu da Tina "nossa conversa ficou parada
      // por aqui" como PRIMEIRA mensagem — sendo que ele tinha acabado de preencher o
      // formulário dizendo que já publicou e quer divulgar.
      if (await contactWorkedByOtherTeam({ id: f.contact_id, ghl_contact_id: f.ghl_contact_id })) {
        logger.info({ contactId: f.contact_id }, 'follow-up cancelado: lead está com outro time');
        continue;
      }

      // AGENDAMENTO TRAVADO: o lead pediu pra agendar e, passado o prazo, nenhuma
      // reunião foi marcada. NÃO manda mensagem pro lead — avisa o TIME, que antes
      // não ficava sabendo de nada (queixa "lead não foi informado no grupo").
      // Roda depois do gate de reunião futura acima: se fechou, nem chega aqui.
      if (f.reason === 'agendamento_travado') {
        if (f.stage === 'agendado') continue;              // fechou no meio do caminho
        logger.warn({ contactId: f.contact_id }, 'agendamento travado — avisando o time');
        await notifyAgendamentoTravado(
          { id: f.contact_id, ghl_contact_id: f.ghl_contact_id, name: f.name, phone: f.phone },
          { desde: f.created_at },
        ).catch(err => logger.warn({ err: err.message, contactId: f.contact_id }, 'falha avisando agendamento travado'));
        continue;
      }

      // ENCERRAMENTO SEM RESPOSTA: não manda mensagem nenhuma, só FECHA o card do
      // lead que nunca respondeu (regra LC 25/08). Fica DEPOIS de todos os gates
      // acima de propósito: se o lead virou agendado/qualificado, se um humano
      // assumiu (ai_paused) ou se já existe reunião futura, NÃO encerra — encerrar
      // aqui cancelaria uma reunião real (declineOppAndAppointment tira da agenda).
      if (f.reason === 'encerrar_sem_resposta') {
        // respondeu depois do último follow-up? então está vivo, não encerra.
        const enviadoEm = new Date(f.due_at).getTime() - CLOSE_HOURS * 3600_000;
        if (f.last_inbound_at && new Date(f.last_inbound_at).getTime() > enviadoEm) {
          logger.info({ contactId: f.contact_id }, 'lead respondeu depois do follow-up — nao encerra');
          continue;
        }
        await closeLeadNoResponse({ id: f.contact_id, ghl_contact_id: f.ghl_contact_id }).catch(err =>
          logger.warn({ err: err.message, contactId: f.contact_id }, 'falha encerrando lead sem resposta'));
        continue;
      }

      // ⚠️ NÃO usa o nome cru do contato. O WhatsApp entrega coisas como
      // "mariozeferino698", "216681834" ou o próprio telefone como nome — e o
      // follow-up saía "Oi mariozeferino698," (queixa da LC 25/09: "usou nome de
      // contato, ela não devia responder dessa forma"). Sem nome válido, saúda sem nome.
      const primeiro = (f.name || '').trim().split(/\s+/)[0] || '';
      const nomeValido = primeiro.length >= 2 && !/\d/.test(primeiro) && !/^[\W_]+$/.test(primeiro);
      const saudacao = nomeValido ? `Oi ${primeiro}, ` : 'Oi, ';
      // Textos reescritos (queixa do Gabriel, 25/08): o follow-up antigo abria com
      // "dei uma sumida, me desculpa" — a Tina se acusava de sumir, o lead não
      // entendia do que se tratava e respondia "?" ou "não entendi". Agora ela se
      // identifica, lembra o CONTEXTO (o livro dele) e faz UMA pergunta simples.
      const txt = f.reason === 'silencio_sdr'
        ? `${saudacao}passando pra te dar um retorno. O time já foi avisado, mas pra não te deixar sem resposta: me conta rapidinho o que você precisa? Assim eu agilizo por aqui 😊`
        : f.reason === 'silencio_lead_24h'
          ? `${saudacao}aqui é a Tina, do Grupo LC 😊 Só pra não deixar passar: ainda posso te ajudar com o seu livro? Se fizer sentido, me diz em que fase você está — escrevendo, pronto pra publicar, ou já lançado e quer divulgar.`
          : `${saudacao}aqui é a Tina, do Grupo LC 😊 Nossa conversa sobre o seu livro ficou parada por aqui. Você ainda tem interesse em seguir? Me conta em que fase está: escrevendo, pronto pra publicar, ou já lançado e quer divulgar.`;

      markTinaSent(await GHL.sendMessage({
        contactId: f.ghl_contact_id,
        message: txt,
        type: process.env.GHL_OUTBOUND_TYPE || 'WhatsApp', // mesmo canal da Tina (SMS/WhatsApp)
      }));
      recordOutbound(f.contact_id, { author: 'ia', content: txt });
      db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'followup_sent', ?)`)
        .run(f.contact_id, JSON.stringify({ reason: f.reason }));
      logger.info({ contactId: f.contact_id, reason: f.reason }, 'follow-up enviado');

      // Regra LC 16/07: se o lead seguir sem responder, SEGUNDO toque em 24h.
      // Só encadeia a partir do 1º follow-up (não do _24h) → máximo 2 toques.
      // Se o lead responder antes, o webhook re-agenda/cancela os pendentes.
      if (f.reason === 'silencio_lead') {
        db.prepare(`INSERT INTO followups (contact_id, due_at, reason) VALUES (?, ?, 'silencio_lead_24h')`)
          .run(f.contact_id, new Date(Date.now() + 24 * 3600_000).toISOString());
      }

      // Depois do ÚLTIMO toque: se o lead continuar em silêncio, agenda o
      // ENCERRAMENTO do card (regra LC 25/08 — senão o atendimento morto fica
      // aberto pra sempre na coluna da Tina). Horas em FOLLOWUP_CLOSE_HOURS.
      if (f.reason === 'silencio_lead_24h' && CLOSE_HOURS > 0) {
        db.prepare(`INSERT INTO followups (contact_id, due_at, reason) VALUES (?, ?, 'encerrar_sem_resposta')`)
          .run(f.contact_id, new Date(Date.now() + CLOSE_HOURS * 3600_000).toISOString());
      }
    } catch (err) {
      logger.error({ err: err.message, followupId: f.id }, 'falha em follow-up');
    }
  }
}

// Resumo diário pro grupo do time no WhatsApp. Default DESLIGADO; liga com
// RESUMO_DIA_ENABLED=true. Hora em RESUMO_DIA_HORA (0-23, horário de Brasília;
// default 18; valor inválido/vazio cai no default). O placar é ancorado no dia
// de Brasília (queries em notify.js usam date(...,'-3 hours')), então qualquer
// hora 0-23 conta o dia certo. Dispara 1x/dia: reserva o evento ANTES de enviar
// (sobrevive a restart e bloqueia os ticks seguintes); se o envio falhar, desfaz
// a reserva pra tentar de novo no próximo tick.
async function maybeSendResumoDia() {
  if (process.env.RESUMO_DIA_ENABLED !== 'true') return;
  // Sem grupo/token configurado: nem tenta (senão logaria um warn a cada tick).
  if (!process.env.UAZAPI_NOTIFY_GROUP || !process.env.UAZAPI_TOKEN) return;

  // Hora alvo (BRT). NaN/vazio/fora de 0-23 → default 18, em vez de morrer calado.
  const raw = process.env.RESUMO_DIA_HORA;
  let hora = (raw == null || raw === '') ? 18 : Number(raw);
  if (!Number.isInteger(hora) || hora < 0 || hora > 23) hora = 18;

  let brtHour;
  try {
    brtHour = Number(new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23',
    }).format(new Date()));
  } catch {
    brtHour = (new Date().getUTCHours() + 21) % 24; // fallback: UTC-3
  }
  if (brtHour !== hora) return;

  // Idempotência: no máx. 1 envio por ~dia (janela de 20h em UTC).
  const ja = db.prepare(
    `SELECT 1 FROM events_log WHERE kind='resumo_dia_enviado' AND created_at >= datetime('now','-20 hours') LIMIT 1`
  ).get();
  if (ja) return;

  // Reserva o marcador ANTES de enviar: se o INSERT falhar não enviou (nada a
  // duplicar); se o envio falhar, desfaz a reserva pra retomar no próximo tick.
  const reserva = db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (NULL, 'resumo_dia_enviado', ?)`)
    .run(JSON.stringify({ horaBRT: hora }));
  const ok = await sendResumoDiaGroup();
  if (ok) {
    logger.info({ horaBRT: hora }, 'resumo diário enviado pro grupo');
  } else {
    db.prepare(`DELETE FROM events_log WHERE id = ?`).run(reserva.lastInsertRowid);
  }
}

// VARREDURA automática do Funil Orgânico (safety-net): responde os leads PARADOS
// (esperando resposta, <24h, só na raia da Tina, sem SDR ativo) mesmo se o webhook
// ao vivo falhar ou houver apagão de IA — pra os leads não empilharem. Default
// DESLIGADA (ORGANICO_SWEEP_ENABLED=true pra ligar). Roda a cada ORGANICO_SWEEP_MINUTES
// (default 30), no máx. ORGANICO_SWEEP_MAX leads por rodada (default 12). Idempotente:
// o cooldown de 12h do handleOpportunityStage evita re-responder o mesmo lead.
const SWEEP_ON = process.env.ORGANICO_SWEEP_ENABLED === 'true';
const SWEEP_INTERVAL_MS = Math.max(5, Number(process.env.ORGANICO_SWEEP_MINUTES) || 30) * 60_000;
const SWEEP_MAX = Math.max(1, Number(process.env.ORGANICO_SWEEP_MAX) || 12);
let _sweepLast = 0;
let _sweepRunning = false;

async function maybeSweepOrganico() {
  if (!SWEEP_ON) return;
  if (_sweepRunning) return;                                  // não sobrepõe (a varredura demora)
  if (Date.now() - _sweepLast < SWEEP_INTERVAL_MS) return;
  _sweepLast = Date.now();
  _sweepRunning = true;
  try {
    const r = await sweepOrganico({
      send: true,
      max: SWEEP_MAX,
      respondFn: (cid) => handleOpportunityStage({ type: 'IaTinaAssumir', contactId: cid, _force: true }),
    });
    if (r.esperando || r.respondidos) {
      logger.info({
        total: r.total, esperando: r.esperando, respondidos: r.respondidos,
        foraRaia: r.foraRaia, sdrAtivo: r.sdrAtivo, fora24h: r.fora24h, elegiveis: r.elegiveis.length,
      }, 'varredura Funil Orgânico');
    }
  } catch (e) {
    logger.error({ err: e.message }, 'varredura Funil Orgânico falhou');
  } finally {
    _sweepRunning = false;
  }
}

export function startScheduler() {
  const resumoOn = process.env.RESUMO_DIA_ENABLED === 'true';
  const resumoConfigOk = Boolean(process.env.UAZAPI_NOTIFY_GROUP && process.env.UAZAPI_TOKEN);
  if (resumoOn && !resumoConfigOk) {
    logger.warn('RESUMO_DIA_ENABLED=true mas falta UAZAPI_NOTIFY_GROUP/UAZAPI_TOKEN — resumo diário não vai enviar');
  }
  logger.info({
    tick_ms: TICK_MS,
    resumoDia: resumoOn ? (resumoConfigOk ? `ligado (${process.env.RESUMO_DIA_HORA || 18}h BRT)` : 'ligado mas sem grupo/token') : 'desligado',
    varreduraOrganico: SWEEP_ON ? `ligada (${SWEEP_INTERVAL_MS / 60000}min, máx ${SWEEP_MAX})` : 'desligada',
  }, 'scheduler iniciado');
  setInterval(() => {
    processFollowups().catch(err => logger.error(err));
    maybeSendResumoDia().catch(err => logger.error(err));
    maybeSweepOrganico().catch(err => logger.error(err));
  }, TICK_MS);
}
