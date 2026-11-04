// Trava de dado obrigatório: pede UMA vez, depois passa pro time (src/agent/dadoObrigatorio.js).
//
// ❌ CASO REAL (Katiane, 03/11): não quis passar e-mail e recebeu o mesmo pedido a
//    cada mensagem, até cair "agendamento não foi concluído" no grupo.
// ❌ CASO REAL (Deividi, 03/11): livro ainda não publicado, e a Tina seguiu pedindo
//    o link de vendas.
// Casos de "ignora" e de rajada vieram da revisão adversarial de 03/11.
//
// Importa a lógica REAL (não uma cópia). Uso: node scripts/test-dado-obrigatorio.mjs

import assert from 'node:assert/strict';
import { decidirDadoFaltante, semObraPublicada, mensagemEscalada, emailNasMensagens } from '../src/agent/dadoObrigatorio.js';

let ok = 0;
const caso = (nome, fn) => { fn(); console.log(`  ✓ ${nome}`); ok++; };

// Cópia das travas 7.6–7.8 do webhook.js: a mensagem escalada não pode parecer
// promessa de horário, senão o próprio webhook a reescreve ou agenda checagem.
const AFIRMA_AGENDOU = /\b(agendei|agendado|agendada|marquei|marcado|marcada|reservei|reservado|reservada|confirmei|deixei reservado|est[áa] agendad)/i;
const COMPROMETE = /\b(confirmar|confirmo|confirma|fica(mos)?\s+(pra|para)|te ligo|vai te ligar|liga(r)?\s+(pra|para)\s+voc[êe]|encaixar|reserv)/i;

try {
  console.log('\nKatiane — e-mail recusado');
  caso('1ª vez sem e-mail: pede (não escala)', () => {
    assert.deepEqual(decidirDadoFaltante({ temEmail: false, temLink: true, pedidos: [], ultimoInbound: 10 }),
      { falta: 'email', semObra: false, escalar: false, aguardar: false });
  });
  caso('lead respondeu depois do pedido e não veio e-mail: escala', () => {
    const d = decidirDadoFaltante({ temEmail: false, temLink: true, pedidos: [{ falta: 'email', ultimoInbound: 10 }], ultimoInbound: 11 });
    assert.equal(d.escalar, true);
  });
  caso('pedido gravado antes do deploy (payload sem "falta") também conta', () => {
    assert.equal(decidirDadoFaltante({ temEmail: false, temLink: true, pedidos: [{ temEmail: false, temLink: true }], ultimoInbound: 11 }).escalar, true);
  });

  console.log('\nRajada — o lead mandou 2 mensagens antes de ver o pedido');
  caso('mensagem é anterior ao pedido: nem pede de novo, nem escala', () => {
    const d = decidirDadoFaltante({ temEmail: false, temLink: true, pedidos: [{ falta: 'email', ultimoInbound: 11 }], ultimoInbound: 11 });
    assert.equal(d.aguardar, true);
    assert.equal(d.escalar, false);
  });
  const askedAt = '2026-11-03T09:53:00.000Z';
  const ms = iso => Date.parse(iso);
  caso('áudio ENVIADO antes do pedido e gravado depois (id maior): vale a hora de envio, aguarda', () => {
    const d = decidirDadoFaltante({ temEmail: false, temLink: true, pedidos: [{ falta: 'email', askedAt, ultimoInbound: 11 }],
      enviadoEm: ms('2026-11-03T09:52:58.000Z'), ultimoInbound: 12 });
    assert.equal(d.aguardar, true);
  });
  caso('resposta 2 s depois do pedido ainda conta como rajada (folga de relógio)', () => {
    assert.equal(decidirDadoFaltante({ temEmail: false, temLink: true, pedidos: [{ falta: 'email', askedAt }],
      enviadoEm: ms(askedAt) + 2000 }).aguardar, true);
  });
  caso('resposta 1 min depois do pedido, sem e-mail: escala', () => {
    assert.equal(decidirDadoFaltante({ temEmail: false, temLink: true, pedidos: [{ falta: 'email', askedAt }],
      enviadoEm: ms(askedAt) + 60000, textoAtual: 'prefiro não passar' }).escalar, true);
  });
  for (const t of ['só um minutinho', 'vou ver qual e-mail eu uso', 'já te mando', 'peraí']) {
    caso(`"${t}" depois do pedido: aguarda, não escala`, () => {
      assert.equal(decidirDadoFaltante({ temEmail: false, temLink: true, pedidos: [{ falta: 'email', askedAt }],
        enviadoEm: ms(askedAt) + 60000, textoAtual: t }).aguardar, true);
    });
  }
  // revisão 3 (03/11): recusa com "vou passar"/"momento" ficava muda em vez de escalar
  for (const [t, falta] of [['não vou passar meu e-mail', 'email'], ['Não vou mandar email não', 'email'],
    ['não tenho e-mail no momento', 'email'], ['no momento não tenho', 'email'], ['Não quero passar, pode me ligar mais tarde?', 'email'],
    ['Um momento, por que precisa do e-mail?', 'email'], ['não vou passar não, pode marcar sem', 'email'],
    ['não tenho o link no momento', 'link'], ['não vou passar o link', 'link']]) {
    caso(`recusa "${t}" depois do pedido: escala, não fica mudo`, () => {
      const d = decidirDadoFaltante({ temEmail: falta !== 'email', temLink: falta !== 'link', pedidos: [{ falta, askedAt }],
        enviadoEm: ms(askedAt) + 60000, textoAtual: t });
      assert.equal(d.aguardar, false);
      assert.equal(d.escalar, true);
    });
  }

  console.log('\nDeividi — livro não publicado');
  caso('disse que não publicou: escala já na 1ª, sem pedir link', () => {
    assert.deepEqual(decidirDadoFaltante({ temEmail: true, temLink: false, textosLead: ['Ainda não foi publicado, falta diagramar'] }),
      { falta: 'link', semObra: true, escalar: true, aguardar: false });
  });
  caso('sem e-mail E livro não publicado: não pede e-mail de reunião que não vai sair', () => {
    const d = decidirDadoFaltante({ temEmail: false, temLink: false, textosLead: ['meu livro não está à venda ainda'] });
    assert.equal(d.semObra, true);
    assert.equal(d.escalar, true);
  });
  caso('frases no estilo das do Deividi, mais nova primeiro', () => {
    assert.equal(semObraPublicada(['pode ser quinta', 'falta diagramar e a capa', 'terminei de escrever e quero lançar']), true);
  });

  console.log('\nRegressão — o que já funcionava continua igual');
  caso('e-mail e link em mãos: agenda (null)', () => {
    assert.equal(decidirDadoFaltante({ temEmail: true, temLink: true, textosLead: ['ainda não publiquei'] }), null);
  });
  caso('livro publicado sem link: pede o link UMA vez', () => {
    assert.deepEqual(decidirDadoFaltante({ temEmail: true, temLink: false, textosLead: ['quero divulgar meu livro', 'pode ser quinta'] }),
      { falta: 'link', semObra: false, escalar: false, aguardar: false });
  });
  caso('já pediu e-mail, agora falta o link: pede o link (item diferente)', () => {
    assert.equal(decidirDadoFaltante({ temEmail: true, temLink: false, pedidos: [{ falta: 'email', ultimoInbound: 3 }], ultimoInbound: 9 }).escalar, false);
  });

  console.log('\nMensagem mais nova manda (invariantes #1 e #3)');
  caso('"já publiquei" de agora vence "não publiquei" de dias atrás', () =>
    assert.equal(semObraPublicada(['já publiquei! saiu ontem na amazon, pode ser quinta 10h', 'ainda não publiquei, falta revisar']), false));
  caso('"não publiquei" de agora vence "quero divulgar" de antes', () =>
    assert.equal(semObraPublicada(['nem publiquei ainda', 'quero divulgar meu livro']), true));

  console.log('\nDetector de "livro não publicado"');
  for (const t of ['ainda não foi publicado', 'nao publiquei ainda', 'ele não está à venda', 'o livro ainda não está pronto',
    'falta revisar e diagramar', 'ainda estou escrevendo', 'to escrevendo meu livro', 'não foi publicado ainda, tá na editora',
    'não tenho livro publicado', 'ainda n publiquei', 'ñ publiquei ainda', 'nem publiquei ainda', 'naum foi publicado',
    'vai ser lançado mês que vem', 'tá na gráfica', 'está em revisão']) {
    caso(`pega: "${t}"`, () => assert.equal(semObraPublicada([t]), true));
  }
  for (const t of ['não tenho horário disponível', 'não estou pronto pra decidir', 'Não, já está à venda na Amazon',
    'já foi publicado mas não tenho o link aqui', 'não tenho o link agora', 'quero lançar meu livro', 'pode ser quinta 10h',
    'to escrevendo aqui do trabalho', 'terminei de escrever meu segundo livro',
    // falsos positivos achados na revisão adversarial de 03/11: autor COM livro à venda
    'Não divulguei quando lancei, agora quero divulgar', 'Não tá vendendo nada, lancei em março', 'nao vendi nada, publiquei em 2023',
    'Não tive apoio quando lancei', 'Não, ele está à venda na Amazon', 'Não, está à venda sim', 'nao sei como aumentar a venda dele',
    'Vendo só pelo meu site, não está à venda na Amazon', 'ainda nao esta a venda na amazon, so na shopee',
    'É que ainda não lancei o ebook, só o físico', 'não foi publicado por editora, é independente',
    'publiquei pela editora mas nao foi lancado nas livrarias', 'não tô achando, mas tá à venda',
    'não lembro o link, publiquei pela Amazon', 'o livro não foi publicado por editora, publiquei sozinho', 'não, publiquei em março',
    'tenho 2 publicados e ainda estou escrevendo o terceiro', 'não está à venda ainda na Amazon',
    'não foi publicado por editora, mas já está à venda',
    // revisão 3: negação com outra ressalva, ou loja citada na mesma mensagem
    'não foi publicado com editora grande, foi na uiclap', 'de forma tradicional não, publiquei na amazon kdp',
    'não foi lançado oficialmente, mas já vendo na Amazon', 'não foi lançado direito, tá na amazon',
    'Meu livro está na Amazon. Não foi lançado com evento']) {
    caso(`ignora: "${t}"`, () => assert.equal(semObraPublicada([t]), false));
  }

  console.log('\nE-mail digitado no chat (o modelo não devolve lead_email)');
  caso('acha o e-mail mais recente', () =>
    assert.equal(emailNasMensagens(['meu email é Maria.Souza@Gmail.com', 'antigo@x.com']), 'maria.souza@gmail.com'));
  caso('não completa e-mail pela metade', () => assert.equal(emailNasMensagens(['maria@gmail', 'não tenho e-mail']), null));
  caso('e-mail da própria LC não vira e-mail do lead', () => {
    assert.equal(emailNasMensagens(['já mandei pro editorial@lcagencia.com.br']), null);
    assert.equal(emailNasMensagens(['mandei pro editorial@lcagencia.com.br, o meu é ana@uol.com.br']), 'ana@uol.com.br');
    assert.equal(emailNasMensagens(['já mandei pro editorial@lcbookseditora.com.br', 'meu email é ana@uol.com.br']), 'ana@uol.com.br');
  });
  caso('e-mail com acento não vira um pedaço dele ("joão.silva@" ≠ "o.silva@")', () => {
    assert.equal(emailNasMensagens(['meu email é joão.silva@gmail.com']), null);
    assert.equal(emailNasMensagens(['conceição123@hotmail.com']), null);
  });

  console.log('\nMensagem pro lead');
  const aberto = { aberto: true, faixa: '9h às 18h', proxima: 'amanhã às 9h' };
  const fechado = { aberto: false, faixa: '9h às 18h', proxima: 'amanhã às 9h' };
  for (const [rotulo, m] of [
    ['e-mail, expediente aberto', mensagemEscalada({ nome: 'Katiane Souza', semObra: false, exp: aberto })],
    ['e-mail, fora do expediente', mensagemEscalada({ nome: 'Katiane', semObra: false, exp: fechado })],
    ['livro não publicado', mensagemEscalada({ nome: 'Deividi', semObra: true, exp: aberto })],
  ]) {
    caso(`${rotulo}: não parece promessa de horário nem pede o dado de novo`, () => {
      assert.ok(!AFIRMA_AGENDOU.test(m), `diz que agendou: ${m}`);
      assert.ok(!COMPROMETE.test(m), `promete horário: ${m}`);
      assert.ok(!/e-?mail|link/i.test(m), `pede o dado de novo: ${m}`);
    });
  }
  caso('expediente aberto: sem hora nenhuma no texto', () =>
    assert.ok(!/\d/.test(mensagemEscalada({ nome: 'Katiane', semObra: false, exp: aberto }))));
  caso('fora do expediente: diz quando o time chama', () =>
    assert.match(mensagemEscalada({ nome: 'Katiane', semObra: false, exp: fechado }), /amanhã às 9h/));
  caso('nome com dígito (telefone salvo como nome) não vira saudação', () =>
    assert.ok(!mensagemEscalada({ nome: '5511999', semObra: false, exp: aberto }).includes('5511')));
  caso('livro não publicado: fala da divulgação sem afirmar que o livro não está à venda', () => {
    const m = mensagemEscalada({ nome: 'Deividi', semObra: true, exp: aberto });
    assert.match(m, /divulgação/);
    assert.ok(!/não está à venda|não foi publicado/.test(m), 'o detector pode errar: o lead não pode ouvir algo falso');
  });

  console.log(`\n${ok} casos passaram\n`);
} catch (err) {
  console.error(`\n❌ FALHOU: ${err.message}\n`);
  process.exitCode = 1;
}
