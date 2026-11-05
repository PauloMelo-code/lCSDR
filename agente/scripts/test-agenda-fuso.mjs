// Hora de reunião do GHL lida no fuso certo (invariante 5), com o processo em UTC como o
// servidor. ❌ O /contacts/{id}/appointments devolve 'AAAA-MM-DD HH:mm:ss' sem fuso (BRT)
// e o new Date() lia como UTC: nas 3h antes da reunião ela parecia passada, e a Tina
// mandava follow-up, encerrava o card ou avisava "agendamento travado" para quem tinha
// reunião marcada.
// Sem rede e sem banco: db/index.js vai para ':memory:' e o cliente do GHL vira stub.
// Uso: node scripts/test-agenda-fuso.mjs

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

process.env.TZ = 'UTC';   // o servidor de produção
registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context);
    if (!url.endsWith('/src/db/index.js')) return r;
    const src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
    const trocado = src.replace("path.join(DATA_DIR, 'lc-sdr.db')", "':memory:'");
    if (trocado === src) throw new Error('db/index.js mudou: o teste não conseguiu isolar o banco');
    return { ...r, source: trocado };
  },
});
delete process.env.GHL_TIMEZONE;
process.env.GHL_API_TOKEN = 'token-falso-de-teste';
process.env.GHL_API_BASE = 'http://127.0.0.1:9';
process.env.LOG_LEVEL = 'silent';

const { GHL } = await import('../src/ghl/client.js');
const { instanteGhl, upcomingAppointment, labelForSlot, bookSlot, recordOffer } = await import('../src/agent/scheduling.js');

let EVENTOS = [];
GHL.getContactAppointments = async () => ({ events: EVENTOS });
// 'AAAA-MM-DD HH:mm:ss' em BRT, como o GHL devolve, para um instante qualquer
const paredeBRT = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const contato = { id: 1, ghl_contact_id: 'c1' };

let ok = 0;
const caso = async (nome, fn) => { await fn(); console.log(`  ✓ ${nome}`); ok++; };

try {
  console.log('\nHora de reunião do GHL (fuso)\n');

  await caso('hora sem fuso é BRT: 14h vira 17h UTC', () => {
    assert.equal(instanteGhl('2026-11-05 14:00:00'), Date.parse('2026-11-05T17:00:00Z'));
    assert.equal(instanteGhl('2026-11-05T14:00'), Date.parse('2026-11-05T17:00:00Z'));
    assert.equal(instanteGhl('2026-11-05T14:00:00.000'), Date.parse('2026-11-05T17:00:00Z'));
  });

  await caso('virada do dia: 22h BRT é 01h UTC do dia seguinte', () => {
    assert.equal(instanteGhl('2026-11-05 22:30:00'), Date.parse('2026-11-06T01:30:00Z'));
  });

  await caso('com fuso, número ou texto numérico: o instante exato', () => {
    const t = Date.parse('2026-11-05T17:00:00Z');
    assert.equal(instanteGhl('2026-11-05T14:00:00-03:00'), t);
    assert.equal(instanteGhl('2026-11-05T17:00:00Z'), t);
    assert.equal(instanteGhl(t), t);
    assert.equal(instanteGhl(String(t)), t);
  });

  await caso('ilegível vira NaN, nunca epoch 0; outro formato com fuso segue o Date.parse', () => {
    for (const v of [undefined, null, '', 'amanhã', {}, true]) assert.ok(Number.isNaN(instanteGhl(v)), String(v));
    assert.equal(instanteGhl('Thu, 05 Nov 2026 17:00:00 GMT'), Date.parse('2026-11-05T17:00:00Z'));
  });

  await caso('❌ reunião daqui a 2h (hora sem fuso) conta como futura', async () => {
    EVENTOS = [{ id: 'a1', startTime: paredeBRT(Date.now() + 2 * 36e5), appointmentStatus: 'confirmed' }];
    assert.equal((await upcomingAppointment(contato))?.id, 'a1', 'a reunião das próximas 3h sumiu: é o bug do UTC');
  });

  await caso('reunião que já passou não conta', async () => {
    EVENTOS = [{ id: 'a0', startTime: paredeBRT(Date.now() - 10 * 60_000), appointmentStatus: 'confirmed' }];
    assert.equal(await upcomingAppointment(contato), null);
  });

  await caso('cancelada não conta; com várias, vem a mais cedo', async () => {
    EVENTOS = [
      { id: 'longe', startTime: paredeBRT(Date.now() + 48 * 36e5), appointmentStatus: 'confirmed' },
      { id: 'cancelada', startTime: paredeBRT(Date.now() + 1 * 36e5), appointmentStatus: 'cancelled' },
      { id: 'perto', startTime: paredeBRT(Date.now() + 2 * 36e5), appointmentStatus: 'booked' },
    ];
    assert.equal((await upcomingAppointment(contato))?.id, 'perto');
  });

  await caso('rótulo (lembrete, aviso do time) com hora sem fuso diz a hora de Brasília', () => {
    assert.match(labelForSlot('2026-11-05 14:00:00'), /14:00/);
    assert.match(labelForSlot('2026-11-05T14:00:00-03:00'), /14:00/);
  });

  // bookSlot: o book_slot vem do LLM, copiado da lista com -03:00
  process.env.SCHEDULING_ENABLED = 'true';
  process.env.GHL_CALENDAR_ID = 'cal1';
  const marcados = [];
  GHL.listCalendars = async () => ({ calendars: [{ id: 'cal1', slotDuration: 30, teamMembers: [{ userId: 'u1', isPrimary: true }] }] });
  GHL.getCalendarEvents = async () => ({ events: [] });
  GHL.bookAppointment = async b => { marcados.push(b); return { id: 'novo' }; };
  GHL.assignContact = async () => ({});
  const { db } = await import('../src/db/index.js');   // ':memory:' (hook acima)
  const lead = { id: Number(db.prepare(`INSERT INTO contacts (ghl_contact_id, name) VALUES ('c1', 'Teste')`).run().lastInsertRowid), ghl_contact_id: 'c1', name: 'Teste' };

  await caso('❌ book_slot sem fuso marca às 14h BRT, não 3h antes', async () => {
    marcados.length = 0;
    const r = await bookSlot(lead, '2026-11-05T14:00:00');
    assert.ok(r.ok, r.error);
    assert.equal(marcados[0].startTime, '2026-11-05T17:00:00.000Z', 'marcou no fuso do servidor');
    assert.equal(marcados[0].endTime, '2026-11-05T17:30:00.000Z');
    assert.match(r.label, /14:00/);
  });

  await caso('book_slot com -03:00 marca o mesmo horário; lixo é recusado', async () => {
    marcados.length = 0;
    assert.ok((await bookSlot(lead, '2026-11-05T14:00:00-03:00')).ok);
    assert.equal(marcados[0].startTime, '2026-11-05T17:00:00.000Z');
    assert.equal((await bookSlot(lead, 'amanhã às 14h')).error, 'iso inválido');
  });

  await caso('book_slot sem fuso vai para o calendário do closer que ofereceu', async () => {
    recordOffer(lead.id, [{ iso: '2026-11-05T15:00:00-03:00', calendarId: 'cal2', label: 'x' }]);
    const r = await bookSlot(lead, '2026-11-05T15:00:00');
    assert.equal(r.calendarId, 'cal2', 'caiu no calendário padrão: não casou com o horário oferecido');
  });

  await caso('book_slot sem fuso às 19h BRT é recusado (fora do expediente)', async () => {
    assert.equal((await bookSlot(lead, '2026-11-05T19:00:00')).error, 'horário fora do expediente');
  });

  await caso('trava de conflito lê a reunião existente sem fuso como BRT', async () => {
    GHL.getCalendarEvents = async () => ({ events: [{ id: 'x', startTime: '2026-11-05 14:00:00', endTime: '2026-11-05 14:30:00', appointmentStatus: 'confirmed' }] });
    assert.equal((await bookSlot(lead, '2026-11-05T14:00:00-03:00')).error, 'horário já ocupado');
    GHL.getCalendarEvents = async () => ({ events: [] });
  });

  console.log(`\n${ok} casos passaram\n`);
} catch (err) {
  console.error(`\n❌ FALHOU: ${err.message}\n`);
  process.exitCode = 1;
}
