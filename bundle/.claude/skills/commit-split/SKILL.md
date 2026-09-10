---
name: commit-split
description: Split pending changes into logical, dependency-ordered git commits and push the branch. Use when the user types "commit-split"/"COMMIT-SPLIT" or asks to split commits, do staged commits per concern, or commit-and-push what's pending.
license: MIT
---

Split the pending changes in the current repo into separate, logically grouped commits — then
push. This is a personal workflow (works in any repo), adapted from an old Cursor rule: the old
version only printed `git add`/`git commit` command blocks for the user to paste and never
pushed. This version actually runs them and pushes, because committing is meant to be one
deliberate step, separate from editing (see the global rule in `~/.claude/CLAUDE.md`).

**Never use `--no-verify`.** Pre-commit/commit-msg hooks (lint-staged, commitlint, husky, etc.)
must run normally for every commit. If a hook reformats files or fails, fix it forward and
retry that commit — never bypass it.

**Steps**

1. **Inventory changes**
   - Run `git status --porcelain=v1` and `git diff` (staged + unstaged) to see everything
     pending, including untracked files.
   - If there's nothing pending, say so and stop.

2. **Branch check**
   - Get the current branch (`git rev-parse --abbrev-ref HEAD`) and the repo's default branch
     (`git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to checking whether
     `main`/`master`/`develop`/`trunk` exists locally).
   - If currently on the default branch, first `git pull` it to make sure it's up to date with
     the remote, and only then create and switch to a new branch off it (`git checkout -b
<name>`). Derive `<name>` from what actually changed (kebab-case, Conventional-Commits-
     style prefix: `feat/…`, `fix/…`, `chore/…`, `docs/…`). If it's genuinely unclear what to
     call it, ask the user for a short name instead of guessing badly.
   - If the project has a ticket/issue code convention for branch names, follow it.
   - If on a non-default branch that already exists on the remote (has an upstream), `git fetch
origin` and check whether the default branch has commits the current branch doesn't
     (`git log <branch>..origin/<default>`). If so, bring them in with `git merge
origin/<default>` before doing anything else — **merge, never rebase**, since the branch is
     already pushed and rebasing would force a `--force` push later. Resolve conflicts if
     trivial; if a conflict is ambiguous (not an obvious "both sides added independent lines"
     case), stop and show it to the user instead of guessing a resolution. `git merge` runs
     through the commit-msg hook too — if commitlint rejects a custom `-m` merge message (its
     `type-enum` doesn't include `merge`), redo the commit with the standard git-generated
     wording (`Merge branch '<default>' into <branch>` / `Merge remote-tracking branch
'origin/<default>'...`), which commitlint's default ignore rules recognize.
   - Never commit directly on the default branch.

3. **Quality gates**
   - Check the conversation so far: were lint/format/typecheck/test already run after the last
     code change (and after any merge from step 2), and did they pass? If yes and nothing
     changed since, don't rerun.
   - **A pre-commit hook (lint-staged etc.) is not equivalent to CI.** Lint-staged-style hooks
     only check the files staged in _that_ commit — a file committed earlier and left untouched
     since won't get re-checked by a later commit's hook, but a full-repo CI job (e.g. `prettier
--check` over the whole tree, not just a diff) will still catch it. Don't rely on hooks
     alone to prove the branch is clean.
   - Find out what the CI pipeline actually runs, so the same checks run locally before the
     push instead of failing remotely: look for CI config at the repo root and per-app/package
     (`.gitlab-ci.yml`, `.github/workflows/*.yml`, `.circleci/`, etc.) and this repo's
     `CLAUDE.md` ("Comandos"/"Regras" sections usually document the canonical commands). Map
     each validation job to its local command — check root `package.json` scripts first (a CI
     job named e.g. `prettier`/`check`/`test` usually has a same- or similarly-named script;
     prefer the exact script the CI job calls over a close-enough guess, e.g. `test:ci`/`test:cov`
     over plain `test` if that's what CI runs, so coverage thresholds are actually checked),
     then per-app scripts, then a `Makefile`. Never invent a command that doesn't exist in the
     project.
   - Run every locally-reproducible job from that pipeline, not just lint/typecheck/test —
     dependency audit (e.g. `pnpm audit --audit-level high` or equivalent) is a common one that
     gets skipped but fails CI just as easily. Skip only jobs that need CI-only infra, secrets,
     or a running server to work at all (Sonar, image/container scans, deploy jobs) — name which
     ones were skipped and why in the final report, don't just silently omit them.
   - If a check fails, stop and report the failure — do not commit broken code.

4. **Group into logical commits**
   - Group the pending files by concern (e.g. shared types vs. one app, one module, docs,
     config) — one commit per logical unit, not one commit per file and not everything in one.
   - Order the commits by dependency: e.g. a shared package before the app that consumes it,
     backend before a frontend change that depends on it, schema/config before the code that
     uses it.
   - Each commit message is **only a title, one line, imperative, in English** — Conventional
     Commits style (`type: message`, e.g. `chore: estrutura inicial do monorepo (web, api,
shared)`). Add a `(scope)` only if the repo's `commitlint.config.*` requires one and
     dictates its case; otherwise skip the scope. **Never add a body/description** — a single
     `-m "..."` per commit, nothing else. Default types when the repo has no commitlint config:
     `feat`/`fix`/`docs`/`style`/`refactor`/`perf`/`test`/`build`/`ci`/`chore`/`revert`.

5. **Execute**
   - For each group, in order: `git add <files>` then `git commit -m "type: message"` (single
     line, no body).
   - Before pushing, double-check every commit title in this batch is a single-line
     `type: message` (or `type(scope): message` if the repo requires scopes) with no body text.
   - Let hooks run. If a hook modifies files (e.g. auto-format) or fails, re-stage/fix and
     retry that same commit — don't skip ahead leaving it broken.

6. **Push**
   - Once all commits succeed, push the branch: `git push -u origin <branch>` if it has no
     upstream yet, otherwise `git push`. Never force-push.
   - Capture the MR/PR creation URL. GitLab prints one directly in the push output (`remote: ...
merge_requests/new?...`) — reuse that. If the remote doesn't print one (e.g. GitHub), build
     it from the remote instead: `https://github.com/<owner>/<repo>/compare/<default-branch>...
<branch>?expand=1`.

7. **Report**
   - Summarize in the user's language (Portuguese by default): each commit created (short hash
     - message) in order, and the branch pushed.
   - Always include the MR/PR creation link from step 6 so the user can open it and create the
     MR/PR themselves. **Never create the MR/PR** — not via `gh pr create`, `glab mr create`, or
     any other command — even if such a tool is available; only hand over the link.
   - Always finish with a suggested MR/PR title, on its own line, as **plain text only** (no
     backticks, no quotes, no markdown formatting) so it can be copied straight into GitLab/
     GitHub's title field. Derive it from the overall set of changes, not just the last commit —
     Conventional-Commits style, in the user's language, one line.

**When NOT to auto-execute**: if grouping the changes is genuinely ambiguous (e.g. unrelated
changes tangled in the same file in a way that can't be cleanly split), show `git status` and
the proposed grouping and ask before committing, instead of guessing.
