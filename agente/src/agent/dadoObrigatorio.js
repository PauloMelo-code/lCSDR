// Trava de dado obrigatório no agendamento (webhook.js, passo 7) — a parte pura,
// sem banco, pra ser testada direto (scripts/test-dado-obrigatorio.mjs).
//
// A trava pede e-mail e, no funil divulgar, link de vendas (invariante #12) antes
// de reservar. Faltava ela saber PARAR:
// ❌ CASO REAL (Katiane, 03/11): não quis passar e-mail e recebeu o mesmo pedido de
//    novo a cada mensagem, até o aviso de "agendamento não concluído" cair no grupo.
// ❌ CASO REAL (Deividi, 03/11): disse que o livro ainda não foi publicado e a Tina
//    seguiu pedindo o link de vendas — que não existe.
// Regra: pede UMA vez. Se o lead respondeu e o dado não veio, ou se o livro ainda
// não está à venda, não agenda (sem link não agenda divulgação, regra LC 13/07) e
// passa pro time. Os casos de borda vieram de duas revisões adversariais (03/11).

// minúsculo, sem acento, e as negações de WhatsApp ("n", "ñ", "naum", "nem") viram "nao"
const normaliza = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(?:n|naum|nem)\b/g, 'nao');

// O lead disse que o livro ainda NÃO está publicado / à venda.
// Precisão antes de cobertura: errar pra baixo só custa um pedido de link (e na
// repetição já escala); errar pra cima manda pro time quem tem livro à venda.
// Por isso a negação tem que estar COLADA no verbo ("não foi publicado") — "Não
// divulguei quando lancei" ou "Não, está à venda" não contam — e negação com
// ressalva fica de fora: "não está à venda NA AMAZON", "não foi publicado POR
// EDITORA", "não lancei O EBOOK" dizem que o livro existe em outro lugar.
// "Não tenho o link aqui" e "quero lançar" também ficam de fora.
const NEGA = [
  /\bnao\s+(?:foi\s+|esta\s+|ta\s+|e\s+|tem\s+sido\s+)?(?:publicad\w*|lancad\w*|a venda)\b/g,
  /\bnao\s+(?:o\s+)?(?:publiquei|lancei)\b/g,
  /\bnao\s+(?:tenho|tem)\s+(?:o\s+|um\s+|nenhum\s+|meu\s+)?livro\s+(?:publicad\w*|lancad\w*|a venda)\b/g,
];
const RESSALVA = /^\s+(?:ainda\s+)?(?:na|no|nas|nos|em|pela|pelo|por|pra|para|como|com|de\s+forma|so|somente|apenas|oficialmente|formalmente|direito)\b|^[^,.!?\n]{0,15}\b(?:ebook|e-book|fisico|impresso|versao|audiobook|digital)\b/;
const SEM_OBRA = [
  /\b(?:livro|obra)\b[^.!?\n]{0,20}\bnao\s+(?:esta\s+|ta\s+|ficou\s+)?(?:pronto|finalizad\w*|terminad\w*)\b/,
  /\bfalta\b[^.!?\n]{0,15}\b(?:diagramar|diagramacao|publicar|revisar|revisao|imprimir|lancar)\b/,
  /\b(?:ainda\s+(?:estou\s+|to\s+|tou\s+)?escrevendo|(?:estou|to|tou)\s+escrevendo\s+(?:o|meu)\s+livro)\b(?!\s+(?:o\s+|meu\s+)?(?:segundo|terceiro|proximo|outro|novo))/,
  /\b(?:terminando|finalizando)\s+(?:de\s+escrever|o\s+livro)\b/,
  /\bvai\s+ser\s+(?:publicad|lancad)\w*/,
  /\b(?:esta|ta)\s+na\s+grafica\b|\bem\s+(?:revisao|diagramacao)\b/,
];
// "já está à venda", "já publiquei", ou uma loja citada ("não foi lançado com
// evento, tá na Amazon"): vale mesmo com um "não" na mesma mensagem.
const LOJA = /\b(?:amazon|kdp|hotmart|uiclap|clube de autores|kiwify|eduzz|mercado livre)\b/;
const JA_PUBLICADO = /\bja\s+(?:publiquei|lancei|(?:esta|ta|foi|e)\s+(?:publicad\w*|lancad\w*|a venda))/;
// Fala de livro publicado: encerra a busca (a mensagem mais nova manda, #1/#3).
const PUBLICADO = /\b(?:publiquei|lancei|publicad\w*|lancad\w*|a venda|amazon|hotmart|uiclap|clube de autores)\b/;

const negaSemRessalva = s => NEGA.some(re => [...s.matchAll(re)].some(m => !RESSALVA.test(s.slice(m.index + m[0].length))));

// textos: mensagens do lead, MAIS NOVAS PRIMEIRO. Decide pela mais nova que fala do
// assunto: "ainda não publiquei" de 5 dias atrás não vence "já publiquei!" de agora.
export function semObraPublicada(textos = []) {
  for (const t of textos) {
    const s = normaliza(t);
    if (JA_PUBLICADO.test(s) || LOJA.test(s)) return false;
    if (negaSemRessalva(s) || SEM_OBRA.some(re => re.test(s))) return true;
    if (PUBLICADO.test(s)) return false;
  }
  return false;
}

// E-mail digitado pelo lead (o mais recente). O modelo não devolve lead_email — o
// campo não está no schema — então o código lê das mensagens, sem completar nada:
// "joão.silva@gmail.com" NÃO vira "o.silva@gmail.com" (a parte antes do @ não pode
// começar colada numa letra), e e-mail da própria LC (editorial@lcbookseditora,
// @lcagencia) não é do lead.
const EMAIL = /(?<![\p{L}\p{N}._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\p{L}\p{N}])/gu;
const DA_LC = /@(?:[\w-]+\.)*(?:lcagencia|lcbooks\w*)\.com(?:\.br)?$/i;
export function emailNasMensagens(textos = []) {
  for (const t of textos) {
    const achado = (String(t || '').match(EMAIL) || []).find(e => !DA_LC.test(e));
    if (achado) return achado.toLowerCase();
  }
  return null;
}

// "Só um minutinho", "vou ver qual e-mail uso", "já te mando": o lead vai mandar.
// Só frase curta, sem "não" e sem pergunta: "não vou passar meu e-mail", "não tenho
// no momento" e "um momento, por que precisa?" são resposta e escalam.
const ENROLANDO = /\b(?:minutinho|(?:so\s+)?um\s+(?:minuto|momento|instante|segundo)|perai|pera|aguarda|daqui\s+(?:a\s+)?pouco|(?:ja|depois|mais\s+tarde)\s+(?:te\s+|eu\s+)?(?:mando|passo|envio)|vou\s+(?:ver|pegar|procurar|olhar|buscar|mandar|passar|enviar))\b/;
const enrolando = t => { const s = normaliza(t); return s.length <= 40 && !/\bnao\b|\?/.test(s) && ENROLANDO.test(s); };

// O que fazer com um book_slot sem dado obrigatório.
//   pedidos       → payloads dos 'agendamento_bloqueado_dado_faltante' recentes:
//                   { falta, askedAt (ISO, quando o pedido SAIU), ultimoInbound (id) }
//   enviadoEm     → quando o lead mandou a mensagem deste turno (ms, do GHL) ou null
//   ultimoInbound → id da mensagem do lead mais nova agora (plano B sem horário)
//   textoAtual    → a mensagem deste turno
//   textosLead    → mensagens recentes do lead (mais novas primeiro)
// Retorna null (pode agendar) ou { falta: 'email'|'link', semObra, escalar, aguardar }.
//   aguardar → o lead ainda não respondeu o pedido (mensagens em rajada, ou mídia
//              enviada antes e processada depois) ou disse que vai mandar: nem pede
//              de novo, nem escala.
export function decidirDadoFaltante({ temEmail, temLink, pedidos = [], enviadoEm = null, ultimoInbound = null, textoAtual = '', textosLead = [] }) {
  if (temEmail && temLink) return null;
  // Livro ainda não à venda: não tem link pra pedir, nem adianta pedir e-mail
  // de uma reunião que não vai acontecer agora.
  if (!temLink && semObraPublicada(textosLead)) return { falta: 'link', semObra: true, escalar: true, aguardar: false };
  const falta = !temEmail ? 'email' : 'link';
  // payload antigo (antes de 03/11) só tinha temEmail/temLink e conta como respondido
  const item = p => p?.falta || (p?.temEmail === false ? 'email' : p?.temLink === false ? 'link' : null);
  const mesmos = pedidos.filter(p => item(p) === falta);
  if (!mesmos.length) return { falta, semObra: false, escalar: false, aguardar: false };
  const ultimo = mesmos.reduce((a, b) => (String(b.askedAt || '') > String(a.askedAt || '') ? b : a));
  // Pela hora de ENVIO do lead (não pela ordem de gravação: áudio é transcrito antes
  // de ser gravado). 3 s de folga pra relógio: ninguém lê e responde em 3 s.
  const pedidoEm = Date.parse(ultimo.askedAt || '');
  const respondeu = enviadoEm != null && !Number.isNaN(pedidoEm)
    ? enviadoEm > pedidoEm + 3000
    : (ultimo.ultimoInbound != null && ultimoInbound != null ? ultimoInbound > ultimo.ultimoInbound : true);
  if (!respondeu || enrolando(textoAtual)) return { falta, semObra: false, escalar: false, aguardar: true };
  return { falta, semObra: false, escalar: true, aguardar: false };
}

// Mensagem pro lead quando a trava passa pro time. Não afirma que o livro não está
// à venda (o detector pode errar e o lead não pode ouvir algo falso). Sem dígito de
// hora nem "confirmo/agendei": as travas 7.6–7.8 do webhook leem isso como promessa.
export function mensagemEscalada({ nome, semObra, exp }) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0];
  const oi = primeiro && !/\d/.test(primeiro) ? `, ${primeiro}` : '';
  const frase = semObra
    ? `Entendi${oi}! Vou pedir pra alguém do nosso time conversar com você por aqui sobre a divulgação do seu livro`
    : `Tudo bem${oi}! Vou pedir pra alguém do nosso time fechar esse horário com você por aqui`;
  return exp?.aberto === false
    ? `${frase}. O time atende ${exp.faixa}, seg-sex, então te chamam ${exp.proxima} 😊`
    : `${frase} 😊`;
}
