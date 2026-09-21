#!/usr/bin/env node
// Exports Claude Code tool calls from the local transcripts into Loki.
//
// WHY THIS EXISTS
// Claude Code redacts the names of locally configured MCP servers across ALL of
// its OTel telemetry: in the Prometheus metrics `mcp_server_name` becomes
// "custom", and since 2.1.x the `tool_result` log also redacts `tool_name` to
// "mcp_tool". The result: ~85% of MCP token spend lands in one anonymous bucket.
// The local transcripts (`<config>/projects/<slug>/<session>.jsonl`) keep the
// real name (mcp__<server>__<tool>), so they are the only possible source for
// attributing tokens per MCP server/tool.
//
// WHAT IT EMITS
// One Loki line per `tool_use` block, with the real tool name and the tokens
// attributed to it. The `request_id` matches 1:1 the `request_id` attribute of
// the `api_request` event Claude Code sends over OTel, so both sides can be
// joined.
//
// HOW TOKENS ARE ATTRIBUTED
// A tool's cost is what the model paid to READ its result: the input side
// (input_tokens + cache_creation_input_tokens) of the NEXT assistant message on
// the same track. With several tools called in parallel from one message, that
// total is split proportionally to each result's size. `cache_read` is left out
// on purpose: what matters is the marginal cost of the call, not its drag on the
// turns that follow.
//
// Usage:
//   node exporter.mjs            # runs in a loop
//   node exporter.mjs --once     # a single pass, then exit
//   node exporter.mjs --dry-run  # writes neither to Loki nor to the state file
//   node exporter.mjs --rescan   # re-reads the transcripts from scratch, keeping
//                                # the dedup map (to generate a new record type
//                                # out of existing history)

import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { publishUsage } from './usage-meter.mjs';
import { publishRate } from './rate-meter.mjs';
import { join, dirname, basename } from 'node:path';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const PROJECTS_DIR = process.env.TRANSCRIPTS_DIR || join(CONFIG_DIR, 'projects');
const LOKI_URL = process.env.LOKI_URL || 'http://localhost:47100';
const STATE_FILE = process.env.STATE_FILE || join(CONFIG_DIR, '.transcript-exporter-state.json');
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 30);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 2000);
// A pending group with no "next assistant message" after this long is treated as
// orphaned (session ended mid-turn) and goes out with zero attribution.
const ORPHAN_AFTER_MS = Number(process.env.ORPHAN_AFTER_MS || 15 * 60 * 1000);
// How long to remember an already-exported tool_use_id, so a resumed session is
// not counted twice (see dedup below). Aligned with Loki's retention.
const DEDUP_DAYS = Number(process.env.DEDUP_DAYS || 90);
// Reset do limite semanal da Anthropic: dia da semana (0=domingo) e hora local.
// Varia por conta; ajuste se o seu /usage discordar.
const WEEK_START_DAY = Number(process.env.WEEK_START_DAY || 1);
const WEEK_START_HOUR = Number(process.env.WEEK_START_HOUR || 0);
const TZ_OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS || -3);
// Smoothing of the consumption-rate panel. 20min was the best trade-off on real
// data: 1h was so sluggish that 25min after stopping the curve still read 80% of
// its peak, while the raw boxcar it replaces fell 30x in a single step.
//
// ONE variable, in one format, shared with dashboard-generator through .env — it
// also ends up as a stream label, and the generator needs the identical string to
// query the series it computes cutlines from.
const RATE_HALFLIFE = process.env.RATE_HALFLIFE || '20m';
const RATE_HALFLIFE_S = (() => {
  const match = /^(\d+)([smh])$/.exec(RATE_HALFLIFE);
  if (!match) throw new Error(`RATE_HALFLIFE must look like 20m, 90s or 2h (got "${RATE_HALFLIFE}")`);
  return Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2]];
})();
// How far back the rate series is rebuilt on a first run. Loki here accepts old
// samples on purpose (reject_old_samples: false), so the panel has history from
// day one instead of filling in only going forward.
const RATE_BACKFILL_DAYS = Number(process.env.RATE_BACKFILL_DAYS || 14);
// Lookback window for resolving a session's account. A stock Loki refuses queries
// longer than 30d (max_query_length); this stack's loki-config.yaml lifts that
// cap, but the default here stays safe for a Loki without it.
const EMAIL_LOOKBACK_HOURS = Number(process.env.EMAIL_LOOKBACK_HOURS || 720);

const ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');
// NON-destructive re-read: zeroes the per-file offsets but keeps the dedup map.
// Use it to generate a new record type (e.g. tokens per skill) out of existing
// history without rewriting what was already exported — dedup blocks what is
// already there and lets through only what is genuinely new.
const RESCAN = process.argv.includes('--rescan');
// Name of the stream this exporter writes to. It is VERSIONED on purpose.
//
// Loki cannot replace derived data: the delete API marks a time window and then
// filters it at query time, and a request that has already been processed can no
// longer be removed — any reimport carrying historical timestamps falls inside
// that window and is invisible FOREVER. Learned the hard way.
//
// So reimporting means writing under a new name. Bump EXPORTER_STREAM in .env
// (the same value goes to dashboard-generator, which points the panels at it) and
// the exporter rebuilds from scratch. The old generation is orphaned and ages out
// on its own with the 90d retention.
const STREAM = process.env.EXPORTER_STREAM || 'claude-code-exporter-1';
const STREAM_LABELS = { service_name: STREAM, kind: 'tools' };
// Segundo stream: tokens por skill com o nome REAL. O Claude Code redige skill de
// plugin para "third-party" no api_request, igual faz com MCP — numa conta que só
// usa skills de plugin, o painel inteiro colapsa numa linha só. O nome real está
// no input do tool_use "Skill" dentro do transcript.
const SKILL_STREAM_LABELS = { service_name: STREAM, kind: 'skills' };

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------- estado

const emptyState = () => ({
  version: 2, files: {}, sessionEmail: {}, seen: {}, otelSkills: {}, ratePublished: {},
  // sessionId -> [real plugin skill names]. This MUST survive across passes: the
  // transcript line that reveals the real name is read exactly once, but that
  // session's OTel events keep arriving for days. Without persisting it, every
  // later pass labelled those requests "third-party" — and dedup by request_id
  // then locks the wrong name in forever.
  pluginSkills: {},
});

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    // v1 had no `seen` map. Migrate rather than discard: starting over re-reads
    // every transcript and duplicates everything already in Loki.
    if (parsed?.version === 1 || parsed?.version === 2) {
      return { ...emptyState(), ...parsed, version: 2 };
    }
    log(`state has an unexpected version (${parsed?.version}); starting from scratch`);
  } catch (error) {
    if (error.code !== 'ENOENT') log(`state unreadable (${error.message}); starting from scratch`);
  }
  return emptyState();
}

async function saveState(state) {
  if (DRY_RUN) return;
  await mkdir(dirname(STATE_FILE), { recursive: true });
  // Write to a temp file and rename: a kill mid-write then cannot leave a
  // truncated state that would make the exporter reprocess everything.
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, STATE_FILE);
}

// ---------------------------------------------------------- transcripts

// RECURSIVE scan, from a root that may hold several config directories mounted
// side by side. Two things the previous version missed:
//
//   - subagent transcripts, which live in <session>/subagents/*.jsonl, one level
//     deeper than it looked;
//   - a second config directory (e.g. ~/.claude-work next to ~/.claude-personal),
//     which is what you get when accounts are split by context.
//
// This was expensive to find: 331 calls from a single MCP server were missing.
async function findTranscripts(dir = PROJECTS_DIR, depth = 0) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (depth === 0) log(`transcript directory does not exist: ${dir}`);
      return found;
    }
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 6) found.push(...await findTranscripts(full, depth + 1));
    } else if (entry.name.endsWith('.jsonl')) {
      found.push(full);
    }
  }
  return found;
}

function parseToolName(name) {
  // mcp__<server>__<tool>. The tool name itself may contain "__", so split only
  // on the first two occurrences.
  if (!name?.startsWith('mcp__')) return { toolSource: 'builtin', mcpServer: '', mcpTool: '' };
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return { toolSource: 'mcp', mcpServer: rest, mcpTool: '' };
  return { toolSource: 'mcp', mcpServer: rest.slice(0, sep), mcpTool: rest.slice(sep + 2) };
}

// Names every sub-command in a Bash `command` string, so `git status && ls -la`
// attributes tokens to both `git` and `ls`, not just the first. Not a full shell
// parser — a best-effort split on top-level separators is enough for
// classification and keeps this from growing into a shell grammar.
//
// The `rtk` PreToolUse hook installed on this machine rewrites recognized
// commands before they execute (`git status` -> `rtk git status`), and
// sometimes remaps them entirely (`cat file` -> `rtk read file`). Without
// stripping that prefix, almost every Bash call would misclassify as "rtk"
// instead of the command it actually ran. A command rtk left untouched
// (unrecognized, or already prefixed) is used as-is.
function extractBashCommands(commandStr) {
  if (!commandStr) return [];
  const segments = commandStr.split(/&&|\|\||;|\|/);
  const names = [];
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // skip leading env-var assignments, e.g. `FOO=bar git status`
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
    if (i >= tokens.length) continue;
    let name = tokens[i];
    if (name === 'rtk' && i + 1 < tokens.length) name = tokens[i + 1];
    if (name) names.push(name);
  }
  return names;
}

function blockSize(block) {
  const content = block?.content;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (typeof part === 'string') return sum + part.length;
      if (part?.type === 'text') return sum + (part.text?.length || 0);
      return sum + JSON.stringify(part ?? '').length;
    }, 0);
  }
  return JSON.stringify(content ?? '').length;
}

// One call's share of the group's input tokens, and the meta fields every
// record for that call shares regardless of how many rows it fans out into.
function attribute(call, group, inputTokens, total) {
  const tokensAttributed = Math.round(
    total > 0 ? (inputTokens * call.resultBytes) / total : inputTokens / group.calls.length,
  );
  return {
    session_id: group.sessionId,
    request_id: group.requestId,
    tool_use_id: call.toolUseId,
    tool_name: call.toolName,
    tool_source: call.toolSource,
    model: group.model,
    effort: group.effort,
    query_source: group.isSidechain ? 'subagent' : 'main',
    git_branch: group.gitBranch,
    project: group.project,
    result_bytes: String(call.resultBytes),
    // Proportional split. With no result bytes at all (every result empty),
    // split evenly so the total is not lost.
    tokens_attributed: String(tokensAttributed),
  };
}

// Attributes the input tokens of the next assistant message to the tools called
// in the group, proportionally to each one's result size.
//
// A Bash call with recognized sub-commands fans out into one row per
// occurrence, reusing the mcp_server/mcp_tool slot (mcp_server="bash",
// mcp_tool=<command>) so it joins the same breakdown table MCP calls already
// populate, instead of needing a panel of its own. Known tradeoff: a compound
// line like `git status && ls` attributes the WHOLE call's tokens to both
// `git` and `ls`, not a split between them — token cost belongs to the LLM
// turn, not to an individual shell command within it, so this is treated as
// an acceptable approximation rather than something worth a proportional
// split of its own.
function settle(group, inputTokens) {
  const total = group.calls.reduce((sum, call) => sum + call.resultBytes, 0);
  return group.calls.flatMap((call) => {
    const timestampNs = `${Date.parse(call.timestamp)}000000`;
    const meta = attribute(call, group, inputTokens, total);
    if (!call.bashCommands?.length) {
      return [{
        timestampNs,
        line: call.toolName,
        meta: { ...meta, mcp_server: call.mcpServer, mcp_tool: call.mcpTool },
      }];
    }
    return call.bashCommands.map((name, i) => ({
      timestampNs,
      line: call.toolName,
      // Distinct per occurrence: settle() can emit several rows for the same
      // tool_use_id, and dedup keys on that id otherwise.
      dedupKey: `bash:${call.toolUseId}:${i}`,
      meta: { ...meta, mcp_server: 'bash', mcp_tool: name },
    }));
  });
}

// Reads a transcript from the stored offset and returns the finished records.
// `pending` carries, across runs, the groups still waiting for the next assistant
// message — without it a tool_use landing on a poll boundary would be orphaned.
async function processTranscript(path, fileState, pluginSkills) {
  const records = [];
  // Pending groups are kept per track: the main thread must not be settled by a
  // subagent's first message, which is a different conversation.
  const pending = { main: fileState.pending?.main ?? null, sub: fileState.pending?.sub ?? null };
  // Active skill per track. It holds from the "Skill" tool call until the next one
  // — the same behaviour Claude Code uses for skill_name on api_request, where one
  // skill marks hundreds of consecutive requests.
  const activeSkill = { main: fileState.activeSkill?.main ?? '', sub: fileState.activeSkill?.sub ?? '' };
  let offset = fileState.offset ?? 0;

  const { size } = await stat(path);
  if (size < offset) {
    // File shrank: it was truncated or replaced. Start over.
    log(`${basename(path)} shrank (${size} < ${offset}); re-reading from the start`);
    offset = 0;
    pending.main = pending.sub = null;
    activeSkill.main = activeSkill.sub = '';
  }
  // activeSkill has to come back here too: this is the most common path (file with
  // nothing new between polls), and omitting it erased the remembered active skill,
  // dropping attribution back to "third-party".
  if (size === offset) return { records, offset, pending, activeSkill };

  const stream = createReadStream(path, { start: offset, encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let consumed = 0;
  let pendente = 0;

  for await (const line of lines) {
    // readline yields the last line even without a trailing "\n" — which is the
    // normal case here, since Claude Code writes to these files concurrently.
    // Counting the "\n" before knowing it exists left the offset 1 byte ahead of
    // the file, and the first byte of whatever got written next was skipped: that
    // whole entry was lost, silently.
    //
    // So a line's length stays "pending" and only becomes offset once the NEXT
    // line arrives, which proves the previous one ended in "\n".
    consumed += pendente;
    pendente = Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim()) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // linha parcial ou corrompida; a próxima passada pega
    }

    const message = entry.message;
    if (!message || typeof message !== 'object') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const track = entry.isSidechain ? 'sub' : 'main';

    if (entry.type === 'assistant') {
      const usage = message.usage;
      // A plugin skill seen in this session. It does not become a record: the
      // skill numbers come from OTel (see rebuildSkillRecords). All that is noted
      // here is the real name, which is exactly what OTel redacts.
      if (entry.sessionId && activeSkill[track]?.includes(':')) {
        (pluginSkills[entry.sessionId] ??= new Set()).add(activeSkill[track]);
      }
      if (usage && pending[track]) {
        const inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        records.push(...settle(pending[track], inputTokens));
        pending[track] = null;
      }
      const calls = content
        .filter((block) => block?.type === 'tool_use')
        .map((block) => ({
          toolUseId: block.id || '',
          toolName: block.name || '',
          resultBytes: 0,
          timestamp: entry.timestamp,
          bashCommands: block.name === 'Bash' ? extractBashCommands(block.input?.command) : [],
          ...parseToolName(block.name),
        }));
      // A chamada do tool "Skill" traz o nome real no input.
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === 'Skill' && block.input?.skill) {
          activeSkill[track] = String(block.input.skill);
        }
      }
      if (calls.length) {
        pending[track] = {
          sessionId: entry.sessionId || '',
          requestId: entry.requestId || '',
          model: message.model || '',
          effort: entry.perTurnEffort || entry.effort || '',
          gitBranch: entry.gitBranch || '',
          project: entry.cwd ? basename(entry.cwd) : '',
          isSidechain: Boolean(entry.isSidechain),
          at: Date.parse(entry.timestamp) || Date.now(),
          calls,
        };
      }
    } else if (entry.type === 'user' && pending[track]) {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        const call = pending[track].calls.find((candidate) => candidate.toolUseId === block.tool_use_id);
        if (call) call.resultBytes = blockSize(block);
      }
    }
  }

  return { records, offset: offset + consumed, pending, activeSkill };
}

// ------------------------------------------------------------------ Loki

async function lokiQuery(path, params) {
  const url = new URL(path, LOKI_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Loki ${response.status} em ${path}: ${(await response.text()).slice(0, 200)}`);
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

// Transcripts do not record the account. The api_request event Claude Code sends
// over OTel does, and shares the session_id — so the account comes from there,
// once per session. Without it the MCP panel could not filter by account.
async function resolveEmails(state, sessionIds) {
  const missing = sessionIds.filter((id) => id && !state.sessionEmail[id]);
  if (!missing.length) return;
  const end = Date.now() * 1e6;
  const start = end - EMAIL_LOOKBACK_HOURS * 3600 * 1e9;
  for (const sessionId of missing) {
    try {
      const body = await lokiQuery('/loki/api/v1/query_range', {
        query: `{service_name="claude-code"} | session_id = \`${sessionId}\` | user_email != \`\``,
        start: String(start),
        end: String(end),
        limit: '1',
        direction: 'backward',
      });
      const email = body?.data?.result?.[0]?.stream?.user_email;
      // Mark as resolved even when nothing was found, otherwise every pass
      // re-queries sessions that never sent OTel telemetry at all.
      state.sessionEmail[sessionId] = email || '';
    } catch (error) {
      log(`could not resolve the account for session ${sessionId.slice(0, 8)}: ${error.message}`);
    }
  }
}

// Rebuilds the `seen` map from what is already in Loki. Runs when the map is
// empty but exported data exists: an upgrade from an old state, a lost state
// volume, or someone deleting the file. Without it, any of those would reimport
// the whole history on top of what is already there.
async function seedSeenFromLoki(state) {
  const windowMs = DEDUP_DAYS * 24 * 3600 * 1000;
  const step = 24 * 3600 * 1000; // one day per query, to stay under the line limit
  let total = 0;
  for (let offset = 0; offset < windowMs; offset += step) {
    const end = Date.now() - offset;
    const start = end - step;
    let body;
    try {
      body = await lokiQuery('/loki/api/v1/query_range', {
        query: `{service_name="${STREAM}"}`,
        start: String(start * 1e6),
        end: String(end * 1e6),
        limit: '5000',
        direction: 'backward',
      });
    } catch (error) {
      // "continue", not "return": aborting everything on the first error left the
      // remaining days unseeded, and the startup guard never allows another try —
      // those calls would come back as genuine duplicates.
      log(`janela de semeadura falhou (${error.message}); seguindo para a próxima`);
      continue;
    }
    for (const stream of body?.data?.result ?? []) {
      const id = stream.stream?.tool_use_id;
      if (!id) continue;
      for (const [timestampNs] of stream.values ?? []) {
        state.seen[id] = Math.round(Number(timestampNs) / 1e6);
        total += 1;
      }
    }
  }
  if (total) log(`dedup seeded with ${Object.keys(state.seen).length} call(s) already in Loki`);
}

// Sessions older than this stack have no OTel event, so session_id cannot resolve
// the account. The project can: if every ALREADY-attributed session of a directory
// belongs to the same account, the orphans from that directory belong to it too.
// It only attributes when there is no ambiguity — a project with two accounts is
// left alone. Measured on this machine: recovers ~82% of orphaned lines, 0
// ambiguous.
//
// `batch` is the set being exported right now. Without it a from-scratch import
// never infers anything: the map would come only from what is already in Loki,
// which is empty precisely because this is the first import.
async function projectOwners(lokiUrl, batch = []) {
  const owners = new Map();
  const end = Date.now();
  const start = end - DEDUP_DAYS * 24 * 3600 * 1000;
  let body;
  try {
    body = await lokiQuery('/loki/api/v1/query_range', {
      query: `{service_name="${STREAM}", kind="tools"}`,
      start: String(start * 1e6),
      end: String(end * 1e6),
      limit: '5000',
      direction: 'backward',
    });
  } catch (error) {
    log(`Loki history unavailable for the project->account map (${error.message});`
      + ' using only the current batch');
    body = null;
  }
  const seen = new Map();
  const note = (project, email) => {
    if (!project || !email) return;
    if (!seen.has(project)) seen.set(project, new Set());
    seen.get(project).add(email);
  };
  for (const stream of body?.data?.result ?? []) {
    note(stream.stream?.project, stream.stream?.user_email);
  }
  for (const record of batch) note(record.meta.project, record.meta.user_email);
  for (const [project, emails] of seen) {
    if (emails.size === 1) owners.set(project, [...emails][0]);
  }
  return owners;
}

// The per-skill numbers come from OTel, not from the transcript.
//
// The opposite was tried first and was wrong: the transcript does not mirror OTel
// (subagents and rotated sessions never show up in it), and a skill can be
// activated proactively, with no "Skill" tool call — measured, transcript-based
// attribution was off by -87% on one skill and -100% on two others.
//
// So this step re-reads from Loki the requests OTel tagged with a skill and
// republishes them with ONE adjustment: Claude Code replaces a PLUGIN skill's
// name with "third-party", and the transcript knows what it was. That is what
// makes the skills panel reconcile exactly with the weekly breakdown table, which
// reads the same source.
async function rebuildSkillRecords(state, pluginSkills, fullHistory) {
  const out = [];
  // Scans OTel directly rather than the session list from the transcripts: not
  // every session has a transcript on this machine (another config dir, a rotated
  // file), and going session by session lost two thirds of the volume.
  const days = fullHistory ? DEDUP_DAYS : 2;
  const LIMIT = 5000;

  // Loki caps the response at an entry limit, and a saturated window comes back
  // truncated in silence — that is how 39% of the volume went missing. When a
  // window saturates it is split in half and retried.
  async function fetchWindow(start, end, depth = 0) {
    let body;
    try {
      body = await lokiQuery('/loki/api/v1/query_range', {
        query: '{service_name="claude-code"} | event_name = `api_request` | skill_name != ``',
        start: String(start * 1e6),
        end: String(end * 1e6),
        limit: String(LIMIT),
      });
    } catch (error) {
      log(`OTel skills unavailable for that window: ${error.message}`);
      return [];
    }
    const streams = body?.data?.result ?? [];
    const total = streams.reduce((sum, stream) => sum + (stream.values?.length ?? 0), 0);
    if (total >= LIMIT && end - start > 60_000 && depth < 12) {
      const meio = Math.floor((start + end) / 2);
      return [...await fetchWindow(start, meio, depth + 1),
              ...await fetchWindow(meio, end, depth + 1)];
    }
    return streams;
  }

  const step = 24 * 3600 * 1000;
  for (let offset = 0; offset < days * step; offset += step) {
    const end = Date.now() - offset;
    const streams = await fetchWindow(end - step, end);
    for (const stream of streams) {
      const meta = stream.stream ?? {};
      const sessionId = meta.session_id || '';
      // "third-party" can only be undone when the session used exactly one plugin
      // skill — with two, there is no way to tell which is which.
      const candidatos = pluginSkills[sessionId];
      const real = candidatos?.size === 1 ? [...candidatos][0] : null;
      const skill = meta.skill_name === 'third-party' && real ? real : (meta.skill_name || '');
      if (!skill || !meta.request_id) continue;
      // "owner" as a field of its own, rather than letting the dashboard filter by
      // regex over the name. A Grafana filter's options are serialized into a
      // comma-separated "text : value" string, and a value containing ":" (which
      // "superpowers:.*" does) is truncated when re-parsed — the filter then
      // matched nothing at all.
      const dono = skill.includes(':') ? skill.split(':')[0] : 'local';
      for (const [timestampNs] of stream.values ?? []) {
        out.push({
          stream: SKILL_STREAM_LABELS,
          dedupKey: `skill:${meta.request_id}`,
          timestampNs,
          line: skill,
          meta: {
            skill,
            skill_owner: dono,
            session_id: sessionId,
            request_id: meta.request_id,
            model: meta.model || '',
            effort: meta.effort || '',
            query_source: meta.query_source || '',
            project: '',
            tokens: String(
              Number(meta.input_tokens || 0)
              + Number(meta.output_tokens || 0)
              + Number(meta.cache_creation_tokens || 0),
            ),
            user_email: meta.user_email || '',
            account_source: 'otel',
          },
        });
      }
    }
  }
  return out;
}

async function pushToLoki(records) {
  if (!records.length || DRY_RUN) return;
  // Ordena por timestamp antes de empurrar. O Loki rejeita escrita muito fora de
  // ordem dentro de um stream, e o backfill inicial varre vários arquivos que se
  // intercalam no tempo.
  const ordered = [...records].sort((a, b) => Number(BigInt(a.timestampNs) - BigInt(b.timestampNs)));
  for (let i = 0; i < ordered.length; i += BATCH_SIZE) {
    const chunk = ordered.slice(i, i + BATCH_SIZE);
    // Records go to different streams (tools and skills), so group by stream
    // before building the payload.
    const byStream = new Map();
    for (const record of chunk) {
      const labels = record.stream ?? STREAM_LABELS;
      const key = JSON.stringify(labels);
      if (!byStream.has(key)) byStream.set(key, { stream: labels, values: [] });
      byStream.get(key).values.push([record.timestampNs, record.line, record.meta]);
    }
    const payload = { streams: [...byStream.values()] };
    // On a cold start Loki accepts the connection before the ingester is ready and
    // answers "empty ring". Its image has no shell utilities for a compose
    // healthcheck, so the waiting happens here.
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      const response = await fetch(new URL('/loki/api/v1/push', LOKI_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));
      if (response.ok) { lastError = null; break; }
      lastError = `push falhou ${response.status}: ${(await response.text()).slice(0, 200)}`;
      // 4xx means an invalid payload: retrying will not help.
      if (response.status >= 400 && response.status < 500) break;
    }
    if (lastError) throw new Error(lastError);
  }
}

// ------------------------------------------------------------------ loop

// Resuming a session (`claude --resume`, a fork) makes Claude Code rewrite the
// entire history into a NEW transcript: same request_id, same tool_use_id, same
// timestamp, only session_id differs. Without filtering that, every resume counts
// the original session's tools again and inflates the attribution.
// tool_use_id is unique per real call, so that is the key.
function dropAlreadySeen(state, records) {
  const cutoff = Date.now() - DEDUP_DAYS * 24 * 3600 * 1000;
  for (const id of Object.keys(state.seen)) {
    if (state.seen[id] < cutoff) delete state.seen[id];
  }
  const fresh = [];
  const novos = new Map();
  for (const record of records) {
    const id = record.dedupKey || record.meta.tool_use_id;
    if (!id) { fresh.push(record); continue; }
    if (state.seen[id] || novos.has(id)) continue;
    novos.set(id, Math.round(Number(record.timestampNs) / 1e6));
    fresh.push(record);
  }
  return { fresh, novos };
}

async function runPass(state) {
  // Must be read BEFORE processing the transcripts: processing them populates
  // state.files, and the full-history scan then believed it was an incremental
  // pass — silently, only the last 2 days made it in.
  const primeiraPassada = Object.keys(state.files).length === 0;
  const files = await findTranscripts();
  const collected = [];
  // Offset advances and dedup marks stay here until the push succeeds. They used
  // to be applied straight onto `state`; with Loki down, the in-memory object had
  // already moved on and those records were never re-read for as long as the
  // process lived — a silent, permanent loss.
  const atualizacoes = new Map();
  // sessionId -> Set(nomes reais). Semeado do estado persistido e devolvido para
  // ele no fim da passada.
  const pluginSkills = {};
  for (const [sessionId, nomes] of Object.entries(state.pluginSkills ?? {})) {
    pluginSkills[sessionId] = new Set(nomes);
  }

  for (const path of files) {
    const fileState = state.files[path] ?? { offset: 0, pending: null, activeSkill: null };
    try {
      const { records, offset, pending, activeSkill } = await processTranscript(path, fileState, pluginSkills);

      // A pending group this old means a session that ended with no assistant
      // reply. It goes out with zero attribution so it does not vanish from the
      // counts.
      for (const track of ['main', 'sub']) {
        const group = pending[track];
        if (group && Date.now() - group.at > ORPHAN_AFTER_MS) {
          records.push(...settle(group, 0));
          pending[track] = null;
        }
      }

      collected.push(...records);
      // Held aside: it only enters the state once the push confirms.
      atualizacoes.set(path, { offset, pending, activeSkill });
    } catch (error) {
      log(`failed reading ${basename(path)}: ${error.message}`);
    }
  }

  collected.push(...await rebuildSkillRecords(state, pluginSkills, primeiraPassada));

  const { fresh, novos: novosVistos } = dropAlreadySeen(state, collected);
  const skipped = collected.length - fresh.length;
  if (skipped) log(`${skipped} call(s) skipped: already exported (resumed session)`);
  const confirmar = () => {
    for (const [path, st] of atualizacoes) state.files[path] = st;
    for (const [id, ts] of novosVistos) state.seen[id] = ts;
    for (const [sessionId, nomes] of Object.entries(pluginSkills)) {
      state.pluginSkills[sessionId] = [...nomes];
    }
  };
  if (!fresh.length) {
    // Nothing new to write, but the file offsets did move forward.
    if (collected.length) { confirmar(); await saveState(state); }
    return 0;
  }
  collected.length = 0;
  collected.push(...fresh);

  await resolveEmails(state, [...new Set(collected.map((record) => record.meta.session_id))]);
  for (const record of collected) {
    if (record.meta.user_email) continue; // skill records already carry the account from OTel
    record.meta.user_email = state.sessionEmail[record.meta.session_id] || '';
    record.meta.account_source = record.meta.user_email ? 'otel' : '';
  }

  // Second attempt for what OTel could not resolve: the project's owner.
  if (collected.some((record) => !record.meta.user_email)) {
    const owners = await projectOwners(LOKI_URL, collected);
    for (const record of collected) {
      if (record.meta.user_email) continue;
      const owner = owners.get(record.meta.project);
      if (!owner) continue;
      record.meta.user_email = owner;
      // Marked so it stays auditable: this account was inferred, not observed.
      record.meta.account_source = 'project';
    }
  }

  if (DRY_RUN) summarize(collected);
  await pushToLoki(collected);
  // Só agora: o push deu certo.
  confirmar();
  await saveState(state);
  return collected.length;
}

// Under --dry-run, shows what would be written: this is how token attribution
// gets checked without polluting Loki.
function summarize(records) {
  const tally = (rows, keyOf, valueOf) => {
    const acc = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      const entry = acc.get(key) ?? { n: 0, tokens: 0 };
      entry.n += 1;
      entry.tokens += valueOf(row);
      acc.set(key, entry);
    }
    return [...acc.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  };
  const show = (title, rows) => {
    if (!rows.length) return;
    const total = rows.reduce((sum, [, entry]) => sum + entry.tokens, 0);
    log(`--- ${title}: ${total.toLocaleString('en-US')} tokens ---`);
    for (const [key, entry] of rows.slice(0, 20)) {
      log(`  ${key.padEnd(36)} ${String(entry.n).padStart(5)}x  ${entry.tokens.toLocaleString('en-US').padStart(12)} tokens`);
    }
  };
  const tools = records.filter((record) => record.meta.tool_name);
  const skills = records.filter((record) => record.meta.skill);
  show('TOOLS', tally(tools,
    (r) => (r.meta.tool_source === 'mcp' ? `mcp:${r.meta.mcp_server}`
      : r.meta.mcp_tool ? `bash:${r.meta.mcp_tool}` : `builtin:${r.meta.tool_name}`),
    (r) => Number(r.meta.tokens_attributed)));
  show('SKILLS', tally(skills, (r) => r.meta.skill, (r) => Number(r.meta.tokens)));
}



async function main() {
  log(`transcripts: ${PROJECTS_DIR}`);
  log(`loki: ${LOKI_URL}${DRY_RUN ? '  (dry-run)' : ''}`);
  const state = await loadState();
  if (RESCAN) {
    log('RESCAN: zeroing offsets, keeping the dedup map');
    state.files = {};
  }
  const firstRun = Object.keys(state.files).length === 0;
  if (firstRun) log('first run: importing the full transcript history');
  if (!Object.keys(state.seen).length) await seedSeenFromLoki(state);

  for (;;) {
    try {
      const count = await runPass(state);
      if (count) log(`${count} tool call(s) exported`);
    } catch (error) {
      log(`pass failed: ${error.message}`);
    }
    // The usage meter does not depend on new transcripts: it measures what OTel
    // already recorded, and must republish even on a pass with nothing to export.
    try {
      await publishRate({
        dryRun: DRY_RUN,
        lokiUrl: LOKI_URL,
        halfLifeS: RATE_HALFLIFE_S,
        halfLifeLabel: RATE_HALFLIFE,
        backfillDays: RATE_BACKFILL_DAYS,
        state,
        log,
      });
      if (!DRY_RUN) await saveState(state);
    } catch (error) {
      log(`rate meter failed: ${error.message}`);
    }
    try {
      await publishUsage({
        dryRun: DRY_RUN,
        lokiUrl: LOKI_URL,
        weekStartDay: WEEK_START_DAY,
        weekStartHour: WEEK_START_HOUR,
        tzOffsetHours: TZ_OFFSET_HOURS,
        log,
      });
    } catch (error) {
      log(`usage meter failed: ${error.message}`);
    }
    if (ONCE) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
