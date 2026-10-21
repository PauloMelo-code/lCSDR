import express from 'express';
import { db } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { transcribeAudioBuffer } from '../utils/transcribe.js';
import {
  recordInbound, recordOutbound, countMessagesToday,
} from '../agent/contactService.js';
import { generateTinaReply } from '../agent/tina.js';
import { sendSequence, sendText, isTinaSentMessage } from '../agent/messenger.js';
import {
  pauseIA, scheduleFollowup, handleSDRReply,
  markQualifiedAndHandoff, markDisqualified, applyTinaTags,
} from '../agent/handoff.js';
import { withContactLock } from '../utils/contactLock.js';
import { GHL } from '../ghl/client.js';

const router = express.Router();

// Idempotência: registra message_id processado e retorna true se já tinha sido
// processado antes. uazapi reentrega webhooks sem ack confiável.
function alreadyProcessed(source, messageId) {
  if (!messageId) return false;
  const result = db.prepare(
    'INSERT OR IGNORE INTO processed_webhook_ids (source, message_id) VALUES (?, ?)'
  ).run(source, String(messageId));
  return result.changes === 0; // 0 = duplicata (UNIQUE bateu)
}
const MAX_KB = Number(process.env.MAX_ATTACHMENT_KB || 200);
const MAX_MSGS_DAY = Number(process.env.MAX_MESSAGES_PER_CONVERSATION_PER_DAY || 40);

// === Webhook do uazapi ===
// Configurar no painel uazapi → Webhooks: POST https://seu-dominio/webhook/uazapi
//
// FORMATO REAL do uazapi (capturado em prod, 2026-05-06):
// {
//   "EventType": "messages",
//   "owner": "5551926342449",
//   "token": "...",
//   "chat": {
//     "id": "...",
//     "phone": "+55 11 98795-9188",
//     "name": "Paulo Melo",
//     "wa_chatid": "5511987959188@s.whatsapp.net",
//     ...
//   },
//   "message": {
//     "id": "...",
//     "fromMe": false,
//     "chatid": "5511987959188@s.whatsapp.net",
//     "sender": "162801037402112@lid",
//     "sender_pn": "5511987959188@s.whatsapp.net",
//     "senderName": "Paulo Melo",
//     "text": "oi",
//     "content": "oi",
//     "messageType": "Conversation" | "audio" | "image" | "document",
//     "mediaType": "" | "audio" | "image" | ...,
//     "buttonOrListid": "",
//     ...
//   }
// }

router.post('/uazapi', async (req, res) => {
  // Validação de secret opcional
  const secret = process.env.UAZAPI_WEBHOOK_SECRET;
  if (secret) {
    const got = req.headers['x-webhook-secret'] || req.headers['x-uazapi-secret'];
    if (got !== secret) {
      logger.warn('webhook uazapi: secret inválido');
      return res.status(401).json({ error: 'invalid secret' });
    }
  }

  const event = req.body || {};
  const eventType = event.EventType || event.eventType || event.type || event.event;
  const msg = event.message || {};
  const chat = event.chat || {};

  // Log resumido (String() defensivo — uazapi às vezes manda text/content como objeto/null)
  logger.info({
    eventType,
    fromMe: msg.fromMe,
    chatid: msg.chatid || chat.wa_chatid,
    senderName: msg.senderName || chat.name,
    text: String(msg.text || msg.content || '').slice(0, 80),
    messageType: msg.messageType,
    buttonId: msg.buttonOrListid || null,
  }, '[webhook uazapi]');

  // Log RAW completo enquanto estabiliza (desativar com LOG_WEBHOOK_FULL=false)
  if (process.env.LOG_WEBHOOK_FULL !== 'false') {
    logger.info({ payload: event }, '[webhook uazapi RAW]');
  }

  db.prepare('INSERT INTO events_log (kind, payload) VALUES (?, ?)')
    .run(`uazapi_${eventType || 'unknown'}`, JSON.stringify(event).slice(0, 8000));

  // Resposta rápida — processa assíncrono
  res.status(200).json({ ok: true });

  // KILL SWITCH: por padrão a Tina NÃO atende leads pelo uazapi. O canal de
  // lead é o GHL/Meta oficial; este número uazapi serve SÓ pra ENVIAR avisos no
  // grupo. Sem isso, se o webhook do uazapi apontar pro lcsdr, a Tina começa a
  // responder leads pelo número errado. Pra ligar o atendimento por uazapi um
  // dia: UAZAPI_INBOUND_ENABLED=true.
  if (process.env.UAZAPI_INBOUND_ENABLED !== 'true') {
    logger.info({ chatid: msg.chatid || chat.wa_chatid }, 'webhook uazapi: inbound DESATIVADO (só avisos no grupo) — ignorando mensagem');
    return;
  }

  try {
    // Ignora mensagens de GRUPO. A Tina é 1:1 e NUNCA responde em grupo. O
    // número uazapi participa do grupo interno do time (avisos de agendamento/
    // handoff), então mensagens de grupo chegam aqui — não pode virar conversa.
    // ⚠️ VEM ANTES do teste de `fromMe`: o que o time escreve no grupo também sai
    // deste número, e sem esta ordem cairia na detecção de humano abaixo, que
    // tentaria achar um contato pelo id do grupo.
    const chatId = String(msg.chatid || chat.wa_chatid || chat.id || '');
    if (chatId.includes('@g.us') || msg.isGroup === true || chat.isGroup === true) {
      logger.info({ chatId }, 'webhook uazapi: mensagem de GRUPO, ignorando (Tina é 1:1)');
      return;
    }

    // Saiu DESTE número: não vira conversa de entrada. Mas antes de descartar,
    // checa se foi um humano digitando — se foi, a Tina cede o turno.
    if (msg.fromMe === true || msg.wasSentByApi === true) {
      cederTurnoSeHumano(event, msg);
      return;
    }

    // Aceita: EventType "messages" (uazapi padrão), ou qualquer evento que
    // tenha shape de mensagem (message.text + message.chatid)
    const isMessageEvent = eventType === 'messages'
      || eventType === 'message'
      || eventType === 'messages.upsert'
      || (msg.chatid && (msg.text || msg.content || msg.mediaType));

    if (!isMessageEvent) {
      logger.warn({ eventType }, 'evento uazapi não é mensagem, ignorando');
      return;
    }

    // Dedup: se uazapi reentregar o mesmo message.id, ignora.
    if (alreadyProcessed('uazapi', msg.id)) {
      logger.info({ messageId: msg.id }, 'webhook uazapi: mensagem duplicada (já processada), ignorando');
      return;
    }

    await handleInbound(event);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'erro processando webhook uazapi');
    db.prepare('INSERT INTO events_log (kind, payload) VALUES (?, ?)')
      .run('error_uazapi', JSON.stringify({ err: err.message, event }).slice(0, 8000));
  }
});

// Extrai phone E.164 (5511...) de qualquer um dos formatos uazapi
function extractPhone(event) {
  const msg = event.message || {};
  const chat = event.chat || {};

  // Preferência: chatid normalizado (5511987959188@s.whatsapp.net)
  // Fallback: chat.phone formatado ("+55 11 98795-9188") ou sender_pn
  const candidates = [
    msg.chatid,
    msg.sender_pn,
    chat.wa_chatid,
    chat.phone,
    msg.from,
    msg.sender,
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    // Tira "@s.whatsapp.net", "@lid", espaços, +, hífens
    const digits = String(raw).split('@')[0].replace(/\D/g, '');
    // sender pode vir como "162801037402112@lid" (id interno, não phone) — descartar se menor que 10 dígitos
    if (digits && digits.length >= 10) return digits;
  }
  return null;
}

const AUTO_HUMAN_DETECTION = process.env.AUTO_HUMAN_DETECTION_ENABLED === 'true';

// ⚠️ SAÍDA DO PRÓPRIO NÚMERO: FOI A TINA OU FOI O CONSULTOR? (invariante #8)
// No uazapi tudo que sai deste número volta no webhook com `fromMe: true` — a
// resposta da Tina e o que o consultor digita do celular dele chegam IGUAIS.
// Antes os dois caíam no mesmo `if` de descarte, então o consultor podia assumir
// a conversa e a Tina seguia respondendo por cima, sem nunca ficar sabendo: é o
// caso do Gabriel (16/09), só que neste canal não existia trava nenhuma.
// Hoje não dói porque o lead atende pelo GHL, mas o dia em que um consultor
// dividir o número com a Tina (UAZAPI_INBOUND_ENABLED=true) é o dia em que isso
// volta a acontecer.
// A PROCEDÊNCIA resolve, igual ao canal GHL: todo envio nosso é registrado em
// tina_sent_msgs (markTinaSent, inclusive no ramo uazapi). Saída que NÃO está lá
// e não é automação = humano digitou → cede o turno.
function cederTurnoSeHumano(event, msg) {
  if (!AUTO_HUMAN_DETECTION) return false;
  if (msg.wasSentByApi === true) return false;                      // automação, não é gente
  if (isTinaSentMessage(msg.id)) return false;                      // foi a própria Tina
  if (!String(msg.text ?? msg.content ?? '').trim()) return false;  // sem texto: não é fala de ninguém
  const phone = extractPhone(event);
  if (!phone) return false;
  const contact = db.prepare(
    'SELECT id, ai_paused FROM contacts WHERE phone = ? OR ghl_contact_id = ?'
  ).get(phone, `wa-${phone}`);
  // Sem contato = a Tina nunca entrou nessa conversa. Já pausado = nada a fazer.
  if (!contact || contact.ai_paused) return false;
  handleSDRReply(contact.id, null);
  logger.info({ contactId: contact.id, messageId: msg.id },
    'uazapi: humano respondeu por este número — Tina pausada');
  return true;
}

// === Classificador de tipo de mensagem ===
// uazapi/Baileys mandam o tipo em msg.messageType com vários valores possíveis.
// Mapeamos cada um pra uma categoria interna + extrai conteúdo + URL de mídia.
//
// Tipos suportados (case-insensitive):
//   Conversation             → texto puro
//   ExtendedTextMessage      → texto com formatação (link/reply)
//   EphemeralMessage         → wrapper de mensagem efêmera (desempacota)
//   AudioMessage             → áudio
//   ImageMessage             → imagem (caption pode estar em .text)
//   DocumentMessage          → arquivo PDF/doc
//   VideoMessage             → vídeo (tratamos como image — só registra)
//   StickerMessage           → sticker (ignora)
//   LocationMessage          → localização (ignora)
//   ContactMessage           → contato vCard (ignora)
//   ButtonsResponseMessage / TemplateButtonReplyMessage → resposta de botão
//   ListResponseMessage      → resposta de lista
// Coage qualquer valor pra string limpa.
// Uazapi às vezes manda text/content como objeto (ex: {conversation: "oi"})
// ou como null/undefined. Esse helper garante que sempre retornamos string.
function safeString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    // Tenta extrair texto de objetos aninhados comuns do Baileys
    if (typeof v.conversation === 'string') return v.conversation;
    if (typeof v.text === 'string') return v.text;
    if (typeof v.body === 'string') return v.body;
    if (typeof v.caption === 'string') return v.caption;
    return '';
  }
  return String(v);
}

function classifyMessage(msg) {
  const rawType = safeString(msg.messageType || msg.mediaType).toLowerCase();
  // Tenta vários campos defensivamente, sempre coagindo pra string
  const text = (
    safeString(msg.text) ||
    safeString(msg.content) ||
    safeString(msg.caption) ||
    safeString(msg.body)
  ).trim();
  const buttonId = msg.buttonOrListid || msg.buttonReplyId || msg.listResponseId;

  // Botão/lista clicado tem prioridade — vem como mensagem normal mas com buttonOrListid setado
  if (buttonId) {
    return {
      category: 'button_reply',
      text,
      buttonId,
      mediaUrl: null,
    };
  }

  // Áudio
  if (/audio/.test(rawType) || msg.audioUrl || msg.audio) {
    return {
      category: 'audio',
      text,
      mediaUrl: msg.audioUrl || msg.audio?.url || msg.mediaUrl || null,
      mediaBase64: msg.audio?.base64 || msg.mediaBase64 || null,
    };
  }

  // Documento (PDF, doc, xlsx etc)
  if (/document/.test(rawType) || msg.documentUrl) {
    return {
      category: 'document',
      text,
      mediaUrl: msg.documentUrl || msg.mediaUrl || null,
      filename: msg.fileName || msg.filename || null,
    };
  }

  // Imagem (pode ter caption no text)
  if (/image/.test(rawType) || msg.imageUrl) {
    return {
      category: 'image',
      text,
      mediaUrl: msg.imageUrl || msg.mediaUrl || null,
    };
  }

  // Vídeo (tratamos como imagem — só registra)
  if (/video/.test(rawType) || msg.videoUrl) {
    return {
      category: 'video',
      text,
      mediaUrl: msg.videoUrl || msg.mediaUrl || null,
    };
  }

  // Sticker / Location / Contact — ignorar gentilmente
  if (/sticker/.test(rawType)) return { category: 'sticker', text: '', mediaUrl: null };
  if (/location/.test(rawType)) return { category: 'location', text: '', mediaUrl: null };
  if (/contact/.test(rawType)) return { category: 'contact', text: '', mediaUrl: null };

  // EphemeralMessage é wrapper — uazapi normalmente desempacota e popula .text/.content
  // Se chegou texto, trata como texto normal
  // Conversation, ExtendedTextMessage, EphemeralMessage, ou tipo desconhecido com texto → text
  if (text || /conversation|extendedtext|ephemeral|message$/.test(rawType)) {
    return { category: 'text', text, mediaUrl: null };
  }

  // Sem categoria reconhecida nem texto
  return { category: 'unknown', text: '', mediaUrl: null, rawType };
}

// Sincroniza o contato com o GHL (cria ou atualiza lá). Retorna o ID real
// do GHL, ou null se o GHL não estiver configurado / falhar.
// É resiliente: se o GHL cair, o atendimento continua com ID local `wa-`.
async function syncContactToGHL(phone, name) {
  if (!process.env.GHL_API_TOKEN || !process.env.GHL_LOCATION_ID) {
    return null; // GHL não configurado — segue só local
  }
  try {
    const r = await GHL.upsertContact({
      phone: phone.startsWith('+') ? phone : `+${phone}`,
      name: name || undefined,
      source: 'WhatsApp (Tina)',
      tags: ['tina-whatsapp'],
    });
    const id = r?.contact?.id || r?.id || null;
    if (id) {
      logger.info({ phone, ghlId: id, isNew: r?.new }, 'contato sincronizado com GHL');
    }
    return id;
  } catch (err) {
    logger.error({ phone, err: err.message }, 'falha ao sincronizar contato com GHL — usando ID local');
    return null;
  }
}

async function findOrCreateContactByPhone(phone, name) {
  // Busca local: por telefone OU pelo ID sintético antigo (wa-)
  let contact = db.prepare(
    'SELECT * FROM contacts WHERE phone = ? OR ghl_contact_id = ?'
  ).get(phone, `wa-${phone}`);

  if (contact) {
    if (name && !contact.name) {
      db.prepare('UPDATE contacts SET name = ? WHERE id = ?').run(name, contact.id);
      contact = { ...contact, name };
    }
    // Contato antigo ainda com ID sintético — tenta promover pro ID real do GHL
    if (typeof contact.ghl_contact_id === 'string' && contact.ghl_contact_id.startsWith('wa-')) {
      const ghlId = await syncContactToGHL(phone, name || contact.name);
      if (ghlId) {
        try {
          db.prepare('UPDATE contacts SET ghl_contact_id = ? WHERE id = ?').run(ghlId, contact.id);
          contact = { ...contact, ghl_contact_id: ghlId };
        } catch (err) {
          // UNIQUE colidiu (já existe linha com esse ID GHL) — mantém local, loga
          logger.warn({ contactId: contact.id, ghlId, err: err.message }, 'não promoveu ghl_contact_id (colisão)');
        }
      }
    }
    return contact;
  }

  // Contato novo: cria no GHL primeiro pra já nascer com o ID real
  const ghlId = await syncContactToGHL(phone, name);
  const finalId = ghlId || `wa-${phone}`;
  const info = db.prepare(`
    INSERT INTO contacts (ghl_contact_id, name, phone, stage)
    VALUES (?, ?, ?, 'novo')
  `).run(finalId, name || null, phone);
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid);
}

async function handleInbound(event) {
  const msg = event.message || {};
  const chat = event.chat || {};

  const phone = extractPhone(event);
  if (!phone) {
    logger.warn({ event }, 'handleInbound: sem phone identificável');
    return;
  }

  const name = msg.senderName || chat.name || chat.wa_name || null;
  const contact = await findOrCreateContactByPhone(phone, name);

  // Classifica a mensagem (Conversation/ExtendedText/Audio/Image/Document/etc)
  const m = classifyMessage(msg);
  logger.info({ category: m.category, hasText: !!m.text, hasMedia: !!m.mediaUrl }, '[uazapi] mensagem classificada');

  let content = m.text;
  let content_type = 'text';
  let attachment_url = m.mediaUrl;

  // === Tratamento por categoria ===
  switch (m.category) {
    case 'text': {
      // Conversation, ExtendedTextMessage, EphemeralMessage com texto puro
      // content já é m.text
      break;
    }

    case 'button_reply': {
      // Lead clicou num botão/lista da Tina
      const label = m.text || m.buttonId;
      content = `[lead clicou: ${label}] (valor=${m.buttonId})`;
      content_type = 'button_click';
      break;
    }

    case 'audio': {
      // AudioMessage → transcreve via Whisper
      try {
        let buf;
        if (m.mediaBase64) {
          buf = Buffer.from(m.mediaBase64, 'base64');
        } else if (m.mediaUrl) {
          const r = await fetch(m.mediaUrl);
          buf = Buffer.from(await r.arrayBuffer());
        }
        const transcript = buf ? await transcribeAudioBuffer(buf) : null;
        content = transcript || '[áudio recebido — falha na transcrição]';
        content_type = 'audio_transcript';
      } catch (err) {
        logger.error({ err: err.message }, 'falha transcrevendo áudio');
        content = '[áudio recebido — não consegui ouvir]';
        content_type = 'audio_transcript';
      }
      break;
    }

    case 'document': {
      // DocumentMessage (PDF, doc) → bloqueia, delega pra leitura crítica
      recordInbound(contact.id, {
        content: `[lead enviou arquivo${m.filename ? `: ${m.filename}` : ''}]`,
        content_type: 'pdf_blocked',
        attachment_url: m.mediaUrl,
      });
      const txt = 'Opa, análise de arquivo a gente faz na etapa de leitura crítica com a equipe. Me conta em texto: o livro já está finalizado?';
      await sendText(contact, txt).catch(err => logger.error({ err: err.message }, 'send fail'));
      recordOutbound(contact.id, { author: 'ia', content: txt });
      return;
    }

    case 'image': {
      // ImageMessage → registra (caption se houver), não analisa imagem
      content = m.text || '[lead enviou uma imagem]';
      content_type = 'image';
      break;
    }

    case 'video': {
      // VideoMessage → registra mas não analisa
      content = m.text || '[lead enviou um vídeo]';
      content_type = 'video';
      break;
    }

    case 'sticker':
    case 'location':
    case 'contact': {
      // Tipos não-comerciais — registra e responde gentilmente
      const labels = { sticker: 'figurinha', location: 'localização', contact: 'contato' };
      recordInbound(contact.id, {
        content: `[lead enviou ${labels[m.category]}]`,
        content_type: m.category,
      });
      // Não responde automaticamente — espera próxima mensagem do lead
      logger.info({ category: m.category, contactId: contact.id }, 'tipo não-comercial recebido, sem resposta automática');
      return;
    }

    case 'unknown':
    default: {
      logger.warn({ rawType: m.rawType, msg }, 'tipo de mensagem não reconhecido');
      return;
    }
  }

  // Após o switch: precisa ter conteúdo pra processar
  if (!content || !content.trim()) {
    logger.warn({ phone, category: m.category }, 'mensagem sem conteúdo processável, ignorando');
    return;
  }

  recordInbound(contact.id, { content, content_type, attachment_url });

  // === Lock por contato ===
  // Serializa LLM call + send + update por contactId. Sem isso, 2 mensagens
  // do mesmo lead em <1s rodam 2 chamadas LLM paralelas que leem o mesmo
  // histórico e respondem coisas conflitantes.
  await withContactLock(contact.id, async () => {
    // Re-lê o estado fresh DENTRO do lock (pode ter mudado enquanto esperava)
    const fresh = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
    if (!fresh) return;

    if (fresh.ai_paused) {
      logger.info({ contactId: fresh.id }, 'IA pausada (SDR no controle), só registrando');
      scheduleFollowup(contact.id, 'silencio_sdr');
      return;
    }

    if (countMessagesToday(contact.id) > MAX_MSGS_DAY) {
      logger.warn({ contactId: contact.id }, 'limite diário atingido, pausando IA');
      pauseIA(contact.id, 'limite_mensagens_dia');
      return;
    }

    // Gera resposta
    const result = await generateTinaReply({ contact: fresh, incomingText: content });

    const items = result.split && result.split.length ? result.split : [result.reply];
    await sendSequence(fresh, items);
    for (const item of items) {
      const txt = typeof item === 'string' ? item : (item?.text || '');
      if (txt) recordOutbound(fresh.id, { author: 'ia', content: txt, usage: result.usage });
    }

    // Atualiza estado
    if (result.funnel || result.stage) {
      db.prepare(`
        UPDATE contacts
        SET funnel = COALESCE(?, funnel),
            stage = COALESCE(?, stage),
            qualification_score = ?,
            qualification_notes = COALESCE(?, qualification_notes),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        result.funnel || null,
        result.stage || null,
        result.qualification_score || fresh.qualification_score || 0,
        result.qualification_notes || null,
        fresh.id
      );
    }

    // Etiquetas tina-* no GHL (interesse, agenda, dúvida-curso, temperatura)
    await applyTinaTags(fresh, result);

    if (result.handoff || result.stage === 'qualificado') {
      await markQualifiedAndHandoff(fresh, result);
    } else if (result.stage === 'desqualificado' || result.end_conversation) {
      await markDisqualified(fresh, result);
    } else {
      scheduleFollowup(fresh.id, 'silencio_lead');
    }
  });
}

export default router;

// Exportado pra testes (scripts/test-turno-uazapi.mjs)
export { cederTurnoSeHumano };
