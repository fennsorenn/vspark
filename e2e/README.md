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

### Control + instrumentation coverage (does a test touch every control?)
Computed on every `e2e` run by the `control-coverage` reporter. The denominator is **every
interactive control in the frontend**, enumerated from the TypeScript AST by `scripts/controls.mjs`
— a control is an intrinsic interactive element (`button`/`input`/`select`/`textarea`/`a[href]`) or
any JSX element with an `on{Click,Change,Input,KeyDown,Submit,PointerDown,MouseDown,DoubleClick}`
handler. (3D/canvas files are skipped — their handlers are on meshes, not DOM.) Two numbers fall
out, sharing that same honest denominator:

- **control coverage** = controls whose `data-testid` was interacted with (recorded by
  `fixtures/controlCoverage.ts`) / active controls
- **instrumentation** = controls that carry a `data-testid` / active controls

```bash
pnpm --filter @vspark/e2e controls:report   # control count + instrumentation % + "no test id" list (file:line)
pnpm --filter @vspark/e2e controls:check      # files whose control surface drifted vs the manifest
pnpm --filter @vspark/e2e controls:bless       # record the current surface as reviewed (writes the manifest)
```

**Opt-out.** A control where an e2e test makes no sense is excluded from the denominator with a
`data-coverage-ignore` prop on the element (a valid `data-*` attribute — renders harmlessly):
```tsx
<button data-coverage-ignore onClick={devOnlyThing}>…</button>
```
Opt a whole file out with an `instrumentation-ignore-file` marker comment.

**Staleness manifest (`controls-manifest.json`, committed).** Each file has a signature of its
control surface (each control's tag + testid + opt-out). `controls:bless` records them;
`controls:check` flags a file **STALE** when an edit changes that surface (adds a control, drops or
edits a testid, toggles opt-out) and **NEW** when a file with controls isn't recorded yet — so a
newly-added control can't slip past un-instrumented. Editing handler *internals* does not trip it.
Re-review the flagged files (add testids / opt-outs) and `controls:bless` to clear them. Wire
`controls:check --strict` into CI/pre-commit to enforce the review (Phase 9).

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
