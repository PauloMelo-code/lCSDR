// LEMBRETE DE COMPROMISSO PELA TINA (pedido Lilian 21/10).
//
// O GHL já manda lembrete por e-mail e SMS. Este aqui é o da Tina, no WhatsApp, onde
// a autora de fato lê. Os dois convivem de propósito: o e-mail é a rede de segurança.
//
// ⚠️ JANELA DE 24H DO WHATSAPP. A Tina só consegue enviar pra quem falou com ela nas
// últimas 24h (regra da Meta). Reunião marcada com vários dias de antecedência cai
// fora da janela e o lembrete NÃO sai — por isso o e-mail do GHL continua existindo.
// Quando falha, registramos: é isso que vai dizer se vale a pena insistir nesse canal.
//
// O texto muda conforme o tipo:
//   - pré-atendimento (Gabriel/Bruna): LIGAÇÃO de 15 min, NUNCA menciona link/sala
//   - closer: reunião
// ❌ CASO REAL (doc LC 15/10): o lembrete do GHL manda "aqui está o link da chamada"
// pra quem vai receber uma ligação no telefone, porque o workflow não separa os dois.

import { db } from '../db/index.js';
import { GHL } from '../ghl/client.js';
import { getCalendarIds, calendarName, slotModality, labelForSlot } from './scheduling.js';
import { sendText } from './messenger.js';
import { logger } from '../utils/logger.js';

export function lembreteEnabled() {
  return process.env.LEMBRETE_ENABLED === 'true';
}

// Quantas horas antes do compromisso o lembrete sai.
export function lembreteHoras() {
  return Math.max(1, Number(process.env.LEMBRETE_ANTES_HORAS ?? 3));
}

// Largura da janela de varredura. O scheduler roda a cada TICK; a janela precisa ser
// maior que o tick, senão um compromisso "passa entre dois ticks" e nunca é lembrado.
const JANELA_MIN = Math.max(15, Number(process.env.LEMBRETE_JANELA_MIN ?? 45));

// Idempotência: um lembrete por compromisso, para sempre. Sem isto, cada tick dentro
// da janela manda de novo e a autora recebe a mesma mensagem 3 ou 4 vezes — que é
// exatamente a queixa de "mensagens repetidas" que o time já reportou 10 vezes.
function jaLembrado(appointmentId) {
  try {
    return Boolean(db.prepare(
      `SELECT 1 FROM events_log WHERE kind = 'lembrete_enviado' AND payload LIKE ? LIMIT 1`
    ).get(`%"appointmentId":"${appointmentId}"%`));
  } catch { return false; }
}

function marcarLembrado(contactId, appointmentId, entregue) {
  try {
    db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'lembrete_enviado', ?)`)
      .run(contactId, JSON.stringify({ appointmentId, entregue }));
  } catch (err) {
    logger.warn({ err: err.message, appointmentId }, 'falha registrando lembrete');
  }
}

// Texto do lembrete, conforme o tipo de compromisso.
export function textoLembrete({ nome, consultor, quando, tipo }) {
  const oi = nome && !/\d/.test(nome) ? `Oi, ${nome}!` : 'Oi!';
  const comQuem = consultor ? ` com ${consultor}` : '';
  return tipo === 'ligacao'
    // Texto pedido pela Lilian no doc de 15/10. Sem link: é ligação no telefone.
    ? `${oi} Passando pra lembrar da sua ligação de pré-atendimento${comQuem} ${quando}. Podemos confirmar?`
    : `${oi} Passando pra lembrar da sua reunião${comQuem} ${quando}. Podemos confirmar?`;
}

/**
 * Varre os compromissos que começam daqui a ~LEMBRETE_ANTES_HORAS e manda o lembrete.
 * Chamada a cada tick do scheduler. Silenciosa quando desligada.
 */
export async function processarLembretes() {
  if (!lembreteEnabled() || !process.env.GHL_API_TOKEN) return;

  const horas = lembreteHoras();
  const alvo = Date.now() + horas * 3_600_000;
  const ini = alvo - (JANELA_MIN / 2) * 60_000;
  const fim = alvo + (JANELA_MIN / 2) * 60_000;

  for (const calendarId of getCalendarIds()) {
    let eventos = [];
    try {
      const r = await GHL.getCalendarEvents(calendarId, { startTime: ini, endTime: fim });
      eventos = r?.events || r?.appointments || [];
    } catch (err) {
      logger.warn({ err: err.message, calendarId }, 'falha lendo agenda pro lembrete');
      continue;
    }

    for (const ev of eventos) {
      const apptId = ev.id || ev.appointmentId;
      const ghlContactId = ev.contactId;
      if (!apptId || !ghlContactId) continue;

      // Compromisso cancelado não leva lembrete.
      const st = String(ev.appointmentStatus || ev.status || '').toLowerCase();
      if (st && !['confirmed', 'booked', 'new', 'showed'].includes(st)) continue;
      if (jaLembrado(apptId)) continue;

      const contact = db.prepare('SELECT * FROM contacts WHERE ghl_contact_id = ?').get(ghlContactId);
      if (!contact) continue;   // lead que a Tina nunca atendeu: não é dela pra lembrar

      const mod = slotModality(calendarId);
      const texto = textoLembrete({
        nome: (contact.name || '').trim().split(/\s+/)[0],
        consultor: calendarName(calendarId),
        quando: labelForSlot(ev.startTime),
        tipo: mod.tipo,
      });

      try {
        await sendText(contact, texto);
        marcarLembrado(contact.id, apptId, true);
        logger.info({ contactId: contact.id, apptId, tipo: mod.tipo }, 'lembrete enviado pela Tina');
      } catch (err) {
        // Quase sempre é a janela de 24h. Registra como NÃO entregue e segue: o
        // e-mail do GHL cobre esse caso, e o contador diz se o canal vale a pena.
        marcarLembrado(contact.id, apptId, false);
        logger.warn({ err: err.message, contactId: contact.id, apptId },
          'lembrete da Tina não saiu (provável janela de 24h) — o e-mail do GHL cobre');
      }
    }
  }
}
