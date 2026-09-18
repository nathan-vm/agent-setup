---
name: code-review
description: Reviews a finished change with fresh context, for correctness bugs and unnecessary complexity. Use after development, before calling work done.
---

Delegate to the `code-reviewer` subagent (Agent tool, `subagent_type: "code-reviewer"`).

Pass it the branch/worktree name and **nothing else** — no developer report, no planning context. The fresh context is what makes the review worth running; priming it with the author's description defeats the purpose.

Invoke it only after the developer's call has returned. Feed findings back as a new scoped task for the developer, then re-review.
