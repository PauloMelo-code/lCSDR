// Orquestração de agendamento da Tina via calendários do GHL.
//
// Fluxo (a Tina é uma SDR que agenda o quanto antes pra não esfriar o lead):
//   1. Lead qualifica → webhook coloca em stage 'agendando' (IA segue ativa)
//   2. Próximo turno → getNextSlots() puxa os horários livres mais próximos
//      do AGORA, OLHANDO TODOS os calendários dos closers (rodízio), e pega
//      os mais cedo entre todos
//   3. Tina oferece os 2-3 slots mais próximos
//   4. Lead escolhe → Tina devolve book_slot (ISO) → bookSlot() marca no GHL,
//      no calendário do closer dono daquele horário
//   5. Confirma + notifica grupo + handoff (Closer assume)
//
// MÚLTIPLOS CALENDÁRIOS (rodízio de closers):
//   GHL_CALENDAR_IDS = "id1,id2,id3"  (lista dos closers)
//   ou GHL_CALENDAR_ID = "id"          (um só, compat)
// A Tina consulta todos, junta os horários e oferece os mais próximos de
// QUALQUER closer livre. Assim o lead pega o primeiro horário disponível.
//
// Env-gated: sem calendário configurado, cai no handoff normal.

import { db } from '../db/index.js';
import { GHL } from '../ghl/client.js';
import { logger } from '../utils/logger.js';

const SLOT_MINUTES = Number(process.env.GHL_SLOT_MINUTES || 30);
const LOOKAHEAD_DAYS = Number(process.env.GHL_SLOT_LOOKAHEAD_DAYS || 5);
// Distância MÁXIMA (em dias) do horário que o consultor da vez pode oferecer. Se o
// mais cedo dele passar disso, o rodízio pula pro próximo — mesmo que esse próximo
// já tenha recebido lead (regra LC 03/09: lead atendido rápido > distribuição igual).
// 0 desliga a regra (volta ao rodízio puro).
const MAX_AHEAD_DAYS = Number(process.env.SCHEDULING_MAX_AHEAD_DAYS ?? 3);
const TIMEZONE = process.env.GHL_TIMEZONE || 'America/Sao_Paulo';

// TRAVA DE CONFLITO: antes de agendar, confere se o horário JÁ tem reunião no
// calendário (via /calendars/events) e recusa se tiver. Pega o que o free-slots
// não vê: marcação MANUAL pelo contact page, corrida entre 2 leads, buffer não
// aplicado. Default LIGADA; SCHEDULING_CONFLICT_CHECK=false desliga. A folga extra
// (além da sobreposição pura) vem de SCHEDULING_MIN_GAP_MIN (default 0 = só bloqueia
// sobreposição real; o intervalo entre reuniões já é garantido pelo buffer do GHL).
const CONFLICT_CHECK = process.env.SCHEDULING_CONFLICT_CHECK !== 'false';
const MIN_GAP_MS = Math.max(0, Number(process.env.SCHEDULING_MIN_GAP_MIN) || 0) * 60_000;

// TRAVA de horário comercial: a Tina só oferece/agenda slots DENTRO desta faixa
// (hora local BRT). O free-slots do GHL às vezes devolve horários FORA do expediente
// (ex.: 19h–23h30 por config de fuso/disponibilidade errada no calendário) — sem esta
// trava a Tina agendava de madrugada. Default 8h–18h = envelope que cobre TODOS os
// closers (uns 8–17, outros 9–18) e bloqueia só o fora-de-hora (ex.: 19h–23h30 da
// Andressa). O free-slots já respeita o expediente fino de cada calendário (menos o
// bug da Andressa); a trava é a rede de segurança. Config: SCHEDULING_HOUR_MIN /
// SCHEDULING_HOUR_MAX (0-24). Se MIN >= MAX (inválido), a trava fica DESLIGADA.
const SCHED_HOUR_MIN = Number(process.env.SCHEDULING_HOUR_MIN ?? 8);
const SCHED_HOUR_MAX = Number(process.env.SCHEDULING_HOUR_MAX ?? 18);
function slotHourBRT(iso) {
  try {
    return Number(new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)));
  } catch { return new Date(iso).getHours(); }
}
// True se o slot COMEÇA dentro do expediente. Trava desligada/ inválida → sempre true.
function withinBusinessHours(iso) {
  if (!Number.isFinite(SCHED_HOUR_MIN) || !Number.isFinite(SCHED_HOUR_MAX) || SCHED_HOUR_MIN >= SCHED_HOUR_MAX) return true;
  const h = slotHourBRT(iso);
  return h >= SCHED_HOUR_MIN && h < SCHED_HOUR_MAX;
}

// EXPEDIENTE DO TIME HUMANO (quando alguém pode de fato atender o lead).
// ⚠️ Diferente da trava SCHEDULING_HOUR_MIN/MAX acima: aquela é o envelope dos
// horários de REUNIÃO; esta é quando há gente pra responder AGORA.
// Antes o expediente só existia como frase no prompt — o código não sabia se era
// fim de semana. ❌ CASO REAL (19-20/09): no sábado e domingo a Tina ofereceu
// "falar agora" em 20 conversas, e o grupo recebeu "🔥 Lead quer falar AGORA —
// assumir o quanto antes" pra lead a quem ela tinha acabado de dizer "te chamamos
// na segunda". Config: ATENDIMENTO_DIAS (0=dom … 6=sáb), ATENDIMENTO_HORA_INI/FIM.
const EXP_DIAS = (process.env.ATENDIMENTO_DIAS || '1,2,3,4,5').split(',').map(s => Number(s.trim())).filter(n => n >= 0 && n <= 6);
const EXP_INI = Number(process.env.ATENDIMENTO_HORA_INI ?? 9);
const EXP_FIM = Number(process.env.ATENDIMENTO_HORA_FIM ?? 18);
const DIA_NOME = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export function expedienteConfig() {
  return { dias: EXP_DIAS, horaIni: EXP_INI, horaFim: EXP_FIM };
}

// Dia da semana (0=dom) e hora no fuso de Brasília — NUNCA no do servidor (UTC).
function diaEHoraBRT(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { dow, hora: Number(p.hour) + Number(p.minute) / 60 };
}

/**
 * O time humano está atendendo agora? E quando é a próxima abertura?
 * @returns {{ aberto: boolean, proxima: string, faixa: string }}
 *   proxima: "hoje às 9h" | "amanhã às 9h" | "segunda-feira às 9h"
 */
export function expediente(agora = new Date()) {
  const { dow, hora } = diaEHoraBRT(agora);
  const faixa = `${EXP_INI}h às ${EXP_FIM}h`;
  const aberto = EXP_DIAS.includes(dow) && hora >= EXP_INI && hora < EXP_FIM;
  let proxima = null;
  for (let i = 0; i <= 7 && !proxima; i++) {
    const d = (dow + i) % 7;
    if (!EXP_DIAS.includes(d)) continue;
    if (i === 0 && hora >= EXP_INI) continue;   // hoje já abriu (ou já fechou)
    proxima = `${i === 0 ? 'hoje' : i === 1 ? 'amanhã' : DIA_NOME[d]} às ${EXP_INI}h`;
  }
  return { aberto, proxima: proxima || `às ${EXP_INI}h`, faixa };
}

// Lista de calendários (closers). Aceita GHL_CALENDAR_IDS (CSV) ou GHL_CALENDAR_ID (único).
export function getCalendarIds() {
  const multi = (process.env.GHL_CALENDAR_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (multi.length) return multi;
  const single = (process.env.GHL_CALENDAR_ID || '').trim();
  return single ? [single] : [];
}

export function schedulingEnabled() {
  return process.env.SCHEDULING_ENABLED === 'true' && getCalendarIds().length > 0;
}

// Nome do consultor dono do calendário (pra avisos do time). Prioriza o env
// GHL_CALENDAR_NAMES ("calId:Nome,calId:Nome"); cai no mapa conhecido dos 6.
const CALENDAR_NAMES = {
  xzm7QW8TUGbwOP6IxAK8: 'Andressa', fMuUzjj4nSKRUXEPZYAx: 'Victor',
  OGYp8xuhvT1Fk5alNApk: 'Nataly', mbhOf9ovPL5HcCnCu5EN: 'Fernanda',
  '3XfNAPi9421TD3HlN7ac': 'Bruna', NhjBRFw1AJex8TqNuLAw: 'Gabriel',
};
export function calendarName(calendarId) {
  if (!calendarId) return null;
  for (const pair of (process.env.GHL_CALENDAR_NAMES || '').split(',')) {
    const [id, ...rest] = pair.split(':');
    if (id?.trim() === calendarId && rest.length) return rest.join(':').trim();
  }
  return CALENDAR_NAMES[calendarId] || null;
}

// MODALIDADE POR CALENDÁRIO (a roleta mistura dois tipos de compromisso):
//   - pré-atendimento (Gabriel/Bruna): LIGAÇÃO de 15 min, triagem antes do closer
//   - closer (Nataly/Victor/Fernanda/Andressa): REUNIÃO de 30 min com o especialista
// Sem isso a Tina usava um texto único pra todo mundo e prometia "ligação de 15 min"
// pra quem ia receber reunião de closer — o lead ficava esperando o telefone tocar
// (❌ caso Juliete, 20/08: "aguardei e ninguém me ligou").
// Config: PREATENDIMENTO_CALENDAR_IDS="id1,id2" (os que são ligação). Sem ela,
// cai no PREATENDIMENTO_ENABLED antigo (tudo ligação) ou tudo reunião.
function preAtendimentoCalendarIds() {
  return (process.env.PREATENDIMENTO_CALENDAR_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}
export function slotModality(calendarId) {
  const ids = preAtendimentoCalendarIds();
  const isPre = ids.length
    ? ids.includes(calendarId)
    : process.env.PREATENDIMENTO_ENABLED === 'true';   // compat: modo global antigo
  // tituloAgenda + sep formam o título do compromisso: `${tituloAgenda}${sep}${nome}`.
  // Closer usa "Reunião LC Agência x Fulano" (pedido da LC, e é o mesmo formato que
  // os calendários dos closers já usam nativamente); pré-atendimento segue com vírgula.
  return isPre
    ? { tipo: 'ligacao', termo: 'pré-atendimento', desc: 'ligação de 15 min por telefone', tituloAgenda: 'Pré-atendimento LC', sep: ', ', avisoTitulo: 'Novo pré-atendimento agendado pela Tina', avisoQuem: 'Atende' }
    : { tipo: 'reuniao', termo: 'reunião', desc: 'reunião com o especialista', tituloAgenda: 'Reunião LC Agência', sep: ' x ', avisoTitulo: 'Nova reunião agendada pela Tina', avisoQuem: 'Consultor' };
}

// Achata a resposta de free-slots do GHL num array de ISO datetimes.
// GHL devolve { "2026-06-15": { slots: [ "...T14:00:00-03:00", ... ] }, traceId }
function flattenSlots(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const all = [];
  for (const [key, val] of Object.entries(raw)) {
    if (key === 'traceId' || key === '_dates_') continue;
    if (val && Array.isArray(val.slots)) all.push(...val.slots);
    else if (Array.isArray(val)) all.push(...val);
  }
  return all;
}

// Dia (YYYY-MM-DD) de um ISO no fuso configurado, pra agrupar.
function dayKey(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// Índice de rodízio do agendamento: distribui os leads entre os consultores
// (a "roleta" que a Lilian pediu). Avança a cada reunião agendada. Como todos
// os closers têm a MESMA grade de horário, sem isso todo lead cairia no 1º da
// lista (sempre o mesmo consultor). Rotaciona pra dividir de forma justa.
function rotationStart(n) {
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM events_log WHERE kind = 'reuniao_agendada'").get();
    return (row?.c || 0) % n;
  } catch { return 0; }
}

// Pega um spread (cedo/meio/fim de cada dia, até 3 dias) de uma lista de slots.
function spreadPick(slots, count) {
  const byDay = new Map();
  for (const s of slots) {
    const k = dayKey(s.iso);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }
  const chosen = [];
  for (const day of [...byDay.keys()].slice(0, 3)) {
    const ds = byDay.get(day);
    const picks = ds.length <= 3 ? ds : [ds[0], ds[Math.floor(ds.length / 2)], ds[ds.length - 1]];
    chosen.push(...picks);
  }
  chosen.sort((a, b) => new Date(a.iso) - new Date(b.iso));
  return chosen.slice(0, count);
}

// Puxa horários livres dos closers, com RODÍZIO entre eles (roleta).
// Cada lead é atendido por um consultor da vez; oferece os horários DELE.
// Se o consultor da vez não tiver horário, passa pro próximo da roleta.
// Retorna [{ iso, label, calendarId }] de UM consultor, ordenado.
export async function getNextSlots(count = 3, { fromDate = new Date(), spread = true } = {}) {
  if (!schedulingEnabled()) return [];
  const calendarIds = getCalendarIds();
  const startMs = fromDate.getTime();
  const endMs = startMs + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;

  const results = await Promise.allSettled(calendarIds.map(calendarId =>
    GHL.getFreeSlots(calendarId, { startDate: String(startMs), endDate: String(endMs), timezone: TIMEZONE })
      .then(raw => ({ calendarId, isos: flattenSlots(raw) }))
  ));

  // mapa calendarId → slots futuros ordenados
  const byCal = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') { logger.warn({ err: r.reason?.message }, 'falha ao puxar free-slots de um calendário'); continue; }
    const list = r.value.isos
      .filter(iso => new Date(iso).getTime() > fromDate.getTime())
      .filter(withinBusinessHours)   // ignora slots fora do expediente que o GHL retorna
      .sort()
      .map(iso => ({ iso, calendarId: r.value.calendarId }));
    if (list.length) byCal.set(r.value.calendarId, list);
  }
  if (!byCal.size) return [];

  const pack = s => ({ iso: s.iso, label: labelForSlot(s.iso), calendarId: s.calendarId });

  // RODÍZIO: começa pelo consultor da vez, oferece os horários DELE.
  // Pula quem não tiver horário, na ordem da roleta.
  //
  // ⚠️ REGRA LC 03/09: pula TAMBÉM quem só tem horário LONGE (> MAX_AHEAD_DAYS),
  // passando pro próximo mesmo que ele já tenha recebido lead. Antes o rodízio só
  // olhava "tem horário?" — então o lead caía num consultor com agenda travada e
  // recebia reunião pra semana que vem, mesmo com outro closer livre AMANHÃ.
  // ❌ CASO REAL: Nataly só abria em 07/09 e Victor em 09/09 enquanto Andressa
  // tinha 6 horários no dia seguinte; a Tina oferecia 07/09 e o lead esfriava.
  // Se NINGUÉM estiver dentro do limite, cai no fallback e oferece o mais cedo que
  // existir — o lead nunca fica sem opção. MAX_AHEAD_DAYS=0 desliga a regra.
  const limiteMs = MAX_AHEAD_DAYS > 0 ? MAX_AHEAD_DAYS * 86_400_000 : Infinity;
  const maisCedoDe = cid => new Date(byCal.get(cid)[0].iso).getTime() - startMs;

  const start = rotationStart(calendarIds.length);
  for (let i = 0; i < calendarIds.length; i++) {
    const cid = calendarIds[(start + i) % calendarIds.length];
    const slots = byCal.get(cid);
    if (!slots?.length) continue;                       // sem horário → próximo
    if (maisCedoDe(cid) > limiteMs) {                   // só tem horário longe → próximo
      logger.debug({ calendarId: cid, dias: Math.floor(maisCedoDe(cid) / 86_400_000) }, 'consultor da vez só tem horário distante — passa pro próximo');
      continue;
    }
    const picked = spread ? spreadPick(slots, count) : slots.slice(0, count);
    return picked.map(pack);
  }

  // FALLBACK: ninguém dentro do limite (todos com agenda travada) → oferece o
  // horário MAIS CEDO que existir, seja de quem for. Melhor uma reunião distante
  // do que nenhuma.
  const comSlots = [...byCal.keys()].filter(c => byCal.get(c)?.length);
  if (!comSlots.length) return [];
  const maisCedo = comSlots.sort((a, b) => maisCedoDe(a) - maisCedoDe(b))[0];
  logger.info({ calendarId: maisCedo, dias: Math.floor(maisCedoDe(maisCedo) / 86_400_000) }, 'nenhum consultor com horário próximo — oferecendo o mais cedo disponível');
  const slots = byCal.get(maisCedo);
  return (spread ? spreadPick(slots, count) : slots.slice(0, count)).map(pack);
}

// Formata um ISO em rótulo humano PT-BR relativo (hoje/amanhã + hora).
// O "hoje/amanhã" é comparado no fuso de BRASÍLIA, não no do servidor (UTC): à noite
// no BR já é o dia seguinte em UTC, e o toDateString() do servidor fazia "amanhã 16h"
// virar "hoje 16h" no aviso do grupo.
export function labelForSlot(iso) {
  const d = new Date(iso);
  const now = new Date();
  const brtDay = x => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const dDay = brtDay(d), nowDay = brtDay(now), tomDay = brtDay(new Date(now.getTime() + 86_400_000));

  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
  if (dDay === nowDay) return `hoje às ${hora}`;
  if (dDay === tomDay) return `amanhã às ${hora}`;
  const dia = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: TIMEZONE });
  return `${dia} às ${hora}`;
}

// Bloco de contexto injetado no prompt quando há slots disponíveis.
export function slotsContextBlock(slots) {
  if (!slots || !slots.length) return null;
  const linhas = slots.map((s, i) => {
    const m = slotModality(s.calendarId);
    return `  ${i + 1}. ${s.label} — ${m.desc}  (ISO: ${s.iso})`;
  }).join('\n');

  // Se a lista mistura ligação e reunião, a Tina PRECISA usar o texto certo pra
  // cada horário — senão promete ligação pra quem vai receber reunião de closer.
  const tipos = new Set(slots.map(s => slotModality(s.calendarId).tipo));
  const regraModalidade = tipos.size > 1
    ? `
⚠️ **ATENÇÃO, os horários acima são de DOIS tipos diferentes.** Cada linha diz qual é o dela:
- **"ligação de 15 min por telefone"** → é um **pré-atendimento**: nossa equipe LIGA para o lead. Use a palavra "pré-atendimento", diga que é rápido (15 min) e **por telefone**.
- **"reunião com o especialista"** → é uma **reunião**. Use a palavra "reunião", NÃO prometa ligação telefônica.
🚫 **NUNCA troque um pelo outro.** Se você oferecer/confirmar o horário de uma reunião dizendo que "vamos te ligar", o lead fica esperando uma ligação que não vai acontecer. Use SEMPRE a descrição da linha que você escolheu.`
    : `
Todos os horários acima são: **${slotModality(slots[0].calendarId).desc}**. Use esse enquadramento ao oferecer e ao confirmar.`;

  return `
HORÁRIOS DISPONÍVEIS PARA AGENDAMENTO (próximos dias):
${linhas}
${regraModalidade}

REGRAS DE AGENDAMENTO:
- Ofereça proativamente os **2-3 mais cedo** desta lista (priorize o quanto antes, o lead não pode esfriar).
- Se o lead pedir um DIA ou PERÍODO específico ("amanhã de manhã", "fim da tarde", "quinta"), escolha da lista o horário que MELHOR casa com o pedido e ofereça. NÃO invente horário fora da lista.
- Se NENHUM horário da lista casa com o que o lead quer, seja honesta: ofereça o mais próximo que tem ("o mais perto disso que consigo é X") e, se ainda assim não servir, diga que o especialista confirma um horário sob medida.
- ⚠️ SÓ devolva "book_slot" quando o lead confirmar **DIA E HORA específicos** (ex: "pode ser amanhã às 11h30", ou um "sim" claro a um horário que VOCÊ ofereceu com dia+hora). Use o ISO EXATO daquele horário (copie da lista).
- ⚠️ Se o lead deu só a HORA ("11:30 dá certo") mas NÃO o dia — ou só o dia sem a hora — **NÃO marque ainda**: confirme o que falta ("11h30 de qual dia fica melhor pra você, hoje ou amanhã?") e só devolva book_slot depois que ele responder com dia+hora.
- ⚠️ NUNCA trate como confirmação mensagens ambíguas tipo "ok", "recebido", "confirmado o recebimento", "blz", "deixa eu ver", "vou verificar". Isso NÃO é "pode marcar". Pergunte de forma direta: "Posso confirmar então [dia] às [hora]?" e só marque com o "sim" explícito.
- NUNCA invente um horário que não está nesta lista.
- 🗓️ **FALE O HORÁRIO COM O RÓTULO EXATO DA LISTA.** Se a linha diz "quarta-feira, 09/09 às 10:30", diga **"quarta-feira, 09/09 às 10:30"**. **NUNCA traduza por conta própria para "hoje" ou "amanhã"** — só use "hoje"/"amanhã" se for exatamente o que está escrito na linha. ❌ ERRO REAL: a lista dizia "quarta-feira, 09/09" e a Tina falou "amanhã, quarta-feira" — o lead esperou a reunião no dia seguinte e ela estava marcada 8 dias depois.`.trim();
}

// Contexto injetado quando NÃO há NENHUM horário livre em nenhum calendário.
// ⚠️ Sem este aviso a Tina ficava sem lista nenhuma no contexto e — proibida pelo
// prompt de dizer que "a agenda não abriu" — INVENTAVA horários plausíveis e dizia
// "agendei", sem preencher book_slot: nada ia pro calendário e ninguém era avisado.
// ❌ CASO REAL (Juliete, 20/08): as duas agendas do pré-atendimento estavam zeradas,
// a Tina ofereceu "11h, 11h30 ou 13h", confirmou "agendei pra hoje às 11h30" e a
// lead esperou uma ligação que nunca existiu ("aguardei e ninguém me ligou").
export const NO_SLOTS_CONTEXT = `
⚠️ AGENDA SEM HORÁRIO DISPONÍVEL (informação do SISTEMA — é fato, confie nela):
Neste momento NÃO há nenhum horário livre na agenda do time.

- ❌ **NÃO ofereça horário nenhum.** Você não tem horários pra oferecer. Não diga "consigo às 11h", não derive horário do que o lead falou, não chute.
- ❌ **NÃO diga que agendou, marcou, reservou ou encaixou.** Nada foi marcado — dizer isso faz o lead esperar uma ligação que não vai acontecer.
- ✅ Diga com naturalidade que vai **confirmar a melhor janela com o time** e que ele retorna com o horário.
- ✅ Marque \`handoff: true\` e \`stage: "qualificado"\` — o consultor humano assume e fecha o horário.

Exemplo: "Perfeito, [nome]! Vou confirmar a melhor janela com o nosso time e já te retorno com o horário certinho, pode ser? 😊"
`.trim();

// Registra os horários oferecidos (com o calendário de cada um) pra na hora
// de marcar saber em qual closer agendar.
export function recordOffer(contactId, slots) {
  if (!slots || !slots.length) return;
  try {
    db.prepare(`INSERT INTO events_log (contact_id, kind, payload) VALUES (?, 'slots_offered', ?)`)
      .run(contactId, JSON.stringify({ slots }));
  } catch (err) {
    logger.warn({ err: err.message, contactId }, 'falha ao registrar slots oferecidos');
  }
}

// Descobre em qual calendário (closer) está o horário que o lead escolheu,
// lendo o último 'slots_offered' do contato.
function calendarForSlot(contactId, iso) {
  try {
    const row = db.prepare(`
      SELECT payload FROM events_log
      WHERE contact_id = ? AND kind = 'slots_offered'
      ORDER BY id DESC LIMIT 1
    `).get(contactId);
    if (!row) return null;
    const { slots } = JSON.parse(row.payload);
    const t = new Date(iso).getTime();
    const match = (slots || []).find(s => new Date(s.iso).getTime() === t);
    return match?.calendarId || null;
  } catch {
    return null;
  }
}

// Retorna a próxima reunião FUTURA e ativa do contato (anti double-booking), ou
// null. Se um consultor (ou a própria Tina) já marcou, não cria outra.
// Falha ABERTO (erro/API fora → null → segue e agenda) pra não travar o lead.
export async function upcomingAppointment(contact) {
  if (!contact?.ghl_contact_id || !process.env.GHL_API_TOKEN) return null;
  try {
    const r = await GHL.getContactAppointments(contact.ghl_contact_id);
    const events = r?.events || r?.appointments || (Array.isArray(r) ? r : []);
    if (!Array.isArray(events) || !events.length) return null;
    const now = Date.now();
    const ativos = events.filter(e => {
      const st = new Date(e.startTime || e.startedAt || 0).getTime();
      const status = String(e.appointmentStatus || e.status || '').toLowerCase();
      const morta = /cancel|invalid|noshow|no-show|deleted/.test(status);
      return st > now && !morta;
    }).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    return ativos[0] || null;
  } catch (err) {
    logger.warn({ err: err.message, contactId: contact.id }, 'falha checando reunião existente; segue (fail-open)');
    return null;
  }
}

// TRUE se [startMs,endMs] (± MIN_GAP_MS) colide com alguma reunião ATIVA já
// existente no calendário. Consulta /calendars/events (pega marcações manuais que
// o free-slots ignora). Fail-open: erro de API → false (não trava agendamento por
// hiccup; buffer/free-slots/Outlook seguem protegendo). Reuniões canceladas/no-show
// não contam.
async function slotHasConflict(calendarId, startMs, endMs) {
  if (!CONFLICT_CHECK || !calendarId || !process.env.GHL_API_TOKEN) return false;
  try {
    // janela de busca com margem (pega vizinhas); a colisão é testada com precisão abaixo
    const r = await GHL.getCalendarEvents(calendarId, {
      startTime: startMs - MIN_GAP_MS - 3_600_000,
      endTime: endMs + MIN_GAP_MS + 3_600_000,
    });
    const events = r?.events || r?.appointments || (Array.isArray(r) ? r : []);
    if (!Array.isArray(events) || !events.length) return false;
    const aStart = startMs - MIN_GAP_MS;
    const aEnd = endMs + MIN_GAP_MS;
    return events.some(e => {
      const status = String(e.appointmentStatus || e.status || '').toLowerCase();
      if (/cancel|invalid|noshow|no-show|deleted/.test(status)) return false;
      const es = new Date(e.startTime || e.startedAt || 0).getTime();
      const ee = new Date(e.endTime || e.endedAt || es).getTime();
      if (!es) return false;
      return aStart < ee && aEnd > es; // sobreposição (bordas que só encostam NÃO colidem)
    });
  } catch (err) {
    logger.warn({ err: err.message, calendarId }, 'trava de conflito falhou; segue (fail-open)');
    return false;
  }
}

// Dono (teamMember) de cada calendário — cache por processo, 1 chamada resolve todos.
// Usado pra ATRIBUIR o contato/reunião ao consultor (regra LC 16/07: sem proprietário
// a conversa não aparece na caixa de entrada de ninguém — caso Creusa).
let _calOwners = null;
let _calDurations = null;
async function loadCalendarMeta() {
  if (_calOwners) return;
  const r = await GHL.listCalendars();
  _calOwners = {};
  _calDurations = {};
  for (const c of (r?.calendars || [])) {
    const tm = (c.teamMembers || []).find(t => t.isPrimary) || (c.teamMembers || [])[0];
    if (tm?.userId) _calOwners[c.id] = tm.userId;
    if (c.slotDuration) _calDurations[c.id] = Number(c.slotDuration);
  }
}
async function calendarOwnerUserId(calendarId) {
  if (!calendarId) return null;
  try {
    await loadCalendarMeta();
  } catch (err) {
    logger.warn({ err: err.message }, 'falha resolvendo donos dos calendários (segue sem atribuir)');
    return null; // não cacheia a falha — tenta de novo no próximo agendamento
  }
  return _calOwners[calendarId] || null;
}

// Duração da reunião SEGUNDO O CALENDÁRIO, não a global. A roleta mistura agendas
// com durações diferentes (closers 30min, pré-atendimento 15min) — usar o
// GHL_SLOT_MINUTES global marcaria reunião de closer com a duração errada.
// Cai no global só se o calendário não informar.
async function slotMinutesFor(calendarId) {
  try {
    await loadCalendarMeta();
    return _calDurations?.[calendarId] || SLOT_MINUTES;
  } catch {
    return SLOT_MINUTES;
  }
}

// Marca o agendamento no GHL, no calendário do closer dono do horário.
// Retorna { ok, label, error }.
export async function bookSlot(contact, iso, { title, notes, assignedUserId } = {}) {
  if (!schedulingEnabled()) return { ok: false, error: 'scheduling desativado' };
  if (!iso) return { ok: false, error: 'iso vazio' };

  const start = new Date(iso);
  if (isNaN(start.getTime())) return { ok: false, error: 'iso inválido' };
  // Defensivo: nunca marca fora do expediente, mesmo se a IA passar um horário que o
  // lead pediu (fora da lista oferecida). O webhook trata ok:false ("mantém agendando").
  if (!withinBusinessHours(iso)) {
    logger.warn({ contactId: contact.id, iso }, 'book_slot fora do horário comercial — recusado');
    return { ok: false, error: 'horário fora do expediente' };
  }
  // calendário do closer que tinha esse horário (ou o 1º configurado como fallback)
  const calendarId = calendarForSlot(contact.id, iso) || getCalendarIds()[0];
  if (!calendarId) return { ok: false, error: 'sem calendário configurado' };

  // duração PELO CALENDÁRIO (a roleta mistura 30min de closer com 15min de pré-atendimento)
  const end = new Date(start.getTime() + (await slotMinutesFor(calendarId)) * 60 * 1000);

  // TRAVA DE CONFLITO: recusa se o horário já tem reunião (manual, corrida, etc.).
  // ok:false → webhook mantém a Tina agendando e ela oferece outro horário no próximo turno.
  if (await slotHasConflict(calendarId, start.getTime(), end.getTime())) {
    logger.warn({ contactId: contact.id, iso, calendarId }, 'book_slot: já existe reunião nesse horário — recusado (evita sobreposição)');
    return { ok: false, error: 'horário já ocupado' };
  }

  // Consultor dono do calendário → vira o responsável pela reunião E proprietário
  // do contato (senão a conversa não aparece na caixa de entrada de ninguém).
  const ownerId = assignedUserId || await calendarOwnerUserId(calendarId);

  try {
    const res = await GHL.bookAppointment({
      calendarId,
      contactId: contact.ghl_contact_id,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      // título conforme a MODALIDADE do calendário (pré-atendimento x reunião),
      // pra agenda do consultor bater com o que a Tina prometeu pro lead
      title: title || (process.env.GHL_APPOINTMENT_TITLE
        ? `${process.env.GHL_APPOINTMENT_TITLE}, ${contact.name || 'lead'}`
        : `${slotModality(calendarId).tituloAgenda}${slotModality(calendarId).sep}${contact.name || 'lead'}`),
      notes: notes || `Agendado pela Tina (SDR). Funil: ${contact.funnel || '-'}.`,
      ...(ownerId ? { assignedUserId: ownerId } : {}),
    });
    logger.info({ contactId: contact.id, iso, calendarId, apptId: res?.id || res?.appointment?.id }, 'reunião agendada no GHL');
    // Atribui o CONTATO ao consultor (fire-and-forget; não desfaz a reunião se falhar)
    if (ownerId) {
      GHL.assignContact(contact.ghl_contact_id, ownerId).catch(err =>
        logger.warn({ err: err.message, contactId: contact.id, ownerId }, 'falha atribuindo proprietário ao contato (segue)'));
    }
    return { ok: true, label: labelForSlot(iso), calendarId, appointment: res };
  } catch (err) {
    logger.error({ err: err.message, contactId: contact.id, iso, calendarId }, 'falha ao agendar no GHL');
    return { ok: false, error: err.message };
  }
}
