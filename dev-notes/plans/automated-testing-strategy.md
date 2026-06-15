# Plan: Automated testing strategy (unit, API, UI regression + control coverage)

> Branch: `claude/automated-testing-strategy-zlryx4` · Status: draft → ready-for-handoff
> This plan is the seed context for an implementation session. It is a starting point,
> not an airtight spec — refine it interactively as gaps surface.

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

### Tier 2 — API integration (exemplar + prerequisite refactor)
- `packages/backend/src/index.ts` — **refactor**: extract a `createApp()` (and `createServer()`)
  that builds the Express app + wiring **without** `listen()` / UDP bind / WS bind. The current
  entry couples app construction with port binding; tests need the app without the sockets.
  This is the one real structural change and the whole API tier depends on it.
- `packages/backend/test/helpers/testApp.ts` — new: fresh in-memory WASM DB, run migrations,
  seed a known project, return a `supertest` agent.
- `packages/backend/test/api.projects.test.ts` — `POST /api/projects` → `GET` it back; assert
  200 + persisted row. Establishes the supertest + in-memory-DB pattern (incl. the mesh
  write-through path: REST → `collection.set` → persistence tap).

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
- Coverage **gates/thresholds** — collect numbers, don't hard-gate yet (gating breeds gaming).
- R3F/WebGL 3D rendering correctness in unit tests (jsdom can't; that's the `verify`/`smoketest`
  skills' territory). Extract pose/IK *math* into pure functions and unit-test that instead.
- Overlive / Twitch / StreamElements network integration tests.
- Autonomous crawler / "monkey" UI exploration (note as a future option for inventory discovery).
- Backend coverage *during E2E* via `NODE_V8_COVERAGE` (note it; API coverage already comes
  from the supertest tier natively).
- Exhaustive per-module test suites — this lands the harness + exemplars only.

## Approach

### Phase 0 — Vitest infra (all packages)
1. Add Vitest + `vitest.config.ts` to `shared`, `backend`, `frontend` mirroring the mesh config.
   Frontend config sets `environment: 'jsdom'`. Add `"test": "vitest run --passWithNoTests"` to each.
2. Root `"test": "pnpm -r test"`. Verify `pnpm test` runs green (existing mesh tests + empty packages pass).
3. CI: add a `test` job after `Lint`. Required for packages that have tests.

### Phase 1 — unit exemplars (`shared`, then `backend` engine)
Write the three exemplar unit tests above. `shared` first (pure, no deps, proves the harness),
then the signal-engine test (highest architectural value — it's the system's core).

### Phase 2 — API integration
1. Refactor `index.ts` → `createApp()`/`createServer()` (decouple from `listen()`/sockets).
2. Build `testApp.ts` helper (in-memory DB + migrations + seed + supertest agent).
3. Write the projects round-trip exemplar.

### Phase 3 — functional UI (Playwright)
1. `e2e/` package: `@playwright/test`, `playwright.config.ts` with `webServer` booting backend
   (test DB) + frontend, and a global setup that seeds a known project via the API.
2. Exemplar specs — drive the browser like a user, assert on **state**, not appearance. Query by
   role / `data-testid` / translation value (never hardcoded EN strings). Candidate flows:
   - Home → create project → open editor → loads with **no console errors / no WebGL context-loss**.
   - Scene graph: add a node (VRM/camera/light) → appears in tree + properties panel.
   - i18n smoke: switch EN↔DE → a known control's label changes (catches missing keys).
   - One **two-level assertion**: after a UI mutation, also hit the REST API from the test to
     confirm the DB actually changed (catches optimistic-UI-but-silent-write-failure).
3. CI `e2e` job: official Playwright container (browsers preinstalled) or `playwright install
   --with-deps`; upload HTML report + traces (`trace: 'on-first-retry'`) as artifacts.
   **Functional specs required; ungate-able coverage reporter is informational.**

### Phase 4 — UI control coverage reporter
The metric the user asked for: **control/surface coverage** ("of all operable controls, which
does some test exercise?"), NOT interaction-*path* coverage (combinatorially infinite — out).

1. **Inventory (denominator):** `inventory-controls.mjs` statically scans frontend source for
   interactive controls — every `data-testid`, plus role-bearing elements (`button`, `menuitem`,
   inputs). Produces the universe of operable controls.
2. **Exercised set (numerator):** a Playwright fixture wraps locator actions (`.click()`,
   `.fill()`, `.check()`, …) to log the target's `data-testid` on every interaction — no
   per-test bookkeeping.
3. **Diff:** custom reporter emits `exercised / inventory` as a headline % **and** — the real
   deliverable — the list of controls **no test ever touched**:
   ```
   UI control coverage: 134 / 210 controls exercised (64%)
   Never interacted with:
     scenegraph.node.duplicate
     properties.material.reset
     compose.layer.reorder.up
     ...
   ```
4. Treat the **untouched-controls list as the artifact** and the **% as a trend line**. Do not
   hard-gate. Document the caveats below in the reporter output/README so the number isn't
   misread.

## Caveats to document (so metrics aren't misread)

- **Exercised ≠ asserted.** Both line coverage and control coverage measure *execution/interaction*,
  not *verification*. A clicked control with no following assertion still counts. Rely on review
  to ensure interactions have assertions; treat UI coverage as a *reachability* signal.
- **E2E line coverage is inflated** (mount runs huge swaths unasserted) → if collected at all,
  it's informational, never a gate. Vitest unit/API line coverage is meaningful and can be gated later.
- **Control coverage measures surface, not depth** — finds *completely untested* controls (high
  value), not *under-tested* ones (disabled/loading/error states).
- **Inventory completeness depends on testid discipline** — controls without a `data-testid` or
  clean role are invisible to the denominator. Argues for a future lint rule enforcing testids.

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
