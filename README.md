# agents-setup

Hub to bootstrap a Claude Code dev setup. Three parts:

- **`bin/agent-setup`** — interactive wizard that asks, item by item, what you
  want (shared skills/commands, MCP servers, rtk, ponytail, caveman,
  observability) and whether to install it **global** (`~/.claude`, every
  project) or **just this project** (`.claude/` here).
- **`bundle/`** — the project-agnostic skills/commands/MCP config the wizard
  (and the plain installer) drop into a target.
- **`observability/`** — local stack (OTel Collector + Prometheus + Grafana)
  that tracks Claude Code cost/token usage across every session. See
  [`observability/README.md`](observability/README.md).

Everything here targets **Claude Code only**.

## `agent-setup` — wizard

```sh
agent-setup             # interactive wizard (default)
agent-setup wizard      # same, explicit
```

Walks through, one question at a time (each with a global-vs-project choice):

| Item | What it does |
|------|--------------|
| Skills & commands | drops the `bundle/` (OpenSpec workflow + `commit-split`) into `.claude/` |
| MCP: **context7** | up-to-date library docs, avoids hallucinated APIs (`claude mcp add`) |
| MCP: **github** | official remote GitHub MCP server (issues, PRs, code search) |
| MCP: **playwright** | browser automation/inspection (`@playwright/mcp`) |
| MCP: **sequential-thinking** | forces step-by-step reasoning on complex tasks |
| **rtk** | [rtk-ai/rtk](https://github.com/rtk-ai/rtk) — compresses noisy bash output before it hits the context window |
| **ponytail** | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) — pushes the agent toward the smallest, native, non-overengineered solution |
| **caveman** | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) — ultra-compressed responses, cuts output tokens |
| **Superpowers** | [obra/superpowers](https://github.com/obra/superpowers) — full dev methodology plugin: spec-first workflow, TDD, systematic-debugging, root-cause-tracing, using-git-worktrees, finishing-a-development-branch, requesting/receiving-code-review, brainstorming, writing-plans |
| **Anthropic example-skills** | official [anthropics/skills](https://github.com/anthropics/skills) — `skill-creator` (build your own skills), `mcp-builder`, `webapp-testing` (Playwright-based), `frontend-design` |
| **Anthropic document-skills** | official [anthropics/skills](https://github.com/anthropics/skills) — `docx`/`pdf`/`pptx`/`xlsx` editing & extraction |
| Observability | `docker compose up -d` in `observability/` + wires the telemetry env vars into your shell rc (bash/zsh/fish) |

MCP servers and plugins are registered via `claude mcp add` / `claude plugin
install` with `--scope user` (global) or `--scope project` (this repo);
skills/commands go to `~/.claude` or `./.claude` accordingly. Safe to re-run —
each item is asked again and skipped/merged non-destructively.

## `agent-setup install` — non-interactive bundle drop

For scripting, or if you just want the plain bundle without the Q&A:

```sh
agent-setup install                # bundle into the current directory
agent-setup install --force        # overwrite skills/commands that already exist
agent-setup install /path/to/project
agent-setup --list                 # show what the bundle contains
```

Non-destructive by default: existing skill dirs and command files are skipped;
`settings.local.json` and `.mcp.json` are **merged** (permissions and server lists
are deduped, existing keys kept). `--force` overwrites skipped items and lets the
bundle win on `.mcp.json` key clashes.

### Put it on PATH

```sh
ln -s "$PWD/bin/agent-setup" /usr/local/bin/agent-setup
# or, fish:
alias --save agent-setup="$PWD/bin/agent-setup"
```

Requires `jq` (`brew install jq`).

## What's in the bundle

Project-agnostic only — nothing tied to a specific repo, and nothing ClickUp.

| Kind | Item | Purpose |
|------|------|---------|
| skill | `commit-split` | split pending changes into ordered commits, push branch |
| skill | `openspec-propose` / `-apply-change` / `-update-change` / `-archive-change` / `-explore` / `-sync-specs` | OpenSpec change workflow |
| command | `/opsx:propose` `/opsx:apply` `/opsx:update` `/opsx:archive` `/opsx:explore` `/opsx:sync` | thin wrappers over the OpenSpec skills |
| config | `.claude/settings.local.json` | allow `docker compose`, Playwright browse tools, `Skill(claude-api)`; enable the `context7` MCP server |
| config | `.mcp.json` | `context7` MCP server (docs lookup) |

The OpenSpec skills expect the `openspec` CLI and an `openspec/` directory in the
target project.

### Deliberately excluded

ClickUp sync skills (`sync-dip-devtasks`, `sync-dip-scope-changes`), the
`.claude/clickup/` map, the ClickUp MCP permission, and repo-specific skills
(`schema-migration` — Prisma/monorepo-specific, `update-dip-tech-decisions` —
tied to one project's planning artifact).
