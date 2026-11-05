// Amarras da Tina com os funis do GHL (src/ghl/opportunities.js + o declínio do
// handoff.js). Rede de segurança da reorganização do CRM aprovada pela Lilian (04/11):
// mexer em coluna ou funil sem quebrar os invariantes 6, 7 e 9 do CLAUDE.md.
//
// Sem rede e sem banco de produção: o cliente do GHL vira stub e o db/index.js é
// redirecionado pra ':memory:' ANTES de qualquer import do src. Nenhuma env do .env
// entra (o src só carrega dotenv no index.js, que este teste não importa).
// O node-fetch do organicoSweep.js também vira stub (ele chama o GHL direto, sem o client).
// Uso: node scripts/test-oportunidades.mjs

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Nunca o data/lc-sdr.db: troca o caminho no fonte do db/index.js. Se esse trecho
// mudar, o teste aborta em vez de abrir o banco real.
const FETCH_STUB = 'data:text/javascript,' + encodeURIComponent('export default (...a) => globalThis.__fetchOrg(...a);');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node-fetch' && context.parentURL?.endsWith('/src/agent/organicoSweep.js')) return { url: FETCH_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const r = nextLoad(url, context);
    if (!url.endsWith('/src/db/index.js')) return r;
    const src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
    const trocado = src.replace("path.join(DATA_DIR, 'lc-sdr.db')", "':memory:'");
    if (trocado === src) throw new Error('db/index.js mudou: o teste não conseguiu isolar o banco');
    return { ...r, source: trocado };
  },
});

for (const k of ['GHL_PIPELINE_ID', 'GHL_PIPELINE_STAGE_QUALIFIED', 'GHL_PIPELINE_STAGE_IA_TINA',
  'GHL_BLOCK_OPP_STAGES', 'GHL_TINA_OWNED_STAGES', 'GHL_TINA_LANE_STAGES', 'ORGANICO_STAGE_ID',
  'LOST_OPP_BLOCK_DAYS', 'SKIP_CONVERTED_CUSTOMERS', 'CLOSE_SDR_OPP_ON_BOOKING', 'SCHEDULED_SDR_OPP_STATUS',
  'DECLINE_OPP_ON_DISQUALIFY', 'TINA_LOST_REASON_BOOKED_ID', 'TINA_LOST_REASON_DISQUALIFIED_ID',
  'TINA_LOST_REASON_NO_RESPONSE_ID', 'GHL_LOCATION_ID']) delete process.env[k];
process.env.GHL_API_TOKEN = 'token-falso-de-teste';
process.env.GHL_API_BASE = 'http://127.0.0.1:9';   // se algo escapar do stub, bate numa porta local fechada
process.env.LOG_LEVEL = 'silent';

const { GHL } = await import('../src/ghl/client.js');
const O = await import('../src/ghl/opportunities.js');
const H = await import('../src/agent/handoff.js');
const { sweepOrganico } = await import('../src/agent/organicoSweep.js');

// === stubs do GHL ===
let OPS = [];
let chamadas = [];
GHL.getOpportunitiesByContact = async () => ({ opportunities: OPS });
GHL.updateOpportunity = async (id, patch) => { chamadas.push({ fn: 'update', id, ...patch }); return {}; };
GHL.updateOpportunityStatus = async (id, body) => { chamadas.push({ fn: 'status', id, ...body }); return {}; };
GHL.createOpportunity = async b => { chamadas.push({ fn: 'create', ...b }); return { opportunity: { id: 'nova' } }; };
GHL.getContactAppointments = async () => ({ events: [] });
GHL.deleteAppointment = async id => { chamadas.push({ fn: 'deleteAppt', id }); };
GHL.listCustomFields = async () => ({ customFields: [] });   // markDisqualified grava custom fields
GHL.upsertCustomFields = async () => ({});

// Ids reais (funis.json, 04/11)
const TINA = 'MfDNcFdH03j0ZBuwJDYM';       // 1. Pré-Vendas LCA (SDR)
const VENDAS = 'RrFpWfwZP8ZZkkGUVqnM';     // 2. Vendas LCA (Closers)
const BOOKS = '9P0F2IxnytskxDlu00eu';      // 3. LC Books
const ST = {
  iaTina: '74164182-d3b0-447b-a761-3bdcd6d47eac',
  aguardando: '0c040fa3-3ed5-449f-ab07-c7b3fb40f97c',
  organico: 'd596db34-ada4-4e7a-936a-943a9410d9a6',
  reentrada: 'b661d5f1-69cd-4531-8be9-79b3e11c862f',
  reentradaBooks: '009b6a60-2c9b-41f9-95d3-20d54c18ab8d',
  reentrada20: 'ee211407-4153-4a93-bf03-0b9ff000effe',
  followUp: '93eea3c5-dce9-4be0-bbd2-076e8d81308d',
  proposta: '696ae817-e60f-4cae-8a79-255f3a38c874',
  reunioes: 'cca2a745-e94e-49a5-9d22-81f9f1f030e0',
  venda: 'f9fef38e-deeb-480d-a13c-63bff144336f',
};
let n = 0;
const card = (pipelineId, pipelineStageId, status = 'open', extra = {}) =>
  ({ id: `o${++n}`, pipelineId, pipelineStageId, status, ...extra });
const diasAtras = d => new Date(Date.now() - d * 86_400_000).toISOString();
const lead = { ghl_contact_id: 'c-teste' };   // sem `id`: markSelfMove não toca banco nenhum
const com = (...ops) => { OPS = ops; chamadas = []; return ops; };
const espera = () => new Promise(r => setTimeout(r, 20));   // deixa terminar o que é fire-and-forget

let ok = 0;
const caso = async (nome, fn) => { await fn(); console.log(`  ✓ ${nome}`); ok++; };

try {
  console.log('\nPadrões de hoje (nada muda sem env)');
  await caso('crmConfig devolve os mesmos ids e flags de antes', () => {
    const c = O.crmConfig();
    assert.equal(c.pipelineId, TINA);
    assert.equal(c.stageQualified, ST.aguardando);
    assert.equal(c.stageIaTina, ST.iaTina);
    assert.equal(c.stageOrganico, ST.organico);
    assert.deepEqual(c.blockOppStages, [ST.reentrada, ST.reentradaBooks, ST.reentrada20]);
    assert.deepEqual(c.tinaOwnedStages, [ST.organico]);   // fonte única do Funil Orgânico
    assert.deepEqual(c.tinaLaneStages, []);
    assert.equal(c.lostOppBlockDays, 30);
    assert.equal(c.skipConvertedCustomers, true);
    assert.equal(c.closeSdrOppOnBooking, true);
    assert.equal(c.scheduledSdrOppStatus, 'lost');
    assert.equal(c.lostReasonBookedId, null);
    assert.equal(c.lostReasonDisqualifiedId, null);
    assert.equal(c.lostReasonNoResponseId, null);
  });

  console.log('\nInvariante 6: ganho em outro funil = cliente convertido');
  await caso('venda ganha no Vendas: convertido e de outro time', async () => {
    com(card(VENDAS, ST.venda, 'won'));
    assert.equal(await O.contactIsConvertedCustomer(lead), true);
    assert.equal(await O.contactWorkedByOtherTeam(lead), true);
  });
  await caso('ganho no PRÓPRIO funil da Tina não conta como convertido', async () => {
    com(card(TINA, ST.aguardando, 'won'));
    assert.equal(await O.contactIsConvertedCustomer(lead), false);
    assert.equal(await O.contactWorkedByOtherTeam(lead), false);
  });

  console.log('\nInvariante 7: card declinado recente em outro funil bloqueia (LOST_OPP_BLOCK_DAYS=30)');
  await caso('perdido no Vendas há 10 dias: bloqueia', async () => {
    com(card(VENDAS, ST.proposta, 'lost', { updatedAt: diasAtras(10) }));
    assert.equal(await O.contactWorkedByOtherTeam(lead), true);
  });
  await caso('perdido no Vendas há 40 dias: não bloqueia (lead antigo é lead novo)', async () => {
    com(card(VENDAS, ST.proposta, 'lost', { updatedAt: diasAtras(40) }));
    assert.equal(await O.contactWorkedByOtherTeam(lead), false);
  });
  await caso('perdido no funil da Tina há 10 dias: não bloqueia (foi a própria Tina)', async () => {
    com(card(TINA, ST.iaTina, 'lost', { updatedAt: diasAtras(10) }));
    assert.equal(await O.contactWorkedByOtherTeam(lead), false);
  });

  console.log('\nOutro time');
  await caso('aberto em outro funil (Proposta Enviada do Vendas) = outro time', async () => {
    com(card(VENDAS, ST.proposta));
    assert.equal(await O.contactWorkedByOtherTeam(lead), true);
  });
  await caso('aberto em Reentrada (Pré-Vendas e LC Books) bloqueia', async () => {
    for (const [p, s] of [[TINA, ST.reentrada], [BOOKS, ST.reentradaBooks]]) {
      com(card(p, s));
      assert.equal(await O.contactWorkedByOtherTeam(lead), true, s);
      assert.equal(await O.contactOppInReentrada(lead), true, s);
    }
  });
  await caso('só aberto na IA Tina: não é de outro time', async () => {
    com(card(TINA, ST.iaTina));
    assert.equal(await O.contactWorkedByOtherTeam(lead), false);
    assert.equal(await O.contactOppInReentrada(lead), false);
  });

  console.log('\nInvariante 9: ao agendar, fecha o card do Pré-Vendas e nunca o do Vendas');
  await caso('fecha só o card ABERTO do funil da Tina, como lost, sem motivo', async () => {
    const [tina] = com(card(TINA, ST.iaTina), card(VENDAS, ST.reunioes), card(TINA, ST.organico, 'lost'));
    await O.closeSdrOppOnBooking(lead);
    assert.deepEqual(chamadas, [{ fn: 'update', id: tina.id, pipelineId: TINA, pipelineStageId: ST.iaTina, status: 'lost' }]);
  });
  await caso('CLOSE_SDR_OPP_ON_BOOKING=false: não mexe em nada', async () => {
    com(card(TINA, ST.iaTina));
    process.env.CLOSE_SDR_OPP_ON_BOOKING = 'false';
    await O.closeSdrOppOnBooking(lead);
    delete process.env.CLOSE_SDR_OPP_ON_BOOKING;
    assert.deepEqual(chamadas, []);
  });
  await caso('com TINA_LOST_REASON_BOOKED_ID: fecha e grava o motivo de agendamento, só no card da Tina', async () => {
    const [tina] = com(card(TINA, ST.aguardando), card(VENDAS, ST.reunioes));
    process.env.TINA_LOST_REASON_BOOKED_ID = 'motivo-agendou';
    process.env.TINA_LOST_REASON_DISQUALIFIED_ID = 'motivo-desqualificou';
    await O.closeSdrOppOnBooking(lead);
    assert.deepEqual(chamadas, [
      { fn: 'update', id: tina.id, pipelineId: TINA, pipelineStageId: ST.aguardando, status: 'lost' },
      { fn: 'status', id: tina.id, status: 'lost', lostReasonId: 'motivo-agendou' },
    ]);
  });
  await caso('SCHEDULED_SDR_OPP_STATUS=won: fecha como won e NÃO manda motivo de perda', async () => {
    const [tina] = com(card(TINA, ST.iaTina));
    process.env.SCHEDULED_SDR_OPP_STATUS = 'won';
    await O.closeSdrOppOnBooking(lead);
    delete process.env.SCHEDULED_SDR_OPP_STATUS;
    assert.deepEqual(chamadas, [{ fn: 'update', id: tina.id, pipelineId: TINA, pipelineStageId: ST.iaTina, status: 'won' }]);
  });
  await caso('motivo de perda falhando no GHL: o card continua fechado e nada estoura', async () => {
    const [tina] = com(card(TINA, ST.iaTina));
    const real = GHL.updateOpportunityStatus;
    GHL.updateOpportunityStatus = async () => { const e = new Error('422'); e.status = 422; throw e; };
    const antes = O.crmConfig().motivoPerdaFalhas.n;
    await O.closeSdrOppOnBooking(lead);
    GHL.updateOpportunityStatus = real;
    assert.deepEqual(chamadas, [{ fn: 'update', id: tina.id, pipelineId: TINA, pipelineStageId: ST.iaTina, status: 'lost' }]);
    // a falha aparece no /health (crm.motivoPerdaFalhas), não só no log
    assert.equal(O.crmConfig().motivoPerdaFalhas.n, antes + 1);
    assert.equal(O.crmConfig().motivoPerdaFalhas.ultimoStatus, 422);
  });
  await caso('continuidade da IA Tina: evento de card fechado é reconhecido; aberto ou sem status, não', () => {
    assert.equal(O.eventoDeCardFechado({ type: 'OpportunityStatusUpdate', status: 'lost', pipelineStageId: ST.iaTina }), true);
    assert.equal(O.eventoDeCardFechado({ type: 'IaTinaAssumir', opportunity: { status: 'won' } }), true);
    assert.equal(O.eventoDeCardFechado({ status: 'abandoned' }), true);
    assert.equal(O.eventoDeCardFechado({ type: 'OpportunityStageUpdate', status: 'open' }), false);
    assert.equal(O.eventoDeCardFechado({ type: 'IaTinaAssumir', _force: true }), false);   // varredura
    assert.equal(O.eventoDeCardFechado({}), false);
  });

  console.log('\nEncerramento: declina só o card da Tina, e cada caso com o seu motivo');
  const leadDb = { id: 424242, ghl_contact_id: 'c-teste' };   // id inexistente no banco em memória
  const fechou = id => ({ fn: 'update', id, pipelineId: TINA, pipelineStageId: ST.iaTina, status: 'lost' });
  await caso('desqualificado (markDisqualified): motivo de desqualificação, nem o de agendamento nem o de sem resposta', async () => {
    process.env.TINA_LOST_REASON_NO_RESPONSE_ID = 'motivo-sem-resposta';
    const [tina] = com(card(TINA, ST.iaTina), card(VENDAS, ST.proposta));
    await H.markDisqualified(leadDb, { qualification_score: 0 });
    await espera();
    assert.deepEqual(chamadas, [fechou(tina.id), { fn: 'status', id: tina.id, status: 'lost', lostReasonId: 'motivo-desqualificou' }]);
  });
  await caso('encerrado sem resposta (closeLeadNoResponse): motivo próprio, não o de desqualificado', async () => {
    const [tina] = com(card(TINA, ST.iaTina), card(VENDAS, ST.proposta));
    await H.closeLeadNoResponse(leadDb);
    assert.deepEqual(chamadas, [fechou(tina.id), { fn: 'status', id: tina.id, status: 'lost', lostReasonId: 'motivo-sem-resposta' }]);
  });
  await caso('sem TINA_LOST_REASON_NO_RESPONSE_ID: sem resposta fecha sem motivo, mesmo com o de desqualificado setado', async () => {
    delete process.env.TINA_LOST_REASON_NO_RESPONSE_ID;
    const [tina] = com(card(TINA, ST.iaTina));
    await H.closeLeadNoResponse(leadDb);
    assert.deepEqual(chamadas, [fechou(tina.id)]);
  });
  await caso('sem env de motivo: só o lost de sempre, nos dois encerramentos', async () => {
    delete process.env.TINA_LOST_REASON_BOOKED_ID;
    delete process.env.TINA_LOST_REASON_DISQUALIFIED_ID;
    let [tina] = com(card(TINA, ST.iaTina), card(VENDAS, ST.proposta));
    await H.markDisqualified(leadDb, { qualification_score: 0 });
    await espera();
    assert.deepEqual(chamadas, [fechou(tina.id)]);
    [tina] = com(card(TINA, ST.iaTina), card(VENDAS, ST.proposta));
    await H.closeLeadNoResponse(leadDb);
    assert.deepEqual(chamadas, [fechou(tina.id)]);
  });

  console.log('\nclaimToIaTina não puxa card de coluna bloqueada');
  await caso('Funil Orgânico: puxa pra IA Tina (controle — prova que o claim move)', async () => {
    const [o] = com(card(TINA, ST.organico));
    assert.equal(await O.claimToIaTina(lead), o.id);
    assert.deepEqual(chamadas, [{ fn: 'update', id: o.id, pipelineId: TINA, pipelineStageId: ST.iaTina, status: 'open' }]);
  });
  await caso('Reentrada: não move', async () => {
    const [o] = com(card(TINA, ST.reentrada));
    assert.equal(await O.claimToIaTina(lead), o.id);
    assert.deepEqual(chamadas, []);
  });
  await caso('aberto só no Vendas: não move nem cria', async () => {
    com(card(VENDAS, ST.proposta));
    await O.claimToIaTina(lead);
    assert.deepEqual(chamadas, []);
  });
  await caso('só cards fechados (cliente antigo): não cria card novo', async () => {
    com(card(VENDAS, ST.venda, 'won'));
    await O.claimToIaTina(lead);
    assert.deepEqual(chamadas, []);
  });
  await caso('lead sem card nenhum: cria na IA Tina', async () => {
    com();
    assert.equal(await O.claimToIaTina(lead), 'nova');
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].fn, 'create');
    assert.equal(chamadas[0].stageId, ST.iaTina);
  });

  console.log('\nRaia da Tina');
  await caso('contactInIaTinaLane: basta UM card aberto na IA Tina', async () => {
    com(card(VENDAS, ST.proposta), card(TINA, ST.iaTina));
    assert.equal(await O.contactInIaTinaLane(lead), true);
    com(card(TINA, ST.iaTina, 'lost'));
    assert.equal(await O.contactInIaTinaLane(lead), false);
    com(card(TINA, ST.organico));
    assert.equal(await O.contactInIaTinaLane(lead), false);
  });
  await caso('contactExclusivelyInTinaLane: TODOS os abertos na IA Tina/Orgânico', async () => {
    com(card(TINA, ST.iaTina), card(TINA, ST.organico));
    assert.equal(await O.contactExclusivelyInTinaLane(lead), true);
    com(card(TINA, ST.iaTina), card(VENDAS, ST.proposta));
    assert.equal(await O.contactExclusivelyInTinaLane(lead), false);
    com(card(TINA, ST.followUp));
    assert.equal(await O.contactExclusivelyInTinaLane(lead), false);
    com(card(TINA, ST.iaTina, 'lost'));
    assert.equal(await O.contactExclusivelyInTinaLane(lead), false);
    com();
    assert.equal(await O.contactExclusivelyInTinaLane(lead), false);
  });

  await caso('contactOppOutsideTinaLane: aberto fora da IA Tina/Aguardando bloqueia; só GHL_TINA_LANE_STAGES amplia', async () => {
    com(card(TINA, ST.iaTina), card(TINA, ST.aguardando), card(TINA, ST.followUp, 'lost'));
    assert.equal(await O.contactOppOutsideTinaLane(lead), null);
    const [org] = com(card(TINA, ST.organico));
    assert.equal(await O.contactOppOutsideTinaLane(lead), org);
    process.env.GHL_TINA_OWNED_STAGES = ST.organico;   // coluna DONA não entra na raia do gate
    assert.equal(await O.contactOppOutsideTinaLane(lead), org);
    delete process.env.GHL_TINA_OWNED_STAGES;
    process.env.GHL_TINA_LANE_STAGES = ST.organico;
    assert.equal(await O.contactOppOutsideTinaLane(lead), null);
    delete process.env.GHL_TINA_LANE_STAGES;
  });

  console.log('\nVarredura do Funil Orgânico (ligada em produção)');
  await caso('busca a coluna do Funil Orgânico (stageOrganico), só abertos', async () => {
    const urls = [];
    globalThis.__fetchOrg = async url => { urls.push(String(url)); return { ok: true, json: async () => ({ opportunities: [] }) }; };
    process.env.GHL_LOCATION_ID = 'loc-teste';
    const r = await sweepOrganico();
    delete process.env.GHL_LOCATION_ID;
    assert.equal(r.total, 0);
    assert.equal(urls.length, 1);
    const q = new URL(urls[0]).searchParams;
    assert.equal(q.get('pipeline_stage_id'), ST.organico);
    assert.equal(q.get('status'), 'open');
  });

  console.log('\nFollow Up do Pré-Vendas (93eea3c5): o de hoje e o efeito da opção. NÃO é recomendação (decisão de 19/06, commit 8da24a8: a colisão é detectada por mensagem)');
  await caso('HOJE: card do time em Follow Up é puxado pra IA Tina e a Tina atende', async () => {
    const [o] = com(card(TINA, ST.followUp));
    assert.equal(await O.contactWorkedByOtherTeam(lead), false);
    await O.claimToIaTina(lead);
    assert.deepEqual(chamadas, [{ fn: 'update', id: o.id, pipelineId: TINA, pipelineStageId: ST.iaTina, status: 'open' }]);
  });
  await caso('SE a LC decidir anexar 93eea3c5 ao GHL_BLOCK_OPP_STAGES: não puxa e a Tina não atende', async () => {
    process.env.GHL_BLOCK_OPP_STAGES = [ST.reentrada, ST.reentradaBooks, ST.reentrada20, ST.followUp].join(',');
    const [o] = com(card(TINA, ST.followUp));
    assert.equal(await O.claimToIaTina(lead), o.id);
    assert.equal(await O.createOrMoveOpportunityQualified(lead, { funnel: 'publicar', score: 80 }), o.id);
    assert.deepEqual(chamadas, []);
    assert.equal(await O.contactWorkedByOtherTeam(lead), true);   // efeito colateral: o gate 1.5a barra
    delete process.env.GHL_BLOCK_OPP_STAGES;
  });

  console.log('\nChecagem de ids contra os funis do GHL (/health crm.faltando)');
  const funis = () => [
    { id: TINA, stages: [ST.reentrada, ST.iaTina, ST.followUp, ST.aguardando, ST.organico].map(id => ({ id })) },
    { id: BOOKS, stages: [{ id: ST.reentradaBooks }] },
    { id: 'k1MRNt3vW7Jsd405hpJD', stages: [{ id: ST.reentrada20 }] },
  ];
  await caso('padrões de hoje: nada faltando', () => {
    assert.deepEqual(O.idsFaltando(O.crmConfig(), funis()), []);
  });
  await caso('coluna apagada e coluna em outro funil aparecem, cada uma com o motivo', () => {
    const f = funis();
    f[0].stages = f[0].stages.filter(s => s.id !== ST.iaTina && s.id !== ST.organico);
    f[1].stages.push({ id: ST.organico });
    assert.deepEqual(O.idsFaltando(O.crmConfig(), f), [
      { env: 'GHL_PIPELINE_STAGE_IA_TINA', id: ST.iaTina, motivo: 'coluna não existe' },
      { env: 'ORGANICO_STAGE_ID', id: ST.organico, motivo: 'coluna fora do funil da Tina' },
      { env: 'GHL_TINA_OWNED_STAGES', id: ST.organico, motivo: 'coluna fora do funil da Tina' },
    ]);
  });
  await caso('funil da Tina apagado e Reentrada sumida', () => {
    const f = funis().slice(1);
    const out = O.idsFaltando(O.crmConfig(), f);
    assert.deepEqual(out[0], { env: 'GHL_PIPELINE_ID', id: TINA, motivo: 'funil não existe' });
    assert.ok(out.some(x => x.env === 'GHL_BLOCK_OPP_STAGES' && x.id === ST.reentrada));
    assert.ok(!out.some(x => x.id === ST.reentradaBooks));
  });
  await caso('GHL fora do ar: checagem.erro e mantém o último faltando bom', async () => {
    GHL.listPipelines = async () => ({ pipelines: funis() });
    await O.checarIdsCrm();
    assert.deepEqual(O.estadoChecagemCrm().faltando, []);
    GHL.listPipelines = async () => { throw new Error('GHL GET /opportunities/pipelines → 503'); };
    const e = await O.checarIdsCrm();
    assert.equal(e.checagem.ok, false);
    assert.match(e.checagem.erro, /503/);
    assert.deepEqual(e.faltando, []);
    GHL.listPipelines = async () => ({ pipelines: [] });
    assert.match((await O.checarIdsCrm()).checagem.erro, /0 funis/);
  });
  await caso('checagem.erro não expõe o locationId no /health (público)', async () => {
    GHL.listPipelines = async () => { throw new Error('request to http://127.0.0.1:9/opportunities/pipelines?locationId=loc-secreta failed, reason: connect ECONNREFUSED'); };
    const { erro } = (await O.checarIdsCrm()).checagem;
    assert.doesNotMatch(erro, /loc-secreta|locationId/);
    assert.match(erro, /ECONNREFUSED/);
  });
  await caso('iniciarChecagemCrm sem token: não chama o GHL e marca o erro', () => {
    let chamou = 0;
    GHL.listPipelines = async () => { chamou++; return { pipelines: funis() }; };
    delete process.env.GHL_API_TOKEN;
    O.iniciarChecagemCrm();
    process.env.GHL_API_TOKEN = 'token-falso-de-teste';
    assert.equal(chamou, 0);
    assert.equal(O.estadoChecagemCrm().checagem.erro, 'GHL_API_TOKEN ausente');
  });
  await caso('iniciarChecagemCrm com token: checa no boot e o timer não segura o processo', async () => {
    let chamou = 0;
    GHL.listPipelines = async () => { chamou++; return { pipelines: funis() }; };
    const t = O.iniciarChecagemCrm();
    const segura = t.hasRef();
    clearInterval(t);
    await espera();
    assert.equal(segura, false);
    assert.equal(chamou, 1);
    assert.equal(O.estadoChecagemCrm().checagem.ok, true);
  });

  console.log(`\n${ok} casos passaram`);
} catch (err) {
  console.error('\n✗ FALHOU:', err.message);
  process.exit(1);
}
