// Levantamento do que existe HOJE no GHL para o fluxo de proposta -> contrato.
// Serve de base para o orçamento/aprovação da Lilian: nomes e IDs reais, sem adivinhação.
//
// NÃO imprime token. Só lê (GET), não altera nada.
//
// Uso: node scripts/levantar-proposta-ghl.mjs [> saida.json]

import 'dotenv/config';
import fetch from 'node-fetch';

const BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const LOC = process.env.GHL_LOCATION_ID;
const TOKEN = process.env.GHL_API_TOKEN;
if (!TOKEN || !LOC) { console.error('GHL_API_TOKEN ou GHL_LOCATION_ID ausente no .env'); process.exit(1); }

// Os 8 campos que o gerador Press LC já escreve (lidos do bundle da página).
const USADOS_PELO_GERADOR = [
  'Livro', 'Valor da Proposta', 'Serviço Fechado', 'Prazo de Execução',
  'Condições de Pagamento', 'Data de Início dos Trabalhos',
  'Observações da Proposta', 'Consultor Responsável',
];

// Os 30 campos da ficha de contrato que existem no modelo da página mas não têm
// input na tela. Serve para conferir quais já têm campo correspondente no GHL.
const FICHA = [
  'tipo', 'pfNome', 'pfCpf', 'pfRg', 'pfNascimento', 'pfEndereco', 'pfCep', 'pfEmail', 'pfTelefone',
  'razaoSocial', 'cnpj', 'inscricao', 'endereco', 'cep',
  'responsavelNome', 'responsavelCpf', 'responsavelNascimento', 'responsavelEmail',
  'testemunhaNome', 'testemunhaEmail',
  'financeiroNome', 'financeiroEmail', 'financeiroTelefone',
  'servicoFechado', 'modeloContrato', 'periodoContrato', 'dataInicio',
  'horasMes', 'valorMensalidade', 'diaVencimento',
];

async function get(path, version = '2021-07-28') {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Version: version, Accept: 'application/json' },
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, json };
}

const norm = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

const out = {};

// === 1. CAMPOS PERSONALIZADOS ===
const cf = await get(`/locations/${LOC}/customFields`);
const campos = cf.json?.customFields || cf.json?.customField || [];
out.camposTotal = campos.length;
out.camposStatus = `${cf.status}${cf.ok ? '' : ' FALHOU'}`;
out.campos = campos.map(c => ({
  id: c.id, nome: c.name, chave: c.fieldKey, tipo: c.dataType, modelo: c.model,
}));

// cruza: os 8 do gerador existem no GHL?
out.cruzamentoGerador = USADOS_PELO_GERADOR.map(nome => {
  const achado = campos.find(c => norm(c.name) === norm(nome))
    || campos.find(c => norm(c.name).includes(norm(nome)) || norm(nome).includes(norm(c.name)));
  return { usadoPelaPagina: nome, existeNoGhl: !!achado, id: achado?.id || null, nomeNoGhl: achado?.name || null, tipo: achado?.dataType || null };
});

// cruza: a ficha de contrato tem campo no GHL?
out.cruzamentoFicha = FICHA.map(k => {
  const achado = campos.find(c => norm(c.name) === norm(k))
    || campos.find(c => norm(c.name).includes(norm(k)));
  return { campoDaFicha: k, existeNoGhl: !!achado, id: achado?.id || null, nomeNoGhl: achado?.name || null };
});
out.fichaFaltando = out.cruzamentoFicha.filter(f => !f.existeNoGhl).map(f => f.campoDaFicha);

// === 2. WORKFLOWS ===
const wf = await get(`/workflows/?locationId=${LOC}`);
out.workflowsStatus = `${wf.status}${wf.ok ? '' : ' FALHOU'}`;
const workflows = wf.json?.workflows || [];
out.workflows = workflows.map(w => ({ id: w.id, nome: w.name, status: w.status, criado: w.createdAt, atualizado: w.updatedAt }));
out.workflowsSuspeitos = out.workflows.filter(w => /propost|contrat|closer|sdr|press/i.test(w.nome || ''));

// === 3. PIPELINES E ESTÁGIOS ===
const pp = await get(`/opportunities/pipelines?locationId=${LOC}`);
out.pipelinesStatus = `${pp.status}${pp.ok ? '' : ' FALHOU'}`;
out.pipelines = (pp.json?.pipelines || []).map(p => ({
  id: p.id, nome: p.name,
  estagios: (p.stages || []).map(s => ({ id: s.id, nome: s.name, posicao: s.position })),
}));

// === 4. USUÁRIOS (alvo das notificações internas) ===
const us = await get(`/users/?locationId=${LOC}`);
out.usuariosStatus = `${us.status}${us.ok ? '' : ' FALHOU'}`;
out.usuarios = (us.json?.users || []).map(u => ({
  id: u.id, nome: `${u.firstName || ''} ${u.lastName || ''}`.trim(), email: u.email, papel: u.roles?.role,
}));

console.log(JSON.stringify(out, null, 2));
