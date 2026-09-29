// Guardrail determinístico da Tina (cinto de segurança pós-IA).
//
// Roda DEPOIS da IA gerar e ANTES de enviar. Não é outro LLM (não alucina):
// são regras fixas que CORRIGEM ou BLOQUEIAM as falhas que quebram a confiança
// do cliente e descaracterizam a SDR. Toda violação é registrada (pra métricas
// e pra provar que "é impossível a Tina soltar preço / virar bot").
//
// Severidades:
//   block  → troca a mensagem inteira pela resposta-cofre (ex: vazou preço)
//   fix    → conserta cirurgicamente e mantém a mensagem (ex: "custo"→"investimento")
//   flag   → não altera, só registra pra acompanhamento (ex: não terminou com pergunta)
//
// O guard é env-desligável (POLICY_GUARD_ENABLED=false) mas vem LIGADO por padrão.

import { db } from '../db/index.js';
import { logger } from '../utils/logger.js';

const ENABLED = process.env.POLICY_GUARD_ENABLED !== 'false';

// Valores que a Tina PODE citar (gate de qualificação + livro público).
// Qualquer outro valor monetário >= R$ 1.000 é preço de serviço proibido.
// Único valor que a Tina pode citar: o livro público "O Livro Secreto" (R$ 59,90).
// Qualquer outro número de dinheiro é bloqueado (regra Lilian: nunca preço).
const VALORES_PERMITIDOS = new Set([59.9, 59, 60]);

// Converte "7.800", "50.000", "1.299,90", "629", "59,90" → Number em reais.
function parseBRL(raw) {
  let s = String(raw).trim();
  // tem vírgula decimal? então pontos são milhar
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/\.(?=\d{3}\b)/g, ''); // ponto de milhar (1.000 → 1000)
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Detecta QUALQUER valor de dinheiro proibido. Regra Lilian (15/06): a Tina
// não fala NENHUM número de dinheiro, exceto o livro público (R$ 59,90).
// Ou seja: qualquer "R$ X" que não seja o livro é bloqueado.
function detectPriceLeak(text) {
  if (!text) return false;

  // 1) Qualquer valor com R$ que não seja o livro (59,90/59/60)
  const reMoney = /R\$\s?([\d][\d.,]*)/gi;
  let m;
  while ((m = reMoney.exec(text)) !== null) {
    const val = parseBRL(m[1]);
    if (val == null) continue;
    if (!VALORES_PERMITIDOS.has(val)) return true;
  }

  // 2) "X mil" perto de contexto financeiro (investimento/valor/custa/reais),
  //    sem pegar prova social tipo "5 mil livros divulgados".
  const reMil = /(?:investiment\w+|valor\w*|custa\w*|fica em|sai por|sai a|or[çc]ament\w+|a partir de|parte de|R\$)[^.!?]{0,25}\b(\d{1,3})\s*mil\b/i;
  if (reMil.test(text)) return true;
  // "cinquenta mil", "sete mil e oitocentos" perto de financeiro
  const reMilExt = /(?:investiment\w+|valor\w*|custa\w*|or[çc]ament\w+)[^.!?]{0,30}\b(?:mil|cem mil|cinquenta mil|sete mil)\b/i;
  if (reMilExt.test(text)) return true;

  return false;
}

// Correções cirúrgicas que mantêm a mensagem (regex → substituição).
const FIXES = [
  // Master/Press LC → descrição genérica por DURAÇÃO (preserva comparação:
  // se trocasse os 2 pelo mesmo termo, viraria "Assessoria vs Assessoria").
  // Master = longa duração / Press = curta duração. Quem nomeia é o Closer.
  { re: /\bMaster\s*LC\b/gi, to: 'a Assessoria de Imprensa de longa duração', tag: 'master_press' },
  { re: /\bPress\s*LC\b/gi, to: 'a Assessoria de Imprensa de curta duração', tag: 'master_press' },
  // Veículos específicos → genérico (sem quebrar "Café com Deus Pai" etc)
  { re: /\b(Globo|CNN|Folha de S\.?\s?Paulo|Folha|Veja|Record|SBT|Band)\b/g, to: 'grandes veículos', tag: 'veiculo_especifico' },
  // "custo(s)" → "investimento(s)"
  { re: /\bcustos\b/gi, to: 'investimentos', tag: 'palavra_custo' },
  { re: /\bcusto\b/gi, to: 'investimento', tag: 'palavra_custo' },
  // "Dr." / "Dra." antes de nome → remove o pronome
  { re: /\bDr[ª.ao]?\.?\s+(?=[A-ZÀ-Ú])/g, to: '', tag: 'dr_dra' },
  // Encerramentos de bot (não-SDR)
  { re: /\b(fico|estou|estamos)\s+(à|a)\s+disposi[çc][ãa]o\b\.?/gi, to: '', tag: 'encerramento_bot' },
];

// Frases que denunciam comportamento de bot/atendente (flag, não bloqueia).
const FLAG_PHRASES = [
  /qualquer d[úu]vida,?\s*(me avise|estou aqui|é s[óo] chamar)/i,
  /espero ter ajudado/i,
];

function applyFixesToText(text, violations) {
  if (!text) return text;
  let out = text;
  for (const f of FIXES) {
    if (f.re.test(out)) {
      out = out.replace(f.re, f.to);
      violations.push(f.tag);
    }
    f.re.lastIndex = 0;
  }
  // colapsa repetição criada pela substituição ("grandes veículos e grandes veículos")
  out = out.replace(/grandes ve[íi]culos(\s*[,e]+\s*grandes ve[íi]culos)+/gi, 'grandes veículos');
  // colapsa artigo duplicado criado pela substituição ("a a Assessoria" → "a Assessoria")
  out = out.replace(/\b([aoAO])\s+(a|o)\s+(Assessoria)/g, '$2 $3');
  // normaliza espaços que sobraram de remoções
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

// ─── NÃO PEÇA O QUE O LEAD JÁ RESPONDEU (regra LC, a queixa mais reincidente) ───
// Aparece 8 vezes no documento da LC: "questionando o que o lead já havia
// informado", "não pode ficar repetindo a mesma pergunta", "pergunta de novo
// depois de o lead confirmar", "falou do @ 8 vezes na mesma conversa", "não
// completou a frase e se identificou de novo". Até aqui só havia regra no prompt —
// e o modelo desobedece. Estas são travas: o texto é corrigido ANTES de sair.
//
// Recorta a FRASE (não a bolha inteira) que contém a pergunta indevida.
function removerFrase(texto, teste) {
  const frases = String(texto).split(/(?<=[.!?…])\s+/);
  const mantidas = frases.filter(f => !teste(f));
  if (!mantidas.length) return '';
  return mantidas.join(' ').replace(/\s{2,}/g, ' ').trim();
}

const PERGUNTA_EMAIL = /\be-?mail\b/i;
const REAPRESENTACAO = /\baqui\s+[ée]\s+a\s+tina\b|\bsou a tina\b|\bmeu nome [ée] tina\b/i;

// Aplica só o que depende do ESTADO do contato (por isso fora do FIXES genérico).
function aplicarTravasDeContexto(result, contact, violations) {
  const jaTemEmail = !!(contact?.email && /@/.test(contact.email));
  const jaConversou = !!contact?.last_outbound_at;
  if (!jaTemEmail && !jaConversou) return;

  // snapshot pra poder desfazer se a limpeza esvaziar a mensagem
  const antes = { reply: result.reply, split: Array.isArray(result.split) ? [...result.split] : result.split };

  eachText(result, texto => {
    if (!texto) return texto;
    let out = texto;

    // 1) Pedir e-mail que já temos. ❌ ERRO REAL: o lead mandou o e-mail e a Tina
    // pediu de novo 11 segundos depois.
    // Tira a BOLHA inteira, não só a frase: recortar só a pergunta deixava órfã a
    // frase que a explicava ("É pra onde vai o convite."), sem sentido sozinha.
    if (jaTemEmail && PERGUNTA_EMAIL.test(out) && /\?/.test(out)) {
      violations.push('repetiu_pergunta_email');
      out = '';
    }

    // 2) Se reapresentar no meio da conversa. ❌ ERRO REAL: se apresentou 8 vezes
    // na mesma conversa e a lead pediu atendimento humano 3 vezes.
    if (jaConversou && REAPRESENTACAO.test(out)) {
      const semApresentacao = removerFrase(out, f => REAPRESENTACAO.test(f));
      if (semApresentacao !== out) { violations.push('reapresentacao'); out = semApresentacao; }
    }

    return out;
  });

  // Rede de segurança: se as travas esvaziaram TUDO, DESFAZ — melhor uma mensagem
  // redundante do que a Tina muda (o turno mudo é uma falha pior que a repetição).
  if (!allTextOf(result).trim()) {
    result.reply = antes.reply;
    result.split = antes.split;
    violations.push('travas_desfeitas_texto_vazio');
    return;
  }
  // Tira bolhas que ficaram vazias depois do recorte.
  if (Array.isArray(result.split)) {
    result.split = result.split.filter(i => (typeof i === 'string' ? i.trim() : (i?.text || '').trim()));
  }
}

// Extrai todos os textos da resposta (reply + split bubbles).
function eachText(result, fn) {
  if (typeof result.reply === 'string' && result.reply) result.reply = fn(result.reply);
  if (Array.isArray(result.split)) {
    result.split = result.split.map(item => {
      if (typeof item === 'string') return fn(item);
      if (item && typeof item === 'object' && item.text) item.text = fn(item.text);
      return item;
    });
  }
}

function allTextOf(result) {
  const parts = [];
  if (result.reply) parts.push(result.reply);
  if (Array.isArray(result.split)) {
    for (const it of result.split) parts.push(typeof it === 'string' ? it : (it?.text || ''));
  }
  return parts.join(' ');
}

// Resposta-cofre quando vaza preço: troca a mensagem inteira por uma versão
// SEM número (o especialista é quem fala valor). Sonda investimento aberto.
function priceVaultMessage(contact) {
  const nome = contact?.name && !/\d/.test(contact.name) ? contact.name : null;
  const ola = nome ? `${nome}, ` : '';
  return [
    `${ola}o investimento é personalizado conforme o projeto, e quem apresenta a proposta completa é nosso especialista.`,
    `Posso te conectar com ele pra detalhar tudo. Você já tem uma ideia de investimento pra esse próximo passo?`,
  ];
}

/**
 * Aplica o guardrail. Retorna { result, violations, blocked }.
 * Muta o result (corrige textos) e, se necessário, substitui a mensagem.
 */
export function applyPolicyGuard(result, contact = {}) {
  if (!ENABLED || !result) return { result, violations: [], blocked: false };

  const violations = [];

  // 1) PREÇO — severidade máxima: bloqueia e troca pela resposta-cofre.
  if (detectPriceLeak(allTextOf(result))) {
    violations.push('price_leak');
    result.reply = '';
    result.split = priceVaultMessage(contact);
    // garante que continua sendo uma SDR coerente
    if (!result.stage) result.stage = 'qualificando';
    logViolations(contact, ['price_leak'], { blocked: true });
    return { result, violations, blocked: true };
  }

  // 2) FIXES cirúrgicos (mantêm a mensagem)
  eachText(result, t => applyFixesToText(t, violations));

  // 2.5) TRAVAS DE CONTEXTO: não pedir o que o lead já deu, não se reapresentar.
  aplicarTravasDeContexto(result, contact, violations);

  // 3) FLAGS (não alteram, só registram)
  const full = allTextOf(result);
  for (const re of FLAG_PHRASES) {
    if (re.test(full)) violations.push('encerramento_bot_flag');
  }
  // SDR sempre termina com pergunta (exceto confirmação de agendamento / encerramento).
  // Tira emojis e pontuação de fechamento do fim antes de checar o "?".
  const isClosing = result.book_slot || result.end_conversation;
  if (!isClosing && full) {
    const tail = full.trim().replace(/[\s)"'.!]*$/u, '').replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
    if (!tail.endsWith('?')) violations.push('sem_pergunta_final');
  }

  if (violations.length) logViolations(contact, violations, { blocked: false });
  return { result, violations: [...new Set(violations)], blocked: false };
}

function logViolations(contact, violations, { blocked }) {
  try {
    if (contact?.id) {
      db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'policy_guard', ?)`)
        .run(contact.id, JSON.stringify({ violations: [...new Set(violations)], blocked }));
    }
  } catch { /* não-crítico */ }
  logger.warn({ contactId: contact?.id, violations, blocked }, 'policy guard atuou');
}

// exportado pra testes
export { detectPriceLeak, applyFixesToText };
