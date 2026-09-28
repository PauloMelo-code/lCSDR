// Tina via Google Gemini (gemini-3.0-flash por padrão)
//
// Usa structured output nativo do Gemini (responseMimeType json +
// responseSchema) pra garantir JSON válido, equivalente ao json_schema
// strict da OpenAI. systemInstruction recebe o prompt (cacheável).
//
// Custos por 1M tokens são configuráveis por env (GEMINI_COST_*), pois
// variam por modelo. Defaults aproximados (estimativa do dashboard, não
// billing). Ajuste GEMINI_COST_IN/OUT/CACHED_IN conforme o pricing do 3.0.

import { GoogleGenAI, Type } from '@google/genai';
import { TINA_SYSTEM_PROMPT, PROMPT_VERSION } from './systemPrompt.js';
import { SERVICOS, resolveServiceKey } from './knowledge.js';
import { db } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { marcasDeTempo } from '../utils/historyTime.js';

const VALID_SERVICES = new Set(Object.keys(SERVICOS));
const PROVIDER = 'gemini';
const MAX_HISTORY_TOKENS = Number(process.env.LLM_HISTORY_MAX_TOKENS || 8000);

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

const COST_IN_PER_MTOK = Number(process.env.GEMINI_COST_IN || 0.30);
const COST_CACHED_IN_PER_MTOK = Number(process.env.GEMINI_COST_CACHED_IN || 0.075);
const COST_OUT_PER_MTOK = Number(process.env.GEMINI_COST_OUT || 2.50);

// Client LAZY: só constrói quando este provider é usado (evita warning de
// chave ausente quando o primário é outro).
let _client;
function getClient() {
  if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _client;
}

// === Schema de saída (structured output do Gemini) ===
// split é só array de strings: o WhatsApp oficial não tem botões, então a
// Tina manda bolhas de texto. Simplifica o schema e evita anyOf.
const TINA_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reply: { type: Type.STRING, description: 'Texto da resposta (1-3 linhas). Vazio se usar split.' },
    split: {
      type: Type.ARRAY,
      nullable: true,
      items: { type: Type.STRING },
      description: 'Bolhas de texto em sequência (2-3). Sobrescreve reply quando preenchido.',
    },
    funnel: {
      type: Type.STRING,
      nullable: true,
      // sem enum aqui de propósito: enum + nullable no Gemini pode forçar um
      // valor e nunca emitir null. O prompt restringe a escrever|publicar|divulgar|null.
      description: 'Fase do lead: "escrever", "publicar", "divulgar" ou null se ainda não identificada.',
    },
    service_recommended: { type: Type.STRING, nullable: true },
    stage: {
      type: Type.STRING,
      enum: ['pre_qualificando', 'qualificando', 'qualificado', 'handoff', 'desqualificado'],
    },
    handoff: { type: Type.BOOLEAN },
    handoff_reason: { type: Type.STRING, nullable: true },
    qualification_score: { type: Type.INTEGER },
    qualification_notes: { type: Type.STRING },
    end_conversation: { type: Type.BOOLEAN },
    course_help: { type: Type.STRING, enum: ['nao', 'comprar', 'aluno'] },
    book_slot: {
      type: Type.STRING,
      nullable: true,
      description: 'ISO do horário que o lead confirmou agendar (copie EXATO da lista de horários disponíveis). null se não está agendando agora.',
    },
    search_book: {
      type: Type.STRING,
      nullable: true,
      description: 'Título do livro (+ autor, se souber) pra o sistema pesquisar o link de venda e confirmar com o lead. Preencha SÓ quando o lead disser que tem livro publicado e informar o título, mas não tiver mandado o link. Você NÃO inventa o link, só passa o título aqui. null caso contrário.',
    },
    handoff_mode: {
      type: Type.STRING,
      nullable: true,
      enum: ['agora', 'agendar'],
      description: 'Como o lead QUALIFICADO quer ser atendido: "agora" = quer falar com um especialista na hora (vai pro próximo da fila). "agendar" = prefere marcar um horário. null se ainda não perguntou/decidiu.',
    },
  },
  required: [
    'reply', 'split', 'funnel', 'stage', 'handoff',
    'qualification_score', 'qualification_notes', 'end_conversation', 'course_help',
  ],
  propertyOrdering: [
    'reply', 'split', 'funnel', 'service_recommended', 'stage', 'handoff',
    'handoff_reason', 'qualification_score', 'qualification_notes',
    'end_conversation', 'course_help', 'book_slot', 'search_book', 'handoff_mode',
  ],
};

function sanitizeName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  const name = rawName.trim();
  if (!name || name.length < 2) return null;
  if (/\d/.test(name)) return null;
  if (/^[\W_]+$/.test(name)) return null;
  return name;
}

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// Histórico no formato Gemini: role 'user' | 'model', parts:[{text}]
function buildHistory(contactId, limit = 30) {
  // As N mensagens MAIS RECENTES, devolvidas em ordem cronológica.
  // ⚠️ ERA `ORDER BY created_at ASC LIMIT 30` = as 30 mais ANTIGAS: passando de 30
  // mensagens a janela CONGELAVA no começo da conversa e a Tina nunca mais via o
  // que o lead acabou de dizer — ela lembrava do @ do Instagram do início e pedia
  // de novo o e-mail/horário que o lead tinha dado 1 minuto antes, em loop. Era a
  // causa raiz das "mensagens repetidas" (9 relatos da LC entre 02/07 e 11/08).
  let rows = db.prepare(`
    SELECT * FROM (
      SELECT direction, author, content, content_type, created_at, id
      FROM messages
      WHERE contact_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    ) ORDER BY created_at ASC, id ASC
  `).all(contactId, limit);

  let totalTokens = rows.reduce((s, m) => s + estimateTokens(m.content), 0);
  if (totalTokens > MAX_HISTORY_TOKENS) {
    const kept = [];
    let cum = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const t = estimateTokens(rows[i].content);
      if (cum + t > MAX_HISTORY_TOKENS) break;
      cum += t;
      kept.unshift(rows[i]);
    }
    logger.warn(
      { contactId, original: rows.length, kept: kept.length },
      'history truncado por exceder MAX_HISTORY_TOKENS'
    );
    rows = [
      { direction: 'inbound', author: 'lead', content: '[contexto anterior truncado por tamanho — segue só os últimos turnos]', content_type: 'text' },
      ...kept,
    ];
  }

  // A janela agora começa no meio da conversa, então pode começar com uma fala da
  // Tina — e o Gemini recusa `contents` que não comece com 'user'. Descarta as
  // saídas do topo até a primeira mensagem do lead.
  while (rows.length && rows[0].direction !== 'inbound') rows.shift();

  const marcas = marcasDeTempo(rows);   // avisa saltos de tempo (invariante #3)
  const turns = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const role = m.direction === 'inbound' ? 'user' : 'model';
    let text = m.content || '';
    if (m.content_type === 'audio_transcript' && !text.startsWith('[áudio')) text = `[áudio transcrito] ${text}`;
    if (m.content_type === 'pdf_blocked') text = `[o lead mandou um PDF — você respondeu que análise é etapa de leitura crítica]`;
    if (m.author === 'sdr') text = `[SDR humano respondeu] ${text}`;
    const marca = marcas.get(i);
    if (marca) text = `${marca}\n${text}`;
    turns.push({ role, parts: [{ text }] });
  }
  return turns;
}

function tryParseJSON(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// Erro transitório da Google que vale retry (503/500/429/timeout/conn).
function isTransientGeminiError(err) {
  const msg = String(err?.message || '');
  const status = err?.status || err?.code;
  if (status === 503 || status === 500 || status === 429) return true;
  return /503|500|429|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(msg);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Chama generateContent com até N retries em erro transitório (backoff: 0.4s, 1s).
async function generateWithRetry(req, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await getClient().models.generateContent(req);
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransientGeminiError(err)) {
        const delay = attempt === 0 ? 400 : 1000;
        logger.warn({ attempt: attempt + 1, err: err.message }, 'Gemini transitório, retry com backoff');
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Descreve uma imagem que o lead enviou, usando a visão multimodal do Gemini.
// Roda no webhook (igual ao Whisper pro áudio): vira texto e entra no
// histórico como contexto. Retorna 1-2 frases ou null se não der.
// Transcreve áudio do lead pelo Gemini — alternativa ao Whisper.
// ⚠️ Existe porque o Whisper depende da OPENAI_API_KEY e, quando ela expira, a Tina
// para de ouvir áudio SEM NINGUÉM PERCEBER: o chat roda no Gemini e continua normal,
// então só o áudio (e o plano B do chat) quebram. Foi o que aconteceu — Whisper
// devolvendo 401 invalid_api_key, e a queixa "não está ouvindo os áudios" (LC 25/09).
export async function transcribeAudioBufferGemini(buffer, mime = 'audio/ogg') {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!buffer || !buffer.length) return null;
  try {
    const resp = await generateWithRetry({
      model: MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
          { text: 'Transcreva EXATAMENTE o que a pessoa fala neste áudio, em português do Brasil. Responda só a transcrição, sem preâmbulo, sem aspas e sem comentários. Se não houver fala audível, responda apenas: VAZIO' },
        ],
      }],
      config: {
        temperature: 0,
        maxOutputTokens: 800,
        thinkingConfig: { thinkingLevel: 'low' },
        abortSignal: AbortSignal.timeout(30_000),
      },
    });
    const t = (resp.text || '').trim();
    if (!t || /^vazio$/i.test(t)) return null;
    return t;
  } catch (err) {
    logger.error({ err: err.message }, 'falha ao transcrever áudio (Gemini)');
    return null;
  }
}

export async function describeImageBuffer(buffer, mime = 'image/jpeg') {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('GEMINI_API_KEY ausente — descrição de imagem pulada');
    return null;
  }
  if (!buffer || !buffer.length) return null;
  try {
    const resp = await generateWithRetry({
      model: MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
          { text: 'Você é assistente de uma agência literária. Em 1-2 frases objetivas e em português, descreva o que o lead enviou nesta imagem. Se for capa/foto de um livro, diga o título (se legível) e o tema. Se for print de conversa, documento ou tela, resuma o essencial. Responda só a descrição, sem preâmbulo.' },
        ],
      }],
      config: {
        temperature: 0.2,
        maxOutputTokens: 300,
        thinkingConfig: { thinkingLevel: 'low' },
        abortSignal: AbortSignal.timeout(25_000),
      },
    });
    return (resp.text || '').trim() || null;
  } catch (err) {
    logger.error({ err: err.message }, 'falha ao descrever imagem (Gemini vision)');
    return null;
  }
}

export async function generateTinaReplyGemini({ contact, incomingText, extraContext = null }) {
  const history = buildHistory(contact.id);
  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    history.push({ role: 'user', parts: [{ text: incomingText }] });
  }

  const usableName = sanitizeName(contact.name);
  let meta = `
Contexto atual do lead (NÃO responda sobre isso, só use pra calibrar):
- Nome: ${usableName || '⚠ AINDA NÃO CONHECIDO — chame de "Escritor(a)" ou use saudação genérica até o lead se apresentar'}
- Funil detectado até agora: ${contact.funnel || 'ainda não identificado'}
- Estágio: ${contact.stage || 'novo'}
- Última nota de qualificação: ${contact.qualification_notes || 'nenhuma'}
`.trim();
  if (extraContext) meta += `\n\n${extraContext}`;

  // timeout de 25s (mesma justificativa dos outros providers)
  //
  // thinkingConfig: o Gemini 3 Flash "pensa" antes de responder, e esse
  // raciocínio CONSOME o maxOutputTokens. Sem controlar, o JSON sai truncado
  // (resposta inválida → fallback). Pra uma SDR queremos resposta rápida e
  // direta: thinkingLevel baixo + teto de tokens folgado garantem o JSON
  // completo. Configurável por env (GEMINI_THINKING_LEVEL, GEMINI_MAX_TOKENS).
  const thinkingLevel = process.env.GEMINI_THINKING_LEVEL || 'low';
  const maxOutputTokens = Number(process.env.GEMINI_MAX_TOKENS || 2048);

  // Retry com backoff em 503/429/timeout transitório da Google. Reabsorve o
  // tranco curto SEM acionar o fallback OpenAI (que é mais lento/caro).
  const resp = await generateWithRetry({
    model: MODEL,
    contents: history,
    config: {
      systemInstruction: `${TINA_SYSTEM_PROMPT}\n\n${meta}`,
      temperature: 0.7,
      maxOutputTokens,
      thinkingConfig: { thinkingLevel },
      responseMimeType: 'application/json',
      responseSchema: TINA_SCHEMA,
      abortSignal: AbortSignal.timeout(25_000),
    },
  });

  const raw = (resp.text || '').trim();
  const parsed = tryParseJSON(raw);

  const um = resp.usageMetadata || {};
  const cached = um.cachedContentTokenCount || 0;
  const tokens_in = um.promptTokenCount || 0;
  const tokens_out = um.candidatesTokenCount || 0;
  const non_cached_in = Math.max(0, tokens_in - cached);

  const cost_usd =
    (non_cached_in / 1e6) * COST_IN_PER_MTOK +
    (cached / 1e6) * COST_CACHED_IN_PER_MTOK +
    (tokens_out / 1e6) * COST_OUT_PER_MTOK;

  const meta_usage = {
    tokens_in,
    tokens_out,
    cached_tokens: cached,
    cost_usd,
    provider: PROVIDER,
    model: MODEL,
    prompt_version: PROMPT_VERSION,
  };

  if (!parsed || (!parsed.reply && !parsed.split)) {
    logger.warn({ raw: raw.slice(0, 300) }, 'Tina (Gemini) devolveu JSON inválido, usando fallback');
    return {
      reply: 'Deixa eu te conectar com alguém aqui do time, [aguarde um instante].',
      funnel: null,
      stage: 'pre_qualificando',
      handoff: true,
      llm_failed: true,
      handoff_reason: 'IA falhou em gerar resposta válida — encaminhando ao humano',
      qualification_score: 0,
      qualification_notes: '⚠ Tina falhou em gerar resposta válida',
      end_conversation: false,
      usage: meta_usage,
    };
  }

  // Normaliza service_recommended pra chave canônica (aceita nome OU chave).
  // Só descarta (e avisa) se NÃO casar com nenhum serviço real do catálogo.
  if (parsed.service_recommended) {
    const key = resolveServiceKey(parsed.service_recommended);
    if (key) {
      parsed.service_recommended = key;
    } else {
      logger.warn({ invented: parsed.service_recommended }, 'Tina (Gemini) citou serviço fora do catálogo — descartando');
      parsed.service_recommended = null;
    }
  }

  return { ...parsed, usage: meta_usage };
}
