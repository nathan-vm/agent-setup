# Agents Observability

Local stack to monitor **coding-assistant CLI sessions** — how much each session
spends and how it is used. Today it ingests Claude Code; other tools (Copilot,
Codex, …) plug in through their own adapters later.

Path: Claude Code → OTel Collector → Prometheus → Grafana.

## Why a collector

Claude Code emits OpenTelemetry **metrics** (`claude_code.cost.usage`,
`claude_code.token.usage`, …) and log events. Those need Prometheus + Grafana.
The OTel Collector is the single ingest endpoint; it also accepts traces/logs so
nothing breaks if a client sends them, but for now those only go to the
collector's own log.

## Services

| Service        | URL                     | Purpose                                  |
|----------------|-------------------------|------------------------------------------|
| OTel Collector | `localhost:47317` (gRPC), `localhost:47318` (HTTP) | single OTLP ingest endpoint |
| Grafana        | http://localhost:47300  | dashboard "Claude Code — Uso & Custo" (anon viewer, admin/admin) |
| Prometheus     | http://localhost:47909  | metric storage, 90d retention            |

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

- Host ports: 47300 (Grafana), 47317/47318 (OTLP), 47909 (Prometheus).
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
