// Trava de dado obrigatório não pode deixar o lead PRESO (causa raiz da queixa nº 1
// do doc da LC: "agendou e não colocou na agenda", 13 ocorrências desde julho).
//
// O bug: quando falta e-mail ou link, o webhook zera o book_slot e pede o dado. Mas o
// `stage` que ia pro banco era o do modelo, que estava tentando agendar e devolve
// 'agendado'. Gravado 'agendado', o turno seguinte não busca mais lista de horários,
// e o lead nunca mais consegue marcar — com o CRM dizendo que está agendado.
//
// ❌ CASO REAL: Alessandra, 13/10. Escolheu 17h, deu o e-mail um minuto depois,
// compromisso nunca criado, e ainda saiu lembrete no dia errado.
//
// Uso: node scripts/test-agendamento-preso.mjs

import assert from 'node:assert/strict';

let ok = 0;
const caso = (nome, fn) => { fn(); console.log(`  ✓ ${nome}`); ok++; };

// Reproduz a trava do webhook (passo 7.4) sobre o resultado do modelo.
function aplicarTrava(result, { temEmail, temLink }) {
  const r = { ...result };
  if (r.book_slot && (!temEmail || !temLink)) {
    r.book_slot = null;
    r.reply = '';
    r.split = [!temEmail ? 'me manda seu e-mail' : 'me manda o link do seu livro'];
    r.stage = 'agendando';
  }
  return r;
}

// Reproduz a decisão de buscar horários no turno seguinte (passo 5).
const INTENCAO = /\b(agendar|marcar|hor[áa]rio|reuni[ãa]o)\b|\b\d{1,2}\s*(?:h\b|:\d{2})/i;
const buscaHorarios = (stage, texto) =>
  ['agendando', 'qualificado'].includes(stage)
  || (INTENCAO.test(texto || '') && !['desqualificado', 'agendado'].includes(stage));

try {
  console.log('\nTrava de agendamento: o lead não pode ficar preso\n');

  caso('sem e-mail, a trava adia e devolve o stage pra agendando', () => {
    const r = aplicarTrava({ book_slot: '2026-10-15T17:00:00-03:00', stage: 'agendado' },
      { temEmail: false, temLink: true });
    assert.equal(r.book_slot, null, 'deveria adiar o agendamento');
    assert.equal(r.stage, 'agendando', 'stage ficou agendado e prende o lead');
  });

  caso('sem link de divulgação, mesma coisa', () => {
    const r = aplicarTrava({ book_slot: '2026-10-15T17:00:00-03:00', stage: 'agendado' },
      { temEmail: true, temLink: false });
    assert.equal(r.book_slot, null);
    assert.equal(r.stage, 'agendando');
  });

  caso('O BUG: com stage agendado, o turno do e-mail não busca horários', () => {
    // É isto que acontecia: o lead responde só o e-mail, sem palavra de agendamento.
    assert.equal(buscaHorarios('agendado', 'alearteatelier@gmail.com'), false);
  });

  caso('A CORREÇÃO: com stage agendando, busca e o lead consegue marcar', () => {
    assert.equal(buscaHorarios('agendando', 'alearteatelier@gmail.com'), true);
  });

  caso('fluxo completo do caso Alessandra, ponta a ponta', () => {
    // turno 1: escolheu 17h, modelo tenta agendar, mas não tem e-mail
    const t1 = aplicarTrava({ book_slot: '2026-10-15T17:00:00-03:00', stage: 'agendado' },
      { temEmail: false, temLink: true });
    assert.equal(t1.book_slot, null);
    // turno 2: lead manda só o e-mail
    assert.equal(buscaHorarios(t1.stage, 'alearteatelier@gmail.com'), true,
      'o lead continuaria preso: sem lista de horários o modelo não consegue agendar');
  });

  caso('com tudo em mãos, a trava não interfere', () => {
    const r = aplicarTrava({ book_slot: '2026-10-15T17:00:00-03:00', stage: 'agendado' },
      { temEmail: true, temLink: true });
    assert.equal(r.book_slot, '2026-10-15T17:00:00-03:00', 'bloqueou um agendamento válido');
    assert.equal(r.stage, 'agendado', 'mexeu no stage sem precisar');
  });

  console.log(`\n${ok} casos passaram\n`);
} catch (err) {
  console.error(`\n❌ FALHOU: ${err.message}\n`);
  process.exitCode = 1;
}
