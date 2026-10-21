// Cliente uazapi — provedor brasileiro de API WhatsApp
// Token via header `token: <UAZAPI_TOKEN>` (não Authorization Bearer)
// Endpoints usados:
//   POST /send/text  — mensagem texto simples
//   POST /send/menu  — mensagem com botões/lista (interativa)
//   POST /send/media — futuro: mandar imagem/áudio/doc

import fetch from 'node-fetch';
import { logger } from '../utils/logger.js';

const BASE = process.env.UAZAPI_BASE || 'https://liaautomacoes.uazapi.com';

function tokenOrThrow() {
  const t = process.env.UAZAPI_TOKEN;
  if (!t) throw new Error('UAZAPI_TOKEN ausente no .env');
  return t;
}

// Retry simples pra 429/5xx
async function uaz(method, path, body, { retries = 2 } = {}) {
  const url = `${BASE}${path}`;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    token: tokenOrThrow(),
  };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (res.ok) return json;

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = 2 ** attempt * 600;
        logger.warn({ path, status: res.status, attempt, waitMs: wait }, 'uazapi retry');
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      logger.error({ method, path, status: res.status, body: json }, 'uazapi error');
      const err = new Error(`uazapi ${method} ${path} → ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    } catch (err) {
      lastErr = err;
      if (err.status) throw err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2 ** attempt * 600));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// === API ===
export const UAZAPI = {
  /**
   * Envia mensagem de texto simples.
   * @param {string} number — formato E.164 sem +, ex: "5511987959188"
   * @param {string} text
   */
  async sendText(number, text) {
    return uaz('POST', '/send/text', { number, text });
  },

  /**
   * Envia menu com botões/lista interativa.
   *
   * @param {object} opts
   * @param {string} opts.number
   * @param {string} opts.text — corpo da mensagem
   * @param {string} [opts.footerText] — texto pequeno embaixo
   * @param {string[]} opts.choices — formato "Label|valor"
   *   - valor pode ser:
   *     - string qualquer → vira reply (a Tina recebe "valor" no webhook)
   *     - URL `https://...` → botão de link
   *     - `call:+5511...` → botão de ligar
   * @param {'button'|'list'} [opts.type='button'] — button (até 3) ou list (até 10)
   */
  async sendMenu({ number, text, choices, footerText, type = 'button' }) {
    return uaz('POST', '/send/menu', {
      number, type, text, choices, footerText,
    });
  },

  /** Helper: lista (mais de 3 opções) */
  async sendList(opts) {
    return this.sendMenu({ ...opts, type: 'list' });
  },

  /**
   * Envia mídia (imagem, documento) com legenda opcional.
   * Usado pela imagem de orientação que acompanha o agendamento com closer
   * (regra LC 15/10).
   *
   * @param {object} opts
   * @param {string} opts.number — E.164 sem +
   * @param {string} opts.file — URL pública do arquivo
   * @param {'image'|'document'|'video'} [opts.type='image']
   * @param {string} [opts.text] — legenda
   */
  async sendMedia({ number, file, type = 'image', text = '' }) {
    return uaz('POST', '/send/media', { number, type, file, text });
  },

  /** Status da conexão da instância */
  async status() {
    return uaz('GET', '/instance/status');
  },
};

// Normaliza número de WhatsApp pro formato uazapi (5511...)
export function normalizePhone(raw) {
  if (!raw) return null;
  // Remove tudo que não é dígito; preserva formato E.164 sem +
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // Se começar com 0, drop. Se vier sem 55, assume Brasil.
  if (digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 10 || digits.length === 11) return '55' + digits; // sem DDI
  return digits;
}

export default UAZAPI;
