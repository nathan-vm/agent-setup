---
name: qa
description: Exercises a finished, reviewed change the way a user would. Use for user-facing changes, after review passes.
---

Delegate to the `qa` subagent (Agent tool, `subagent_type: "qa"`).

Pass it the branch/worktree name and what the change is supposed to do from a user's point of view. It runs the thing for real and reports what it observed.

Skip it for pure refactors, internal-only changes, and doc/config edits — there is nothing for a user to exercise.
