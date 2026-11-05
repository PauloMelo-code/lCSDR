import { db } from '../db/index.js';
import { GHL } from './client.js';
import { logger } from '../utils/logger.js';

// Resolve pipeline + stage "Qualificado" a partir do .env ou de nomes convencionais.
// Configurar no .env:
//   GHL_PIPELINE_ID=abc123
//   GHL_PIPELINE_STAGE_QUALIFIED=stage_xyz
//   GHL_PIPELINE_STAGE_HANDOFF=stage_zzz (opcional, se quiser mover depois)
//
// Se não configurado, tenta detectar: primeiro pipeline da location + primeira stage que contenha "qualif" no nome.

let PIPELINE_CACHE = null;

// Defaults conhecidos (Pré-Vendas LCA). Evita o auto-detect que pegava
// "Reentrada" (stages[0]) errado. Env sobrescreve.
const DEFAULT_PIPELINE_ID = 'MfDNcFdH03j0ZBuwJDYM';
const DEFAULT_STAGE_QUALIFIED = '0c040fa3-3ed5-449f-ab07-c7b3fb40f97c'; // Aguardando Atendimento
const DEFAULT_STAGE_IA_TINA = '74164182-d3b0-447b-a761-3bdcd6d47eac';    // IA Tina
// Funil Orgânico. Fonte ÚNICA do id: a varredura (organicoSweep.js, via stageOrganico)
// e o padrão de GHL_TINA_OWNED_STAGES leem daqui. Antes o id estava escrito nos dois
// arquivos — na reorganização do CRM (04/11) trocar um e esquecer o outro faria a
// varredura achar os leads e a raia exclusiva recusar todos.
const DEFAULT_STAGE_ORGANICO = 'd596db34-ada4-4e7a-936a-943a9410d9a6';

const csv = raw => String(raw || '').split(',').map(s => s.trim()).filter(Boolean);

export function resolvePipeline() {
  if (PIPELINE_CACHE) return PIPELINE_CACHE;
  PIPELINE_CACHE = {
    pipelineId: process.env.GHL_PIPELINE_ID || DEFAULT_PIPELINE_ID,
    stageQualified: process.env.GHL_PIPELINE_STAGE_QUALIFIED || DEFAULT_STAGE_QUALIFIED,
    stageIaTina: process.env.GHL_PIPELINE_STAGE_IA_TINA || DEFAULT_STAGE_IA_TINA,
    stageOrganico: process.env.ORGANICO_STAGE_ID || DEFAULT_STAGE_ORGANICO,
  };
  return PIPELINE_CACHE;
}

// Motivo de perda nos cards que a Tina fecha. DESLIGADO por padrão: env vazia = card
// vai pra lost sem motivo, como sempre foi. Lido a cada chamada.
export const lostReasonAgendou = () => (process.env.TINA_LOST_REASON_BOOKED_ID || '').trim() || null;
export const lostReasonDesqualificou = () => (process.env.TINA_LOST_REASON_DISQUALIFIED_ID || '').trim() || null;
// Encerrado sem resposta (closeLeadNoResponse) NÃO é desqualificado: motivo próprio, pra
// não misturar os dois no relatório de perdas (proposta de reorganização, pág. 9).
export const lostReasonSemResposta = () => (process.env.TINA_LOST_REASON_NO_RESPONSE_ID || '').trim() || null;

// Grava o motivo num card que JÁ foi fechado como lost. Na doc da API v2 o lostReasonId
// não existe no PUT /opportunities/:id (o que fecha o card), só no PUT
// /opportunities/:id/status — por isso vai numa 2ª chamada, depois do fechamento: se
// ela falhar, o card continua fechado (invariante 9) e só fica sem motivo.
// Falhas contadas pro /health (crm.motivoPerdaFalhas): id de motivo errado só aparecia no log.
let MOTIVO_FALHAS = { n: 0, ultimoStatus: null, em: null };
export async function gravarMotivoPerda(oppId, lostReasonId, contactId) {
  if (!lostReasonId) return;
  try {
    await GHL.updateOpportunityStatus(oppId, { status: 'lost', lostReasonId });
  } catch (err) {
    MOTIVO_FALHAS = { n: MOTIVO_FALHAS.n + 1, ultimoStatus: err.status || null, em: new Date().toISOString() };
    logger.warn({ err: err.message, contactId, oppId }, 'falha gravando motivo de perda (card já fechado; segue)');
  }
}

// Evento de card JÁ FECHADO (lost/won/abandoned). A continuidade da IA Tina não pode
// retomar a conversa de um lead que acabou de ser fechado: o card fechado continua na
// coluna IA Tina, e fechamento em massa (limpeza) ou a 2ª chamada do motivo de perda
// geram OpportunityStatusUpdate. Sem status no evento = segue como antes.
export function eventoDeCardFechado(event) {
  const st = String(event?.status || event?.opportunity?.status || '').toLowerCase();
  return /^(lost|won|abandon)/.test(st);
}

// Escolhe a oportunidade RELEVANTE do contato (em vez de `ops[0]` cego, que é
// não-determinístico quando o contato tem várias). Prioriza a ABERTA no pipeline
// da Tina; senão a 1ª aberta; null se não há aberta.
function pickOpenOpp(ops, pipelineId) {
  const open = (Array.isArray(ops) ? ops : []).filter(o => String(o.status || 'open').toLowerCase() === 'open');
  return open.find(o => o.pipelineId === pipelineId) || open[0] || null;
}

// Marca que foi a PRÓPRIA Tina que moveu/criou a opp na IA Tina. O handler do
// webhook de mudança de stage (handleOpportunityStage) usa isso pra IGNORAR o
// evento gerado pela própria movimentação (anti-loop) — imune ao quirk de
// alguns PITs carimbarem userId nas escritas via API.
function markSelfMove(contact, oppId = null) {
  if (!contact?.id) return;
  try {
    db.prepare('UPDATE contacts SET ia_tina_self_moved_at = CURRENT_TIMESTAMP, ia_tina_self_moved_opp = ? WHERE id = ?')
      .run(oppId ? String(oppId) : null, contact.id);
  } catch { /* coluna pode não existir em banco muito antigo; segue */ }
}

// Cria oportunidade no pipeline "Qualificado" quando a Iara qualifica.
// Se já existe oportunidade pro contato, só move pra stage qualificada.
export async function createOrMoveOpportunityQualified(contact, { funnel, score, notes }) {
  const { pipelineId, stageQualified } = await resolvePipeline();
  if (!pipelineId || !stageQualified) return null;

  try {
    // Verifica se já existe oportunidade aberta. SEM `.catch` inline: se a busca
    // FALHAR (rede/5xx/401), o erro sobe pro catch externo e retorna null SEM
    // criar — senão duplicaria a oportunidade (falha de API ≠ "não tem opp").
    const existing = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const ops = existing?.opportunities || (Array.isArray(existing) ? existing : []);
    const opp = pickOpenOpp(ops, pipelineId); // a aberta do pipeline da Tina (não ops[0] cego)

    if (opp) {
      const cur = opp.pipelineStageId;
      // pickOpenOpp já exclui won/lost (só abertas). Não rouba lead que o time
      // está re-trabalhando (stage bloqueada/reentrada).
      if (blockedOppStages().includes(cur)) return opp.id;
      // Manda `pipelineId` junto: sem ele, o GHL valida o stage contra o
      // pipeline ATUAL da oportunidade — se ela estiver em outro pipeline (ex.:
      // já foi movida pros Closers), o stage não bate e dá 400. Com o
      // pipelineId, move a oportunidade pro pipeline configurado.
      await GHL.updateOpportunity(opp.id, {
        pipelineId,
        pipelineStageId: stageQualified,
        status: 'open',
        ...(score ? { monetaryValue: estimateTicket(funnel, score) } : {}),
      });
      return opp.id;
    }

    const name = `${contact.name || 'Lead'} · funil ${funnel || '—'}`;
    const created = await GHL.createOpportunity({
      pipelineId,
      stageId: stageQualified,
      contactId: contact.ghl_contact_id,
      name,
      monetaryValue: estimateTicket(funnel, score),
    });
    return created?.opportunity?.id || created?.id || null;
  } catch (err) {
    logger.error({ err: err.message, contactId: contact.id }, 'falha ao criar/mover oportunidade');
    return null;
  }
}

// Ao AGENDAR (Tina marcou reunião/pré-atendimento), FECHA a opp do Pré-Vendas (SDR)
// como PERDIDO/DECLINADO — o time NÃO quer "Ganho" (SDR não fecha venda; o lead vai
// pro pipeline de Vendas → Reuniões Agendadas, criado pelo workflow do GHL). Sem
// fechar, a opp fica ABERTA e a automação de reentrada do GHL a captura ~2h depois →
// card duplicado (caso Cláudia). Só toca o pipeline da Tina, NUNCA Vendas/outro time.
// Status configurável (SCHEDULED_SDR_OPP_STATUS, default 'lost'); desliga com
// CLOSE_SDR_OPP_ON_BOOKING=false. Fail-open.
export async function closeSdrOppOnBooking(contact) {
  if (process.env.CLOSE_SDR_OPP_ON_BOOKING === 'false') return;
  const { pipelineId } = resolvePipeline();
  if (!pipelineId || !contact?.ghl_contact_id || String(contact.ghl_contact_id).startsWith('wa-') || !process.env.GHL_API_TOKEN) return;
  const closeStatus = process.env.SCHEDULED_SDR_OPP_STATUS || 'lost'; // time pediu declinar, não ganho
  try {
    const r = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const ops = r?.opportunities || (Array.isArray(r) ? r : []);
    for (const o of ops) {
      if (String(o.status || 'open').toLowerCase() !== 'open') continue;
      if (o.pipelineId !== pipelineId) continue;   // só o Pré-Vendas da Tina
      await GHL.updateOpportunity(o.id, { pipelineId: o.pipelineId, pipelineStageId: o.pipelineStageId, status: closeStatus });
      logger.info({ contactId: contact.id, oppId: o.id, closeStatus }, 'agendou: card Pré-Vendas declinado pra não duplicar');
      if (closeStatus === 'lost') await gravarMotivoPerda(o.id, lostReasonAgendou(), contact.id);
    }
  } catch (err) {
    logger.warn({ err: err.message, contactId: contact.id }, 'falha fechando card Pré-Vendas no agendamento (segue)');
  }
}

// Stages "do time" (ex: Reentrada): se o lead tem oportunidade ABERTA numa
// delas, o time já está re-trabalhando ele → a Tina NÃO deve assumir. Default:
// "Reentrada" do Pré-Vendas LCA. Adicione outras stages via GHL_BLOCK_OPP_STAGES
// (CSV de stageIds). A Tina move pra "Aguardando Atendimento", nunca pra essas,
// então não há conflito com o que ela mesma cria.
function blockedOppStages() {
  return csv(process.env.GHL_BLOCK_OPP_STAGES || [
    'b661d5f1-69cd-4531-8be9-79b3e11c862f', // Reentrada — Pré-Vendas LCA (SDR)
    '009b6a60-2c9b-41f9-95d3-20d54c18ab8d', // Reentrada — LC Books (SDR & Closers)
    'ee211407-4153-4a93-bf03-0b9ff000effe', // Reentrada — Pré-Vendas 2.0 (SDR1)
  ].join(','));
}

// Stages que a Tina é DONA (guarda do reclaim, contactExclusivelyInTinaLane): IA Tina
// + estas. Padrão: Funil Orgânico.
const tinaOwnedStages = () => csv(process.env.GHL_TINA_OWNED_STAGES || resolvePipeline().stageOrganico);
// Funis de ENTRADA extras da raia (só valem com LANE_GATE_ENABLED). Padrão: nenhum.
const tinaLaneStages = () => csv(process.env.GHL_TINA_LANE_STAGES);

// A "RAIA" da Tina (allowlist, default-deny). Ela só atende lead cuja
// oportunidade está na IA Tina ou na Aguardando Atendimento (qualificado/
// agendando que ela mesma conduz), OU que NÃO tem oportunidade (lead novo). Se
// há opp ABERTA em QUALQUER outra coluna (Reentrada, Follow Up, Aplicação,
// Proposta, funis de captação, Closers...), é trabalho de OUTRO → retorna a opp
// pra bloquear. Falha ABERTO (erro → null → Tina segue normal).
export async function contactOppOutsideTinaLane(contact) {
  const { stageIaTina, stageQualified } = resolvePipeline();
  if (!contact?.ghl_contact_id || !process.env.GHL_API_TOKEN) return null;
  // Raia da Tina = IA Tina + Aguardando Atendimento + funis de ENTRADA onde caem
  // os leads de anúncio/captação que ela DEVE qualificar (env GHL_TINA_LANE_STAGES,
  // CSV de stageIds). Setar os funis de entrada lá pra a Tina atender os anúncios.
  const lane = new Set([stageIaTina, stageQualified, ...tinaLaneStages()].filter(Boolean));
  try {
    const r = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const ops = r?.opportunities || (Array.isArray(r) ? r : []);
    return ops.find(o =>
      String(o.status || 'open').toLowerCase() === 'open'
      && !lane.has(o.pipelineStageId)
    ) || null;
  } catch (err) {
    logger.warn({ err: err.message, contactId: contact.id }, 'falha checando raia da Tina (opp); segue');
    return null;
  }
}

// Lead tem opp ABERTA na coluna IA Tina? É o sinal POSITIVO de que o TIME colocou
// o lead na raia da Tina pra ela trabalhar → ela DEVE assumir e qualificar, mesmo
// que a conversa tenha histórico de humano (em_atendimento) ou reentrada: a
// colocação na coluna É a autorização. Falha FECHADO (erro → false → não força;
// os gates normais decidem). Cobre multi-opp (basta UMA aberta na IA Tina).
export async function contactInIaTinaLane(contact) {
  const { stageIaTina } = resolvePipeline();
  if (!stageIaTina || !contact?.ghl_contact_id || !process.env.GHL_API_TOKEN) return false;
  try {
    const r = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const ops = r?.opportunities || (Array.isArray(r) ? r : []);
    return ops.some(o => String(o.status || 'open').toLowerCase() === 'open' && o.pipelineStageId === stageIaTina);
  } catch {
    return false;
  }
}

// Lead está EXCLUSIVAMENTE na raia da Tina? True SÓ se (a) tem pelo menos uma opp
// ABERTA e (b) TODAS as opps abertas estão numa stage que a Tina é dona (IA Tina +
// Funil Orgânico, por padrão). Basta UMA opp aberta fora da raia (outro pipeline,
// Reentrada, ou stage do time no mesmo pipeline — Proposta/Follow Up/Aplicação...)
// pra dar false. É a guarda do RECLAIM: a Tina só reassume um lead que sumiu do radar
// do time se ele NÃO tem nenhum negócio vivo em outra coluna (senão roubaria um lead
// que um closer está tocando — caso multi-opp). Configurável por GHL_TINA_OWNED_STAGES
// (CSV de stageIds). Falha FECHADO (erro → false → não reassume; lado seguro).
export async function contactExclusivelyInTinaLane(contact) {
  if (!contact?.ghl_contact_id || !process.env.GHL_API_TOKEN) return false;
  const { stageIaTina } = resolvePipeline();
  const owned = new Set([stageIaTina, ...tinaOwnedStages()].filter(Boolean));
  try {
    const r = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const open = (r?.opportunities || (Array.isArray(r) ? r : []))
      .filter(o => String(o.status || 'open').toLowerCase() === 'open');
    if (!open.length) return false;                        // sem opp aberta → não reassume
    return open.every(o => owned.has(o.pipelineStageId));  // TODAS na raia da Tina
  } catch {
    return false;
  }
}

// Lead tem opp ABERTA numa stage de REENTRADA (o time está re-trabalhando ele)?
// Usado pelo modo "atende todos menos Reentrada" pra a Tina NÃO assumir esses.
// Falha ABERTO (erro → false → atende; não bloqueia atendimento por falha de API).
export async function contactOppInReentrada(contact) {
  if (!contact?.ghl_contact_id || !process.env.GHL_API_TOKEN) return false;
  const blocked = new Set(blockedOppStages());
  if (!blocked.size) return false;
  try {
    const r = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const ops = r?.opportunities || (Array.isArray(r) ? r : []);
    return ops.some(o => String(o.status || 'open').toLowerCase() === 'open' && blocked.has(o.pipelineStageId));
  } catch {
    return false;
  }
}

// Lead pertence a OUTRO time (a Tina NÃO deve assumir)? True se tem opp ABERTA:
//  (1) numa stage de REENTRADA (blockedOppStages), OU
//  (2) num PIPELINE diferente do da Tina (Pré-Vendas LCA) — ou seja, Closers,
//      Editorial, Pré-Vendas 2.0, etc. estão com o lead.
// Lead novo/de anúncio só tem opp no pipeline da Tina (Funil Orgânico) → false →
// atende. Cobre "outros funis" sem precisar listar 80 stages. Dentro do pipeline
// da Tina, a colisão (Follow Up/Proposta) fica na detecção por MENSAGEM
// (lastOutboundWasHuman). Falha ABERTO (erro → false → atende; não trava por hiccup).
// Card DECLINADO (lost) por consultor em OUTRO pipeline conta como "do time" por
// este período (caso Keli 13/07: consultora atendeu, declinou o card, e a Tina
// reabriu o atendimento + criou card novo). Depois da janela o lead volta a poder
// ser reengajado (lead antigo é lead novo). LOST_OPP_BLOCK_DAYS=0 desliga.
const LOST_BLOCK_DAYS = Number(process.env.LOST_OPP_BLOCK_DAYS ?? 30);
// CLIENTE CONVERTIDO: opp GANHA em pipeline que não é o da Tina (ex.: Vendas Closers)
// = já é cliente do time de vendas. A Tina não reassume (caso Luana: campanha reativou
// cliente antigo). SKIP_CONVERTED_CUSTOMERS=false desliga.
const SKIP_CONVERTED = process.env.SKIP_CONVERTED_CUSTOMERS !== 'false';

export async function contactWorkedByOtherTeam(contact) {
  const { pipelineId } = resolvePipeline();
  if (!contact?.ghl_contact_id || !process.env.GHL_API_TOKEN) return false;
  const blocked = new Set(blockedOppStages());
  try {
    const r = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const ops = r?.opportunities || (Array.isArray(r) ? r : []);
    return ops.some(o => {
      const status = String(o.status || 'open').toLowerCase();
      const otherPipe = o.pipelineId && pipelineId && o.pipelineId !== pipelineId;
      if (status === 'open') {
        if (blocked.has(o.pipelineStageId)) return true;   // Reentrada
        if (otherPipe) return true;                        // outro time/pipeline
        return false;
      }
      // Cliente CONVERTIDO em outro pipeline (venda ganha) → não reassume nunca.
      if (SKIP_CONVERTED && /won/.test(status) && otherPipe) return true;
      // Declinado há pouco em outro pipeline → o time encerrou de propósito, Tina não reabre.
      if (/lost|abandon/.test(status) && otherPipe && LOST_BLOCK_DAYS > 0) {
        const t = new Date(o.updatedAt || o.lastStatusChangeAt || o.dateUpdated || 0).getTime();
        if (t && (Date.now() - t) < LOST_BLOCK_DAYS * 86_400_000) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

// TRUE se o lead é cliente CONVERTIDO (venda ganha em pipeline != Tina). Usado pra
// travar a Tina mesmo quando um workflow move o card pra IA Tina (a continuação
// ignora a whitelist, mas NÃO deve reassumir cliente já vendido — caso Luana).
export async function contactIsConvertedCustomer(contact) {
  if (!SKIP_CONVERTED || !contact?.ghl_contact_id || !process.env.GHL_API_TOKEN) return false;
  const { pipelineId } = resolvePipeline();
  try {
    const r = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const ops = r?.opportunities || (Array.isArray(r) ? r : []);
    return ops.some(o => /won/.test(String(o.status || '').toLowerCase()) && o.pipelineId && o.pipelineId !== pipelineId);
  } catch { return false; }
}

// Reivindica o lead pra Tina (re-engajamento ATIVO): move a opp pra IA Tina (ou
// cria). NÃO reabre won/lost. Uso INTENCIONAL (script de re-engajamento) — aí o
// lead entra na raia da Tina e ela passa a tratar as respostas dele.
export async function claimToIaTina(contact) {
  const { pipelineId, stageIaTina, stageQualified } = resolvePipeline();
  if (!pipelineId || !stageIaTina || !contact?.ghl_contact_id) return null;
  try {
    const r = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const ops = r?.opportunities || (Array.isArray(r) ? r : []);
    const opp = pickOpenOpp(ops, pipelineId); // a aberta do pipeline da Tina (não ops[0] cego)
    if (opp) {
      // Já na IA Tina ou já em Aguardando Atendimento → não mexe.
      if (opp.pipelineStageId === stageIaTina || opp.pipelineStageId === stageQualified) return opp.id;
      // NÃO assume/move lead que o time está re-trabalhando (Reentrada).
      if (blockedOppStages().includes(opp.pipelineStageId)) return opp.id;
      // Só reorganiza DENTRO do pipeline da Tina (Pré-Vendas LCA). Não puxa opp
      // de OUTRO pipeline (Closers/Editorial) pra não bagunçar o board deles.
      if (opp.pipelineId && opp.pipelineId !== pipelineId) return opp.id;
      markSelfMove(contact, opp.id);
      await GHL.updateOpportunity(opp.id, { pipelineId, pipelineStageId: stageIaTina, status: 'open' });
      return opp.id;
    }
    // Sem opp ABERTA, mas COM opp fechada (won/lost) = cliente convertido/perdido →
    // NÃO cria duplicada na IA Tina (deixa como está). Só cria pra lead REALMENTE
    // novo (zero opp), senão re-qualifica cliente do zero + suja o board.
    if (ops.length) return ops[0]?.id || null;
    const created = await GHL.createOpportunity({
      pipelineId, stageId: stageIaTina, contactId: contact.ghl_contact_id,
      name: `${contact.name || 'Lead'} · IA Tina`,
    });
    const newId = created?.opportunity?.id || created?.id || null;
    markSelfMove(contact, newId);
    return newId;
  } catch (err) {
    logger.warn({ err: err.message, contactId: contact.id }, 'falha reivindicando lead p/ IA Tina; segue');
    return null;
  }
}

// Coloca o lead na coluna "IA Tina" pra dar visibilidade ao time enquanto a
// Tina qualifica. SEGURO (default-deny): só CRIA uma oportunidade na IA Tina
// quando o lead NÃO tem nenhuma aberta. Se JÁ existe opp (de quem for, em
// qualquer stage), NÃO mexe — não rouba lead do time nem rebaixa stage. SEM
// `.catch` inline na busca: erro de API → catch externo → NÃO cria (não
// duplica). Falha aberto.
export async function moveLeadToIaTina(contact) {
  const { pipelineId, stageIaTina } = resolvePipeline();
  if (!pipelineId || !stageIaTina || !contact?.ghl_contact_id || !process.env.GHL_API_TOKEN) return null;
  try {
    const r = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const ops = r?.opportunities || (Array.isArray(r) ? r : []);
    if (ops.length) return ops[0].id; // já tem opp → não mexe (não rouba/duplica/rebaixa)
    // Só chega aqui se a busca teve SUCESSO e o lead não tem nenhuma opp.
    const created = await GHL.createOpportunity({
      pipelineId, stageId: stageIaTina, contactId: contact.ghl_contact_id,
      name: `${contact.name || 'Lead'} · IA Tina`,
    });
    const newId = created?.opportunity?.id || created?.id || null;
    markSelfMove(contact, newId);
    return newId;
  } catch (err) {
    logger.warn({ err: err.message, contactId: contact.id }, 'falha criando opp na IA Tina; segue');
    return null;
  }
}

// === Diagnóstico pro /health (bloco `crm`) ===
// Valores RESOLVIDOS (env ou padrão) com que este arquivo amarra a Tina aos funis.
// Só ids, booleanos e números — nunca token. Os gates do webhook/handoff/scheduler
// entram no index.js, junto com estes.
export function crmConfig() {
  return {
    ...resolvePipeline(),
    blockOppStages: blockedOppStages(),
    tinaOwnedStages: tinaOwnedStages(),
    tinaLaneStages: tinaLaneStages(),
    skipConvertedCustomers: SKIP_CONVERTED,
    lostOppBlockDays: LOST_BLOCK_DAYS,
    closeSdrOppOnBooking: process.env.CLOSE_SDR_OPP_ON_BOOKING !== 'false',
    scheduledSdrOppStatus: process.env.SCHEDULED_SDR_OPP_STATUS || 'lost',
    lostReasonBookedId: lostReasonAgendou(),
    lostReasonDisqualifiedId: lostReasonDesqualificou(),
    lostReasonNoResponseId: lostReasonSemResposta(),
    motivoPerdaFalhas: MOTIVO_FALHAS,
  };
}

// Ids configurados que NÃO batem com os funis do GHL. Coluna da Tina (IA Tina,
// Aguardando, Orgânico, donas e raia) tem que estar no funil GHL_PIPELINE_ID: em outro
// funil, a Tina move pro lugar errado (400) ou o contactWorkedByOtherTeam trata o lead
// como de outro time. As de bloqueio (Reentrada) podem estar em qualquer funil.
export function idsFaltando(cfg, pipelines) {
  const todas = new Set(pipelines.flatMap(p => (p.stages || []).map(s => s.id)));
  const daTina = pipelines.find(p => p.id === cfg.pipelineId);
  const doFunil = new Set((daTina?.stages || []).map(s => s.id));
  const out = [];
  if (!daTina) out.push({ env: 'GHL_PIPELINE_ID', id: cfg.pipelineId, motivo: 'funil não existe' });
  const daRaia = {
    GHL_PIPELINE_STAGE_QUALIFIED: [cfg.stageQualified],
    GHL_PIPELINE_STAGE_IA_TINA: [cfg.stageIaTina],
    ORGANICO_STAGE_ID: [cfg.stageOrganico],
    GHL_TINA_OWNED_STAGES: cfg.tinaOwnedStages,
    GHL_TINA_LANE_STAGES: cfg.tinaLaneStages,
  };
  for (const [env, ids] of Object.entries(daRaia)) {
    for (const id of ids) {
      if (!todas.has(id)) out.push({ env, id, motivo: 'coluna não existe' });
      else if (daTina && !doFunil.has(id)) out.push({ env, id, motivo: 'coluna fora do funil da Tina' });
    }
  }
  for (const id of cfg.blockOppStages) {
    if (!todas.has(id)) out.push({ env: 'GHL_BLOCK_OPP_STAGES', id, motivo: 'coluna não existe' });
  }
  return out;
}

// A checagem NUNCA roda dentro do /health: roda no boot e a cada 30 min em segundo plano
// (iniciarChecagemCrm, chamado pelo index.js) e o /health só lê este cache. Falha do
// GHL vira `checagem.erro` e mantém o último `faltando` bom; o /health segue rápido.
// Custa 1 GET a cada 30 min no mesmo token que atende os leads.
let CHECAGEM = { faltando: null, checagem: { em: null, ok: false, erro: 'ainda não rodou' } };
export const estadoChecagemCrm = () => CHECAGEM;

export async function checarIdsCrm() {
  const em = new Date().toISOString();
  try {
    const pipelines = (await GHL.listPipelines())?.pipelines || [];
    if (!pipelines.length) throw new Error('GHL devolveu 0 funis');
    CHECAGEM = { faltando: idsFaltando(crmConfig(), pipelines), checagem: { em, ok: true } };
  } catch (err) {
    // Sem a query: a mensagem traz o path com ?locationId=… e o /health é público.
    CHECAGEM = { faltando: CHECAGEM.faltando, checagem: { em, ok: false, erro: String(err.message).replace(/\?\S*/g, '').slice(0, 200) } };
  }
  return CHECAGEM;
}

export function iniciarChecagemCrm(intervaloMs = 30 * 60_000) {
  if (!process.env.GHL_API_TOKEN) {
    CHECAGEM = { faltando: null, checagem: { em: new Date().toISOString(), ok: false, erro: 'GHL_API_TOKEN ausente' } };
    return;
  }
  checarIdsCrm();
  return setInterval(checarIdsCrm, intervaloMs).unref();   // devolve o timer só pro teste
}

// Estimativa grosseira de ticket pro campo monetaryValue.
// Base: tabela de preços mencionada pela Lilian na reunião.
function estimateTicket(funnel, score = 0) {
  const factor = Math.max(0.3, score / 100);
  switch (funnel) {
    case 'escrever': return Math.round(1680 * factor);   // ticket base: curso
    case 'publicar': return Math.round(50000 * factor);  // Hélice Books
    case 'divulgar': return Math.round(8000 * factor);   // estimativa média
    default: return 0;
  }
}
