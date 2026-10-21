// Cria no GHL os campos personalizados da FICHA DE CONTRATO.
//
// Por que script e não na mão: são ~29 campos. Criar um a um na interface é onde
// nasce campo duplicado e nome torto — a conta JÁ tem dois campos de CPF diferentes
// ("CPF/CNPJ" e "Digite abaixo o seu CPF completo") por causa disso.
//
// Todos levam o prefixo "Contrato - " de propósito: agrupa na listagem, não colide
// com os 179 campos que já existem e deixa óbvio de onde vieram.
//
// SEGURANÇA: por padrão roda em SIMULAÇÃO e não escreve nada. Só grava com --aplicar.
//   node scripts/criar-campos-contrato.mjs              # mostra o que faria
//   node scripts/criar-campos-contrato.mjs --aplicar    # cria de verdade
//
// Idempotente: campo cujo nome já existe é PULADO, nunca recriado.

import 'dotenv/config';
import fetch from 'node-fetch';

const BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const LOC = process.env.GHL_LOCATION_ID;
const TOKEN = process.env.GHL_API_TOKEN;
const APLICAR = process.argv.includes('--aplicar');

if (!TOKEN || !LOC) { console.error('GHL_API_TOKEN ou GHL_LOCATION_ID ausente no .env'); process.exit(1); }

// ⚠️ dataType ACEITOS pela API (confirmado no erro 422 de 20/10): TEXT, LARGE_TEXT,
// NUMERICAL, PHONE, MONETORY, CHECKBOX, SINGLE_OPTIONS, MULTIPLE_OPTIONS, FLOAT, TIME,
// DATE, FILE_UPLOAD. **NÃO existe EMAIL** — e-mail vai como TEXT.
const CAMPOS = [
  // --- quem contrata: pessoa física ---
  { name: 'Contrato - Tipo de Pessoa', dataType: 'SINGLE_OPTIONS', options: ['Pessoa Física', 'Pessoa Jurídica'] },
  { name: 'Contrato - Nome do Contratante', dataType: 'TEXT' },
  { name: 'Contrato - CPF', dataType: 'TEXT' },
  { name: 'Contrato - RG', dataType: 'TEXT' },
  { name: 'Contrato - Data de Nascimento', dataType: 'DATE' },
  { name: 'Contrato - Endereço', dataType: 'TEXT' },
  { name: 'Contrato - CEP', dataType: 'TEXT' },
  // ⚠️ NÃO existe "Contrato - E-mail" de propósito. O e-mail do contratante é o
  // e-mail PADRÃO do contato — é ele que o GHL usa pra casar a ficha com a pessoa
  // certa. Um campo próprio aqui criaria uma segunda verdade pro mesmo dado, e na
  // hora que divergisse ninguém saberia qual vale.
  { name: 'Contrato - Telefone', dataType: 'PHONE' },

  // --- quem contrata: pessoa jurídica ---
  { name: 'Contrato - Razão Social', dataType: 'TEXT' },
  { name: 'Contrato - CNPJ', dataType: 'TEXT' },
  { name: 'Contrato - Inscrição Estadual/Municipal', dataType: 'TEXT' },
  { name: 'Contrato - Endereço da Empresa', dataType: 'TEXT' },
  { name: 'Contrato - CEP da Empresa', dataType: 'TEXT' },
  { name: 'Contrato - Responsável Legal', dataType: 'TEXT' },
  { name: 'Contrato - CPF do Responsável', dataType: 'TEXT' },
  { name: 'Contrato - Nascimento do Responsável', dataType: 'DATE' },
  { name: 'Contrato - E-mail do Responsável', dataType: 'TEXT' },

  // --- testemunha ---
  { name: 'Contrato - Nome da Testemunha', dataType: 'TEXT' },
  { name: 'Contrato - E-mail da Testemunha', dataType: 'TEXT' },

  // --- responsável financeiro ---
  { name: 'Contrato - Nome do Financeiro', dataType: 'TEXT' },
  { name: 'Contrato - E-mail do Financeiro', dataType: 'TEXT' },
  { name: 'Contrato - Telefone do Financeiro', dataType: 'PHONE' },

  // --- condições do serviço contratado ---
  { name: 'Contrato - Modelo', dataType: 'TEXT' },
  { name: 'Contrato - Período', dataType: 'TEXT' },
  { name: 'Contrato - Horas por Mês', dataType: 'NUMERICAL' },
  { name: 'Contrato - Valor da Mensalidade', dataType: 'MONETORY' },
  { name: 'Contrato - Dia de Vencimento', dataType: 'NUMERICAL' },

  // --- controle do fluxo (não estão na ficha, mas o workflow precisa) ---
  // Data do aceite: é o GATILHO do workflow que move o card e abre o caso da Thalia.
  { name: 'Contrato - Proposta Aceita Em', dataType: 'DATE' },
  // Onde a Thalia anexa o documento assinado, dentro do próprio contato.
  { name: 'Contrato - Documento Assinado', dataType: 'FILE_UPLOAD' },
];

const norm = s => String(s || '').trim().toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`, Version: '2021-07-28',
      Accept: 'application/json', 'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, json };
}

// 1) o que já existe
const atual = await api('GET', `/locations/${LOC}/customFields`);
if (!atual.ok) { console.error('não consegui listar os campos:', atual.status, JSON.stringify(atual.json).slice(0, 200)); process.exit(1); }
const existentes = atual.json?.customFields || [];
const porNome = new Map(existentes.map(c => [norm(c.name), c]));

console.log(`\n${APLICAR ? '>>> APLICANDO' : '>>> SIMULAÇÃO (nada será criado)'} — location ${LOC}`);
console.log(`campos hoje na conta: ${existentes.length}\n`);

const criar = [], pular = [];
for (const c of CAMPOS) {
  const achado = porNome.get(norm(c.name));
  (achado ? pular : criar).push(achado ? { ...c, id: achado.id } : c);
}

for (const c of pular) console.log(`  = JÁ EXISTE  ${c.name}  [${c.id}]`);
for (const c of criar) console.log(`  + CRIAR      ${c.name}  (${c.dataType})`);
console.log(`\n${criar.length} a criar, ${pular.length} já existem.`);

if (!APLICAR) {
  console.log('\nSimulação. Para criar de verdade: node scripts/criar-campos-contrato.mjs --aplicar\n');
  process.exit(0);
}

// 2) cria
console.log('\ncriando...\n');
const resultado = [];
for (const c of criar) {
  const body = { name: c.name, dataType: c.dataType, placeholder: '', model: 'contact' };
  if (c.options) body.options = c.options;
  const r = await api('POST', `/locations/${LOC}/customFields`, body);
  const id = r.json?.customField?.id || r.json?.id || null;
  if (r.ok && id) {
    console.log(`  ✓ ${c.name}  -> ${id}`);
    resultado.push({ nome: c.name, id, tipo: c.dataType });
  } else {
    console.log(`  ✗ ${c.name}  HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  }
  await new Promise(res => setTimeout(res, 250));   // respeita o rate limit
}

console.log(`\n${resultado.length} de ${criar.length} criados.`);
console.log('\n--- IDs (guarde, servem pra montar o formulário e os workflows) ---');
for (const r of resultado) console.log(`${r.id}  ${r.nome}`);
console.log();
