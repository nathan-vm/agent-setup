#!/usr/bin/env node
// Gera os dashboards por conta (user_email) do Claude Code.
//
// Fonte única: templates/claude-code.json. Este script NÃO duplica a lógica dos
// painéis — lê o template em tempo de execução e só troca uid, título e o que é
// específico da conta. O template fica FORA de dashboards/ de propósito: aquele
// diretório é o provisionado, e um template lá apareceria como um dashboard a
// mais, com filtro de conta vazio.
//
// Por conta ele escreve dois arquivos:
//   accounts/<slug>.json   "Claude Code — <email>"
//
// É um arquivo por conta e nada mais: não existe dashboard "todas as contas",
// porque cada conta tem MCPs, plugins e configuração próprios e os dados não se
// somam de forma útil.
//
// Além de fixar a conta, ele calcula duas coisas que não dá para deixar
// estáticas no mestre:
//   - as linhas de corte do painel de ritmo (P75 e cerca de outlier) sobre o
//     histórico da conta, ignorando períodos parados — o LogQL não calcula
//     quantil de agregado, então o cálculo mora aqui;
//   - a lista de servidores MCP que a conta realmente usou, virando as opções
//     do seletor do dashboard de drill-down.
//
// Uso:
//   node observability/grafana/generate-account-dashboards.mjs
//
// Variáveis de ambiente:
//   PROM_URL  URL do Prometheus (padrão http://localhost:47909)
//   LOKI_URL  URL do Loki       (padrão http://localhost:47100)
//
// Os arquivos são carregados pelo provisioning do Grafana
// (updateIntervalSeconds: 30). Contas que somem dos dados têm os dashboards
// removidos na execução seguinte.

import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROM_URL = process.env.PROM_URL || 'http://localhost:47909';
const LOKI_URL = process.env.LOKI_URL || 'http://localhost:47100';
// Precisa bater com o EXPORTER_STREAM do transcript-exporter: é de onde os
// painéis de MCP e de skill leem. Ver o comentário no topo do exporter.mjs.
const EXPORTER_STREAM = process.env.EXPORTER_STREAM || 'claude-code-exporter-1';
const here = dirname(fileURLToPath(import.meta.url));
// O template NÃO fica em dashboards/: aquele diretório é o que o Grafana
// provisiona, e um template lá viraria um dashboard visível com filtro de conta
// vazio. Só o que este script gera é provisionado.
const templatePath = join(here, 'templates', 'claude-code.json');
const limitsPath = join(here, 'account-limits.json');
const outDir = join(here, 'dashboards', 'accounts');
// Janela em que o ritmo é medido. TEM que ser a mesma do template, senão as
// linhas de corte são calculadas sobre uma distribuição diferente da que o
// gráfico desenha — um pico de 5min tem taxa horária muito maior do que a mesma
// atividade diluída em 1h, e a linha fica baixa demais.
const RATE_WINDOW = '15m';
const RATE_TO_HOUR = 4;
// Usados quando a conta ainda não tem histórico suficiente para estatística própria.
const CUTLINE_FALLBACK = { p75: 766_008, outlier: 1_721_058 };

function slug(email) {
  return email.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// O valor entra numa expressão LogQL como `user_email =~ \`<valor>\``, então os
// metacaracteres do email (o ponto, principalmente) precisam ser literais.
function escapeRegex(value) {
  // O backtick entra junto: os valores são interpolados dentro de `...` no
  // LogQL, e um backtick no meio fecharia a string, fazendo o resto do valor
  // virar sintaxe.
  return value.replace(/[.+*?()|[\]{}\\^$`]/g, '\\$&');
}

async function promLabelValues(label) {
  const url = new URL(`/api/v1/label/${label}/values`, PROM_URL);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Prometheus respondeu ${response.status} em ${url}`);
  const body = await response.json();
  if (body.status !== 'success') throw new Error(`Prometheus status=${body.status}`);
  return [...new Set((body.data || []).filter(Boolean))].sort();
}

async function lokiQueryRange(query, { hours, stepSeconds }) {
  const url = new URL('/loki/api/v1/query_range', LOKI_URL);
  const end = Math.floor(Date.now() / 1000);
  url.searchParams.set('query', query);
  url.searchParams.set('start', String(end - hours * 3600));
  url.searchParams.set('end', String(end));
  url.searchParams.set('step', String(stepSeconds));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Loki ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  if (body.status !== 'success') throw new Error(`Loki status=${body.status}`);
  return body.data?.result ?? [];
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

// Linhas de corte do painel de ritmo, sobre o histórico de 7 dias da conta:
//
//   p75      — acima dela, a conta está no quarto mais intenso do próprio normal.
//   outlier  — cerca superior de Tukey (Q3 + 1,5×IQR). Acima dela não é "intenso",
//              é atípico.
//
// Períodos parados são descartados: incluir zeros puxaria os quantis para baixo e
// a linha passaria a dizer apenas "está usando", não "está usando muito".
//
// Quantil de agregado não existe em LogQL (dá para tirar quantil dos valores
// individuais, não dos baldes que o gráfico desenha), por isso o cálculo é aqui.
async function rateCutlines(email, fields = ['input_tokens', 'output_tokens', 'cache_creation_tokens']) {
  const selector = '{service_name="claude-code"} | event_name = `api_request` '
    + `| user_email =~ \`${escapeRegex(email)}\``;
  try {
    // Um scan por campo, somados aqui. Antes o "total" pedia ao Loki uma quarta
    // expressão que reescaneava entrada e saída — já trazidas pelas chamadas
    // individuais — a cada ciclo, para sempre. Somar no JS também evita o caso
    // em que um campo sem amostra esvazia a soma inteira no LogQL.
    // stepSeconds = a janela: amostras de 15min colhidas de 5 em 5min se
    // sobrepõem e enviesam o quantil.
    const series = await Promise.all(fields.map((field) => lokiQueryRange(
      `sum(sum_over_time(${selector} | unwrap ${field} [${RATE_WINDOW}]))`,
      { hours: 7 * 24, stepSeconds: 900 },
    )));
    const porInstante = new Map();
    for (const result of series) {
      for (const [ts, value] of result[0]?.values ?? []) {
        porInstante.set(ts, (porInstante.get(ts) ?? 0) + Number(value));
      }
    }
    const values = [...porInstante.values()]
      .map((value) => value * RATE_TO_HOUR)
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    // Poucas amostras dão quantil sem significado; melhor o fallback.
    if (values.length < 20) return { ...CUTLINE_FALLBACK, fallback: true };
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    return { p75: Math.round(q3), outlier: Math.round(q3 + 1.5 * (q3 - q1)) };
  } catch (error) {
    console.error(`linhas de corte de ${email} indisponíveis (${error.message}); usando o padrão`);
    return { ...CUTLINE_FALLBACK, fallback: true };
  }
}

// Donos de skill vistos na conta. "Dono" é o plugin que traz a skill: em
// "superpowers:brainstorming" o dono é "superpowers"; skill sem prefixo é local
// do projeto ou do usuário. O valor da opção é um REGEX, porque é assim que o
// painel filtra — assim não precisa de nenhum label novo no dado.
async function skillOwners(email) {
  const expr = `sum by (skill_owner) (count_over_time({service_name="${EXPORTER_STREAM}", kind="skills"} `
    + `| user_email =~ \`${escapeRegex(email)}\` [1h]))`;
  try {
    const result = await lokiQueryRange(expr, { hours: 30 * 24, stepSeconds: 3600 });
    // Valores são nomes simples (o campo skill_owner do exporter), nunca regex
    // com ":" dentro — ver o comentário em rebuildSkillRecords no exporter.
    const donos = [...new Set(result.map((series) => series.metric?.skill_owner).filter(Boolean))].sort();
    return donos.map((dono) => ({
      text: dono === 'local' ? 'locais (sem plugin)' : dono,
      value: escapeRegex(dono),
    }));
  } catch (error) {
    console.error(`donos de skill de ${email} indisponíveis (${error.message})`);
    return [];
  }
}

async function mcpServers(email) {
  const expr = `sum by (mcp_server) (count_over_time({service_name="${EXPORTER_STREAM}", kind="tools"} `
    + `| user_email =~ \`${escapeRegex(email)}\` | tool_source = \`mcp\` [1h]))`;
  try {
    const result = await lokiQueryRange(expr, { hours: 30 * 24, stepSeconds: 3600 });
    return [...new Set(result.map((series) => series.metric?.mcp_server).filter(Boolean))].sort();
  } catch (error) {
    console.error(`servidores MCP de ${email} indisponíveis (${error.message})`);
    return [];
  }
}

// Um dashboard por conta, e só. Cada conta tem MCPs, plugins e configuração
// próprios; um dashboard agregando todas mistura dados que não se somam.
function accountVariable(email) {
  const escaped = escapeRegex(email);
  return {
    name: 'account',
    label: 'Conta',
    type: 'constant',
    query: escaped,
    current: { text: email, value: escaped },
    hide: 2,
  };
}

// O limite da Anthropic varia por plano, então é por conta. Ver os comentários
// dentro de account-limits.json para o procedimento de calibração.
async function loadLimits() {
  try {
    return JSON.parse(await readFile(limitsPath, 'utf8'));
  } catch (error) {
    // Ausente é normal na primeira execução. QUALQUER outro erro (JSON com
    // vírgula sobrando, permissão) tem que abortar: tratar como "{}" reverteria
    // em silêncio a lista de contas ignoradas e os limites calibrados, e as
    // gauges passariam a mostrar percentuais errados sem nenhum aviso.
    if (error.code === 'ENOENT') return {};
    throw new Error(`account-limits.json ilegível (${error.message}). `
      + 'Corrija o arquivo: seguir sem ele reverteria limites e lista de ignorados.');
  }
}

function limitsFor(limits, email) {
  const fallback = { block_5h: 1_750_000, week: 21_500_000 };
  return { ...fallback, ...(limits.default ?? {}), ...(limits.contas?.[email] ?? {}) };
}

// Percorre TODOS os painéis, inclusive os que ficam dentro de uma seção
// fechada — esses moram em row.panels, não na lista de topo. Esquecer disso faz
// um painel inteiro parar de funcionar em silêncio: o placeholder do stream não
// era substituído e a query ia para o Loki com "__EXPORTER_STREAM__" literal.
function allPanels(node) {
  const out = [];
  for (const panel of node.panels ?? []) {
    out.push(panel, ...allPanels(panel));
  }
  return out;
}

// Rede de segurança para a classe de bug acima: se QUALQUER placeholder
// sobreviver, é melhor falhar alto do que escrever um dashboard com um painel
// que consulta o Loki por um nome de stream inexistente e mostra "No data".
function conferirPlaceholders(dashboard) {
  const restantes = allPanels(dashboard).flatMap((panel) =>
    (panel.targets ?? [])
      .filter((target) => /__[A-Z_]+__/.test(target.expr ?? ''))
      .map((target) => `${panel.id}:${target.refId}`));
  if (restantes.length) {
    throw new Error(`placeholder não substituído em ${restantes.join(', ')} `
      + `(dashboard ${dashboard.uid}) — painel ficaria sem dados`);
  }
}

function replaceVariable(dashboard, variable) {
  const list = dashboard.templating?.list ?? (dashboard.templating = { list: [] }).list;
  const index = list.findIndex((entry) => entry.name === variable.name);
  if (index >= 0) list[index] = variable;
  else list.unshift(variable);
}

// Injeta as linhas de corte nos painéis de ritmo que as desenham. O primeiro
// degrau é o base (transparente) e fica intacto; painéis sem linha de corte têm
// só esse degrau e são ignorados.
function applyCutlines(dashboard, byName) {
  const write = (steps, cutlines) => {
    if (!Array.isArray(steps) || steps.length < 3 || !cutlines) return;
    steps[1] = { ...steps[1], value: cutlines.p75 };
    steps[2] = { ...steps[2], value: cutlines.outlier };
  };
  for (const panel of allPanels(dashboard)) {
    if (panel.type !== 'timeseries') continue;
    // Painel do total: linhas em defaults.
    write(panel.fieldConfig?.defaults?.thresholds?.steps, byName.total);
    // Painel de entrada/saída: cada série tem as suas, num override.
    for (const override of panel.fieldConfig?.overrides ?? []) {
      const serie = override.matcher?.options;
      const property = (override.properties ?? []).find((item) => item.id === 'thresholds');
      if (property) write(property.value?.steps, byName[serie]);
    }
  }
}

function scopeAccount(template, email, cutlines, servers, owners, limits) {
  const dashboard = structuredClone(template);
  dashboard.uid = `cc-${slug(email)}`.slice(0, 40);
  dashboard.title = `Claude Code — ${email}`;
  dashboard.description =
    `Conta ${email}. Gerado a partir de templates/claude-code.json — não edite à mão, `
    + `rode generate-account-dashboards.mjs. Linhas de corte do ritmo, sobre os `
    + `últimos 7 dias desta conta: P75 ${cutlines.total.p75.toLocaleString('pt-BR')} e `
    + `outlier ${cutlines.total.outlier.toLocaleString('pt-BR')} tokens/h.`;
  replaceVariable(dashboard, accountVariable(email));
  applyCutlines(dashboard, cutlines);

  for (const panel of allPanels(dashboard)) {
    for (const target of panel.targets ?? []) {
      if (target.expr) target.expr = target.expr.replaceAll('__EXPORTER_STREAM__', EXPORTER_STREAM);
    }
  }

  for (const [name, value] of [['limit_tokens_5h', limits.block_5h],
                               ['limit_tokens_week', limits.week]]) {
    replaceVariable(dashboard, {
      name, type: 'textbox', hide: 2,
      query: String(value), current: { text: String(value), value: String(value) },
    });
  }

  // O link do painel de servidores aponta para o próprio dashboard da conta.
  // Ele vive num override (só na coluna do nome), não em defaults.
  for (const panel of allPanels(dashboard)) {
    const linkLists = [
      panel.fieldConfig?.defaults?.links,
      ...(panel.fieldConfig?.overrides ?? []).flatMap((override) =>
        (override.properties ?? [])
          .filter((property) => property.id === 'links')
          .map((property) => property.value)),
    ];
    for (const links of linkLists) {
      for (const link of links ?? []) {
        if (link.url?.includes('__DASHBOARD__')) {
          link.url = link.url.replace('__DASHBOARD__', dashboard.uid);
        }
      }
    }
  }

  // Filtros com "Todos" na frente e sempre selecionado por padrão: abrir o
  // dashboard tem que mostrar tudo, não um item arbitrário.
  const filtro = (name, label, options) => {
    const todas = [{ text: 'Todos', value: '.*' }, ...options];
    return {
      name,
      label,
      type: 'custom',
      query: todas.map((option) => `${option.text} : ${option.value}`).join(','),
      options: todas.map((option, index) => ({ ...option, selected: index === 0 })),
      current: { ...todas[0] },
      includeAll: false,
      multi: false,
      hide: 0,
    };
  };
  replaceVariable(dashboard, filtro('server', 'Servidor MCP',
    servers.map((server) => ({ text: server, value: escapeRegex(server) }))));
  replaceVariable(dashboard, filtro('owner', 'Dono da skill', owners));
  conferirPlaceholders(dashboard);
  return dashboard;
}

async function main() {
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  const limits = await loadLimits();
  // Contas na lista de ignorados não geram dashboard. Um email só some dos
  // labels do Prometheus quando a retenção expira, então sem isso uma conta
  // desativada continuaria aparecendo com todos os painéis vazios.
  const ignorar = new Set(limits.ignorar ?? []);
  const todosEmails = await promLabelValues('user_email');
  const emails = todosEmails.filter((email) => {
    if (!ignorar.has(email)) return true;
    console.log(`ignorado: ${email} (lista 'ignorar' em account-limits.json)`);
    return false;
  });
  await mkdir(outDir, { recursive: true });

  const wanted = new Map();
  for (const email of emails) {
    const [total, entrada, saida, servers, owners] = await Promise.all([
      rateCutlines(email),
      rateCutlines(email, ['input_tokens']),
      rateCutlines(email, ['output_tokens']),
      mcpServers(email),
      skillOwners(email),
    ]);
    const cutlines = { total, entrada, 'saída': saida };
    const accountLimits = limitsFor(limits, email);
    wanted.set(`${slug(email)}.json`, scopeAccount(template, email, cutlines, servers, owners, accountLimits));
    console.log(
      `${email}  ->  corte total P75 ${total.p75.toLocaleString('pt-BR')}`
      + ` / outlier ${total.outlier.toLocaleString('pt-BR')} tokens/h`
      + `, ${servers.length} servidor(es) MCP, ${owners.length} dono(s) de skill`
      + `, limites ${accountLimits.block_5h.toLocaleString('pt-BR')}/5h `
      + `e ${accountLimits.week.toLocaleString('pt-BR')}/semana`,
    );
  }

  // Remove dashboards de contas que não têm mais dados.
  const existing = (await readdir(outDir).catch(() => [])).filter((file) => file.endsWith('.json'));
  for (const file of existing) {
    if (!wanted.has(file)) {
      await unlink(join(outDir, file));
      console.log(`removido: ${file} (conta sem dados)`);
    }
  }

  for (const [file, dashboard] of wanted) {
    // Escreve e renomeia: o Grafana relê este diretório por conta própria e
    // poderia pegar um JSON truncado no meio da escrita.
    const destino = join(outDir, file);
    const tmp = `${destino}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(dashboard, null, 2)}\n`);
    await rename(tmp, destino);
    console.log(`  ${dashboard.uid}  ->  ${file}`);
  }

  console.log(`${wanted.size} dashboard(s), um por conta, em ${outDir}`);
  if (emails.length === 0) {
    console.log(todosEmails.length
      ? `Nenhum dashboard gerado: as ${todosEmails.length} conta(s) com dados estão na lista 'ignorar'.`
      : 'Nenhuma conta ainda — rode uma sessão Claude e tente de novo.');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
