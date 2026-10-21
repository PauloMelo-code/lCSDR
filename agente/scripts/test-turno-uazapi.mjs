// Trava de "humano assumiu" no canal uazapi (invariante #8, por procedência).
//
// No uazapi TUDO que sai deste número volta no webhook com `fromMe: true`: a
// resposta da Tina e o que o consultor digita do celular dele chegam iguais.
// O que separa um do outro é tina_sent_msgs (markTinaSent). Este teste prende
// essa tabela de decisão pra ela não regredir em silêncio.
//
// Uso: node scripts/test-turno-uazapi.mjs

import 'dotenv/config';
import assert from 'node:assert/strict';

// A flag é lida no topo do módulo, então tem que estar setada ANTES do import.
process.env.AUTO_HUMAN_DETECTION_ENABLED = 'true';

const { db } = await import('../src/db/index.js');
const { cederTurnoSeHumano } = await import('../src/routes/webhookUazapi.js');

const PHONE = '5500000000001';                 // número de teste, não é de ninguém
const WA_ID = `wa-${PHONE}`;                   // prefixo wa- impede chamada ao GHL
const evento = { message: { chatid: `${PHONE}@s.whatsapp.net` } };

function limpar() {
  const c = db.prepare('SELECT id FROM contacts WHERE phone = ?').get(PHONE);
  if (c) {
    db.prepare('DELETE FROM events_log WHERE contact_id = ?').run(c.id);
    db.prepare('DELETE FROM followups WHERE contact_id = ?').run(c.id);
    db.prepare('DELETE FROM contacts WHERE id = ?').run(c.id);
  }
  db.prepare("DELETE FROM tina_sent_msgs WHERE ghl_message_id LIKE 'teste-turno-%'").run();
}

function criarContato() {
  limpar();
  db.prepare(`INSERT INTO contacts (ghl_contact_id, name, phone, stage, ai_paused)
              VALUES (?, 'Lead de teste', ?, 'qualificando', 0)`).run(WA_ID, PHONE);
  return db.prepare('SELECT * FROM contacts WHERE phone = ?').get(PHONE);
}

const pausado = id => db.prepare('SELECT ai_paused FROM contacts WHERE id = ?').get(id).ai_paused;

let ok = 0;
const caso = (nome, fn) => { fn(); console.log(`  ✓ ${nome}`); ok++; };

try {
  console.log('\nTrava de turno no canal uazapi\n');

  caso('resposta da PRÓPRIA Tina não pausa (está em tina_sent_msgs)', () => {
    const c = criarContato();
    db.prepare('INSERT INTO tina_sent_msgs (ghl_message_id) VALUES (?)').run('teste-turno-tina');
    const cedeu = cederTurnoSeHumano(evento, {
      id: 'teste-turno-tina', fromMe: true, text: 'Oi! Aqui é a Tina 😊',
    });
    assert.equal(cedeu, false, 'cedeu turno pra mensagem da própria Tina');
    assert.equal(pausado(c.id), 0, 'pausou a IA por causa da própria resposta dela');
  });

  caso('mensagem do CONSULTOR pausa a Tina', () => {
    const c = criarContato();
    const cedeu = cederTurnoSeHumano(evento, {
      id: 'teste-turno-humano', fromMe: true, text: 'Oi Marcela, aqui é a Fernanda!',
    });
    assert.equal(cedeu, true, 'não detectou o humano digitando');
    assert.equal(pausado(c.id), 1, 'detectou mas não pausou a IA');
  });

  caso('envio por API (automação) não pausa', () => {
    const c = criarContato();
    const cedeu = cederTurnoSeHumano(evento, {
      id: 'teste-turno-api', fromMe: true, wasSentByApi: true, text: 'disparo automático',
    });
    assert.equal(cedeu, false);
    assert.equal(pausado(c.id), 0);
  });

  caso('evento sem texto (recibo/status) não pausa', () => {
    const c = criarContato();
    const cedeu = cederTurnoSeHumano(evento, { id: 'teste-turno-vazio', fromMe: true, text: '   ' });
    assert.equal(cedeu, false);
    assert.equal(pausado(c.id), 0);
  });

  caso('contato desconhecido não quebra nem cria nada', () => {
    limpar();
    const cedeu = cederTurnoSeHumano(evento, {
      id: 'teste-turno-orfao', fromMe: true, text: 'conversa que a Tina nunca tocou',
    });
    assert.equal(cedeu, false);
    assert.equal(db.prepare('SELECT id FROM contacts WHERE phone = ?').get(PHONE), undefined);
  });

  caso('já pausado não re-pausa (idempotente)', () => {
    const c = criarContato();
    assert.equal(cederTurnoSeHumano(evento, { id: 'h1', fromMe: true, text: 'assumi' }), true);
    assert.equal(cederTurnoSeHumano(evento, { id: 'h2', fromMe: true, text: 'segunda msg' }), false);
  });

  console.log(`\n${ok}/6 passaram\n`);
} catch (err) {
  console.error(`\n❌ FALHOU: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  limpar();
}
