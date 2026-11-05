import { db } from '../db/index.js';
import { GHL } from '../ghl/client.js';
import { writeQualificationFields } from '../ghl/customFields.js';
import { createOrMoveOpportunityQualified, resolvePipeline, gravarMotivoPerda, lostReasonDesqualificou, lostReasonSemResposta } from '../ghl/opportunities.js';
import { upcomingAppointment } from './scheduling.js';
import { SQL_CANCELA_PENDENTES } from './contactService.js';
import { logger } from '../utils/logger.js';

const FOLLOWUP_MIN = Number(process.env.FOLLOWUP_SILENCE_MINUTES || 60);

// === Etiquetas GHL — esquema "tina-*" (reunião de alinhamento LC, 18/05/2026) ===
// Configuráveis por env — se a LC renomear uma etiqueta, ajusta a variável
// sem mexer no código.
const TAG = {
  // Interesse do lead (mapeia direto do funnel detectado pela Tina)
  escrever: process.env.GHL_TAG_ESCREVER || 'tina-escrever',
  publicar: process.env.GHL_TAG_PUBLICAR || 'tina-publicar',
  divulgar: process.env.GHL_TAG_DIVULGAR || 'tina-divulgar',
  // Lead pronto pro closer (quer agendar / tem perfil de investimento)
  agenda: process.env.GHL_TAG_AGENDA || 'tina-agenda',
  // Dúvidas sobre curso
  duvidaCurso: process.env.GHL_TAG_DUVIDA_CURSO || 'tina-duvida-curso',
  duvidaCursoAluno: process.env.GHL_TAG_DUVIDA_CURSO_ALUNO || 'tina-duvida-curso-aluno',
  // Temperatura (termômetro do lead)
  frio: process.env.GHL_TAG_FRIO || 'frio',
  morno: process.env.GHL_TAG_MORNO || 'morno',
  quente: process.env.GHL_TAG_QUENTE || 'quente',
  superquente: process.env.GHL_TAG_SUPERQUENTE || 'superquente',
  // Marcação quando SDR humano assume a conversa
  transferida: process.env.GHL_TAG_TRANSFERIDA || 'tina-transferida',
};

// Temperatura pelo score (escala definida na reunião LC 18/05):
//   frio 0-20 · morno 21-45 · quente 46-70 · superquente 71+ COM tina-agenda
function temperatureForScore(score, hasAgenda = false) {
  const s = Number(score) || 0;
  if (hasAgenda && s >= 71) return TAG.superquente;
  if (s >= 46) return TAG.quente;
  if (s >= 21) return TAG.morno;
  return TAG.frio;
}

// Mapeia o funnel da Tina pra etiqueta de interesse
function interestTag(funnel) {
  if (funnel === 'escrever') return TAG.escrever;
  if (funnel === 'publicar') return TAG.publicar;
  if (funnel === 'divulgar') return TAG.divulgar;
  return null;
}

const isSyntheticId = (id) => !id || String(id).startsWith('wa-');

// Sincroniza a etiqueta de temperatura no GHL.
// Só chama a API quando a faixa MUDA (compara com contacts.ghl_temp_tag).
async function syncTemperatureTag(contact, score, hasAgenda) {
  if (!process.env.GHL_API_TOKEN || isSyntheticId(contact.ghl_contact_id)) return;

  const wanted = temperatureForScore(score, hasAgenda);
  const current = contact.ghl_temp_tag || null;
  if (wanted === current) return;

  try {
    if (current) {
      await GHL.removeTag(contact.ghl_contact_id, [current]).catch(() => {});
    }
    await GHL.addTag(contact.ghl_contact_id, [wanted]);
    db.prepare('UPDATE contacts SET ghl_temp_tag = ? WHERE id = ?').run(wanted, contact.id);
    logger.info({ contactId: contact.id, from: current, to: wanted }, 'temperatura GHL atualizada');
  } catch (err) {
    logger.error({ err: err.message, contactId: contact.id }, 'falha ao sincronizar temperatura GHL');
  }
}

// Aplica TODAS as etiquetas tina-* no GHL conforme o resultado da Tina.
// Chamado a cada turno pelos webhooks. Idempotente (addTag não duplica).
//   - interesse: tina-escrever / tina-publicar / tina-divulgar (do funnel)
//     → MUTUAMENTE EXCLUSIVAS: muda funnel → remove anteriores antes
//   - course_help: tina-duvida-curso / tina-duvida-curso-aluno
//   - handoff: tina-agenda (lead pronto pro closer)
//   - temperatura: frio / morno / quente / superquente
export async function applyTinaTags(contact, result) {
  if (!process.env.GHL_API_TOKEN || isSyntheticId(contact.ghl_contact_id)) return;
  if (!result) return;

  const hasAgenda = result.handoff === true || result.stage === 'qualificado';
  const toAdd = [];
  const toRemove = [];

  // Tags de interesse: mutuamente exclusivas — se mudou de funnel, remove as outras
  const interest = interestTag(result.funnel);
  if (interest) {
    toAdd.push(interest);
    const allInterest = [TAG.escrever, TAG.publicar, TAG.divulgar];
    allInterest.filter(t => t !== interest).forEach(t => toRemove.push(t));
  }

  if (result.course_help === 'comprar') toAdd.push(TAG.duvidaCurso);
  if (result.course_help === 'aluno') toAdd.push(TAG.duvidaCursoAluno);

  if (hasAgenda) toAdd.push(TAG.agenda);

  try {
    if (toAdd.length) {
      await GHL.addTag(contact.ghl_contact_id, toAdd);
    }
    // Remove tags de interesse antigas (defesa contra mudança de funil)
    if (toRemove.length) {
      await GHL.removeTag(contact.ghl_contact_id, toRemove).catch(() => {});
    }
    await syncTemperatureTag(contact, result.qualification_score, hasAgenda);
  } catch (err) {
    logger.error({ err: err.message, contactId: contact.id }, 'falha ao aplicar etiquetas tina-* no GHL');
  }
}

// Alias mantido pra compat — agora aplica o conjunto completo de etiquetas.
export const tagLeadProgress = applyTinaTags;

export function pauseIA(contactId, reason = 'sdr_assumiu') {
  db.prepare(`
    UPDATE contacts
    SET ai_paused = 1, ai_paused_at = CURRENT_TIMESTAMP, stage = 'handoff', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(contactId);
  db.prepare(`
    INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'handoff', ?)
  `).run(contactId, JSON.stringify({ reason }));
}

export function resumeIA(contactId, reason = 'silencio_humano') {
  db.prepare(`
    UPDATE contacts
    SET ai_paused = 0, ai_paused_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(contactId);
  db.prepare(`
    INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'ia_resume', ?)
  `).run(contactId, JSON.stringify({ reason }));
}

// Decisão da Lilian (jun/2026): a Tina é SDR PURA, não faz follow-up.
// Quem faz follow-up é o time comercial. Por isso o follow-up vem DESLIGADO
// por padrão. Pra religar (caso a LC mude de ideia), FOLLOWUP_ENABLED=true.
const FOLLOWUP_ENABLED = process.env.FOLLOWUP_ENABLED === 'true';
const FOLLOWUP_SDR_ENABLED = process.env.FOLLOWUP_SILENCIO_SDR_ENABLED === 'true';

export function scheduleFollowup(contactId, reason = 'silencio_lead', minutesFromNow = FOLLOWUP_MIN) {
  // SDR pura: sem follow-up. Só cancela pendências antigas e sai.
  if (!FOLLOWUP_ENABLED) {
    db.prepare(SQL_CANCELA_PENDENTES).run(contactId);
    return;
  }
  // Pula o follow-up de silencio_sdr se desativado por env.
  if (reason === 'silencio_sdr' && !FOLLOWUP_SDR_ENABLED) {
    return;
  }
  // CANCELA follow-ups pendentes antigos do mesmo contato antes de criar novo.
  // Sem isso, cada turno da conversa criava um follow-up novo. Quando o primeiro
  // vence (1h), TODOS os outros já estão vencidos também e disparam juntos
  // → o lead recebe a mesma mensagem 5x.
  db.prepare(SQL_CANCELA_PENDENTES).run(contactId);
  const due = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
  db.prepare(`
    INSERT INTO followups (contact_id, due_at, reason) VALUES (?, ?, ?)
  `).run(contactId, due, reason);
}

// pause=false: usado no modo agendamento, onde a Tina precisa CONTINUAR ativa
// pra puxar horários e fechar a reunião. Nesse caso o webhook já setou
// stage='agendando' e não queremos sobrescrever pra 'qualificado' nem pausar.
export async function markQualifiedAndHandoff(contact, result, { pause = true } = {}) {
  db.prepare(`
    UPDATE contacts
    SET stage = ${pause ? "'qualificado'" : 'stage'},
        funnel = COALESCE(?, funnel),
        qualification_score = ?,
        qualification_notes = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(result.funnel || null, result.qualification_score || 0, result.qualification_notes || '', contact.id);

  if (pause) pauseIA(contact.id, 'qualificado_pronto_pro_sdr');

  // As etiquetas (tina-agenda, temperatura, etc) são aplicadas pelo
  // applyTinaTags() que o webhook chama a cada turno. Aqui só custom
  // fields + oportunidade no GHL.
  const fields = writeQualificationFields(contact.ghl_contact_id, {
    funnel: result.funnel,
    score: result.qualification_score,
    notes: result.qualification_notes,
  });

  const opp = createOrMoveOpportunityQualified(contact, {
    funnel: result.funnel,
    score: result.qualification_score,
    notes: result.qualification_notes,
  }).then(oppId => {
    if (oppId) {
      db.prepare(`
        INSERT INTO events_log (contact_id, kind, payload)
        VALUES (?, 'opportunity_qualified', ?)
      `).run(contact.id, JSON.stringify({ oppId }));
    }
  });

  await Promise.allSettled([fields, opp]);
}

// Regra LC 16/07 (caso Creusa): lead desqualificado que encerrou o atendimento →
// DECLINA o card no GHL (opp aberta no pipeline da Tina vira 'lost') e TIRA a
// reunião futura da agenda (Creusa recusou depois de agendar e a reunião ficou
// pendurada no calendário). Só toca o pipeline da Tina — card de outro time fica
// intacto. Fail-open. Desliga com DECLINE_OPP_ON_DISQUALIFY=false.
// lostReasonId: quem chama escolhe (desqualificado ≠ sem resposta); null = sem motivo.
export const DECLINE_ON_DISQUALIFY = process.env.DECLINE_OPP_ON_DISQUALIFY !== 'false';

export async function declineOppAndAppointment(contact, { lostReasonId = null } = {}) {
  if (!DECLINE_ON_DISQUALIFY || !process.env.GHL_API_TOKEN || isSyntheticId(contact.ghl_contact_id)) return;
  // 1) reunião futura → cancela (tira da agenda do closer)
  try {
    const ev = await upcomingAppointment(contact);
    if (ev?.id) {
      await GHL.deleteAppointment(ev.id);
      logger.info({ contactId: contact.id, apptId: ev.id }, 'desqualificado: reunião futura cancelada');
    }
  } catch (err) {
    logger.warn({ err: err.message, contactId: contact.id }, 'falha cancelando reunião do desqualificado (segue)');
  }
  // 2) opp aberta no pipeline da Tina → lost (card declinado)
  try {
    const { pipelineId } = resolvePipeline();
    if (!pipelineId) return;
    const r = await GHL.getOpportunitiesByContact(contact.ghl_contact_id);
    const ops = r?.opportunities || (Array.isArray(r) ? r : []);
    for (const o of ops) {
      if (String(o.status || 'open').toLowerCase() !== 'open') continue;
      if (o.pipelineId !== pipelineId) continue; // nunca mexe em card de outro time
      await GHL.updateOpportunity(o.id, { pipelineId: o.pipelineId, pipelineStageId: o.pipelineStageId, status: 'lost' });
      logger.info({ contactId: contact.id, oppId: o.id }, 'desqualificado: card declinado (lost) no GHL');
      await gravarMotivoPerda(o.id, lostReasonId, contact.id);
    }
  } catch (err) {
    logger.warn({ err: err.message, contactId: contact.id }, 'falha declinando card do desqualificado (segue)');
  }
}

// ENCERRA lead que nunca respondeu, depois de todos os follow-ups (regra LC 25/08).
// ❌ CASO REAL (Eurivan, 14/07): a Tina mandou a apresentação, o lead nunca respondeu
// e o card ficou ABERTO na coluna "IA Tina" desde julho. Somados, viraram ~600 cards
// abertos que ninguém está atendendo — o time perdia a visão de quem a Tina realmente
// toca e teria que fechar um a um na mão.
// NÃO manda mensagem nenhuma: só fecha o card e para de tocar o lead.
export async function closeLeadNoResponse(contact) {
  db.prepare(`
    UPDATE contacts SET stage = 'desqualificado', ai_paused = 1,
      qualification_notes = COALESCE(NULLIF(qualification_notes,''), 'encerrado sem resposta do lead'),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(contact.id);
  await declineOppAndAppointment(contact, { lostReasonId: lostReasonSemResposta() });
  try {
    db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'encerrado_sem_resposta', ?)`)
      .run(contact.id, JSON.stringify({ ghlContactId: contact.ghl_contact_id }));
  } catch {}
  logger.info({ contactId: contact.id }, 'lead encerrado sem resposta — card declinado');
}

export async function markDisqualified(contact, result) {
  db.prepare(`
    UPDATE contacts
    SET stage = 'desqualificado',
        qualification_score = ?,
        qualification_notes = ?,
        ai_paused = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(result.qualification_score || 0, result.qualification_notes || '', contact.id);

  // Declina card + cancela reunião em paralelo (não bloqueia a resposta ao lead)
  declineOppAndAppointment(contact, { lostReasonId: lostReasonDesqualificou() }).catch(() => {});

  // Log auditável do encerramento — alimenta o "Encerrados" do resumo diário
  // (pedido do Gabriel 25/08: saber quantos a Tina declinou no dia).
  try {
    db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'lead_desqualificado', ?)`)
      .run(contact.id, JSON.stringify({ motivo: result?.qualification_notes || null }));
  } catch {}

  // Etiquetas (temperatura frio, etc) são aplicadas pelo applyTinaTags()
  // que o webhook chama a cada turno. Aqui só os custom fields.
  try {
    await writeQualificationFields(contact.ghl_contact_id, {
      funnel: result.funnel,
      score: result.qualification_score,
      notes: result.qualification_notes,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'falha ao gravar custom fields do desqualificado');
  }
}

// Chamado quando detectamos no webhook que um SDR humano respondeu direto no GHL.
// Pausa a IA na hora. Marca tag tina-transferida pra rastreio + cancela
// follow-ups pendentes (não queremos a Tina voltando depois que humano assumiu).
export function handleSDRReply(contactId, sdrId = null) {
  db.prepare(`
    UPDATE contacts
    SET ai_paused = 1,
        ai_paused_at = CURRENT_TIMESTAMP,
        assigned_sdr_id = COALESCE(?, assigned_sdr_id),
        last_outbound_at = CURRENT_TIMESTAMP,
        stage = CASE WHEN stage IN ('novo','pre_qualificando','qualificando') THEN 'handoff' ELSE stage END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(sdrId, contactId);

  // Cancela follow-ups pendentes — humano está conversando, Tina não deve voltar
  db.prepare('UPDATE followups SET sent = 1 WHERE contact_id = ? AND sent = 0').run(contactId);

  // Marca tag tina-transferida no GHL pra rastreio do time
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (contact && contact.ghl_contact_id && !String(contact.ghl_contact_id).startsWith('wa-') && process.env.GHL_API_TOKEN) {
    GHL.addTag(contact.ghl_contact_id, [TAG.transferida])
      .catch(err => logger.error({ err: err.message, contactId }, 'falha ao marcar tina-transferida no GHL'));
  }
}
