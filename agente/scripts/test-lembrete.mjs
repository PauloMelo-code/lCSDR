// Lembrete de compromisso pela Tina (pedido Lilian 21/10).
//
// Trava o que importa:
//   - pré-atendimento NUNCA pode mencionar link/sala: é ligação no telefone, e o
//     lembrete do GHL errando isso foi a queixa de 15/10;
//   - reunião e ligação precisam de textos diferentes;
//   - nome estranho do WhatsApp (número, página) não pode virar "Oi, 5511999...!".
//
// Uso: node scripts/test-lembrete.mjs

import assert from 'node:assert/strict';
import { textoLembrete } from '../src/agent/lembrete.js';

let ok = 0;
const caso = (nome, fn) => { fn(); console.log(`  ✓ ${nome}`); ok++; };

try {
  console.log('\nLembrete da Tina\n');

  caso('pré-atendimento usa o texto da Lilian e fala em LIGAÇÃO', () => {
    const t = textoLembrete({ nome: 'Marcela', consultor: 'Gabriel', quando: 'hoje às 15:00', tipo: 'ligacao' });
    assert.match(t, /liga[çc][ãa]o de pr[ée]-atendimento/i);
    assert.match(t, /Podemos confirmar\?/);
    assert.match(t, /com Gabriel/);
    assert.match(t, /hoje às 15:00/);
  });

  caso('⚠️ pré-atendimento NUNCA menciona link nem sala', () => {
    const t = textoLembrete({ nome: 'Marcela', consultor: 'Bruna', quando: 'hoje às 10:00', tipo: 'ligacao' });
    assert.doesNotMatch(t, /link|sala|meet|teams|zoom|chamada de v[íi]deo/i,
      'o lembrete de ligação mencionou link — é exatamente o erro reportado em 15/10');
  });

  caso('reunião tem texto próprio', () => {
    const t = textoLembrete({ nome: 'Marcela', consultor: 'Nataly', quando: 'amanhã às 14:00', tipo: 'reuniao' });
    assert.match(t, /reuni[ãa]o/i);
    assert.doesNotMatch(t, /pr[ée]-atendimento/i, 'texto de reunião falou em pré-atendimento');
  });

  caso('os dois textos são de fato diferentes', () => {
    const base = { nome: 'Ana', consultor: 'Victor', quando: 'hoje às 09:00' };
    assert.notEqual(
      textoLembrete({ ...base, tipo: 'ligacao' }),
      textoLembrete({ ...base, tipo: 'reuniao' }),
    );
  });

  caso('nome que não é nome vira saudação neutra', () => {
    // O nome vem do perfil do WhatsApp e pode ser numero ou nome de pagina.
    const t = textoLembrete({ nome: '5511970515157', consultor: 'Nataly', quando: 'hoje às 11:00', tipo: 'reuniao' });
    assert.match(t, /^Oi!/, 'saudou o lead pelo numero de telefone');
    assert.doesNotMatch(t, /5511970515157/);
  });

  caso('sem consultor conhecido, a frase continua inteira', () => {
    const t = textoLembrete({ nome: 'Ana', consultor: null, quando: 'hoje às 16:00', tipo: 'reuniao' });
    assert.doesNotMatch(t, /\scom\s+(null|undefined)/, 'vazou null na mensagem do lead');
    assert.match(t, /reuni[ãa]o hoje às 16:00/);
  });

  console.log(`\n${ok} casos passaram\n`);
} catch (err) {
  console.error(`\n❌ FALHOU: ${err.message}\n`);
  process.exitCode = 1;
}
