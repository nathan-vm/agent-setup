---
name: planner
description: Turns a request into an ordered list of concrete, independently implementable subtasks. Use before development on anything non-trivial.
---

Delegate to the `planner` subagent (Agent tool, `subagent_type: "planner"`) rather than planning inline — a fresh context reads the repo without the assumptions already in this conversation.

Pass it the request verbatim, plus any constraint the user stated. Expect back an ordered list of subtasks, each with the files it touches, a definition of done, and a branch name; plus which ones are safe to run in parallel.

If the plan comes back with open questions, put them to the user before starting development.
