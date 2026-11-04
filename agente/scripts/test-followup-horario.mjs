// Follow-up no horário certo (scheduler.js, processFollowups).
//
// ❌ BUG (achado na revisão de 03/11): due_at é gravado em ISO ("…T…Z") e a query
//    comparava como TEXTO com datetime('now') ("YYYY-MM-DD HH:MM:SS"). O "T" ganha
//    do espaço, então nada vencia no mesmo dia UTC: todo follow-up saía na virada do
//    dia UTC (21h BRT), qualquer que fosse o prazo — e o aviso de "agendamento
//    travado" de 15 min chegava horas depois.
// Regra nova: follow-up pro lead só sai no horário comercial (expediente do time);
// aviso pro time e encerramento de card rodam a qualquer hora.
//
// ❌ BUG 2 (revisão de 03/11): o scheduleFollowup('silencio_lead') do fim do turno
//    cancelava a checagem de agendamento travado que o passo 7.8 tinha acabado de
//    agendar no MESMO turno, e o time nunca era avisado do horário prometido.
//    A resposta do lead (recordInbound) também cancelava: quem escolhia o horário e
//    travava no e-mail era declinado sem aviso (revisão 04/11).
//    E a reserva do tick é pela LINHA: o aviso não consome o toque do lead do mesmo
//    turno, e um tick com SELECT velho não manda nem consome linha nova.
//
// Invariante 2: com a fase do livro já gravada (funnel), os toques não perguntam a
// fase de novo.
//
// Roda a query REAL (SQL_FOLLOWUPS_VENCIDOS) num banco em memória com o schema real.
// Uso: node scripts/test-followup-horario.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { SQL_FOLLOWUPS_VENCIDOS, SEM_MENSAGEM_PRO_LEAD, textoFollowup, reservarFollowup } from '../src/scheduler.js';
import { expediente } from '../src/agent/scheduling.js';
import { SQL_CANCELA_PENDENTES, recordInbound } from '../src/agent/contactService.js';

let ok = 0;
const caso = (nome, fn) => { fn(); console.log(`  ✓ ${nome}`); ok++; };

const db = new Database(':memory:');
db.exec(fs.readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));
const agoraSqlite = off => db.prepare(`SELECT datetime('now', ?) AS t`).get(off).t;   // 'YYYY-MM-DD HH:MM:SS'
const iso = off => agoraSqlite(off).replace(' ', 'T') + '.000Z';                     // como o código grava
let n = 0;
const contato = () => db.prepare(`INSERT INTO contacts (ghl_contact_id, name) VALUES (?, 'Lead')`).run(`c${++n}`).lastInsertRowid;
const followup = (cid, due, reason) => db.prepare(`INSERT INTO followups (contact_id, due_at, reason) VALUES (?, ?, ?)`).run(cid, due, reason).lastInsertRowid;
const vencidos = aberto => db.prepare(SQL_FOLLOWUPS_VENCIDOS).all(aberto ? 1 : 0, ...SEM_MENSAGEM_PRO_LEAD).map(f => f.id);
const limpa = () => db.prepare('DELETE FROM followups').run();

try {
  console.log('\nVencimento (o bug do "T")');
  caso('ISO vencido há 1 min sai agora, não na virada do dia UTC', () => {
    limpa();
    const id = followup(contato(), iso('-1 minute'), 'silencio_lead');
    assert.deepEqual(vencidos(true), [id]);
  });
  caso('ISO no futuro ainda não sai', () => {
    limpa();
    followup(contato(), iso('+5 minutes'), 'silencio_lead');
    assert.deepEqual(vencidos(true), []);
  });
  caso('formato do SQLite (checagem de agendamento travado) também vence', () => {
    limpa();
    const id = followup(contato(), agoraSqlite('-1 minute'), 'agendamento_travado');
    assert.deepEqual(vencidos(true), [id]);
  });
  caso('1 por contato: o mais antigo', () => {
    limpa();
    const c = contato();
    const a = followup(c, iso('-10 minutes'), 'silencio_lead');
    followup(c, iso('-5 minutes'), 'silencio_lead_24h');
    assert.deepEqual(vencidos(true), [a]);
  });

  console.log('\nHorário comercial');
  caso('fechado: follow-up pro lead espera; aviso pro time e encerrar card saem', () => {
    limpa();
    followup(contato(), iso('-1 minute'), 'silencio_lead');
    followup(contato(), iso('-1 minute'), 'silencio_lead_24h');
    followup(contato(), iso('-1 minute'), 'retomar_script');
    followup(contato(), iso('-1 minute'), 'silencio_sdr');
    const travado = followup(contato(), agoraSqlite('-1 minute'), 'agendamento_travado');
    const encerrar = followup(contato(), iso('-1 minute'), 'encerrar_sem_resposta');
    assert.deepEqual(vencidos(false).sort(), [travado, encerrar].sort());
  });
  caso('aberto: sai tudo que venceu', () => {
    assert.equal(vencidos(true).length, 6);
  });
  caso('fechado: 20 follow-ups pro lead pendentes não seguram o aviso pro time (LIMIT)', () => {
    limpa();
    for (let i = 0; i < 25; i++) followup(contato(), iso('-1 hour'), 'silencio_lead');
    const travado = followup(contato(), agoraSqlite('-1 minute'), 'agendamento_travado');
    assert.deepEqual(vencidos(false), [travado]);
  });

  console.log('\nChecagem de agendamento travado não é cancelada pelo follow-up do lead');
  const pendentes = cid => db.prepare('SELECT reason FROM followups WHERE contact_id = ? AND sent = 0 ORDER BY id').all(cid).map(r => r.reason);
  caso('scheduleFollowup cancela os pendentes do lead, mas mantém a checagem do mesmo turno', () => {
    limpa();
    const c = contato();
    followup(c, iso('+50 minutes'), 'silencio_lead');                 // do turno anterior
    followup(c, agoraSqlite('+15 minutes'), 'agendamento_travado');   // passo 7.8, este turno
    db.prepare(SQL_CANCELA_PENDENTES).run(c);                          // fim do turno
    assert.deepEqual(pendentes(c), ['agendamento_travado']);
  });
  caso('lead responde ("amanhã às 10h"): cancela o toque dele, mantém a checagem da oferta', () => {
    limpa();
    const c = contato();
    followup(c, agoraSqlite('+10 minutes'), 'agendamento_travado');   // armada na oferta de horário
    followup(c, iso('+40 minutes'), 'silencio_lead');
    assert.match(recordInbound.toString(), /SQL_CANCELA_PENDENTES/);   // recordInbound usa a mesma regra
    db.prepare(SQL_CANCELA_PENDENTES).run(c);                          // recordInbound
    assert.deepEqual(pendentes(c), ['agendamento_travado']);
  });
  caso('com o silencio_lead novo na fila, a checagem (mais antiga) é a que vence primeiro', () => {
    limpa();
    const c = contato();
    const travado = followup(c, agoraSqlite('-1 minute'), 'agendamento_travado');
    db.prepare(SQL_CANCELA_PENDENTES).run(c);
    followup(c, iso('+45 minutes'), 'silencio_lead');
    assert.deepEqual(vencidos(false), [travado]);
  });

  console.log('\nReserva pela linha, não pelo contato');
  caso('reservar a checagem travada não consome o silencio_lead do mesmo turno', () => {
    limpa();
    const c = contato();
    const travado = followup(c, agoraSqlite('-1 minute'), 'agendamento_travado');
    followup(c, iso('+45 minutes'), 'silencio_lead');
    assert.equal(reservarFollowup({ id: travado, contact_id: c, reason: 'agendamento_travado' }, db), true);
    assert.deepEqual(pendentes(c), ['silencio_lead']);
  });
  caso('reservar um toque pro lead cancela os outros pendentes do contato', () => {
    limpa();
    const c = contato();
    const t = followup(c, iso('-1 minute'), 'silencio_lead');
    followup(c, iso('+1 day'), 'silencio_lead_24h');
    assert.equal(reservarFollowup({ id: t, contact_id: c, reason: 'silencio_lead' }, db), true);
    assert.deepEqual(pendentes(c), []);
  });
  caso('SELECT velho: o lead falou no meio do tick e o turno armou linhas novas → pula sem tocar nelas', () => {
    limpa();
    const c = contato();
    const velho = followup(c, iso('-1 minute'), 'silencio_lead');
    db.prepare(SQL_CANCELA_PENDENTES).run(c);                                               // recordInbound
    followup(c, agoraSqlite('+15 minutes'), 'agendamento_travado');                         // 7.8 do turno
    followup(c, iso('+60 minutes'), 'silencio_lead');
    assert.equal(reservarFollowup({ id: velho, contact_id: c, reason: 'silencio_lead' }, db), false);
    assert.deepEqual(pendentes(c), ['agendamento_travado', 'silencio_lead']);
  });
  caso('dois ticks: o mais novo já mandou e encadeou o 24h → o atrasado pula', () => {
    limpa();
    const c = contato();
    const f = { id: followup(c, iso('-1 minute'), 'silencio_lead'), contact_id: c, reason: 'silencio_lead' };
    assert.equal(reservarFollowup(f, db), true);                // tick 2
    followup(c, iso('+1 day'), 'silencio_lead_24h');           // tick 2 encadeia
    assert.equal(reservarFollowup(f, db), false);               // tick 1, atrasado
    assert.deepEqual(pendentes(c), ['silencio_lead_24h']);
  });

  console.log('\nTexto do toque: não repergunta a fase (invariante 2)');
  const FASE = /em que fase/;
  caso('fase gravada: 1º toque termina na pergunta de interesse', () => {
    const t = textoFollowup({ reason: 'silencio_lead', name: 'Ana Souza', funnel: 'publicar' });
    assert.ok(!FASE.test(t), t);
    assert.ok(t.startsWith('Oi Ana, ') && t.endsWith('Você ainda tem interesse em seguir?'), t);
  });
  caso('fase gravada: 2º toque termina em "ainda posso te ajudar com o seu livro?"', () => {
    const t = textoFollowup({ reason: 'silencio_lead_24h', name: 'Ana', funnel: 'divulgar' });
    assert.ok(!FASE.test(t) && t.endsWith('ainda posso te ajudar com o seu livro?'), t);
  });
  caso('sem fase (null ou indefinido): pergunta a fase como antes', () => {
    for (const funnel of [null, undefined, 'indefinido']) {
      assert.ok(FASE.test(textoFollowup({ reason: 'silencio_lead', name: 'Ana', funnel })));
      assert.ok(FASE.test(textoFollowup({ reason: 'silencio_lead_24h', name: 'Ana', funnel })));
    }
  });
  caso('nome cru do WhatsApp continua fora da saudação', () => {
    assert.ok(textoFollowup({ reason: 'silencio_lead', name: 'mariozeferino698', funnel: 'escrever' }).startsWith('Oi, aqui é a Tina'));
  });

  console.log('\nExpediente (BRT, nunca o fuso do servidor)');
  const exp = isoUtc => expediente(new Date(isoUtc)).aberto;
  caso('terça 22h30 BRT: fechado', () => assert.equal(exp('2026-11-04T01:30:00Z'), false));
  caso('quarta 10h BRT: aberto', () => assert.equal(exp('2026-11-04T13:00:00Z'), true));
  caso('quarta 8h59 BRT: fechado; 9h: aberto', () => {
    assert.equal(exp('2026-11-04T11:59:00Z'), false);
    assert.equal(exp('2026-11-04T12:00:00Z'), true);
  });
  caso('quarta 18h BRT: fechado', () => assert.equal(exp('2026-11-04T21:00:00Z'), false));
  caso('sábado 11h BRT: fechado', () => assert.equal(exp('2026-11-07T14:00:00Z'), false));

  console.log(`\n${ok} casos passaram`);
} catch (err) {
  console.error('\n✗ FALHOU:', err.message);
  process.exit(1);
}
