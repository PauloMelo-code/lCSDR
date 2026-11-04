import { db } from '../db/index.js';
import { GHL } from '../ghl/client.js';
import { logger } from '../utils/logger.js';

// O better-sqlite3 só aceita number/string/bigint/buffer/null. Se receber um
// OBJETO ele acha que são "named params" e dispara "Too few parameter values".
// O GHL às vezes manda body como objeto (áudio/imagem/anexo estruturado),
// então coagimos qualquer não-primitivo p/ JSON string antes de gravar.
function bindable(v, dflt = null) {
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return v; // number, string, bigint, boolean
}

export function upsertContactFromGHL(ghlContact) {
  const existing = db.prepare('SELECT * FROM contacts WHERE ghl_contact_id = ?').get(ghlContact.id);
  if (existing) {
    db.prepare(`
      UPDATE contacts
      SET name = COALESCE(?, name),
          phone = COALESCE(?, phone),
          email = COALESCE(?, email),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      ghlContact.name || `${ghlContact.firstName || ''} ${ghlContact.lastName || ''}`.trim() || null,
      ghlContact.phone || null,
      ghlContact.email || null,
      existing.id
    );
    return db.prepare('SELECT * FROM contacts WHERE id = ?').get(existing.id);
  }

  const info = db.prepare(`
    INSERT INTO contacts (ghl_contact_id, name, phone, email, stage)
    VALUES (?, ?, ?, ?, 'novo')
  `).run(
    ghlContact.id,
    ghlContact.name || `${ghlContact.firstName || ''} ${ghlContact.lastName || ''}`.trim() || null,
    ghlContact.phone || null,
    ghlContact.email || null,
  );
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid);
}

// Cancela os pendentes do contato, MENOS a checagem de agendamento travado: ela é
// aviso pro TIME, não mensagem pro lead. Vale pro lead respondendo (recordInbound) e
// pro fim de turno (scheduleFollowup). ❌ Antes os dois cancelavam a checagem: o
// horário prometido no passo 7.8 do webhook morria no scheduleFollowup do mesmo
// turno, e o "amanhã às 10h" do lead matava a checagem da oferta de horário. Quem
// escolhia o horário e travava no e-mail era declinado sem o time saber (revisão
// 04/11). Quem resolve o agendamento (marcou, já tinha reunião, escalou, humano
// respondeu) cancela tudo explicitamente, e o scheduler reconfere estágio e
// reunião futura antes de avisar.
export const SQL_CANCELA_PENDENTES =
  `UPDATE followups SET sent = 1 WHERE contact_id = ? AND sent = 0 AND reason <> 'agendamento_travado'`;

export function recordInbound(contactId, { content, content_type = 'text', ghl_message_id = null, attachment_url = null } = {}) {
  db.prepare(`
    INSERT INTO messages (contact_id, ghl_message_id, direction, author, content, content_type, raw_attachment_url)
    VALUES (?, ?, 'inbound', 'lead', ?, ?, ?)
  `).run(
    contactId,
    bindable(ghl_message_id),
    bindable(content, ''),
    bindable(content_type, 'text'),
    bindable(attachment_url),
  );
  db.prepare('UPDATE contacts SET last_inbound_at = CURRENT_TIMESTAMP WHERE id = ?').run(contactId);
  // Lead respondeu → cancela follow-ups pendentes desse contato.
  // Não faz sentido mandar "dei uma sumida" pra quem acabou de falar.
  db.prepare(SQL_CANCELA_PENDENTES).run(contactId);
}

export function recordOutbound(contactId, { author = 'ia', content, sdr_id = null, usage = {} }) {
  const {
    tokens_in = 0,
    tokens_out = 0,
    cached_tokens = 0,
    cost_usd = 0,
    provider = null,
    model = null,
    prompt_version = null,
  } = usage;
  db.prepare(`
    INSERT INTO messages
      (contact_id, direction, author, sdr_id, content, tokens_in, tokens_out, cached_tokens, cost_usd, provider, model_used, prompt_version)
    VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(contactId, author, sdr_id, bindable(content, ''), tokens_in, tokens_out, cached_tokens, cost_usd, provider, model, prompt_version);
  db.prepare('UPDATE contacts SET last_outbound_at = CURRENT_TIMESTAMP WHERE id = ?').run(contactId);
}

export function countMessagesToday(contactId) {
  // Conta SÓ as mensagens da IA (author='ia') — a proteção é de CUSTO (tokens da
  // Tina). Contar inbound/sdr inflava o limite e, com o backfill da continuidade
  // (que importa histórico do lead/SDR), poderia pausar a IA indevidamente.
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM messages
    WHERE contact_id = ? AND author = 'ia' AND date(created_at) = date('now')
  `).get(contactId);
  return row?.c || 0;
}
