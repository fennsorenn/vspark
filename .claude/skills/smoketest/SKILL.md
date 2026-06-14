---
name: smoketest
description: >-
  Smoke-test new changes or features. Inspects the instruction context and git
  diff to scope what changed, plans a small set of API and/or browser (Playwright)
  tests, brings up the app, runs them, and captures screenshots. If a PR exists
  for the current branch it posts a results summary as a PR comment and commits a
  detailed markdown report plus screenshots. Always reports a concise result back
  to the calling agent. Use when asked to smoke-test, sanity-check, verify, or
  "test" a change/feature before or after pushing.
---

# Smoketest

Lightweight, scope-driven smoke testing for a change or feature. This is **not**
a full test suite — the goal is to exercise the code paths the current change
actually touches, prove they work end-to-end, and produce evidence (pass/fail +
report + screenshots).

You will usually be invoked by another agent that just made a change. Treat the
caller's task description as the primary signal for *what to test*, and the git
diff as the ground truth for *what actually changed*.

> **Project specifics live in [project.md](project.md).** Everything in this file
> is project-agnostic and refers to concrete facts — ports, commands, paths, repo
> slug, base branch, route conventions — by name. **Read `project.md` first**, and
> to port this skill to another project, edit `project.md` only.

## Workflow

### 1. Establish scope

Figure out what changed and what kind of testing it needs.

- Read the instruction/context you were given (the caller's task, any args).
- Inspect the diff against the **base branch** (see `project.md`):
  - `git fetch origin <base>` then `git diff --stat origin/<base>...HEAD` and
    `git diff origin/<base>...HEAD` (fall back to `git diff HEAD~1` if the base
    is unavailable).
- Classify each changed area using the **path → test-type map** in `project.md`:
  - Backend / API paths → **API tests**.
  - Frontend / UI paths → **browser (Playwright) tests**.
  - Both → do both. Pure docs / config-only diffs → say so and skip runtime
    tests (still report).

Write down a short test plan (3–8 checks) before running anything. Keep it
proportional to the diff — a one-route change gets a couple of assertions, not a
tour of the whole app.

### 2. Bring up the app

Use the **install / run commands, ports, and readiness probes** from
`project.md`. Start the servers with `run_in_background: true`, and poll the
readiness probe until each is up before testing — do **not** `sleep`-guess.

If a server crashes on boot, that is itself a test failure — capture the log
output and report it.

### 3. Author and run the tests

Keep tests ephemeral — write them to a scratch dir (e.g. `/tmp/smoketest/`), not
into the repo source tree.

**API tests.** Discover exact routes/shapes from the project's API surface (see
`project.md` for the base path and any live spec, e.g. an OpenAPI document).
Drive endpoints with `curl` or a small script and assert status + response shape.
For stateful flows, create → act → read-back → clean up.

**Browser (Playwright) tests.** Check `project.md` for whether Playwright is
preinstalled and how to load it. Use the runner template in
[templates/playwright-smoke.mjs](templates/playwright-smoke.mjs) as a starting
point: it launches Chromium headless, navigates, waits for content, runs your
assertions, and screenshots each step. Drive the real UI using the **routes
listed in `project.md`**. Capture a screenshot for every meaningful state — both
to **show off the feature** and to surface visual regressions. Check the browser
console for errors and treat uncaught exceptions as failures.

Save screenshots to `/tmp/smoketest/shots/` with descriptive names
(`01-...png`, `02-...png`, …).

### 4. Detect a PR for the current branch

```bash
git branch --show-current
```

Use the GitHub MCP tools (load via ToolSearch — `mcp__github__list_pull_requests`,
`mcp__github__pull_request_read`, `mcp__github__add_issue_comment`). List open PRs
with `head` = the current branch on the **repo slug from `project.md`**. If
exactly one matches, that's the target PR. If none, skip the PR-publishing step.
If several, don't guess — note it in the report and pick the most recent, or ask
via the caller.

### 5. Report

Build a detailed markdown report from [templates/report-template.md](templates/report-template.md):
scope summary, the test plan, per-check pass/fail with evidence, console/server
errors, and embedded screenshots.

**If a PR exists:**

1. Commit the report + screenshots so they're reachable from the comment (the
   GitHub API can't attach files to a comment; committing to the branch and
   linking is the reliable path):
   - Put them under the **report directory from `project.md`**, in a
     `<branch>-<UTC-timestamp>/` subfolder (report.md + shots/). Commit with
     `chore: add smoketest report` and push to the current branch
     (`git push -u origin <branch>`, retry on network error).
2. Post a **concise** PR comment via `mcp__github__add_issue_comment` (PR number =
   issue number): overall PASS/FAIL, the check counts, the headline findings, a
   link to the committed `report.md`, and a few inline screenshots referenced by
   their committed blob URL with `?raw=true` (URL shape in `project.md`) so they
   render. Don't dump the whole report into the comment.

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
place (cheap, ephemeral container). Do **not** commit scratch tests or dependency
changes.

## Notes & guardrails

- **Don't widen scope.** A smoke test proves the change works; it is not a full
  regression run. Match effort to the diff.
- **Real failures are the deliverable.** If something is broken, report it
  plainly with the error output — never paper over a failing check.
- **Idempotency.** Clean up any entities your API tests create so reruns stay
  green; never assume a fixed id exists — create your own.
- **Migrations / schema changes** in the diff: a clean backend boot already
  exercises them; note in the report that they applied without error.
- See `project.md` for any **project-specific test hooks** (e.g. i18n/locale
  checks) worth folding in when the diff touches those areas.
