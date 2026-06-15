# @vspark/e2e — functional UI regression suite

Playwright-based end-to-end tests that boot the **real** backend + Vite frontend and drive them in
a headless browser. They assert reachability, maneuverability, and **state changes** (DOM + REST
read-back) — never appearance. There is deliberately **no screenshot/visual diffing**.

See [dev-notes/plans/automated-testing-strategy.md](../dev-notes/plans/automated-testing-strategy.md)
for the overall testing strategy (this is the Phase 3 tier).

## Running locally

```bash
# One-time: download the browser (Chromium only is enough for this suite)
pnpm --filter @vspark/e2e exec playwright install chromium

# Run the suite (boots backend + frontend automatically via webServer config)
pnpm --filter @vspark/e2e e2e

# View the last HTML report
pnpm --filter @vspark/e2e e2e:report
```

The config (`playwright.config.ts`) starts two servers:

- **backend** — `tsx src/index.ts` on a stamped throwaway SQLite DB (`vspark-e2e-<timestamp>.db`
  in the OS temp dir) with `MULTIPLAYER_RENDEZVOUS_URL=''` (multiplayer/signaling disabled).
- **frontend** — `vite` dev server on :5173, which proxies `/api` + `/ws` to the backend.

Each run gets a fresh DB, so tests start from a known-empty backend.

## Conventions

- **Select controls by `data-testid`**, not visible text — the UI is i18n'd (EN/DE), so text
  assertions would break under a locale switch. Add a `data-testid` to any control a test needs.
- **Assert state, not looks.** Prefer DOM outcomes plus a REST read-back (`request.get('/api/…')`)
  to prove a mutation actually reached the backend.
- Tests should be **independent** — seed their own data via the API rather than relying on
  another test's side effects.

## Coverage signals

Two complementary signals (both **trend** signals, not hard gates — a sharp *drop* is the alarm):

### Control coverage (which controls does any test touch?)
Runs automatically on every `e2e` run via the `control-coverage` reporter. It diffs the
`data-testid` inventory (`scripts/inventory-controls.mjs`) against the set actually interacted
with (recorded by `fixtures/controlCoverage.ts`) and prints the % plus the **"never interacted
with"** list — the controls no test exercises. A machine-readable copy lands in
`.coverage/control-coverage.json`.

### Instrumentation coverage (is the control-coverage denominator complete?)
Control coverage only sees controls that carry a `data-testid`, so a component with interactive
UI but **no** test ids is invisible and silently inflates the %. Instrumentation coverage measures
that blind spot:

```bash
pnpm --filter @vspark/e2e instrument:report   # % of interactive components that carry a testid + blind-spot list
pnpm --filter @vspark/e2e instrument:check     # files whose interactive surface drifted vs the manifest
pnpm --filter @vspark/e2e instrument:bless      # record the current surface as reviewed (writes the manifest)
```

`scripts/instrumentation.mjs` counts interactive markers (`button`/`input`/`select`/`textarea`/
anchor + `on{Click,Change,Input,KeyDown,Submit}` handlers) per `.tsx` file (heuristic, regex — not
a full parser; 3D/canvas files are excluded, opt out elsewhere with an `instrumentation-ignore-file`
marker comment). It reports the fraction of interactive components carrying ≥1 `data-testid` and
lists those with none. The reporter prints this **next to** control coverage so a high control % is
never read in isolation.

**Staleness manifest (`instrumentation-manifest.json`, committed).** Each interactive file has a
signature of its interactive surface (tag/handler/testid counts). `instrument:bless` records them;
`instrument:check` flags a file **STALE** when an edit changes that surface (adds a control, drops a
testid) and **NEW** when an interactive component isn't in the manifest yet — so newly-added UI
elements can't slip past un-instrumented. Editing handler *internals* does not trip it. Re-review
the flagged files (add testids as needed) and `instrument:bless` to clear them. Wire
`instrument:check --strict` into CI/pre-commit to enforce the review.

### E2E code coverage (which source lines does a UI run reach?)
```bash
pnpm --filter @vspark/e2e e2e:coverage     # COVERAGE=1 → vite instruments via istanbul
pnpm --filter @vspark/e2e coverage:report  # nyc → text-summary + html + lcov + json-summary
pnpm --filter @vspark/e2e coverage:trend   # compare to baseline, warn on a drop
```
`vite-plugin-istanbul` instruments the frontend **only when `COVERAGE` is set** (never the
production build). The per-test fixture harvests `window.__coverage__` into `.nyc_output/`.

A high % is a weak positive; a **sharp drop is a strong negative** (orphaned/unreachable code, or
new functionality shipped without a UI path). `coverage:trend` compares the line % to
`coverage-baseline.json` and warns past `COVERAGE_DROP_THRESHOLD` (default 1.5%); set
`COVERAGE_FAIL_ON_DROP=1` to make it exit non-zero. `coverage:trend --update` writes the baseline.

**Sharpen the signal with annotations.** Code that is intentionally NOT reachable via UI
interaction (CLI/bootstrap paths, dev-only branches, defensive `assertNever`, backend-only modules)
should carry an istanbul ignore hint **with a reason**:
```ts
/* istanbul ignore next -- bootstrap-only, never hit from the UI */
```
The cleaner these annotations, the more a coverage drop means a real UI regression vs. noise.
A future lint rule should require the `-- reason`. (The codebase-wide annotation sweep + the
committed ratcheted baseline are Phase 9 of the testing plan.)

## CI job (apply manually)

This job is not yet in `.github/workflows/ci.yml` because the originating session's token lacked
GitHub `workflow` scope. Add it as a separate job (it's minutes, not seconds — keep it off the
fast `build` job):

```yaml
  e2e:
    runs-on: ubuntu-latest
    container:
      image: mcr.microsoft.com/playwright:v1.61.0-noble
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @vspark/e2e e2e
        env:
          CI: 'true'
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: e2e/playwright-report/
          retention-days: 7
```
