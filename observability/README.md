# Agents Observability

Local stack for tracking **coding-assistant CLI sessions** — how much of your
limit each session burns and how it is used. Today it ingests Claude Code; other
tools plug in later through their own adapters.

Path: Claude Code → OTel Collector → Prometheus (metrics) + Loki (logs) →
Grafana. In parallel, the **transcript-exporter** reads the local transcripts and
publishes into Loki two things the OTel telemetry does not give you: the real MCP
and skill names, and consumption measured over the real limit windows.

## Services

| Service             | URL / port                                         | Role |
|---------------------|----------------------------------------------------|------|
| OTel Collector      | `localhost:47317` (gRPC), `localhost:47318` (HTTP) | single OTLP ingest endpoint |
| Grafana             | http://localhost:47300                             | dashboards (anonymous Viewer, `admin`/`admin` to edit) |
| Prometheus          | http://localhost:47909                             | metrics, 90d retention |
| Loki                | http://localhost:47100                             | logs and events, 90d retention |
| transcript-exporter | —                                                  | real tool names + usage meter |
| dashboard-generator | —                                                  | one dashboard per account |

## Getting started

The short path is the wizard. It **discovers on its own** which Claude Code
config directories you have, identifies the account behind each one, asks which
ones you want to monitor, writes the configuration and enables telemetry in the
right shell:

```sh
bin/agent-setup
```

By hand:

```sh
cd observability
cp .env.example .env     # adjust CLAUDE_DIR
docker compose up -d
```

### More than one account

It is common to keep accounts split by context (`~/.claude-personal`,
`~/.claude-work`), each with its own transcript directory. The first one comes
from `CLAUDE_DIR` in `.env`; the rest go into a `docker-compose.override.yml`,
mounted at `/transcripts/d1`, `d2`, … — the exporter scans the root recursively:

```yaml
services:
  transcript-exporter:
    volumes:
      - ${HOME}/.claude-work/projects:/transcripts/d1:ro
```

The wizard generates that file when you pick more than one directory, and also
puts the accounts you did NOT pick on the `ignore` list in `account-limits.json`
— otherwise they would get an empty dashboard as soon as they showed up in
Prometheus.

Neither `.env` nor `docker-compose.override.yml` is versioned: they point at
paths on this machine. The templates are `.env.example` and this README.

Scanning only one directory is a **silent failure**: nothing breaks, the panels
just show a fraction of your usage. Here that hid 331 calls from a single MCP
server — the panel read 4 thousand tokens where the real number was 268 thousand.

## Enabling telemetry in every session

The wizard does this for you, picking the right file for your shell. By hand,
from the repo root:

```sh
cat observability/claude-telemetry.sh   >> ~/.bashrc                    # bash
cat observability/claude-telemetry.sh   >> ~/.zshrc                     # zsh
cat observability/claude-telemetry.fish >> ~/.config/fish/config.fish   # fish
```

Both files carry the same values — change one, change the other.

Open a new terminal (or `source` the file). The first data point arrives within a
minute of the first prompt (that is the export interval; see "Resource usage").

## One dashboard per account — and nothing else

There is no "all accounts" dashboard. Each account has its own MCP servers,
plugins and configuration, and the numbers do not add up into anything useful.

The `dashboard-generator` comes up with the stack and runs every 10 minutes. The
first time a new account sends data, its dashboard shows up as
**"Claude Code — <email>"**.

The single source is `grafana/templates/claude-code.json`. It deliberately sits
**outside** `grafana/dashboards/`: that is the provisioned directory, and a
template there would become one more dashboard with an empty account filter. The
generator reads the template and swaps what is account-specific:

- pins the account filter to one email;
- injects **that account's hourly P75 and outlier fence** as the rate cutlines;
- injects **that account's limit references** (see below);
- fills the MCP server and skill owner filters with what the account actually used.

Run it by hand: `node grafana/generate-account-dashboards.mjs`. Accounts that
disappear from the data have their file removed on the next run. The generated
files contain emails, are specific to this machine, and are gitignored.

## The limit windows (and why a rolling window was wrong)

Anthropic enforces two windows, and **neither is a rolling window**:

- **5h block**: it opens on your first message and expires 5h later. The next
  block only opens on your next message. A `sum_over_time[5h]` adds the tail of
  one block to the head of the next — a different measurement entirely.
- **Week**: it resets on a fixed day. A `sum_over_time[7d]` drags in last week's
  consumption.

Finding the block boundary means scanning activity for the gap where the previous
block expired. LogQL cannot do that, so the **usage-meter** (inside
transcript-exporter) does it: every pass it measures both windows per account and
publishes the result back into Loki, on the `service_name="claude-code-usage"`
stream. The gauges are then a direct read of that value.

The weekly reset day and hour are configurable on the service (`WEEK_START_DAY`,
default 1 = Monday; `WEEK_START_HOUR`, default 0; `TZ_OFFSET_HOURS`, default -3).

### The limit references

**Anthropic does not expose the limit through any telemetry**, and it varies by
plan. The references live in `grafana/account-limits.json`, per account, in new
tokens. That file is **not versioned** (it contains emails, same rule as the
generated dashboards) — copy the template the first time:

```sh
cp grafana/account-limits.example.json grafana/account-limits.json
```

To calibrate: run `/usage` on the account, note both percentages, and compare
them with what the meter published at that moment:

```
{service_name="claude-code-usage"} | user_email = `<email>`
```

Then `limit = meter_tokens / (usage_percentage / 100)`. The personal account here
was calibrated that way and read 26.3% against `/usage`'s 26%. Accounts with no
entry fall back to the `default` block.

### Why "new tokens"

The windows count **input + output + cache creation**. Cache reads are excluded:
they are ~97% of the raw volume and are not new spend, just the drag of context
you already paid for. Including them would pin the gauges at 100% permanently.

## The two data sources

### OTel — what Claude Code sends on its own

The event that matters is `claude_code.api_request`: **one line per API request**,
carrying `cost_usd`, the four token types, `model`, `effort`, `speed`,
`duration_ms`, `query_source`, `skill_name`, `session_id`, `prompt_id` and
`request_id`. Every panel reads from it.

It is exact per request, unlike the Prometheus metrics, which are per-session
counters that go stale ~5min after a session ends. Prometheus stays in the stack
(cheap ingest, long retention, and it is where the account list comes from) but it
is out of the panels.

### transcript-exporter — what OTel redacts

Claude Code **redacts the names of locally configured MCP servers across all of
its OTel telemetry**: `mcp_server_name` becomes `custom` in the metrics, and since
2.1.x `tool_name` in the `tool_result` log becomes `mcp_tool`. Only
`mcp_server_scope` survives. Measured on this machine: **~85% of MCP tokens fell
into a single anonymous bucket**. It is not a bug and there is no env var to turn
it off — it is intentional privacy redaction, documented at
https://code.claude.com/docs/en/monitoring-usage.

The same redaction applies to **plugin skills**, which become `third-party` in
`api_request`'s `skill_name`.

The local transcripts keep both real names. The exporter scans the config
directories mounted under `/transcripts` **recursively** and publishes to
`{service_name="$EXPORTER_STREAM"}`, with a `kind` label separating `tools` (one
line per `tool_use` block) from `skills` (one line per skill-tagged request). The
stream name is **versioned** — see "Rescan and reimport" below.

#### How tokens are attributed to a tool

A tool's cost is **what the model paid to read its result**: the input side
(`input_tokens + cache_creation_input_tokens`) of the **next** assistant message
on the same track. With several tools called in parallel, that total is split
proportionally to each result's size.

`cache_read` is left out **on purpose**: what matters is the marginal cost of that
call, not its drag on later turns. That is why the exporter's number is much
smaller than Prometheus's `claude_code_token_usage_tokens_total` for the same
server — they measure different things, and only the exporter's answers "what did
this tool cost me".

Subagent tracks (`isSidechain`) are tracked separately from the main thread,
otherwise a subagent's first message would settle the attribution of a tool called
on the track above.

#### About the skill numbers

The skills panel reads the exporter's stream, but the **values come from OTel** —
the exporter republishes the `api_request` attribution, changing only the name, to
undo the plugin-skill redaction. That is what makes the skills table reconcile
exactly with the weekly breakdown: `dip-code-review` reads 2,840,009 on both
sides, and so on.

The opposite was tried first and was wrong: a skill can be activated
**proactively**, with no `Skill` tool call, and the transcript does not cover every
request (subagents and rotated sessions are missing). Transcript-based attribution
was off by −87% on one skill and −100% on two others. The transcript now only says
**which** plugin skill ran in each session, and the name is only restored when a
session used exactly one — with two, there is no way to tell which is which.

The MCP panel keeps its own transcript-based attribution (the marginal cost of
reading a result), which is a different measurement with no OTel equivalent.

#### Deduplication

Resuming a session makes Claude Code rewrite the entire history into a new
transcript: same `request_id`, same `tool_use_id`, different `session_id`. Without
filtering, every resume counts everything again. The key is `tool_use_id`, and the
map is seeded from Loki itself when empty — which also makes losing the state
volume harmless (it re-reads everything, recognises what is already there, and
writes zero duplicates).

#### What has to be scanned

Two traps in scanning the transcripts, both found after the numbers looked too
low:

- **More than one config directory.** Accounts split by context use different
  directories (`~/.claude-personal`, `~/.claude-work`). Scanning only one loses
  everything from the other, with no error at all.
- **Subagents live one level deeper.** Their transcripts are in
  `<session>/subagents/*.jsonl`. A single-level scan ignores them — that was 134
  files on one account alone.

Hence the recursive scan from the root, with both directories mounted as
subfolders of it.

#### How each call's account is discovered

Transcripts do not record the account. There are two attempts, in order, and the
`account_source` field on each line records which one won:

1. **`otel`** — by `session_id`, querying the `api_request` event in Loki. This is
   the exact path.
2. **`project`** — transcripts go further back than the telemetry, and sessions
   older than this stack have no OTel event at all. For those, the directory's
   owner decides: if every already-attributed session of a project belongs to the
   same account, the orphans there belong to it too. A project with two accounts
   is left alone — the inference only acts when there is no ambiguity. The map is
   built from Loki history **and from the batch being imported**, otherwise a
   from-scratch import would never infer anything. Measured here: 1,231 of 1,492
   orphaned records recovered, 0 ambiguous.

What is left without an account (projects that never had a session with telemetry)
exists in Loki but does not show up in the per-account dashboards.

#### Rescan and reimport

Loki is append-only, and the exporter stores an offset at the end of each
transcript — a restart re-reads nothing. Two operations cover this.

**Rescan** (`--rescan`): zeroes the offsets and re-reads everything while keeping
the dedup map. Use it to generate a **new** record type out of existing history
without rewriting anything:

```sh
docker compose run --rm transcript-exporter node /work/exporter.mjs --rescan --once
```

**Reimport**: to redo the whole derivation (say, after changing how accounts or
tokens are attributed), bump the stream generation — edit `EXPORTER_STREAM` in
**`.env`**, the single source both services read. Then drop the state and come up;
`up -d` recreates both services on its own because the variable changed:

```sh
docker compose down
docker volume rm agents-observability_exporter-state
docker compose up -d
```

The old generation is orphaned and ages out with the 90-day retention.

> **Why not use Loki's delete API.** The temptation is to delete the stream and
> reimport under the same name. It does not work, and it fails silently: a delete
> request marks a time window and Loki starts **filtering it at query time** — the
> stream looks empty, but anything reimported with historical timestamps lands
> inside that window and is born invisible. Worse, a request that has already been
> processed **cannot be removed** (`deletion of request which is in process or
> already processed is not allowed`), so that window stays blind forever on that
> stream. Hence the generation in the name.

## The panels

Thirteen panels in five sections, two of them collapsed by default. Reading top to
bottom, they answer: *how much can I still spend* → *where is it going* → *is my
rate high right now*.

Two filters at the top, **MCP server** and **Skill owner**, both set to "All" by
default. They only affect the granular tables; the rest of the dashboard ignores
them.

### Overview

| Panel | What it decides |
|-------|-----------------|
| **5h block limit — % used** | How much of the current block is gone. If no block is open it reads zero — it does not carry over from the last one. |
| **Weekly limit — % used** | How much of the weekly limit is gone since the reset. |
| **Cache reuse** | Share of input that came from cache you already paid for. |
| **Tokens by model** (donut) | Where the consumption went. |

The gauges show **% used**, not % remaining, on purpose: it is the same reading as
`/usage`, so you can check one against the other without flipping it in your head.
The value is clamped at 100% — going over the limit is not "more than 100% of the
limit", it is simply blown. LogQL has no `clamp_max`, so the clamp comes from
`(vector(100) < x) or x`.

The donut is in **tokens, not dollars**: on a fixed-price subscription what runs
out is the limit, and the dollar figure decides nothing.

#### Section "Weekly breakdown" (collapsed by default)

One table with all of the week's consumption, broken down **from the widest scope
to the narrowest**: `Model | Effort | Source | Skill | % of weekly limit`. It is
the most granular cut of the overview — it answers *why* the limit is being
consumed — which is why it sits right below it, but collapsed: it is a lookup, not
daily reading.

It covers **all** consumption, not just what ran inside a skill: requests with no
skill show an empty Skill cell. That is why the footer total reconciles with the
weekly gauge — verified here: 30.37% in the table against 30.37% on the gauge.
This holds as long as the time range is the current week (the default); on another
range the sum becomes that period's.

There is no tool column: the event that accounts for 100% of consumption does not
carry which tool was used. That cut lives in the "Tokens by MCP tool" table, with
its own attribution.

**The Skill column here is OTel's, redacted.** Unlike the "Tokens by skill" table,
which uses the real name from the transcript, a plugin skill appears here as
`third-party`. The reason is the reconciliation: only OTel accounts for 100% of
consumption, and mixing the two sources would break the sum. To find out which
skill is behind `third-party`, the Skills and tools table answers.

### Skills and tools

| Panel | What it decides |
|-------|-----------------|
| **Tokens by skill** (table) | Which skill consumes most, with its real name. |
| **Tokens by MCP server** (table) | Which server consumes most. |
| **Tokens by source** (donut) | Main thread, subagents, or auxiliary calls. |

All three are clickable, and each opens its own table in the collapsed
**"Breakdown"** section below:

| Click | Opens | Showing |
|---|---|---|
| a server name | **Tokens by MCP tool** | what each specific call of that server cost |
| a skill name | **Tokens by skill, model and effort** | which model and effort that skill ran on |
| a donut slice | **Tokens by model and effort** | the models behind that origin |

Same pattern as the weekly breakdown — the granular cut stays collapsed, right
below the panels it details.

#### How a click opens a collapsed section

A link sets the filter variable and adds `viewPanel=panel-<id>`, which opens that
one table full screen, already filtered; "Back to dashboard" returns. It has to
work that way because **a row's collapsed state does not exist in the URL** — it
lives in the dashboard JSON, so no link can expand a section. `viewPanel` does
resolve a panel that sits inside a collapsed row (verified on this Grafana), which
is what makes the drill-down possible at all.

The two drill-down variables, `skill` and `source`, are **textbox** variables, not
the `custom` dropdowns used for `server` and `owner`. A skill name can contain a
colon (`superpowers:brainstorming`) and Grafana re-parses a custom variable's
`query` on that character, truncating the value — the same trap that broke the
owner filter before.

`source` is not a label in the data: the donut separates main / subagent /
auxiliary with regexes over `query_source`. The table turns that same rule into a
real label with `label_format`, so the clicked origin can be filtered by a
variable. Its totals were checked against the donut's three queries and match to
the token: main 5,714,385, subagent 2,959,681, auxiliary 1,327,210.

**The skill drill-down reads the exporter's stream, not OTel** — the same source as
the "Tokens by skill" table above it, with the un-redacted names. Clicking a row
there always finds data here; against OTel a plugin skill would be `third-party`
and the click would land on nothing. Verified per skill: `code-review` 1,075,077 in
both, `superpowers:brainstorming` 63,290 in both.

The tables carry a bar inside the cell and come sorted highest first. Tables
rather than bar charts for two practical reasons: they sort natively, and they
give the name full width — in a bar chart the names were cut off after the first
few characters.

The top filters act here: **Skill owner** narrows to one plugin (e.g.
`superpowers`) or to local skills; **MCP server** narrows both the server summary
table and the tool table — picking a server collapses the summary to a single row,
which is the expected effect of clicking its name.

The source donut groups `query_source`, which arrives detailed in Loki
(`repl_main_thread`, `agent:builtin:general-purpose`, `agent_summary`, …):
`repl_main_thread` → **main**, `agent:*` → **subagent**, everything else →
**auxiliary**.

### Consumption rate

Two line charts in tokens/hour. This panel is a **speedometer**, not a budget
meter: it answers "am I fast or slow right now" so you can judge whether that
speed is warranted — a session firing many tools and MCP calls, or an agent that
quietly spawned 30 subagents and started accelerating on its own. It says nothing
about the limit; the gauges above do that.

The curve is an **exponentially weighted moving average** with a 20-minute
half-life (`RATE_HALFLIFE` in `.env`), computed by the exporter's rate-meter and
published into Loki, because LogQL has no EWMA.

It used to be `sum_over_time(tokens[15m]) * 4` computed directly in the panel.
That is a boxcar, and on real data it behaved badly enough to make the panel
useless:

| | boxcar | EWMA 20m |
|---|---|---|
| jitter between consecutive points | 451,185 tokens/h | **44,296** |
| peak ÷ P75 cutline | 9.9× | **6.0×** |
| when a session stops | 30× drop in one 5-min step | ~50-minute glide |

The jitter is why crossing the line meant nothing: the chart was a field of
needles, and the peaks towered so far above the cutline that the line sat squashed
at the floor. And the cliff misrepresented reality — stopping does not mean you
were instantly slow, it means you decelerated.

The half-life is part of the **stream labels** on purpose. Loki cannot replace
derived data, so changing it would otherwise mix two different maths in one
series; as a label, a new value simply starts a fresh series and the old one ages
out with retention.

The rate-meter backfills the series on its first run (14 days by default,
`RATE_BACKFILL_DAYS`). The history is not lost — this Loki accepts old samples on
purpose.

### The two cutlines

Both are computed by the `dashboard-generator` over **that account's** last 7
days, as quantiles of the very same smoothed curve the panel draws:

| Line | What it is | What it means |
|---|---|---|
| green | P75 | Above it you are in the busiest quarter of your own normal. |
| orange | Q3 + 1.5×IQR (Tukey's inner fence) | Not "busy" any more — out of pattern. |
| red | Q3 + 3×IQR (Tukey's outer fence) | The textbook "far out" point. Worth looking at what ran there. |

**The curve itself changes colour with the band it is in**: white below P75 (your
usual pace), green, orange, red.

The colouring is not a gradient. The panel draws the same curve four times: a
white base, then one series per band filtered in LogQL to the samples above
that band's cutline (`sum(...) > 986651`). A comparison in LogQL drops the
samples that fail it, so with `spanNulls: false` each overlay renders only the
stretch that actually crossed, in one flat colour, and the cutline the query
filters on is the same number the dashed line is drawn at. The overlays are line
only, with no points of their own -- Grafana already draws a point under the
cursor on the base curve, which is the only moment one is useful. The cost is
that a crossing lasting a single 5-minute bucket has no segment to draw and so
goes uncoloured: 3 of the 27 crossings in a measured week, with the white curve
still showing the spike. The overlays are hidden from the legend and the
tooltip, being the same curve recut.

There are three cutlines rather than two because with a single fence the top band
ran from the fence all the way to the maximum — a 3.3x span on real data, so a
mild peak and an extreme one were painted the same colour and the top band stopped
meaning anything. Tukey defines both fences, so the second one is not an invented
threshold: 1.5×IQR is an outlier, 3×IQR is "far out".

Measured over 7 days, on two accounts:

| | white | green | orange | red | top band span |
|---|---|---|---|---|---|
| personal | 90.3% | 7.0% | 1.5% | 1.2% | 2.3× (was 3.3×) |
| work | 92.1% | 6.5% | 1.2% | 0.2% | 1.0× (was 3.3×) |

Most of a week is idle or coasting down, and the cutlines are quantiles of
*working* time, so the colours only light up while you are actually going.

The input/output panel keeps fixed per-series colours instead (blue and purple),
because there colour has to tell the two series apart.

They are computed **only over buckets that actually contained requests**. An EWMA
never quite reaches zero, so after a busy stretch it leaves a long tail of small
positive values — measured here, 76% of the "non-zero" points were tail rather
than work. Taking quantiles over that collapses the line (P75 fell from 560k to
274k and the peaks went to 12× above it). Masking by real activity also matches
what the line is supposed to mean: *faster than I usually run **while working***.

The values vary a lot between accounts — 555k/1.01M on one, 1.49M/3.25M on another
— which is why they are per account rather than constants.

The input/output panel has cutlines **of its own per series**, computed only over
that series. Input and output differ by an order of magnitude, so using the
total's cutline there would compare different things.

Two things have to stay in sync here, and both have burned this dashboard before:
the generator must read the same `RATE_HALFLIFE` as the exporter (hence one
variable in `.env`, in one format), and the cutlines must be quantiles of the
curve actually drawn. An earlier version computed them over 1h windows while the
graph drew 15min ones, which put the line at 782k under a curve whose real P75 was
1.09M — a line that lies.

### Time range

The default is **`now/w+9h+24h` → `now`** (current week, from Monday 9am). The
picker also offers *Current day* (`now/d+9h`), *5 hours*, *24 hours*, *7 days* and
*30 days*.

The week rather than the day because **skills and MCP calls are sparse**: on a day
with no MCP use, or no skill run, those panels opened empty — and a dashboard that
opens empty is worth nothing. The week keeps the "right now" framing and still has
something to show.

The limit gauges **ignore this picker**: their windows are Anthropic's, not the
analysis window.

## Adding other tools later

- **GitHub Copilot** — no local telemetry. Poll the Copilot Metrics API with a
  small scraper exposing `/metrics`.
- **OpenAI Codex CLI** — no native OTEL. Parse its session JSONL.
- Give every adapter a `tool="…"` label.

## Stop / reset

```sh
docker compose down           # stop, keep the data
docker compose down -v        # stop, wipe everything
```

## Known traps

**A published series needs a lookback window, not `$__interval`.** The rate series
is published every 5 minutes. Querying it with `last_over_time(... [$__interval])`
looks back only as far as the graph's own step, which on a wide panel is 30s — so
19 steps out of 20 find nothing. Grafana then declares the frame's interval as 30s,
sees points 300s apart, and inserts nulls between them; with `spanNulls: false` and
`showPoints: never`, the entire line disappears while the tooltip still reports
values. The fix is a fixed `[10m]` window (always covers at least two published
points) plus `interval: 5m` on the panel so Grafana does not over-sample a series
that only has 5-minute resolution.

**A transparent base threshold makes the line invisible.** Grafana's default field
color mode is `thresholds`, so the line takes the colour of whichever band its
value falls in — which the rate panel relies on. But the base step must be a real
colour. It used to be `transparent` (so the threshold band would not tint the
chart), which drew every value below the first cutline as nothing at all. The panel
looked blank while its tooltip still showed values, and it only surfaced once the
curve was smoothed: the old spiky one crossed the cutline constantly, so coloured
fragments stayed visible.

**Colouring a line by threshold band is not what `color.mode: thresholds` does.**
Two modes both look right and are both wrong. With `gradientMode: "opacity"`
Grafana resolves the field colour **once for the whole series**, so the rate
curve came out uniformly green no matter how many peaks crossed the cutlines.
With `gradientMode: "scheme"` it colours per point, but as a *gradient*: it
interpolates between the threshold colours instead of stepping at them, so the
curve turns into a rainbow and a point still well below the red cutline is
already drawn reddish. Neither mode paints "the part of the line above the
line". Overlaying one filtered series per band does, which is what this panel
now uses, at the cost of one extra query per band.

**`allowUiUpdates` must be `false`.** With `true`, the first time a dashboard is
touched through the UI, Grafana unlinks it from provisioning (`meta.provisioned`
goes `false`) and serves the database copy forever — the file changes and nothing
happens. Since these dashboards are regenerated on a schedule, the database copy
must never win. To check what is actually being served (not just what is on disk):

```sh
curl -s -u admin:admin http://localhost:47300/api/dashboards/uid/cc-<slug> \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["meta"]["provisioned"], d["dashboard"]["version"])'
```

**An `instant` query breaks series names.** Loki returns `numeric-multi` frames
for instant queries; Grafana merges those frames into one and renames the fields
to `Value #A`, discarding the name from `legendFormat`. Every panel uses `range`
except the weekly breakdown table — there, `range` would render one row per graph
step instead of one per combination.

## Resource usage

The stack runs all day on a developer machine, so what matters is not peak CPU —
it is **how often things wake up**. Every periodic task keeps the CPU from going
idle, and that is battery.

The intervals are tuned for the data to be useful, not instantaneous:

| Component | Interval | Why |
|---|---|---|
| Claude Code → collector | 60s (metrics), 30s (logs) | runs in EVERY session; was 10s/5s |
| `transcript-exporter` | 120s | each pass scans hundreds of transcripts and publishes the rate curve |
| `dashboard-generator` | 600s | spawns a Node process and queries 7–30 days |
| Grafana re-provision | 300s | re-parses every dashboard on disk |
| Prometheus scrape | 60s | only used to list accounts; the panels read Loki |
| Loki compactor | 600s | the image's default |
| Dashboard auto-refresh | 300s | each refresh fires ~14 Loki queries |

That is **~82% fewer wakeups per hour** than the initial configuration (1740 →
306). Grafana also has unified alerting (which keeps a scheduler running even with
zero rules), version checks and analytics turned off.

At rest the stack sits around **700 MiB** with CPU near zero. If you need fresher
data occasionally, raise the refresh in the Grafana tab rather than lowering these
intervals again.

## Notes

- Host ports: 47300 (Grafana), 47317/47318 (OTLP), 47909 (Prometheus), 47100
  (Loki). All published on `127.0.0.1`, not `0.0.0.0` — Grafana runs anonymous and
  the Loki API has no authentication, so binding them to every interface would
  expose both to anyone on the same network.
- Metric names carry the Prometheus exporter's unit and type suffixes, e.g.
  `claude_code_cost_usage_USD_total`.
- Resource attributes (`user.email`, `organization.id`, `service.name`) become
  Prometheus labels (`user_email`, …) through `resource_to_telemetry_conversion`.
- `loki-config.yaml` deviates from the image's default in four places, all
  commented in the file: it accepts old samples (backfill), removes the query
  window cap, enables 90d retention, and raises `ingester.max_chunk_age` — without
  that last one Loki rejects every historical backfill with HTTP 400 as soon as the
  stream has a recent line.
