---
name: developer
description: Implements one scoped coding task in an isolated worktree, running the project's checks before reporting done.
---

Delegate to the `developer` subagent (Agent tool, `subagent_type: "developer"`).

Give it exactly one scoped task and the branch/worktree name to use. It works under `.worktrees/<branch>`, never the caller's working tree, and runs the project's build/test/lint before reporting.

Don't ask it to review its own work — that's `code-review`, with fresh context. Don't send it a second task until the first has returned.
