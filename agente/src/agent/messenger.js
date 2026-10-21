// Dispatcher de canal: decide se envia via uazapi ou GHL.
// - Se UAZAPI_TOKEN setado → uazapi (canal nativo brasileiro, suporta botões interativos)
// - Senão → GHL sendMessage (canal genérico, sem botões nativos)
//
// Mantém uma interface única pro restante do código não se preocupar com canal.

import { UAZAPI, normalizePhone } from '../uazapi/client.js';
import { GHL } from '../ghl/client.js';
import { db } from '../db/index.js';
import { logger } from '../utils/logger.js';

// Registra o messageId que a Tina acabou de enviar (procedência). No GHL a saída
// carimba o userId do DONO do contato — igual ao do humano — então o único jeito
// confiável de saber "isto foi a Tina" é guardar o id do envio. Idempotente/fail-open.
//
// ⚠️ VALE PROS DOIS CANAIS. A tabela guarda "ids de mensagem que NÓS enviamos",
// não só do GHL (o nome da coluna é histórico). No uazapi a saída da Tina e a do
// consultor chegam no webhook com o MESMO `fromMe: true` — sem este registro não
// existe como separar uma da outra, e a trava de "humano assumiu" fica cega.
// Por isso o ramo uazapi de sendText/sendMenu também passa por aqui.
export function markTinaSent(res) {
  const id = res?.messageId || res?.messageid || res?.id
    || res?.key?.id || res?.message?.id || res?.messages?.[0]?.id;
  if (id) { try { db.prepare('INSERT OR IGNORE INTO tina_sent_msgs (ghl_message_id) VALUES (?)').run(String(id)); } catch {} }
  return res;
}

// TRUE se este messageId do GHL foi enviado pela PRÓPRIA Tina (procedência).
export function isTinaSentMessage(ghlMessageId) {
  if (!ghlMessageId) return false;
  try { return Boolean(db.prepare('SELECT 1 FROM tina_sent_msgs WHERE ghl_message_id = ? LIMIT 1').get(String(ghlMessageId))); }
  catch { return false; }
}

export function preferredChannel() {
  // Canal de ATENDIMENTO do lead. Default = GHL/Meta oficial.
  // ATENÇÃO: ter UAZAPI_TOKEN setado é SÓ pros avisos no grupo (notify.js usa o
  // uazapi direto) — NÃO deve trocar o canal do lead. Antes, a mera presença do
  // token jogava TODA resposta da Tina pro número uazapi (lead recebia de outro
  // número, e a conversa sumia do GHL). Agora só usa uazapi pro lead se for
  // explicitamente pedido (LEAD_CHANNEL=uazapi) ou se o inbound do uazapi estiver
  // ligado (UAZAPI_INBOUND_ENABLED=true) — aí entra e sai pelo mesmo número.
  const explicit = (process.env.LEAD_CHANNEL || '').toLowerCase();
  if (explicit === 'uazapi' || explicit === 'ghl') return explicit;
  return process.env.UAZAPI_INBOUND_ENABLED === 'true' ? 'uazapi' : 'ghl';
}

// Canal de ENVIO no GHL (campo `type` da API de conversas). Default 'WhatsApp'.
// Se o GHL passar a rotear o WhatsApp como canal SMS (ex.: integração Stevo p/
// trackeamento), setar GHL_OUTBOUND_TYPE=SMS — senão a Tina envia como WhatsApp
// e o GHL não entrega (canal não bate com o do contato).
function ghlOutboundType() {
  return process.env.GHL_OUTBOUND_TYPE || 'WhatsApp';
}

/**
 * Envia mensagem de texto pro lead.
 * @param {object} contact — {ghl_contact_id, phone, name}
 * @param {string} text
 * @param {object} [opts] — {ghlChannelType?: 'WhatsApp'|'SMS'|...}
 */
export async function sendText(contact, text, opts = {}) {
  if (preferredChannel() === 'uazapi') {
    const number = normalizePhone(contact.phone);
    if (!number) throw new Error(`contato sem phone válido: ${contact.id}`);
    return markTinaSent(await UAZAPI.sendText(number, text));
  }
  return markTinaSent(await GHL.sendMessage({
    contactId: contact.ghl_contact_id,
    message: text,
    type: opts.ghlChannelType || ghlOutboundType(),
  }));
}

/**
 * Envia menu com botões interativos.
 * choices: array de strings "Label|valor" (formato uazapi)
 * Quando canal não suporta (GHL), faz fallback pra texto numerado.
 */
export async function sendMenu(contact, { text, choices, footerText, type = 'button' }) {
  if (preferredChannel() === 'uazapi') {
    const number = normalizePhone(contact.phone);
    if (!number) throw new Error(`contato sem phone válido: ${contact.id}`);
    return markTinaSent(await UAZAPI.sendMenu({ number, text, choices, footerText, type }));
  }
  // Fallback GHL: vira texto formatado em lista numerada
  const lines = choices.map((c, i) => {
    const [label] = c.split('|');
    return `${i + 1}. ${label.trim()}`;
  });
  const fallbackText = [text, '', ...lines, footerText && `\n_${footerText}_`].filter(Boolean).join('\n');
  return markTinaSent(await GHL.sendMessage({
    contactId: contact.ghl_contact_id,
    message: fallbackText,
    type: ghlOutboundType(),
  }));
}

/**
 * Envia uma IMAGEM pro lead, com legenda opcional.
 * ⚠️ Falha de imagem NÃO pode derrubar a confirmação de agendamento: se o anexo não
 * for aceito, o lead já recebeu o horário e o compromisso está criado. Por isso quem
 * chama trata o erro como não-fatal (sendSequence já faz isso).
 */
export async function sendImage(contact, url, legenda = '') {
  if (!url) return null;
  if (preferredChannel() === 'uazapi') {
    const number = normalizePhone(contact.phone);
    if (!number) throw new Error(`contato sem phone válido: ${contact.id}`);
    return markTinaSent(await UAZAPI.sendMedia({ number, type: 'image', file: url, text: legenda }));
  }
  return markTinaSent(await GHL.sendMessage({
    contactId: contact.ghl_contact_id,
    message: legenda || '',
    type: ghlOutboundType(),
    attachments: [url],
  }));
}

/**
 * Envia múltiplas mensagens em sequência (split de bolhas).
 * Aceita formato:
 *   - string                            → manda como texto
 *   - {text, buttons?:[{label,value}]}  → texto, ou menu se tiver buttons
 */
export async function sendSequence(contact, items) {
  // Retorna o nº de bolhas REALMENTE enviadas. Callers que só querem disparar
  // ignoram o retorno (comportamento inalterado); quem precisa saber se algo
  // saiu (ex.: continuidade IA Tina) checa o contador pra não gravar/contabilizar
  // um envio que falhou.
  let sent = 0;
  for (const item of items) {
    if (!item) continue;
    try {
      let delivered = false;
      if (typeof item === 'string') {
        await sendText(contact, item);
        delivered = true;
      } else if (item.image) {
        // Bolha de IMAGEM (regra LC 15/10: ao agendar com closer, mandar a imagem
        // de orientação pro lead). Vai como anexo da mensagem; a legenda é opcional.
        await sendImage(contact, item.image, item.text);
        delivered = true;
      } else if (item.buttons && item.buttons.length) {
        const choices = item.buttons.map(b => `${b.label}|${b.value || b.label}`);
        await sendMenu(contact, {
          text: item.text,
          choices,
          footerText: item.footerText,
          type: item.buttons.length > 3 ? 'list' : 'button',
        });
        delivered = true;
      } else if (item.text) {
        await sendText(contact, item.text);
        delivered = true;
      }
      if (delivered) {
        sent++;
        // Pausa pequena entre bolhas pra parecer humano
        await new Promise(r => setTimeout(r, 600));
      }
    } catch (err) {
      logger.error({ err: err.message, contactId: contact.id }, 'falha enviando mensagem');
    }
  }
  return sent;
}
