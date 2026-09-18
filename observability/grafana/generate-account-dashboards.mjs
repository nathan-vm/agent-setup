#!/usr/bin/env node
// Generates one Grafana dashboard per Claude Code account (user_email).
//
// Single source: templates/claude-code.json. This script does NOT duplicate the
// panel logic — it reads the template at runtime and only swaps the uid, the
// title, and whatever is account-specific. The template lives OUTSIDE
// dashboards/ on purpose: that directory is the provisioned one, and a template
// sitting there would show up as one more dashboard with an empty account filter.
//
// Per account it writes one file:
//   accounts/<slug>.json   "Claude Code — <email>"
//
// One file per account and nothing else: there is no "all accounts" dashboard,
// because each account has its own MCP servers, plugins and configuration, and
// the numbers do not add up into anything useful.
//
// Besides pinning the account, it computes two things that cannot be static in
// the template:
//   - the cutlines for the rate panels (P75 and the outlier fence) over the
//     account's own history, ignoring idle periods — LogQL has no quantile over
//     an aggregate, so the computation lives here;
//   - the list of MCP servers and skill owners the account actually used, which
//     become the options of the dashboard's filters.
//
// Usage:
//   node observability/grafana/generate-account-dashboards.mjs
//
// Environment:
//   PROM_URL         Prometheus URL (default http://localhost:47909)
//   LOKI_URL         Loki URL       (default http://localhost:47100)
//   EXPORTER_STREAM  stream the panels read from (must match transcript-exporter)
//
// Grafana provisioning picks the files up on its own. Accounts that disappear
// from the data have their dashboard removed on the next run.

import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROM_URL = process.env.PROM_URL || 'http://localhost:47909';
const LOKI_URL = process.env.LOKI_URL || 'http://localhost:47100';
// Must match the transcript-exporter's EXPORTER_STREAM: it is where the MCP and
// skill panels read from. See the comment at the top of exporter.mjs.
const EXPORTER_STREAM = process.env.EXPORTER_STREAM || 'claude-code-exporter-1';
const here = dirname(fileURLToPath(import.meta.url));
// The template does NOT live in dashboards/: that is the directory Grafana
// provisions, and a template there would become a visible dashboard with an
// empty account filter. Only what this script generates is provisioned.
const templatePath = join(here, 'templates', 'claude-code.json');
const limitsPath = join(here, 'account-limits.json');
const outDir = join(here, 'dashboards', 'accounts');

// Window the rate is measured over. It MUST match the template, otherwise the
// cutlines are computed over a different distribution than the graph draws — a
// 5min burst has a far higher hourly rate than the same activity spread over 1h,
// and the line ends up far too low.
const RATE_WINDOW = '15m';
const RATE_TO_HOUR = 4;
// Used when an account has too little history for statistics of its own.
const CUTLINE_FALLBACK = { p75: 766_008, outlier: 1_721_058 };

function slug(email) {
  return email.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The value goes into a LogQL expression as `user_email =~ \`<value>\``, so the
// email's metacharacters (the dot, mostly) have to stay literal.
function escapeRegex(value) {
  // The backtick is in the set too: values are interpolated inside `...` in
  // LogQL, and a backtick in the middle would close the string, turning the rest
  // of the value into syntax.
  return value.replace(/[.+*?()|[\]{}\\^$`]/g, '\\$&');
}

async function promLabelValues(label) {
  const url = new URL(`/api/v1/label/${label}/values`, PROM_URL);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Prometheus answered ${response.status} at ${url}`);
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

// Cutlines for the rate panels, over the account's last 7 days:
//
//   p75      — above it, the account is in the busiest quarter of its own normal.
//   outlier  — Tukey's upper fence (Q3 + 1.5×IQR). Above it is not "busy", it is
//              atypical.
//
// Idle periods are dropped: including zeros would pull the quantiles down and the
// line would only mean "is using", not "is using a lot".
//
// LogQL has no quantile over an aggregate (you can take a quantile of individual
// values, not of the buckets the graph draws), which is why this lives here.
async function rateCutlines(email, fields = ['input_tokens', 'output_tokens', 'cache_creation_tokens']) {
  const selector = '{service_name="claude-code"} | event_name = `api_request` '
    + `| user_email =~ \`${escapeRegex(email)}\``;
  try {
    // One scan per field, summed here. The "total" used to ask Loki for a fourth
    // expression that re-scanned input and output — already fetched by the
    // individual calls — every cycle, forever. Summing in JS also avoids the case
    // where a field with no samples empties the whole sum in LogQL.
    // stepSeconds = the window: 15min samples taken every 5min overlap and skew
    // the quantile.
    const series = await Promise.all(fields.map((field) => lokiQueryRange(
      `sum(sum_over_time(${selector} | unwrap ${field} [${RATE_WINDOW}]))`,
      { hours: 7 * 24, stepSeconds: 900 },
    )));
    const byInstant = new Map();
    for (const result of series) {
      for (const [ts, value] of result[0]?.values ?? []) {
        byInstant.set(ts, (byInstant.get(ts) ?? 0) + Number(value));
      }
    }
    const values = [...byInstant.values()]
      .map((value) => value * RATE_TO_HOUR)
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    // Too few samples make the quantile meaningless; the fallback is better.
    if (values.length < 20) return { ...CUTLINE_FALLBACK, fallback: true };
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    return { p75: Math.round(q3), outlier: Math.round(q3 + 1.5 * (q3 - q1)) };
  } catch (error) {
    console.error(`cutlines for ${email} unavailable (${error.message}); using defaults`);
    return { ...CUTLINE_FALLBACK, fallback: true };
  }
}

// Skill owners seen on the account. The "owner" is the plugin a skill comes from:
// in "superpowers:brainstorming" the owner is "superpowers"; a skill with no
// prefix is local to the project or the user.
async function skillOwners(email) {
  const expr = `sum by (skill_owner) (count_over_time({service_name="${EXPORTER_STREAM}", kind="skills"} `
    + `| user_email =~ \`${escapeRegex(email)}\` [1h]))`;
  try {
    const result = await lokiQueryRange(expr, { hours: 30 * 24, stepSeconds: 3600 });
    // Values are plain names (the exporter's skill_owner field), never a regex
    // with ":" inside — see the comment in rebuildSkillRecords in the exporter.
    const owners = [...new Set(result.map((series) => series.metric?.skill_owner).filter(Boolean))].sort();
    return owners.map((owner) => ({
      text: owner === 'local' ? 'local (no plugin)' : owner,
      value: escapeRegex(owner),
    }));
  } catch (error) {
    console.error(`skill owners for ${email} unavailable (${error.message})`);
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
    console.error(`MCP servers for ${email} unavailable (${error.message})`);
    return [];
  }
}

// One dashboard per account, and that is it. Each account has its own MCP
// servers, plugins and configuration; a dashboard aggregating all of them mixes
// numbers that do not add up.
function accountVariable(email) {
  const escaped = escapeRegex(email);
  return {
    name: 'account',
    label: 'Account',
    type: 'constant',
    query: escaped,
    current: { text: email, value: escaped },
    hide: 2,
  };
}

// Anthropic's limit varies by plan, so it is per account. See the comments
// inside account-limits.json for the calibration procedure.
async function loadLimits() {
  try {
    return JSON.parse(await readFile(limitsPath, 'utf8'));
  } catch (error) {
    // Missing is normal on a first run. ANY other error (a trailing comma in the
    // JSON, a permission problem) has to abort: treating it as "{}" would
    // silently revert the ignore list and the calibrated limits, and the gauges
    // would start showing wrong percentages with no warning at all.
    if (error.code === 'ENOENT') return {};
    throw new Error(`account-limits.json unreadable (${error.message}). `
      + 'Fix the file: carrying on without it would revert limits and the ignore list.');
  }
}

function limitsFor(limits, email) {
  const fallback = { block_5h: 1_750_000, week: 21_500_000 };
  return { ...fallback, ...(limits.default ?? {}), ...(limits.accounts?.[email] ?? {}) };
}

// Walks EVERY panel, including the ones inside a collapsed row — those live in
// row.panels, not in the top-level list. Forgetting that makes a whole panel stop
// working in silence: the stream placeholder went unreplaced and the query
// reached Loki with a literal "__EXPORTER_STREAM__" in it.
function allPanels(node) {
  const out = [];
  for (const panel of node.panels ?? []) {
    out.push(panel, ...allPanels(panel));
  }
  return out;
}

// Safety net for the bug class above: if ANY placeholder survives, failing loudly
// beats writing a dashboard whose panel queries Loki for a stream name that does
// not exist and shows "No data".
function assertNoPlaceholders(dashboard) {
  const left = allPanels(dashboard).flatMap((panel) =>
    (panel.targets ?? [])
      .filter((target) => /__[A-Z_]+__/.test(target.expr ?? ''))
      .map((target) => `${panel.id}:${target.refId}`));
  if (left.length) {
    throw new Error(`unreplaced placeholder in ${left.join(', ')} `
      + `(dashboard ${dashboard.uid}) — that panel would show no data`);
  }
}

function replaceVariable(dashboard, variable) {
  const list = dashboard.templating?.list ?? (dashboard.templating = { list: [] }).list;
  const index = list.findIndex((entry) => entry.name === variable.name);
  if (index >= 0) list[index] = variable;
  else list.unshift(variable);
}

// Injects the cutlines into the rate panels that draw them. The first step is the
// transparent base and stays untouched; panels without cutlines only have that
// step and are skipped.
function applyCutlines(dashboard, byName) {
  const write = (steps, cutlines) => {
    if (!Array.isArray(steps) || steps.length < 3 || !cutlines) return;
    steps[1] = { ...steps[1], value: cutlines.p75 };
    steps[2] = { ...steps[2], value: cutlines.outlier };
  };
  for (const panel of allPanels(dashboard)) {
    if (panel.type !== 'timeseries') continue;
    // Total panel: cutlines live in defaults.
    write(panel.fieldConfig?.defaults?.thresholds?.steps, byName.total);
    // Input/output panel: each series has its own, in an override.
    for (const override of panel.fieldConfig?.overrides ?? []) {
      const series = override.matcher?.options;
      const property = (override.properties ?? []).find((item) => item.id === 'thresholds');
      if (property) write(property.value?.steps, byName[series]);
    }
  }
}

function scopeAccount(template, email, cutlines, servers, owners, limits) {
  const dashboard = structuredClone(template);
  dashboard.uid = `cc-${slug(email)}`.slice(0, 40);
  dashboard.title = `Claude Code — ${email}`;
  dashboard.description =
    `Account ${email}. Generated from templates/claude-code.json — do not edit by `
    + `hand, run generate-account-dashboards.mjs. `
    + (cutlines.total.fallback
      ? 'Rate cutlines: DEFAULT values (not enough history, or Loki unavailable), '
        + 'not computed from this account.'
      : `Rate cutlines, over this account's last 7 days: P75 `
        + `${cutlines.total.p75.toLocaleString('en-US')} and outlier `
        + `${cutlines.total.outlier.toLocaleString('en-US')} tokens/h.`);
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

  // The server panel's link points at the account's own dashboard. It lives in an
  // override (only on the name column), not in defaults.
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

  // Filters with "All" first and always selected by default: opening the
  // dashboard has to show everything, not some arbitrary item.
  const filter = (name, label, options) => {
    const all = [{ text: 'All', value: '.*' }, ...options];
    return {
      name,
      label,
      type: 'custom',
      query: all.map((option) => `${option.text} : ${option.value}`).join(','),
      options: all.map((option, index) => ({ ...option, selected: index === 0 })),
      current: { ...all[0] },
      includeAll: false,
      multi: false,
      hide: 0,
    };
  };
  replaceVariable(dashboard, filter('server', 'MCP server',
    servers.map((server) => ({ text: server, value: escapeRegex(server) }))));
  replaceVariable(dashboard, filter('owner', 'Skill owner', owners));
  assertNoPlaceholders(dashboard);
  return dashboard;
}

async function main() {
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  const limits = await loadLimits();
  // Accounts on the ignore list get no dashboard. An email only leaves the
  // Prometheus labels when retention expires, so without this a deactivated
  // account would keep showing up with every panel empty.
  const ignore = new Set(limits.ignore ?? []);
  const allEmails = await promLabelValues('user_email');
  const emails = allEmails.filter((email) => {
    if (!ignore.has(email)) return true;
    console.log(`ignored: ${email} ('ignore' list in account-limits.json)`);
    return false;
  });
  await mkdir(outDir, { recursive: true });

  const wanted = new Map();
  for (const email of emails) {
    const [total, input, output, servers, owners] = await Promise.all([
      rateCutlines(email),
      rateCutlines(email, ['input_tokens']),
      rateCutlines(email, ['output_tokens']),
      mcpServers(email),
      skillOwners(email),
    ]);
    const cutlines = { total, input, output };
    const accountLimits = limitsFor(limits, email);
    wanted.set(`${slug(email)}.json`, scopeAccount(template, email, cutlines, servers, owners, accountLimits));
    console.log(
      `${email}  ->  total cutlines P75 ${total.p75.toLocaleString('en-US')}`
      + ` / outlier ${total.outlier.toLocaleString('en-US')} tokens/h`
      + `, ${servers.length} MCP server(s), ${owners.length} skill owner(s)`
      + `, limits ${accountLimits.block_5h.toLocaleString('en-US')}/5h `
      + `and ${accountLimits.week.toLocaleString('en-US')}/week`,
    );
  }

  // Drop dashboards of accounts that no longer have data.
  const existing = (await readdir(outDir).catch(() => [])).filter((file) => file.endsWith('.json'));
  for (const file of existing) {
    if (!wanted.has(file)) {
      await unlink(join(outDir, file));
      console.log(`removed: ${file} (account has no data)`);
    }
  }

  for (const [file, dashboard] of wanted) {
    // Write then rename: Grafana re-reads this directory on its own and could
    // otherwise pick up a JSON truncated mid-write.
    const target = join(outDir, file);
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(dashboard, null, 2)}\n`);
    await rename(tmp, target);
    console.log(`  ${dashboard.uid}  ->  ${file}`);
  }

  console.log(`${wanted.size} dashboard(s), one per account, in ${outDir}`);
  if (emails.length === 0) {
    console.log(allEmails.length
      ? `No dashboard generated: all ${allEmails.length} account(s) with data are on the 'ignore' list.`
      : 'No account yet — run a Claude session and try again.');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
