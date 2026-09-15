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

## Dashboard: organização e leitura

A ordem prioriza a decisão **onde investigar o consumo de tokens**:

| Seção | Pergunta e decisão suportada |
|-------|-----------------------------|
| Visão geral | Qual o volume recente e a intensidade de uso? Tokens de 24h, tempo ativo, tokens/minuto ativo e reaproveitamento de cache dão contexto antes da investigação. |
| Skills e ferramentas MCP | Quais skills e ferramentas concentram uso? Ranking horizontal de skills e tabela MCP aparecem logo após o resumo. |
| Ritmo de consumo | Quando ocorrem picos? Throughput ocupa a largura inteira, com média, máximo e último valor disponível na legenda. |
| Composição dos tokens | O consumo vem de entrada, saída ou cache? Barras mostram os totais; a evolução separa entrada/saída de cache, com escalas próprias e cores consistentes. O gráfico de origem distingue sessão principal, subagentes e chamadas auxiliares. |
| Investigação por skill e modelo | Quando cada skill/modelo concentra consumo? Séries temporais aprofundam os rankings sem ocupar o primeiro bloco. |
| Limites estimados | Como o uso se compara às referências configuradas? Estimativas ficam fora do resumo para não parecerem cotas oficiais. |
| Custo, detalhamento e atividade | Qual conta/sessão explica o gasto? Custos, tabelas e histórico de 90 dias ficam abaixo da análise principal. |

**Conta** e **Modelo** são os filtros visíveis. Conta filtra as métricas do
Prometheus; Modelo atua nos painéis de custo e na evolução por modelo. Os
demais painéis de tokens continuam agregando os modelos. As chamadas MCP do
Loki consideram todos os logs no período, sem filtro de conta/modelo.

Totais no período representam a soma do maior contador de cada sessão
observada na janela (`max_over_time`), não necessariamente apenas o consumo
ocorrido dentro dela. Tokens de 24h e históricos de 90d usam janelas fixas.
As evoluções usam janelas móveis de `$__rate_interval`; throughput converte
`rate` para tokens/h e inclui cache, não mede velocidade de geração. Lacunas
não são preenchidas como zero.

Azul destaca o ranking de skills e as barras numéricas da tabela MCP, sem
indicar bom/ruim. Nos tipos de token: azul = entrada, roxo = saída, ciano =
cache lido, laranja = cache criado. Entrada/saída e cache têm eixos
independentes: compare valores, não alturas entre gráficos. Cache hit não
recebe meta arbitrária nem fundo verde/vermelho.

## Um dashboard por conta (automático)

O dashboard mestre **"Claude Code — Uso & Custo"** tem o filtro **Conta** e mostra
todas as contas juntas (`sum by (user_email)`). A ingestão já é multi-conta: o
Claude Code emite `user.email` da conta ativa, então rodar `claude` logado em
outra conta faz os dados aparecerem sozinhos com outro `user_email` — sem
configurar nada.

Para ter um **dashboard dedicado por conta** (cada um travado em um email, sem o
seletor), use o gerador. Ele lê o mestre como fonte única e só troca uid, título
e o filtro de conta — não duplica a lógica dos painéis:

```sh
node observability/grafana/generate-account-dashboards.mjs
```

Ele consulta `label_values(user_email)` no Prometheus e escreve
`grafana/dashboards/accounts/<slug>.json`, um por email. O provisioning do
Grafana varre a pasta recursivamente e os carrega em ~30s como
**"Claude Code — <email>"**. Contas que somem dos dados têm o arquivo removido na
execução seguinte. Esses arquivos são específicos da máquina (contêm emails) e
ficam no `.gitignore`.

**Totalmente automático (detecta novos emails sozinho):** suba o sidecar opcional,
que roda o gerador em loop a cada 60s:

```sh
docker compose --profile autogen up -d
```

Assim, na primeira vez que qualquer conta nova enviar dados, o dashboard dela
aparece sozinho em ~1min. O sidecar não sobe no `docker compose up -d` normal —
só com o perfil `autogen`. Variável `PROM_URL` aponta o Prometheus (padrão
`http://localhost:47909` no host, `http://prometheus:9090` no sidecar).

## Dashboard: referências de uso em 5h / 7d

A seção **LIMITES ESTIMADOS — REFERÊNCIAS, NÃO COTAS OFICIAIS** contém quatro
gauges (0–100%) de tokens/custo em janelas móveis de **5 horas** e **7 dias**.
São referências configuráveis para acompanhar uso, não a medição oficial
dos limites Pro/Max:

- Tokens (5h) — % do limite
- Tokens (7d/semana) — % do limite
- Custo (5h) — % do limite
- Custo (7d/semana) — % do limite

A Anthropic **não expõe** o limite via OTel. Cada gauge divide o contador
por uma variável (`$limit_tokens_5h`, `$limit_tokens_7d`, `$limit_cost_5h`,
`$limit_cost_7d`) com valor inicial de referência. As variáveis ficam ocultas
na barra de filtros; ajuste em **Dashboard settings → Variables**.
Os percentuais dependem dessas referências e incluem a limitação dos
contadores por sessão descrita acima.

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

- **Tokens** (Prometheus): real token counts for non-redacted servers
  (built-in / claude.ai connectors, e.g. ClickUp today).
- **Chamadas** (Loki, including local MCP servers): call counts (not tokens — the metrics
  pipeline is still the only source of token/cost numbers, and it still
  reports `custom` for these) for your locally-configured MCP servers
  (context7, playwright, github, etc.), broken out by real server/tool name.

A tabela começa ordenada por **Chamadas** e depois **Tokens**, em ordem
decrescente. Clique no cabeçalho **Tokens** para priorizar consumo.
As barras de cada coluna usam
escalas independentes: chamadas e tokens não são comparáveis. **—** indica
dado indisponível, não zero. O filtro Conta afeta apenas a coluna Tokens;
Modelo não se aplica a esse painel.

If you need token-level cost attribution for local MCP tools specifically,
correlate `duration_ms` / `tool_input_size_bytes` / `tool_result_size_bytes`
on the Loki log entries with the surrounding session's token usage manually —
there's no clean automated join today.

Loki data isn't retained forever by default (single-binary, filesystem
storage in the `loki-data` volume, no retention limit configured) — if disk
usage becomes a concern, add a `limits_config.retention_period` to a mounted
Loki config file.
