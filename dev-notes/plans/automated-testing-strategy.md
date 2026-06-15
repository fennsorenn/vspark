# Plan: Automated testing strategy (unit, API, UI regression + control coverage)

> Branch: `claude/automated-testing-strategy-zlryx4` · Status: in progress
> This plan is the seed context for an implementation session. It is a starting point,
> not an airtight spec — refine it interactively as gaps surface.
>
> **Progress:** Phase 0 (Vitest infra) ✅ · Phase 1 (unit exemplars) ✅ · Phase 2 (API
> integration + `createApp()` refactor) ✅ · Phase 3 (functional Playwright exemplars) ✅ ·
> Phase 4 (both UI coverage signals) ✅. The full-coverage phases 5–9 are pending. The CI
> `Test`/`e2e` steps are written but NOT yet pushed (the session's OAuth token lacks GitHub
> `workflow` scope — apply manually; the e2e job YAML is in `e2e/README.md`).

## Goal

Stand up automated testing across the monorepo so regressions are caught before
merge. Three layers of correctness checks (unit, API integration, functional UI),
plus a **custom "UI control coverage" reporter** that answers "which interactive
controls does no test exercise yet?" — the indicator of untested behaviour the
user actually wants, distinct from line coverage.

Today the only correctness gate is `pnpm lint` (type-check) + `pnpm build`. Two
packages already run Vitest (`@vspark/mesh`, `@vspark/mesh-transports`); the rest
have no tests. CI (`.github/workflows/ci.yml`) never runs tests.

## Constraints

- **Standardize on Vitest** for unit + API tiers. It's already in use (v3.x), Vite-native,
  zero-config ESM/TS. Do **not** introduce Jest.
- **Playwright** (`@playwright/test`, its own runner — NOT merged into Vitest) for the UI tier.
- UI tier is **functional only**: assert reachability, maneuverability, and correct state
  changes. **No visual/screenshot-diff regression** (explicitly ruled out by the user —
  high maintenance, environment-flaky). No `toHaveScreenshot()` gates.
- Reuse the existing Vitest pattern from `packages/mesh/vitest.config.ts` (simple
  `test.include` config, `"test": "vitest run"` script). Match it; don't reinvent.
- Backend persistence is `node-sqlite3-wasm` (WASM, async `initDb()`, no native addon) —
  in-memory DB per test is clean and fast; lean on it.
- Respect the i18n constraint: UI tests must **not** hardcode English visible strings.
  Query by `data-testid`, ARIA role, or the resolved translation value, so DE locale
  doesn't break them.
- Rollout uses `--passWithNoTests` so empty packages don't fail the suite mid-migration.
- This is a **broad, shallow base**: one or two exemplary tests per tier to establish the
  pattern, not exhaustive coverage. Future tests are copy-and-adapt.

## Files in scope

### Tier 0 — infra
- `package.json` (root) — add `"test": "pnpm -r test"`.
- `packages/shared/package.json` — add `vitest` devDep + `"test": "vitest run --passWithNoTests"`.
- `packages/shared/vitest.config.ts` — new, mirror mesh.
- `packages/backend/package.json` — add `vitest`, `supertest` (+ `@types/supertest`) devDeps + test script.
- `packages/backend/vitest.config.ts` — new.
- `packages/frontend/package.json` — add `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom` devDeps + test script.
- `packages/frontend/vitest.config.ts` — new (`environment: 'jsdom'`).
- `.github/workflows/ci.yml` — add a `test` job (`pnpm test`) after lint; add a separate
  `e2e` job (Playwright). Decide required-vs-advisory gating per tier (see Approach).

### Tier 1 — unit (exemplars)
- `packages/shared/test/signal_types.test.ts` — `isAssignable` (record width-subtyping,
  `unknown` wildcard both directions, the `List<E>` accepts-`E` special case), `transportOf`.
- `packages/shared/test/inference.test.ts` — `InferGraph.tryAddEdge`: one accepted edge +
  one rejected edge with transactional rollback verified.
- `packages/backend/test/engine.test.ts` — build a tiny `GraphDescriptor`, `fire()` an event
  through 2–3 wired nodes, assert the output emitter fired with the right payload + `getStates()`.
  Exercises `fromDescriptor`, edge wiring, push/pull transport in one shot.

### Tier 2 — API integration (exemplar + prerequisite refactor) ✅ DONE
- `packages/backend/src/app.ts` — **new**: `createApp()` builds the Express app with all routes
  mounted **without** `listen()` / UDP bind / WS bind / managers. (Done as a separate module
  rather than in-place in `index.ts` to keep the diff clean.)
- `packages/backend/src/index.ts` — now imports `createApp({ wsSync })`; the http server + WS
  upgrade + manager wiring stay in `start()`.
- `packages/backend/test/helpers/testApp.ts` — sets `VSPARK_DB_PATH=':memory:'`, dynamic-imports
  db+app, resets + migrates a fresh in-memory DB per call, returns `{ app }` for supertest.
- `packages/backend/test/api.projects.test.ts` — list/create/read-back + validation + isolation.
  (Note: projects has no GET-by-id, so read-back uses the list endpoint.)

### Tier 3 — functional UI (Playwright) + control coverage
- `e2e/` (new top-level dir) — `playwright.config.ts` (uses `webServer` to boot backend +
  frontend against a seeded test DB), `tests/`, `fixtures/` (seed project JSON, sample assets).
- `e2e/tests/editor-smoke.spec.ts` — exemplar functional specs (see Approach for the flows).
- `e2e/fixtures/` — deterministic seed: a known project loaded via the API before each spec.
- `e2e/reporters/control-coverage.ts` — **custom reporter** computing UI control coverage.
- `e2e/scripts/inventory-controls.mjs` — static scan of frontend source for interactive
  controls (the coverage denominator).
- `packages/frontend/src/**` — add `data-testid` to interactive controls as needed for stable
  selectors + the coverage inventory. Consider an ESLint rule later to enforce testids on
  interactive elements (out of scope for this pass; note it).

## Out of scope

- Visual / screenshot-diff regression testing (explicitly dropped).
- Coverage **gates/thresholds** during Phases 0–4 — collect numbers first; hard gates land in
  Phase 9 once each tier has real coverage (ratcheted to the achieved number). UI E2E code
  coverage stays a *trend/drop* signal, never a hard gate (see Phase 4b).
- R3F/WebGL 3D rendering correctness in unit tests (jsdom can't; that's the `verify`/`smoketest`
  skills' territory). Extract pose/IK *math* into pure functions and unit-test that instead.
- Overlive / Twitch / StreamElements network integration tests.
- Autonomous crawler / "monkey" UI exploration (note as a future option for inventory discovery).
- Backend coverage *during E2E* via `NODE_V8_COVERAGE` — low priority (Phase 4b step 5); API
  coverage already comes from the supertest tier natively.
- Real Overlive/Twitch network calls — mock the SDK; no live network tests.
- Autonomous crawler / "monkey" UI exploration (note as a future option for inventory discovery).
- Exhaustive per-module suites are deferred to Phases 5–9; Phases 0–4 land the harness + exemplars
  + the two coverage signals only.

## Approach

### Phase 0 — Vitest infra (all packages) ✅ DONE
1. Add Vitest + `vitest.config.ts` to `shared`, `backend`, `frontend` mirroring the mesh config.
   Frontend config sets `environment: 'jsdom'`. Add `"test": "vitest run --passWithNoTests"` to each.
2. Root `"test": "pnpm -r --if-present test"`. Verify `pnpm test` runs green.
3. CI: add a `Test` step after `Lint`. (Step written; push blocked on `workflow` scope — apply manually.)

### Phase 1 — unit exemplars (`shared`, then `backend` engine) ✅ DONE
- `shared/test/signal_types.test.ts`, `shared/test/inference.test.ts`, `backend/test/engine.test.ts`.

### Phase 2 — API integration ✅ DONE
1. Refactored app construction into `src/app.ts` `createApp()` (route mounting, no sockets/managers);
   `index.ts` now wraps it with the http server + WS upgrade in `start()`.
2. `test/helpers/testApp.ts` — sets `VSPARK_DB_PATH=':memory:'`, dynamic-imports db+app, resets +
   migrates a fresh in-memory DB per call.
3. `test/api.projects.test.ts` — list/create/read-back round-trip + validation + isolation.

### Phase 3 — functional UI (Playwright) ✅ DONE (exemplars)
- `e2e/` workspace package (added to `pnpm-workspace.yaml`): `@playwright/test`,
  `playwright.config.ts` with TWO `webServer`s (backend via `tsx src/index.ts` on a stamped
  throwaway DB + multiplayer disabled; Vite frontend which proxies `/api`+`/ws`). `baseURL` is
  the frontend; the browser only talks to :5173.
- Run script is named `e2e` (NOT `test`) so the root `pnpm test` aggregation skips it; it's a
  separate concern/CI job. `lint` runs `tsc --noEmit` and is picked up by `pnpm -r lint`.
- Each `playwright test` run stamps a fresh SQLite DB path (`vspark-e2e-<ts>.db`) → known-empty
  backend, no cross-run leak.
- `e2e/tests/home.spec.ts` (3 specs): home reachable + **no console errors**; create-via-UI →
  card appears **+ REST read-back** (two-level assertion); open → URL navigates to `/editor/:id`.
  Controls selected by `data-testid` (added to `Home.tsx`) — i18n-proof.
- Verified locally against real Chromium (3/3 pass).
- **Pending: the CI `e2e` job** — written in `e2e/README.md`; not pushed (workflow scope). Uses
  the official Playwright container, runs `pnpm --filter @vspark/e2e e2e`, uploads the HTML report
  + traces. Future editor-internal flows (scene graph add-node, i18n switch, no-WebGL-context-loss)
  belong to Phase 8 breadth; this phase establishes the pattern on the WebGL-free Home page.

### Phase 4 — UI coverage signals (two complementary metrics) ✅ DONE (exemplars)

Two distinct, intentionally-kept signals. **Both are trend signals, not pass/fail gates** — but
a sharp *drop* in either is a strong "something's wrong" indicator (orphaned code, unreachable
functionality, newly-added-but-untested behaviour).

Built (all verified locally): `e2e/scripts/inventory-controls.mjs`,
`e2e/fixtures/controlCoverage.ts` (DOM-level interaction recorder + `window.__coverage__`
harvester), `e2e/reporters/control-coverage.ts`, `e2e/scripts/coverage-trend.mjs`, gated
`vite-plugin-istanbul` in `packages/frontend/vite.config.ts` (COVERAGE env; never prod), and the
`e2e:coverage` / `coverage:report` / `coverage:trend` scripts. Control coverage prints on every
run (4/5 on the home exemplar); `COVERAGE=1` run → nyc report works once `--cwd` points at the
repo root (frontend src lives outside `e2e/`). Annotation convention + committed baseline deferred
to Phase 9.

#### 4a — Control/surface coverage + instrumentation coverage (custom reporter)

⚠️ **Denominator caveat → second metric.** Control coverage only counts controls that carry a
`data-testid`, so a high % is deceiving if few components are instrumented. A companion
**instrumentation-coverage** metric measures denominator completeness: of all interactive component
files (button/input/select/textarea/anchor + `on{Click,Change,…}` handlers; 3D/canvas excluded),
how many carry ≥1 `data-testid`? Built in `e2e/scripts/instrumentation.mjs`; the reporter prints it
next to control coverage (exemplar today: control 80% of 5, but instrumentation only 1/27 = 3.7% —
exactly surfacing that the 80% is over a tiny instrumented subset).

**Staleness manifest** (`e2e/instrumentation-manifest.json`, committed): a per-file signature of
each interactive component's surface. `instrument:check` flags a file STALE when an edit changes
that surface (adds a control, drops a testid) or NEW when an interactive component isn't recorded —
so new UI elements can't slip past un-instrumented. `instrument:bless` re-records after review.
Wire `instrument:check --strict` into CI/pre-commit to force the review (Phase 9).

"Of all operable controls, which does some test exercise?" — NOT interaction-*path* coverage
(combinatorially infinite — out of scope).

1. **Inventory (denominator):** `e2e/scripts/inventory-controls.mjs` statically scans frontend
   source for interactive controls — every `data-testid`, plus role-bearing elements (`button`,
   `menuitem`, inputs). Produces the universe of operable controls.
2. **Exercised set (numerator):** a Playwright fixture wraps locator actions (`.click()`,
   `.fill()`, `.check()`, …) to log the target's `data-testid` on every interaction.
3. **Diff:** `e2e/reporters/control-coverage.ts` emits `exercised / inventory` as a headline %
   **and** — the real deliverable — the list of controls **no test ever touched**:
   ```
   UI control coverage: 134 / 210 controls exercised (64%)
   Never interacted with:
     scenegraph.node.duplicate
     properties.material.reset
     ...
   ```

#### 4b — UI E2E code coverage (Istanbul, as a regression trend) ⭐ per user feedback
A high % is a weak positive; a **sharp drop is a strong negative** — it surfaces orphaned code,
unreachable functionality, or new functionality shipped without a UI test path. Worth collecting.

1. **Instrument** the frontend in a dedicated test-build mode with `vite-plugin-istanbul`
   (NEVER in the production build). Instrumented code exposes `window.__coverage__`.
2. **Harvest** `window.__coverage__` after each Playwright test (a fixture writes fragments to
   `.nyc_output/`); **merge** with `nyc` into an Istanbul/lcov report — the same format Vitest
   emits (`@vitest/coverage-istanbul`), so unit + API + E2E can roll into one combined report.
3. **Annotate intentionally-unreachable code** so the signal sharpens: code that is *not meant*
   to be reachable via UI interaction (CLI/bootstrap paths, dev-only branches, defensive
   `assertNever`, backend-only modules pulled into a shared bundle) is marked with Istanbul
   ignore hints (`/* istanbul ignore next -- <reason> */`, `/* istanbul ignore file */`) **with a
   required reason comment**. A lint rule (or a review checklist item) should require the reason.
   The cleaner the annotations, the more a coverage drop means "real UI regression" vs noise.
4. **Track as a trend, alert on drop.** Record the combined coverage % per CI run (artifact +
   optionally a committed badge/JSON). Flag a PR whose UI coverage drops more than a small
   threshold (e.g. > 1–2 absolute %) vs the base branch — as a *warning/review prompt*, not a
   hard block. Treat the absolute number as informational; treat the delta as the signal.
5. (Optional) backend coverage *during E2E* via `NODE_V8_COVERAGE` on the test-DB backend
   process, merged in — but API-tier Vitest coverage already covers the backend natively, so this
   is low priority.

## Caveats to document (so metrics aren't misread)

- **Exercised ≠ asserted.** Coverage (line OR control) measures *execution/interaction*, not
  *verification*. A clicked/executed path with no following assertion still counts. Rely on
  review to ensure interactions have assertions; treat coverage as a *reachability* signal.
- **Absolute E2E line coverage is inflated** (mount runs huge swaths unasserted) → the **absolute
  %** is informational; the **delta vs base** is the actionable signal (per 4b). Vitest unit/API
  line coverage is meaningful and CAN be hard-gated (per Phase 5–7).
- **Control coverage measures surface, not depth** — finds *completely untested* controls (high
  value), not *under-tested* ones (disabled/loading/error states).
- **Coverage signal quality depends on discipline** — control coverage needs `data-testid`
  hygiene (denominator completeness); E2E code-coverage deltas need disciplined
  `istanbul ignore … -- reason` annotations on intentionally-unreachable code. Both argue for
  lint rules (testid-on-interactive-element; require-reason-on-ignore).

### Phases 5–9 — full (or near-full) coverage

Phases 0–4 establish the harness, the patterns, and one or two exemplars per tier. Phases 5–9
fill out real coverage, tier by tier. Each is independently shippable; do them in roughly this
order (cheapest/highest-value first). Introduce **Vitest coverage thresholds** (`@vitest/coverage-v8`
or `-istanbul`) only at the END of each unit/API phase, set just below the achieved number so the
gate ratchets up and can't silently regress.

#### Phase 5 — `shared` full coverage
- All of `signal_types`, `inference`, `infer_nodes` (per-kind inferPorts), `paramPaths`
  (`coerceParamValue`, registry lookups), `node`/`node_decorators` (port harvesting), Zod schemas
  in `schema.ts` (valid + invalid payloads), `arkit_tables`, `sync.ts` envelope helpers.
- Pure, fast, deterministic — aim highest threshold here (≥ 90%). Enable threshold gate.

#### Phase 6 — `backend` full coverage
- **Signal nodes** — table-driven tests over all 57 node kinds: feed representative inputs, assert
  outputs (math/procedural nodes are pure; mapper/calibration nodes test against fixtures). Reuse
  the `fromDescriptor` harness from Phase 1.
- **Engine edge cases** — cycle guard, value cache, list fan-in, enabled gate, error isolation,
  dynamic ports (`pack_event`/`unpack_event`/`queue_events`), `dispose`/`reconcile`.
- **Behaviour managers** — VMC/breathing/lipsync/tracking/api_controller lifecycle (instantiate
  on behavior CRUD, teardown, reconcile) against in-memory DB + a fake WS sink.
- **REST API** — extend `testApp.ts` (seed helpers per resource); cover every route module
  (scenes, scene-nodes, assets, behaviors, compose-layers, track-clips, logic, presets, camera-
  effects, expressions, api-controller, meta) — happy path + validation + not-found + the mesh
  write-through persistence tap. Cover the DB migration runner.
- **Other subsystems** — track-clip playback (playhead/seek/loop), runtime-overrides bus,
  data-channels bus, media-control bus, spawn manager, broadcast bus, VRM skeleton parser (fixture
  GLB/VRM), OSC/VMC packet parsing. Threshold gate ≥ 80% (sockets/multiplayer realistically lower).

#### Phase 7 — `frontend` non-visual full coverage
- Zustand `editorStore` (all actions/selectors), hooks (`useWsSync` reducers, `useTrackClipEvaluator`,
  uplink hooks with mocked transports), pure utils (`feedTemplate`, `materialOverrides` math,
  `composeLayerInteractions` anchor math, the extracted IK/pose-blend math), i18n key-parity test
  (every key present in both `en` and `de`).
- Component tests (Testing Library) for editor panels: SceneGraph, PropertiesPanel, AssetManager,
  dialogs — render + interaction + store wiring. **Exclude R3F/WebGL render paths** from jsdom
  coverage via `istanbul ignore`/coverage `exclude` globs (`Viewport.tsx`, `Avatar.tsx`, R3F node
  components) — those are covered by Phase 8 instead. Threshold gate on the non-excluded surface.

#### Phase 8 — E2E functional coverage (Playwright breadth)
- Specs across every major editor flow: project lifecycle, scene-graph CRUD + reparenting,
  each node kind add/configure, behaviors + logic graph editing, compose view, asset upload +
  placement, track-clip timeline, camera effects, presets/clipboard, overlive accounts modal
  (mocked), i18n switch, help system. Each asserts state (DOM + a REST read-back where it matters).
- Drive **control coverage (4a)** toward high % — close the "never interacted with" list.
- Wire up **E2E code coverage (4b)** instrumentation + the per-run trend artifact + the
  drop-detection warning.

#### Phase 9 — coverage gating + annotation cleanup
- Turn on the combined coverage report (unit + API + E2E merged via `nyc`).
- Ratchet Vitest thresholds to the achieved numbers (hard gate on unit/API tiers).
- Sweep the codebase for intentionally-unreachable code and add `istanbul ignore … -- reason`
  annotations; add the two lint rules (testid-on-interactive-element, require-reason-on-ignore).
- Document the final story in `dev-notes/modules/testing.md` (new module doc): how to run each
  tier, how to read the two UI-coverage signals, how to add tests per tier.

## Acceptance / verification

- `pnpm lint` and `pnpm build` still pass.
- `pnpm test` runs green across all packages (existing mesh tests + new exemplars).
- The three unit exemplars + the API exemplar pass and demonstrably exercise their targets.
- `playwright test` boots the app, the functional specs pass, traces upload on failure.
- The control-coverage reporter emits a % and a non-empty "never interacted with" list on a
  partial suite (proving it detects gaps).
- CI runs unit/API tests (required) and Playwright functional specs; coverage reporter output
  is visible in CI logs/artifacts.

## Output

Open a PR into `dev` when done (per repo convention; the working branch here is
`claude/automated-testing-strategy-zlryx4`). The PR will need a `release:` label per repo policy.
