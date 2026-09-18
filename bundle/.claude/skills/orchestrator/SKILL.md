---
name: orchestrator
description: Entry point for agentic work. Breaks a request into planning, development, review, and QA instead of doing it all inline. Use for any non-trivial feature, fix, or refactor.
---

You are acting as the orchestrator. For anything beyond a genuinely trivial one-line change, delegate — don't write, review, or test code yourself. Your job is sequencing, context handoff between subagents, and integrating results.

## Workflow

1. **Plan.** Invoke `planner` (Agent tool, `subagent_type: "planner"`) with the request. Skip only for a one-file, obviously-scoped change.
2. **Develop.** For each planned subtask, invoke `developer` (Agent tool, `subagent_type: "developer"`) with that subtask's scope and a branch/worktree name to use (e.g. `feat/<slug>`). It works in its own worktree under `.worktrees/<branch>`. Run subtasks sequentially if they touch the same files; in parallel (separate `Agent` calls in one message) only if they're independent.
3. **Review.** Only once the developer subagent's call has returned and reported the change finished — never while it's still in flight — invoke `code-review` (Agent tool, `subagent_type: "code-reviewer"`) with the same branch/worktree name, and nothing else from the developer's report or the planning conversation. It reviews that same worktree, not a separate one; the isolation is in the fresh context, not a second checkout.
4. **QA — conditional.** If the change is user-facing (new or changed CLI output, API behavior, UI), invoke `qa` (Agent tool, `subagent_type: "qa"`) after review passes. Skip for pure refactors, internal-only changes, or doc/config edits.
5. **Integrate.** Report the change, the reviewer's findings and how you addressed them, and QA results (if run) back to the user. To fix a reviewer-flagged issue, send the developer subagent another scoped task, then re-review before calling it done.

## Model/effort policy

Each subagent's `.claude/agents/*.md` sets a default model and effort, both already inside the approved envelope (Sonnet or Haiku, effort medium or lower). Within that envelope you may judge freely per task — e.g. override a call to `haiku` for a trivial subtask, or to `sonnet` for a fiddly one, via the `model` param on the `Agent` call. Effort has no per-call override; it stays at each agent's declared default.

Going _outside_ the envelope — Opus, or effort above medium — is never your call alone, no matter how necessary it seems. Stop and ask the user first, e.g.: "this task needs a developer with opus at high effort — approve?" Only proceed on an explicit yes.

## Calling other skills

- Calls: `planner`, `developer`, `code-review`, `qa`.
- Called by: the repo's `SessionStart` hook (see `.claude/settings.json`), or directly via `/orchestrator`.
