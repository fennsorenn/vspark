---
name: smoketest
description: >-
  Smoke-test new changes or features in vspark. Inspects the instruction context
  and git diff to scope what changed, plans a small set of API and/or Playwright
  frontend tests, brings up the app, runs them, and captures screenshots. If a PR
  exists for the current branch it posts a results summary as a PR comment and
  commits a detailed markdown report plus screenshots. Always reports a concise
  result back to the calling agent. Use when asked to smoke-test, sanity-check,
  verify, or "test" a change/feature before or after pushing.
---

# Smoketest

Lightweight, scope-driven smoke testing for vspark. This is **not** a full test
suite — the goal is to exercise the code paths that the current change actually
touches, prove they work end-to-end, and produce evidence (pass/fail + report +
screenshots).

You will usually be invoked by another agent that just made a change. Treat the
caller's task description as the primary signal for *what to test*, and the git
diff as the ground truth for *what actually changed*.

## Workflow

### 1. Establish scope

Figure out what changed and what kind of testing it needs.

- Read the instruction/context you were given (the caller's task, any args).
- Inspect the diff against the base branch:
  - `git fetch origin dev` then `git diff --stat origin/dev...HEAD` and
    `git diff origin/dev...HEAD` (fall back to `git diff HEAD~1` if `dev` is
    unavailable).
- Classify each changed area:
  - **Backend / API** — `packages/backend/`, `packages/shared/` (routes, signal
    nodes, managers, schemas, migrations). → **API tests**.
  - **Frontend / UI** — `packages/frontend/` (React, R3F viewport, editor
    panels, store, i18n/help). → **Playwright tests**.
  - Both → do both. Pure docs / config-only diffs → say so and skip runtime
    tests (still report).

Write down a short test plan (3–8 checks) before running anything. Keep it
proportional to the diff — a one-route change gets a couple of API assertions,
not a tour of the whole app.

### 2. Bring up the app

vspark is a backend (Express, **:3001**) + frontend (Vite, **:5173**) monorepo.

```bash
pnpm install            # only if node_modules is missing
pnpm dev:backend        # run_in_background — serves http://localhost:3001
pnpm dev:frontend       # run_in_background — serves http://localhost:5173 (only if UI is in scope)
```

Start them with `run_in_background: true`. Poll until ready before testing —
do **not** `sleep`-guess:

```bash
# backend
until curl -sf http://localhost:3001/api-docs.json >/dev/null; do sleep 1; done
# frontend
until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done
```

If a server crashes on boot, that is itself a test failure — capture the log
output and report it.

### 3. Author and run the tests

Keep tests ephemeral — write them to a scratch dir (e.g. `/tmp/smoketest/`), not
into the repo source tree.

**API tests.** The full REST surface is described by the live OpenAPI spec at
`http://localhost:3001/api-docs.json` (Swagger UI at `/api-docs`). Read it to
discover exact routes/shapes for whatever the diff touched. Routes live under
`/api/*` (e.g. `/api/projects`, `/api/scene-nodes/:id/behaviors`,
`/api/behavior-kinds`). Drive them with `curl` or a small Node script and assert
status + response shape. For stateful flows, create → act → read-back → clean up.

**Playwright tests.** Playwright is **preinstalled globally** in this
environment — do not install it. The CLI works directly. To `require`/`import`
it from a Node script, put the global modules dir on Node's path:

```bash
NODE_PATH=$(npm root -g) node /tmp/smoketest/smoke.mjs
```

Use the runner template in [templates/playwright-smoke.mjs](templates/playwright-smoke.mjs)
as a starting point: it launches Chromium headless, navigates to the editor,
waits for the canvas, runs your assertions, and screenshots each step. Drive the
real UI (Home `/`, Editor `/:projectId`, `/docs`). Capture a screenshot for every
meaningful state — both to **show off the feature** and to surface visual
regressions. Check the browser console for errors and treat uncaught exceptions
as failures.

Save screenshots to `/tmp/smoketest/shots/` with descriptive names
(`01-home.png`, `02-editor-loaded.png`, …).

### 4. Detect a PR for the current branch

```bash
git branch --show-current
```

Use the GitHub MCP tools (load via ToolSearch — `mcp__github__list_pull_requests`,
`mcp__github__pull_request_read`, `mcp__github__add_issue_comment`). List open PRs
with `head` = the current branch on `fennsorenn/vspark`. If exactly one matches,
that's the target PR. If none, skip the PR-publishing step. If several, don't
guess — note it in the report and pick the most recent, or ask via the caller.

### 5. Report

Build a detailed markdown report from [templates/report-template.md](templates/report-template.md):
scope summary, the test plan, per-check pass/fail with evidence, console/server
errors, and embedded screenshots.

**If a PR exists:**

1. Commit the report + screenshots so they're reachable from the comment (the
   GitHub API can't attach files to a comment; committing to the branch and
   linking is the reliable path):
   - Put them under `smoketest-reports/<branch>-<UTC-timestamp>/` (report.md +
     shots/). Commit with `chore: add smoketest report` and push to the current
     branch (`git push -u origin <branch>`, retry on network error).
2. Post a **concise** PR comment via `mcp__github__add_issue_comment` (PR number =
   issue number): overall PASS/FAIL, the check counts, the headline findings, a
   link to the committed `report.md`, and a few inline screenshots referenced by
   their committed blob URL with `?raw=true` (e.g.
   `https://github.com/fennsorenn/vspark/blob/<branch>/smoketest-reports/<dir>/shots/02-editor-loaded.png?raw=true`)
   so they render. Don't dump the whole report into the comment.

   Be frugal: one comment per smoketest run, not a play-by-play.

**Always — regardless of whether a PR exists** — return a concise summary to the
calling agent as your final message:

- Overall result: **PASS** / **FAIL** / **PARTIAL** (+ docs/config-only → skipped).
- Counts: N checks, P passed, F failed.
- The most important findings (what broke, or what was verified working).
- Where the artifacts are (committed report path + PR comment link if posted, or
  the local `/tmp/smoketest/` paths if not).

The calling agent acts on this summary, so lead with the verdict and keep it
tight.

### 6. Clean up

Stop the background dev servers when done. Leave `/tmp/smoketest/` scratch in
place (cheap, ephemeral container). Do **not** commit scratch tests or
`node_modules` changes.

## Notes & guardrails

- **Don't widen scope.** A smoke test proves the change works; it is not a full
  regression run. Match effort to the diff.
- **Real failures are the deliverable.** If something is broken, report it
  plainly with the error output — never paper over a failing check.
- **Idempotency.** Clean up any entities your API tests create so reruns stay
  green; never assume a fixed project/scene id exists — create your own.
- **i18n/help changes** (`packages/frontend/src/i18n/`, `help/content/`) are
  Playwright-testable: switch language in the UI and assert strings render in
  both EN and DE, and that `?` HelpButtons open the right doc anchor.
- **Migrations** in the diff: a clean backend boot already exercises them; note
  in the report that migrations applied without error.
