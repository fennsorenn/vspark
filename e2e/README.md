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

**Headless WebGL.** The chromium project launches with `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader`, forcing deterministic software WebGL so the React-Three-Fiber editor
viewport renders identically regardless of host GPU (and in GPU-less CI). `tests/editor-webgl.spec.ts`
is the spike proving the viewport mounts a live WebGL context headless — the basis for editor-level
(Phase 8) E2E breadth.

## Conventions

- **Selecting controls — never by visible text** (the UI is i18n'd EN/DE, so text assertions break
  under a locale switch). In priority order:
  1. **role + accessible name** where a labelled control suffices (resolve the name via the i18n
     resource, don't hardcode English) — needs no markup at all;
  2. otherwise the **`vs-` targeting class** (see below). Scope by a parent class for a specific
     instance, e.g. `page.locator('.vs-project-card').filter({ hasText: name }).locator('.vs-project-open')`.

  Prefer class-_scoped_ paths (`.vs-panel .vs-button`) over positional ones — **never `nth-child`**.

- **Assert state, not looks.** Prefer DOM outcomes plus a REST read-back (`request.get('/api/…')`)
  to prove a mutation actually reached the backend.
- Tests should be **independent** — seed their own data via the API rather than relying on
  another test's side effects.

### The `vs-` targeting layer (a public contract, not test scaffolding)

Stable test/automation handles are expressed as a dedicated layer of **CSS classes prefixed
`vs-`**, layered _on top of_ styling classes. This layer is a deliberate **public surface** that
userscripts, browser addons, custom themes AND this test suite all target — so unlike a
`data-testid` it earns its place in the markup (it has real, multi-consumer value) and we keep it in
production. Conventions:

- **Reserved prefix.** Styling classes never start with `vs-`; the prefix is what distinguishes the
  targeting layer (and lets the AST enumerator find handles). One `vs-` class = one logical control.
- **Stability contract.** Because external consumers depend on them, renaming a `vs-` class is a
  breaking change — treat the layer as API, don't churn it casually.
- **No test-only attributes in the markup.** Opt-out and coverage config live here in `e2e/`
  (`coverage-ignore.json`), not as `data-*` props in `src/`.
- A purely cosmetic refactor (wrapping a div, reordering) leaves the handle intact, so tests don't
  break; _moving a control to a different parent_ breaks a scoped path — which is correct: a
  structural move is exactly when the relevant tests should be re-reviewed.

### Reusable interactive components

A control built as a reusable component (e.g. the `NumInput`/`VecInput`/`SliderInput` numeric
primitives) is wrong to instrument _inside its definition_: a single hardcoded handle there is
shared by every instance, so exercising it once would mark it covered everywhere — and the
definition file is implementation, not a distinct interface surface. Instead:

1. **The component forwards a `className` prop onto its root element.** The recorder walks _up_ from
   the interacted element to the nearest `vs-` ancestor, so a handle on the root covers the whole
   control.
2. **Each call site passes a distinct `vs-` handle** — `<NumInput className="vs-transform-x" … />` —
   so every usage across every panel is enumerated and attributed independently.
3. **The definition file's internal controls are opted out** in `coverage-ignore.json` (e.g.
   `components/editor/numericInputs.tsx`), leaving the _usage sites_ as the real coverage surface.

So detection isn't fooled into "the component was tested once → covered everywhere"; each place the
control appears must be exercised on its own. The registry of such components lives in the
`COMPONENTS` set in `scripts/controls.mjs` — extend it when adding new reusable input primitives, so
their usages are detected even when they pass only custom-named callbacks (`onCommit`, `onSetKeyframe`)
that prop-name detection would miss.

## Coverage signals

Two complementary signals (both **trend** signals, not hard gates — a sharp _drop_ is the alarm):

### Control + instrumentation coverage (does a test touch every control?)

Computed on every `e2e` run by the `control-coverage` reporter. The denominator is **every
interactive control in the frontend**, enumerated from the TypeScript AST by `scripts/controls.mjs`
— a control is an intrinsic interactive element (`button`/`input`/`select`/`textarea`/`a[href]`),
any JSX element with an `on{Click,Change,Input,KeyDown,Submit,PointerDown,MouseDown,DoubleClick}`
handler, or a usage of a **registered reusable component** (see below). (3D/canvas files are skipped
— their handlers are on meshes, not DOM.) Two numbers fall out, sharing that same honest denominator:

- **control coverage** = controls whose `vs-` handle was interacted with (recorded by
  `fixtures/controlCoverage.ts`) / active controls
- **instrumentation** = controls that carry a `vs-` handle / active controls

```bash
pnpm --filter @vspark/e2e controls:report   # control count + instrumentation % + "no vs- handle" list (file:line)
pnpm --filter @vspark/e2e controls:check      # files whose control surface drifted vs the manifest
pnpm --filter @vspark/e2e controls:bless       # record the current surface as reviewed (writes the manifest)
```

**Opt-out (`coverage-ignore.json`).** A control where an e2e test makes no sense is excluded from
the denominator in `e2e/coverage-ignore.json` — kept here, not in the markup, because it is pure
test metadata:

```jsonc
{
  "files": ["pages/Experimental*.tsx"], // whole frontend-src files (glob; * = segment, ** = any)
  "controls": ["vs-dev-only-thing", "pages/Home.tsx:42"], // by vs- handle, or relpath:line
}
```

3D/canvas files (anything importing `@react-three/fiber` or `three`) are auto-excluded — their
handlers are on meshes, not DOM.

**Staleness manifest (`controls-manifest.json`, committed).** Each file has a signature of its
control surface (each control's tag + `vs-` handle + opt-out). `controls:bless` records them;
`controls:check` flags a file **STALE** when an edit changes that surface (adds a control, drops or
edits a handle) and **NEW** when a file with controls isn't recorded yet — so a newly-added control
can't slip past un-instrumented. Editing handler _internals_ does not trip it. Re-review the flagged
files (add handles) and `controls:bless` to clear them. Wire `controls:check --strict` into
CI/pre-commit to enforce the review (Phase 9).

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
