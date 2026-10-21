// IDENTIDADE POR DONO DO LEAD (decisão Lilian 14/10): em vez de uma Tina para todos,
// a IA atende em nome do consultor DONO daquele lead e assina com o nome dele.
// O consultor assume a conversa depois sem troca de nome e sem reapresentação.
//
// ⚠️ A BASE DE REGRAS CONTINUA UMA SÓ. Isto troca o NOME e a AGENDA, nada mais.
// Não existe prompt por consultor: o que o time corrigir vale para todos de uma vez
// (era o risco de fazer N agentes separados e uma correção ficar para trás em um deles).
//
// Procedência do dono, em ordem:
//   1. `assignedTo` do contato no GHL — o GHL faz rodízio na ENTRADA, então todo lead
//      novo já nasce com dono. Vem de graça: handleInbound já busca o contato.
//   2. `contacts.assigned_sdr_id` local — fallback para quando não há contato do GHL
//      em mãos (follow-up do scheduler, canal uazapi).

import { db } from '../db/index.js';
import { getCalendarIds, calendarName } from './scheduling.js';
import { logger } from '../utils/logger.js';

export function personaEnabled() {
  return process.env.PERSONA_DONO_ENABLED === 'true';
}

// Resposta quando o lead pergunta DIRETAMENTE se está falando com uma IA.
// ⚠️ Configurável porque o texto é decisão da LC (entrega 4 da proposta). O default
// NÃO afirma ser pessoa: assinar com o nome do consultor é uma coisa, negar ser IA
// para quem perguntou na cara é outra, e quem paga isso é o consultor no encontro
// seguinte. Enquanto a LC não fechar a frase, vale este piso.
const RESPOSTA_IA_PADRAO = 'sou a assistente que faz o primeiro contato aqui pelo time';
export function respostaSeperguntaremSeEhIA() {
  return (process.env.PERSONA_RESPOSTA_IA || RESPOSTA_IA_PADRAO).trim();
}

const norm = s => String(s || '').trim().toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

// "Fernanda Vieira" → "Fernanda". O sdr_users guarda nome completo, mas o mapa de
// calendários e a assinatura usam o primeiro nome. Sem isto, nada casa.
export function primeiroNome(nome) {
  const limpo = String(nome || '').trim().replace(/\s+/g, ' ');
  return limpo ? limpo.split(' ')[0] : null;
}

// Calendário do consultor, casando pelo primeiro nome com o mapa de calendários.
// Devolve null se ele não tiver agenda na rotação (ex.: Bruna, que cuida de outro evento).
function calendarioDoConsultor(nome) {
  const alvo = norm(primeiroNome(nome));
  if (!alvo) return null;
  for (const id of getCalendarIds()) {
    if (norm(primeiroNome(calendarName(id))) === alvo) return id;
  }
  return null;
}

function montar(row) {
  if (!row) return null;
  const nome = primeiroNome(row.name);
  if (!nome) return null;
  return {
    sdrId: row.id,
    nome,
    nomeCompleto: row.name,
    ghlUserId: row.ghl_user_id || null,
    calendarId: calendarioDoConsultor(row.name),
  };
}

// ⚠️ SÓ QUEM ATENDE LEAD EMPRESTA O NOME. No GHL TODO MUNDO aparece como "admin",
// inclusive os closers, então o papel de lá não serve pra filtrar — quem vale é o
// `role` local. Sem este filtro, lead atribuído à Lilian, à Isabella ou a uma conta
// administrativa faria a IA se apresentar como elas para o lead.
const PAPEIS_QUE_ATENDEM = ['closer', 'sdr'];
const FILTRO_PAPEL = `active = 1 AND LOWER(COALESCE(role,'')) IN (${PAPEIS_QUE_ATENDEM.map(() => '?').join(',')})`;

// Dono a partir do userId do GHL (fonte preferida).
export function donoPorGhlUserId(ghlUserId) {
  if (!ghlUserId) return null;
  const row = db.prepare(`SELECT * FROM sdr_users WHERE ghl_user_id = ? AND ${FILTRO_PAPEL}`)
    .get(String(ghlUserId), ...PAPEIS_QUE_ATENDEM);
  return montar(row);
}

// Dono a partir do que está gravado no contato local.
export function donoDoContato(contact) {
  if (!contact?.assigned_sdr_id) return null;
  const row = db.prepare(`SELECT * FROM sdr_users WHERE id = ? AND ${FILTRO_PAPEL}`)
    .get(contact.assigned_sdr_id, ...PAPEIS_QUE_ATENDEM);
  return montar(row);
}

// Grava no contato local quem é o dono, lendo o `assignedTo` do contato do GHL.
// Roda cedo no inbound, quando o contato do GHL já está em mãos. A partir daí todo o
// resto do código (3 providers, uazapi, follow-up) lê só a linha local.
// Idempotente: só escreve quando mudou, então reatribuição no GHL é acompanhada.
export function sincronizarDonoDoLead(contact, ghlContact) {
  if (!contact?.id) return null;
  const assignedTo = ghlContact?.assignedTo || ghlContact?.assignedUserId || null;
  const dono = donoPorGhlUserId(assignedTo) || donoDoContato(contact);
  if (!dono) return null;
  if (contact.assigned_sdr_id !== dono.sdrId) {
    try {
      db.prepare('UPDATE contacts SET assigned_sdr_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(dono.sdrId, contact.id);
      contact.assigned_sdr_id = dono.sdrId;   // mantém o objeto em memória coerente
      logger.info({ contactId: contact.id, dono: dono.nome }, 'dono do lead sincronizado do GHL');
    } catch (err) {
      logger.warn({ err: err.message, contactId: contact.id }, 'falha gravando dono do lead');
    }
  }
  return dono;
}

// Bloco de contexto que troca a identidade da IA nesta conversa.
// Vai no extraContext (entrada única), NÃO no system prompt, para não quebrar o cache
// do prompt estático — mesma razão do bloco de hora.
export function personaBlock(dono) {
  if (!dono?.nome) return null;
  return [
    `IDENTIDADE NESTA CONVERSA: você NÃO é a Tina aqui. Você atende em nome de **${dono.nome}**,`,
    `consultor(a) do Grupo LC responsável por este lead, e assina como ${dono.nome}.`,
    `- Apresentação (só na PRIMEIRA mensagem): "Oi, [nome do lead]! Tudo bem? Aqui é a ${dono.nome}, do Grupo LC 😊".`,
    `- NUNCA escreva o nome "Tina" nesta conversa, em nenhuma mensagem.`,
    `- NUNCA diga que vai "passar para o consultor" nem para "alguém do time": você JÁ é ${dono.nome}.`,
    `  Ao fechar, ofereça o horário direto, porque a reunião é com você mesma.`,
    `- Se o lead perguntar DIRETAMENTE se é robô, IA ou atendimento automático, NÃO afirme ser`,
    `  humana: responda com naturalidade que ${respostaSeperguntaremSeEhIA()}, e siga o atendimento.`,
    dono.calendarId
      ? `- Os horários da lista são da agenda de ${dono.nome}. Trate como "consigo" e não como "o consultor tem".`
      : `- ${dono.nome} não tem agenda própria na rotação: ofereça os horários da lista normalmente.`,
  ].join('\n');
}

// Atalho usado pelo tina.js: resolve pelo contato local e já devolve o bloco.
export function personaContext(contact) {
  if (!personaEnabled()) return null;
  return personaBlock(donoDoContato(contact));
}
