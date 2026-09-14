# Agents Observability

Local stack to monitor **coding-assistant CLI sessions** — how much each session
spends and how it is used. Today it ingests Claude Code; other tools (Copilot,
Codex, …) plug in through their own adapters later.

Path: Claude Code → OTel Collector → Prometheus (metrics) + Loki (logs) → Grafana.

## Why a collector

Claude Code emits OpenTelemetry **metrics** (`claude_code.cost.usage`,
`claude_code.token.usage`, …) and **log events** (`claude_code.tool_result`,
…). Metrics go to Prometheus, logs go to Loki — the OTel Collector is the
single ingest endpoint that fans both out; traces are also accepted so
nothing breaks if a client sends them, but for now those only go to the
collector's own log.

## Services

| Service        | URL                     | Purpose                                  |
|----------------|-------------------------|------------------------------------------|
| OTel Collector | `localhost:47317` (gRPC), `localhost:47318` (HTTP) | single OTLP ingest endpoint |
| Grafana        | http://localhost:47300  | dashboard "Claude Code — Uso & Custo" (anon viewer, admin/admin) |
| Prometheus     | http://localhost:47909  | metric storage, 90d retention            |
| Loki           | http://localhost:47100  | log storage (tool_result events, real MCP tool names) |

Data persists in named Docker volumes across restarts.

## Start

```sh
cd observability
docker compose up -d
```

Grafana → http://localhost:47300 → dashboard **"Claude Code — Uso & Custo"**
(provisioned). Empty until a Claude session sends data.

## Wire up every Claude session

The stack only receives data if Claude Code is told to export telemetry. Set the
env vars once at the shell level so they apply to any session, whichever Claude
account is active:

```sh
cat observability/claude-telemetry.fish >> ~/.config/fish/config.fish
```

Open a new terminal (or `source ~/.config/fish/config.fish`), then run `claude`
in any project. First data point lands within ~10s of the first prompt.

Verify: `claude --debug` shows no `[3P telemetry]` errors; Prometheus →
http://localhost:47909 → query `claude_code_cost_usage_USD_total` returns series.

## Adding other tools later

- **GitHub Copilot** — no local telemetry. Poll the GitHub Copilot Metrics API
  (org-level, daily) with a small scraper that exposes `/metrics` for Prometheus.
- **OpenAI Codex CLI** — no native OTEL. Parse its local session JSONL and expose
  `/metrics`.
- Give every adapter a `tool="…"` label so one Grafana dashboard covers all.

## Stop / reset

```sh
docker compose down           # stop, keep data
docker compose down -v        # stop, wipe all metrics
```

## Notes

- Host ports: 47300 (Grafana), 47317/47318 (OTLP), 47909 (Prometheus), 47100 (Loki).
- Grafana runs anonymous (Viewer) with an `admin`/`admin` login for edits — fine
  for localhost only. Do not expose these ports off the machine without auth.
- Metric names carry OTel unit + type suffixes via the Prometheus exporter,
  e.g. `claude_code_cost_usage_USD_total`, `claude_code_token_usage_tokens_total`.
- Resource attributes (`user.email`, `organization.id`, `service.name`) become
  Prometheus labels (`user_email`, `organization_id`, `service_name`) via
  `resource_to_telemetry_conversion` — that is how the dashboard splits spend by
  account.
- Cost/token counters are per-session series that go stale ~5min after a session
  ends, so dashboard totals use `max_over_time` to sum each session's final
  cumulative value.

## Dashboard: 5h / weekly usage gauges (topo da seção USO)

The first row under "USO" has 4 gauge panels (0–100%) showing tokens/cost used
in a **rolling 5-hour** and **rolling 7-day** window against a configurable
limit, to eyeball usage against Anthropic's Pro/Max session (5h) and weekly
rate-limit windows:

- Tokens (5h) — % do limite
- Tokens (7d/semana) — % do limite
- Custo (5h) — % do limite
- Custo (7d/semana) — % do limite

The limit itself is **not** exposed by Anthropic over OTel (quota accounting
is message/usage-based internally), so each gauge divides by a dashboard
variable (`$limit_tokens_5h`, `$limit_tokens_7d`, `$limit_cost_5h`,
`$limit_cost_7d`) with a placeholder default. **Edit these in Dashboard
settings → Variables** to match your actual plan — the percentages are only
as accurate as the value you put there. Treat this as a trend indicator, not
an authoritative limit counter.

## Known limitation: local MCP servers show as "custom" in Prometheus (by design)

Claude Code's `claude_code.token.usage` metric always carries
`mcp_server_name` / `mcp_tool_name` labels, but per Anthropic's own docs
(https://code.claude.com/docs/en/monitoring-usage, "Cost counter" /
"Token counter"): *"User-configured server names are replaced with `custom`."*
Only built-in servers, servers proxied through claude.ai/Claude Desktop
connectors (e.g. our ClickUp integration → `claude_ai_ClickUp`), or
official-registry servers appear verbatim. Any MCP server **you** configured
locally (context7, playwright, github, or anything in `.mcp.json` /
`claude mcp add`) is redacted to the literal string `"custom"` on this metric.
There's no env var to disable this — it's intentional privacy redaction on the
metrics pipeline, and it isn't the same thing as an empty/missing label, so a
`mcp_tool_name!=""` filter alone won't catch it.

## "Tokens/chamadas por MCP tool" panel — combining Prometheus + Loki

The redaction above only applies to the *metrics* pipeline. Claude Code also
emits a `claude_code.tool_result` **log event** per tool call, and its
`tool_name` attribute is **not redacted** — for MCP tools it's the real,
literal identifier in the form `mcp__<server>__<tool>` (e.g.
`mcp__playwright__browser_navigate`), the same format used in
`settings.local.json` permission rules. The stack ships a **Loki** service for
this: `otel-collector` forwards the `logs` pipeline to Loki over native OTLP
(`otlphttp` exporter → `http://loki:3100/otlp`), and Grafana has a `Loki`
datasource alongside `Prometheus`.

The panel uses a **mixed datasource** with two queries, aligned on the same
`server`/`tool` field names (via Prometheus `label_replace` and a named-group
Loki `regexp`) and combined with a `merge` transformation into one table:

- **Tokens (Prometheus)**: real token counts for non-redacted servers
  (built-in / claude.ai connectors, e.g. ClickUp today).
- **Chamadas (Loki, MCP local)**: call counts (not tokens — the metrics
  pipeline is still the only source of token/cost numbers, and it still
  reports `custom` for these) for your locally-configured MCP servers
  (context7, playwright, github, etc.), broken out by real server/tool name.

If you need token-level cost attribution for local MCP tools specifically,
correlate `duration_ms` / `tool_input_size_bytes` / `tool_result_size_bytes`
on the Loki log entries with the surrounding session's token usage manually —
there's no clean automated join today.

Loki data isn't retained forever by default (single-binary, filesystem
storage in the `loki-data` volume, no retention limit configured) — if disk
usage becomes a concern, add a `limits_config.retention_period` to a mounted
Loki config file.
