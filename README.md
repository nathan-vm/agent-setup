# agents-setup

Shared multi-agent tooling for Claude Code, in two parts:

- **`observability/`** — local stack (OTel Collector + Prometheus + Grafana)
  that tracks Claude Code cost/token usage across every session. See
  [`observability/README.md`](observability/README.md).
- **`bin/agent-setup` + `bundle/`** — installer that drops a project-agnostic set of
  Claude Code skills, commands and MCP config into any project.

## `agent-setup`

Run it from inside a project to install the bundle into `./.claude` and `./.mcp.json`:

```sh
agent-setup            # install into the current directory
agent-setup --list     # show what the bundle contains
agent-setup --force    # overwrite skills/commands that already exist
agent-setup /path/to/project
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
