// Trava de horário no "falar agora" (queixa do Gabriel, 29/10).
//
// A regra dele, virada código: se a Tina fala um horário, tem que ir pra agenda.
//
// O `handoff_mode: agora` chama o liveHandoff, que NÃO cria compromisso — passa o
// lead pro próximo da fila. Mas no modo pré-atendimento o prompt manda descrever isso
// como "pré-atendimento de 15 min por telefone", e ela acaba propondo horário.
//
// ❌ CASO REAL (Marcos, 29/10): "é uma ligação telefônica de 15 minutos... posso
// confirmar pra hoje às 10:30?" — zero compromissos na agenda.
//
// ⚠️ A trava anterior (7.6) NÃO pegava isso: ela procura AFIRMAÇÃO ("agendei"), e o
// caso do Marcos era PERGUNTA. Pro lead que lê, as duas valem igual.
//
// Uso: node scripts/test-horario-falar-agora.mjs

import assert from 'node:assert/strict';

let ok = 0;
const caso = (nome, fn) => { fn(); console.log(`  ✓ ${nome}`); ok++; };

// Mesmos padrões do webhook (7.6, 7.7 e 7.8).
const HORA_COMPROMETIDA = /(?:^|[^\d])(?:às\s*)?\d{1,2}\s*(?:h\b|h\d{2}|:\d{2})/i;
const COMPROMETE = /\b(confirmar|confirmo|confirma|fica(mos)?\s+(pra|para)|te ligo|vai te ligar|liga(r)?\s+(pra|para)\s+voc[êe]|encaixar|reserv)/i;
const AFIRMA_AGENDOU = /\b(agendei|agendado|agendada|marquei|marcado|marcada|reservei|reservado|reservada|confirmei|deixei reservado|est[áa] agendad)/i;

const corrige = (texto, modo, booked) =>
  modo === 'agora' && !booked?.ok && HORA_COMPROMETIDA.test(texto) && COMPROMETE.test(texto);
const agendaChecagem = (texto, booked) =>
  !booked?.ok && HORA_COMPROMETIDA.test(texto) && (COMPROMETE.test(texto) || AFIRMA_AGENDOU.test(texto));

try {
  console.log('\nTrava de horário no "falar agora"\n');

  const MARCOS = 'O especialista vai te ligar no celular pra entender o projeto e te explicar como funciona a divulgação. Posso confirmar pra hoje às 10:30?';

  caso('o caso do Marcos é corrigido', () => {
    assert.equal(corrige(MARCOS, 'agora', null), true,
      'o texto que gerou a reclamação passaria de novo');
  });

  caso('a trava antiga NÃO pegava esse caso (por isso esta existe)', () => {
    assert.equal(AFIRMA_AGENDOU.test(MARCOS), false,
      'se a trava de afirmação já pegasse, esta aqui seria redundante');
  });

  caso('outras formas de comprometer horário também pegam', () => {
    for (const t of [
      'Posso confirmar pra hoje às 10:30?',
      'Fica para as 14h então?',
      'Te ligo às 15:30, pode ser?',
      'Vou te encaixar às 9h',
    ]) assert.equal(corrige(t, 'agora', null), true, `passou batido: "${t}"`);
  });

  caso('texto SEM horário não é tocado', () => {
    const t = 'Já estou te conectando com o próximo especialista disponível 😊';
    assert.equal(corrige(t, 'agora', null), false);
  });

  caso('menção de horário sem compromisso não é tocada', () => {
    // Falar do expediente é legítimo e não promete nada.
    const t = 'Nosso time atende de segunda a sexta, das 9h às 18h.';
    assert.equal(corrige(t, 'agora', null), false, 'censurou o horário de expediente');
  });

  caso('no fluxo de AGENDAR, horário é legítimo e não é mexido', () => {
    assert.equal(corrige('Agendei para amanhã às 10:30', 'agendar', { ok: true }), false);
  });

  caso('se a reunião FOI criada, não mexe nem no falar agora', () => {
    assert.equal(corrige(MARCOS, 'agora', { ok: true, label: 'hoje às 10:30' }), false);
  });

  caso('a rede agenda checagem em QUALQUER fluxo (era o buraco do Marcos)', () => {
    // Antes, marcarChecagemAgendamento só rodava no handoff_mode 'agendar'.
    assert.equal(agendaChecagem(MARCOS, null), true);
    assert.equal(agendaChecagem('Agendei pra hoje às 09:00', null), true);
    assert.equal(agendaChecagem('Já estou te conectando 😊', null), false);
  });

  caso('com reunião criada, não agenda checagem à toa', () => {
    assert.equal(agendaChecagem(MARCOS, { ok: true }), false);
  });

  console.log(`\n${ok} casos passaram\n`);
} catch (err) {
  console.error(`\n❌ FALHOU: ${err.message}\n`);
  process.exitCode = 1;
}
