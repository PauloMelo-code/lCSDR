import fetch from 'node-fetch';
import FormData from 'form-data';
import { logger } from './logger.js';

// Usa Whisper (OpenAI) apenas pra transcrever áudio. Robusto e barato.
// Expõe duas formas: pela URL (baixa sem auth) e por Buffer (quando já baixamos com auth GHL).

// Transcrição com DOIS provedores. Whisper (OpenAI) é o principal; se ele falhar
// por qualquer motivo — chave ausente, expirada, 401, cota, instabilidade — cai no
// Gemini. ⚠️ Sem essa rede a Tina fica SURDA em silêncio: o chat roda no Gemini e
// segue normal, então ninguém percebe que só o áudio parou. Foi exatamente o caso
// da LC (25/09): Whisper devolvendo 401 invalid_api_key havia semanas.
export async function transcribeAudioBuffer(buffer, { filename = 'audio.ogg', mime = 'audio/ogg' } = {}) {
  const viaWhisper = await transcribeWhisper(buffer, { filename, mime });
  if (viaWhisper) return viaWhisper;
  const { transcribeAudioBufferGemini } = await import('../agent/tina-gemini.js');
  const viaGemini = await transcribeAudioBufferGemini(buffer, mime);
  if (viaGemini) {
    logger.warn('Whisper indisponível — áudio transcrito pelo Gemini (plano B)');
    return viaGemini;
  }
  logger.error('transcrição falhou nos DOIS provedores (Whisper e Gemini)');
  return null;
}

async function transcribeWhisper(buffer, { filename = 'audio.ogg', mime = 'audio/ogg' } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY ausente — Whisper pulado');
    return null;
  }
  try {
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mime });
    form.append('model', 'whisper-1');
    form.append('language', 'pt');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`whisper ${res.status}: ${body}`);
    }
    const json = await res.json();
    return json.text || null;
  } catch (err) {
    logger.error({ err: err.message }, 'Falha na transcrição Whisper');
    return null;
  }
}

export async function transcribeAudio(audioUrl) {
  try {
    const r = await fetch(audioUrl);
    if (!r.ok) throw new Error(`download áudio ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return transcribeAudioBuffer(buf);
  } catch (err) {
    logger.error({ err: err.message }, 'Falha ao baixar áudio');
    return null;
  }
}
