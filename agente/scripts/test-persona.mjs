// Identidade por dono do lead: a IA assina com o nome do consultor responsável.
//
// Trava o que pode quebrar em silêncio:
//   - o sdr_users guarda "Fernanda Vieira" mas o mapa de agendas usa "Fernanda";
//     sem casar por primeiro nome, NINGUÉM acha calendário e todo mundo vira Tina de novo;
//   - a chave de desligar tem que desligar de verdade (é entrega vendida na proposta);
//   - o bloco não pode mandar a IA se apresentar como Tina.
//
// Uso: node scripts/test-persona.mjs

import 'dotenv/config';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { getCalendarIds, calendarName } from '../src/agent/scheduling.js';
import {
  primeiroNome, donoPorGhlUserId, donoDoContato,
  sincronizarDonoDoLead, personaBlock, personaContext, personaEnabled,
} from '../src/agent/persona.js';

const PHONE = '5500000000002';
const WA_ID = `wa-${PHONE}`;

function limpar() {
  const c = db.prepare('SELECT id FROM contacts WHERE phone = ?').get(PHONE);
  if (c) {
    db.prepare('DELETE FROM events_log WHERE contact_id = ?').run(c.id);
    db.prepare('DELETE FROM contacts WHERE id = ?').run(c.id);
  }
}
function criarContato(sdrId = null) {
  limpar();
  db.prepare(`INSERT INTO contacts (ghl_contact_id, name, phone, stage, assigned_sdr_id)
              VALUES (?, 'Lead de teste', ?, 'qualificando', ?)`).run(WA_ID, PHONE, sdrId);
  return db.prepare('SELECT * FROM contacts WHERE phone = ?').get(PHONE);
}

let ok = 0;
const caso = (nome, fn) => { fn(); console.log(`  ✓ ${nome}`); ok++; };

const envAntes = process.env.PERSONA_DONO_ENABLED;

try {
  console.log('\nIdentidade por dono do lead\n');

  caso('primeiro nome sai de nome composto e de lixo', () => {
    assert.equal(primeiroNome('Fernanda Vieira'), 'Fernanda');
    assert.equal(primeiroNome('  Bruna   Menel '), 'Bruna');
    assert.equal(primeiroNome('Nataly'), 'Nataly');
    assert.equal(primeiroNome(''), null);
    assert.equal(primeiroNome(null), null);
  });

  // Consultor real da base, ativo e vinculado ao usuário do GHL.
  const consultor = db.prepare(
    `SELECT * FROM sdr_users WHERE active = 1 AND ghl_user_id IS NOT NULL
     AND role IN ('closer','sdr') ORDER BY id LIMIT 1`).get();
  assert.ok(consultor, 'nenhum consultor vinculado na base: rode scripts/link-ghl-users.js');
  console.log(`  (consultor de referência: ${consultor.name})`);

  caso('acha o dono pelo userId do GHL', () => {
    const d = donoPorGhlUserId(consultor.ghl_user_id);
    assert.ok(d, 'não resolveu o dono pelo ghl_user_id');
    assert.equal(d.nome, primeiroNome(consultor.name));
    assert.equal(d.sdrId, consultor.id);
  });

  caso('userId desconhecido não inventa dono', () => {
    assert.equal(donoPorGhlUserId('nao-existe-xyz'), null);
    assert.equal(donoPorGhlUserId(null), null);
  });

  caso('casa nome composto com o calendário certo', () => {
    // Pega um consultor que TENHA calendário na rotação e confere o vínculo.
    const comAgenda = db.prepare(
      `SELECT * FROM sdr_users WHERE active = 1 AND ghl_user_id IS NOT NULL`).all()
      .map(r => donoPorGhlUserId(r.ghl_user_id))
      .filter(d => d?.calendarId);
    assert.ok(comAgenda.length, 'nenhum consultor casou com calendário: o match por nome quebrou');
    for (const d of comAgenda) {
      assert.equal(primeiroNome(calendarName(d.calendarId)), d.nome,
        `calendário de ${d.nome} aponta pra ${calendarName(d.calendarId)}`);
      assert.ok(getCalendarIds().includes(d.calendarId), 'calendário fora da rotação configurada');
    }
    console.log(`     (${comAgenda.length} consultores com agenda: ${comAgenda.map(d => d.nome).join(', ')})`);
  });

  caso('sincroniza o dono a partir do contato do GHL', () => {
    const c = criarContato(null);
    const d = sincronizarDonoDoLead(c, { assignedTo: consultor.ghl_user_id });
    assert.ok(d, 'não resolveu o dono');
    const salvo = db.prepare('SELECT assigned_sdr_id FROM contacts WHERE id = ?').get(c.id);
    assert.equal(salvo.assigned_sdr_id, consultor.id, 'não gravou o dono no contato');
  });

  caso('admin NÃO empresta o nome (lead da Lilian não vira persona)', () => {
    const admin = db.prepare(
      `SELECT * FROM sdr_users WHERE active = 1 AND ghl_user_id IS NOT NULL
       AND LOWER(COALESCE(role,'')) = 'admin' ORDER BY id LIMIT 1`).get();
    if (!admin) { console.log('     (nenhum admin vinculado, pulando)'); return; }
    assert.equal(donoPorGhlUserId(admin.ghl_user_id), null,
      `${admin.name} é admin e virou dono do lead`);
  });

  caso('reatribuição no GHL troca o dono gravado', () => {
    const outro = db.prepare(
      `SELECT * FROM sdr_users WHERE active = 1 AND ghl_user_id IS NOT NULL AND id != ?
       AND LOWER(COALESCE(role,'')) IN ('closer','sdr') ORDER BY id LIMIT 1`).get(consultor.id);
    if (!outro) { console.log('     (só um consultor vinculado, pulando)'); return; }
    const c = criarContato(consultor.id);
    sincronizarDonoDoLead(c, { assignedTo: outro.ghl_user_id });
    const salvo = db.prepare('SELECT assigned_sdr_id FROM contacts WHERE id = ?').get(c.id);
    assert.equal(salvo.assigned_sdr_id, outro.id, 'manteve o dono antigo depois da reatribuição');
  });

  caso('sem assignedTo conhecido, mantém o que já estava', () => {
    const c = criarContato(consultor.id);
    sincronizarDonoDoLead(c, { assignedTo: 'usuario-que-nao-existe' });
    const salvo = db.prepare('SELECT assigned_sdr_id FROM contacts WHERE id = ?').get(c.id);
    assert.equal(salvo.assigned_sdr_id, consultor.id, 'apagou o dono por causa de um userId desconhecido');
  });

  caso('o bloco assina como a pessoa e proíbe assinar como Tina', () => {
    const d = donoPorGhlUserId(consultor.ghl_user_id);
    const bloco = personaBlock(d);
    assert.ok(bloco.includes(d.nome), 'o bloco não cita o nome do consultor');
    assert.match(bloco, /Aqui é a .+, do Grupo LC/, 'falta a frase de apresentação');
    assert.match(bloco, /NUNCA escreva o nome "Tina"/, 'não proíbe assinar como Tina');
    assert.match(bloco, /NÃO afirme ser\s+humana/, 'perdeu o piso de não se declarar humana');
    assert.match(bloco, /passar para o consultor/, 'não bloqueia o handoff que não faz mais sentido');
  });

  caso('sem dono, não há bloco (lead sem consultor segue como hoje)', () => {
    assert.equal(personaBlock(null), null);
    assert.equal(personaBlock({ nome: null }), null);
  });

  caso('a chave de desligar desliga de verdade', () => {
    const c = criarContato(consultor.id);
    process.env.PERSONA_DONO_ENABLED = 'false';
    assert.equal(personaEnabled(), false);
    assert.equal(personaContext(c), null, 'gerou persona com a chave desligada');
    process.env.PERSONA_DONO_ENABLED = 'true';
    assert.ok(personaContext(c)?.includes(primeiroNome(consultor.name)), 'não gerou persona com a chave ligada');
  });

  caso('contato sem dono não quebra', () => {
    const c = criarContato(null);
    process.env.PERSONA_DONO_ENABLED = 'true';
    assert.equal(donoDoContato(c), null);
    assert.equal(personaContext(c), null);
  });

  console.log(`\n${ok} casos passaram\n`);
} catch (err) {
  console.error(`\n❌ FALHOU: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  limpar();
  if (envAntes === undefined) delete process.env.PERSONA_DONO_ENABLED;
  else process.env.PERSONA_DONO_ENABLED = envAntes;
}
