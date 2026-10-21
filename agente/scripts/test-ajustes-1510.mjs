// Ajustes do doc LC de 15/10: imagem no agendamento com closer + regra da coordenação.
//
// Trava o que pode quebrar em silêncio:
//   - imagem indo em PRÉ-ATENDIMENTO (é ligação de 15 min, não leva imagem);
//   - bolha de imagem atrapalhando a trava de data, que varre os textos das bolhas
//     procurando "hoje/amanhã" — item sem `.text` não pode derrubar essa varredura;
//   - a regra da coordenação sumir do prompt numa edição futura.
//
// Uso: node scripts/test-ajustes-1510.mjs

import 'dotenv/config';
import assert from 'node:assert/strict';

// ⚠️ Fixa a config ANTES de usar slotModality, que lê o env a cada chamada.
// Sem isto o teste depende do .env da máquina: no .env local esta variável está
// vazia (produção tem 2 calendários), e o caso mais importante — imagem NÃO ir em
// pré-atendimento — era simplesmente pulado, dando falsa sensação de cobertura.
const CAL_CLOSER = 'fMuUzjj4nSKRUXEPZYAx';   // Victor, reunião de 30 min
const CAL_PRE = 'NhjBRFw1AJex8TqNuLAw';      // Gabriel, ligação de pré-atendimento
process.env.PREATENDIMENTO_CALENDAR_IDS = CAL_PRE;

const { slotModality } = await import('../src/agent/scheduling.js');
const { TINA_SYSTEM_PROMPT } = await import('../src/agent/systemPrompt.js');

let ok = 0;
const caso = (nome, fn) => { fn(); console.log(`  ✓ ${nome}`); ok++; };

// Reproduz a decisão do webhook (7.45) sem subir o servidor.
const anexaImagem = (booked, url) =>
  Boolean(booked?.ok && url && slotModality(booked.calendarId).tipo === 'reuniao');

// Reproduz a varredura da trava de data (7.5).
const REL = /(?:^|[^a-zA-ZÀ-ÿ])(hoje|amanh[ãa])(?![a-zA-ZÀ-ÿ])/i;
const achaBolhaRelativa = items =>
  items.map(x => (typeof x === 'string' ? x : x?.text || '')).findLastIndex(t => REL.test(t));

try {
  console.log('\nAjustes LC 15/10\n');



  const URL = 'https://exemplo.invalid/orientacao.png';

  caso('reunião com closer recebe a imagem', () => {
    assert.equal(slotModality(CAL_CLOSER).tipo, 'reuniao');
    assert.equal(anexaImagem({ ok: true, calendarId: CAL_CLOSER }, URL), true);
  });

  caso('pré-atendimento NÃO recebe imagem (é ligação)', () => {

    assert.equal(slotModality(CAL_PRE).tipo, 'ligacao');
    assert.equal(anexaImagem({ ok: true, calendarId: CAL_PRE }, URL), false);
  });

  caso('sem URL configurada, não anexa nada', () => {
    assert.equal(anexaImagem({ ok: true, calendarId: CAL_CLOSER }, ''), false);
  });

  caso('agendamento que falhou não anexa imagem', () => {
    assert.equal(anexaImagem({ ok: false, error: 'horário já ocupado' }, URL), false);
    assert.equal(anexaImagem(null, URL), false);
  });

  caso('bolha de imagem não atrapalha a trava de data', () => {
    // A imagem entra DEPOIS da confirmação. A varredura tem que continuar achando
    // o texto com "amanhã", senão a correção de data para de funcionar.
    const items = ['Fechado! Agendei pra amanhã às 10h30 😊', { image: URL }];
    assert.equal(achaBolhaRelativa(items), 0, 'a imagem roubou o índice da bolha de texto');
    // E uma imagem sozinha não pode ser confundida com texto relativo.
    assert.equal(achaBolhaRelativa([{ image: URL }]), -1);
  });

  caso('regra da coordenação está no prompt', () => {
    assert.match(TINA_SYSTEM_PROMPT, /NUNCA OFEREÇA A COORDENAÇÃO/i);
    assert.match(TINA_SYSTEM_PROMPT, /Lilian Cardoso/);
    assert.match(TINA_SYSTEM_PROMPT, /nunca como pessoa disponível/i);
  });

  console.log(`\n${ok} casos passaram\n`);
} catch (err) {
  console.error(`\n❌ FALHOU: ${err.message}\n`);
  process.exitCode = 1;
}
