#!/usr/bin/env node
// Gera um dashboard Grafana por conta (user_email) do Claude Code.
//
// Fonte única: dashboards/claude-code-cost.json (o dashboard mestre, com o
// filtro "Conta"). Este script NÃO duplica a lógica dos painéis — ele lê o
// mestre em tempo de execução e só troca uid, título e o filtro de conta,
// fixando cada dashboard gerado em um único email. Assim o mestre continua
// sendo a única coisa a manter.
//
// Uso:
//   node observability/grafana/generate-account-dashboards.mjs
//
// Variáveis de ambiente:
//   PROM_URL  URL do Prometheus (padrão http://localhost:47909)
//
// Os arquivos vão para dashboards/accounts/<slug>.json e são carregados
// automaticamente pelo provisioning do Grafana (updateIntervalSeconds: 30).
// Contas que somem dos dados têm o dashboard removido na próxima execução.

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROM_URL = process.env.PROM_URL || 'http://localhost:47909';
const here = dirname(fileURLToPath(import.meta.url));
const masterPath = join(here, 'dashboards', 'claude-code-cost.json');
const outDir = join(here, 'dashboards', 'accounts');

function slug(email) {
  return email.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function fetchEmails() {
  const url = new URL('/api/v1/label/user_email/values', PROM_URL);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Prometheus respondeu ${response.status} em ${url}`);
  const body = await response.json();
  if (body.status !== 'success') throw new Error(`Prometheus status=${body.status}`);
  return [...new Set((body.data || []).filter(Boolean))].sort();
}

function scopeToAccount(master, email) {
  const dashboard = structuredClone(master);
  dashboard.uid = `cc-${slug(email)}`.slice(0, 40);
  dashboard.title = `Claude Code — ${email}`;
  dashboard.description =
    `Gerado automaticamente para a conta ${email}. Fonte única: claude-code-cost.json. ` +
    `Não edite à mão — rode generate-account-dashboards.mjs para regenerar.`;

  // Substitui a variável "account" (seletor de conta) por uma constante oculta
  // fixada neste email, escapando os metacaracteres de regex do PromQL.
  const accountVar = {
    name: 'account',
    label: 'Conta',
    type: 'constant',
    query: email.replace(/[.+*?()|[\]{}\\^$]/g, '\\$&'),
    current: { text: email, value: email.replace(/[.+*?()|[\]{}\\^$]/g, '\\$&') },
    hide: 2,
  };
  const list = dashboard.templating?.list ?? (dashboard.templating = { list: [] }).list;
  const index = list.findIndex((v) => v.name === 'account');
  if (index >= 0) list[index] = accountVar;
  else list.unshift(accountVar);

  return dashboard;
}

async function main() {
  const master = JSON.parse(await readFile(masterPath, 'utf8'));
  const emails = await fetchEmails();
  await mkdir(outDir, { recursive: true });

  const wanted = new Map(emails.map((email) => [`${slug(email)}.json`, email]));

  // Remove dashboards de contas que não têm mais dados.
  const existing = (await readdir(outDir).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const file of existing) {
    if (!wanted.has(file)) {
      await unlink(join(outDir, file));
      console.log(`removido: ${file} (conta sem dados)`);
    }
  }

  for (const [file, email] of wanted) {
    const dashboard = scopeToAccount(master, email);
    await writeFile(join(outDir, file), `${JSON.stringify(dashboard, null, 2)}\n`);
    console.log(`gerado: ${dashboard.uid}  ->  ${email}`);
  }

  console.log(`${emails.length} dashboard(s) por conta em ${outDir}`);
  if (emails.length === 0) {
    console.log('Nenhuma conta ainda — rode uma sessão Claude e tente de novo.');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
