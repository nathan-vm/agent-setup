#!/usr/bin/env bash
set -euo pipefail

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "This repo uses an agentic workflow: for any non-trivial feature, fix, or refactor, invoke the orchestrator skill instead of implementing directly. It delegates to planner, developer, code-review, and (conditionally) qa, each a pinned Sonnet/Haiku sub-agent at medium effort or lower. Escalating model or effort beyond that requires asking the user first."
  }
}
JSON
