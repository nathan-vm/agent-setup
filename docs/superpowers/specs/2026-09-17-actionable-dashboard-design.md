# Actionable dashboard — design

Date: 2026-09-17
Status: implemented

`observability/README.md` describes **how the system works**. This document
records **why it is that way**: the decisions, the alternatives that were
discarded, and what was deliberately left out.

## The problem

The previous dashboard had 35 panels and drove no decisions. Five concrete
complaints:

1. One dashboard aggregating every account is useless — each account has its own
   MCP servers, plugins and configuration; mixing them makes the data meaningless.
2. "Skill X is spending a lot" in isolation decides nothing: the same skill run on
   Opus at high effort against a complex task inflates the figure, and the panel
   did not show those variables.
3. Local MCP servers had no join with token data.
4. The charts did not say whether the rate was high or low, near or far from the
   limit.
5. The default time range was not the current day.

## Findings that changed the design

**The existing MCP panel was broken, and the README lied about it.** The README
claimed the `tool_result` log carried the real tool name. On the installed version
(2.1.236 / 2.1.267) it redacts it to `mcp_tool`, just as the metrics redact to
`custom`. Measured: ~85% of MCP tokens fell into an anonymous bucket. There is no
real MCP name anywhere in the OTel telemetry.

**The source of truth was being wasted.** The `claude_code.api_request` log event
already carries exact cost and tokens *per request*, with model, effort, skill,
source, session and prompt. The dashboard read Prometheus instead, whose
per-session counters need `max_over_time` and never give the window's exact total.

**The MCP join exists outside OTel.** The local transcripts carry the real name
and a `requestId` that matches `api_request`'s `request_id` 1:1.

## Decisions

### 1. Loki (`api_request`) becomes the source for every panel

Prometheus keeps ingesting (long, cheap retention, and it is where the account
list comes from) but is out of the panels. This kills `max_over_time` and gives
per-request granularity.

**Discarded alternative:** retire the OTel pipeline and use only transcripts. They
have everything, but we would lose the `cost_usd` Anthropic already computes
(pricing per model by hand) and the near-real-time path.

### 2. transcript-exporter as a second source, not a replacement

**Discarded alternative:** a `PostToolUse` hook emitting the real name. It is
real-time and does not depend on the JSONL format, but it adds latency to *every*
tool call, is not retroactive, and a slow hook degrades the whole session.

**Token attribution:** a tool's cost is the input side of the next assistant
message — what the model paid to read that result. `cache_read` is excluded: what
matters is the marginal cost of the call, not its drag on later turns. This makes
the number diverge substantially from Prometheus's
`claude_code_token_usage_tokens_total` for the same server; they are different
measurements, and only this one answers "what did this tool cost me".

**Deduplication by `tool_use_id`:** resuming a session makes Claude Code rewrite
the whole history into a new transcript — same `request_id`, same `tool_use_id`,
different `session_id`. Without filtering, every resume recounts the original
session's tools. The dedup map is seeded from Loki itself when empty, which also
makes losing the state volume harmless.

### 3. The gauges measure new tokens, not raw tokens

`cache_read` is ~97% of the volume. Including it would pin the gauges at 100%
permanently. The gauges use input + output + cache creation.

> **Recalibrated afterwards.** This document once recorded 5M/5h and 50M/7d. Those
> numbers came from ROLLING windows, which turned out to be the wrong measurement:
> Anthropic uses a 5h block that resets and a week that resets on a fixed day. With
> the correct windows, calibrating against a real `/usage` (15% on the block, 26%
> on the week) gave **1,750,000 per 5h block and 21,500,000 per week** — which is
> what lives in `grafana/account-limits.json`, the source of truth. The limit
> varies by plan, hence per account.

The windows are fixed and ignore the time picker: they are limit windows, not
analysis windows.

### 4. The P75 is computed by the generator, not by Grafana

LogQL has no quantile over an aggregate: you can take a quantile of individual
values, not of the hourly buckets the graph draws.

**Discarded alternative:** Grafana's *Config from query results* transformation
feeding a dynamic threshold. It would require a query LogQL cannot express.

The `dashboard-generator` already runs periodically; it computes the hourly P75 per
account and injects it as a threshold. The value varies a lot between accounts
(473k vs 1.22M tokens/h on the accounts measured), which confirms it has to be per
account.

### 5. Skill stops being a standalone axis

The breakdown table crosses skill × model × effort × source in a single table. A
per-skill total hides exactly the variable that explains the cost. In practice the
same skill shows up cheap under `repl_main_thread` and expensive under
`agent:builtin:general-purpose` — the skill is not expensive, its subagents are.

## What was left out, and why

**The "vs. historical median" column.** The idea was to compare each run against
the median of its own cell (skill+model+effort), lighting up only the anomalous
ones. That needs two levels of aggregation: sum per run, then the median of those
sums. LogQL cannot do it, and the Grafana-transformation path would need a
self-join on a composite key, which does not exist without a plugin.

The table as shipped solves the part that mattered — the confounding variables sit
next to the cost. Getting the deviation from the median would need a job
precomputing the per-run rollup. It was not built.

**The 21 removed panels.** Active time, tokens/min, throughput, cumulative cost per
session, the 90d tables, lines of code. None of them answered a question that led
to an action.

## Known limitation

The transcript JSONL format is undocumented and can change between Claude Code
versions. The exporter skips any line that fails to parse and carries on; a format
change shows up as the MCP panel going flat, not as an error.
