# Testing

**Status:** implemented (Phase 9 complete)

Three test tiers run across the monorepo: Vitest unit/API (packages), Playwright functional e2e (full stack), and two complementary UI coverage signals. CI runs unit and e2e as separate jobs; coverage gating is live on `shared` and enforced on `backend`/`frontend`.

## Running tests

```bash
# Unit + API (all packages, fast)
pnpm test

# Per-package
pnpm --filter @vspark/shared    test
pnpm --filter @vspark/backend   test
pnpm --filter @vspark/frontend  test

# With Istanbul coverage (generates json-summary + text-summary)
pnpm --filter @vspark/shared    test:coverage
pnpm --filter @vspark/backend   test:coverage
pnpm --filter @vspark/frontend  test:coverage

# E2e (boots real backend + frontend; Playwright)
pnpm --filter @vspark/e2e       e2e

# E2e with Istanbul frontend instrumentation (emits .nyc_output/)
pnpm --filter @vspark/e2e       e2e:coverage
```

## Test layout

| Package | Runner | Location | Count |
|---------|--------|----------|-------|
| `shared` | Vitest | `packages/shared/test/` | 125 |
| `backend` | Vitest | `packages/backend/test/` | 693 |
| `frontend` | Vitest/jsdom | `packages/frontend/test/` | 447 |
| `e2e` | Playwright | `e2e/tests/` | 35+ |

## Tier 1 — unit (`shared`, `backend` engine/signal)

**Harness:** `buildGraph` / `pullValue` / `loneNode` in `packages/backend/test/helpers/nodeHarness.ts`.

```ts
import { buildGraph, pullValue } from './helpers/nodeHarness.js';

test('my node computes correctly', () => {
  const g = buildGraph({ kind: 'my_node', config: { gain: 2 } });
  g.fire('input', 3);
  expect(pullValue(g, 'output')).toBe(6);
});
```

Use `loneNode` when you only need to call a node method directly, not wire a full graph.

**DB-only tests** (no Express app, just DB access): use `resetDb` from `test/helpers/testDb.ts`:

```ts
import { resetDb } from './helpers/testDb.js';

beforeEach(async () => { await resetDb(); });
```

`VSPARK_DB_PATH=':memory:'` is set in `packages/backend/vitest.config.ts` for the whole suite so static imports of the db module don't bind to the on-disk path.

## Tier 2 — API integration (`backend` routes)

**Harness:** `makeTestApp` in `packages/backend/test/helpers/testApp.ts`.

```ts
import { makeTestApp } from './helpers/testApp.js';
import request from 'supertest';

let app: Express;
beforeEach(async () => { ({ app } = await makeTestApp()); });

test('POST /api/projects creates a project', async () => {
  const res = await request(app).post('/api/projects').send({ name: 'Test' });
  expect(res.status).toBe(201);
  expect(res.body.data.name).toBe('Test');
});
```

`makeTestApp` boots `createApp()` against a fresh `:memory:` SQLite DB with all migrations applied. Pass `{ mesh: true }` if the route under test touches the multiplayer mesh.

Each `beforeEach` call gets a completely isolated DB — no state leaks between tests.

## Tier 3 — frontend unit (jsdom + Testing Library)

**Harness:** `renderWithProviders` from `packages/frontend/test/helpers/render.tsx` — wraps the component with real i18n (EN) + a `MemoryRouter`.

```tsx
import { renderWithProviders } from './helpers/render.js';
import { screen } from '@testing-library/react';

test('renders correctly', () => {
  renderWithProviders(<MyComponent />);
  expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
});
```

R3F/WebGL components cannot run under jsdom. Mock them:

```ts
vi.mock('../components/editor/Viewport', () => ({ Viewport: () => null }));
```

`packages/frontend/test/setup.ts` registers `afterEach(cleanup)` globally — no cleanup boilerplate needed per file.

## Tier 4 — e2e functional (Playwright)

Specs live in `e2e/tests/`. Each spec seeds state via REST (`e2e/fixtures/seed.ts`) and drives the browser, asserting via DOM and REST read-back — never hardcoded visible strings (use `vs-` handles or ARIA role + accessible name).

```ts
import { test, expect } from '../fixtures/controlCoverage';
import { seedProjectScene, seedNode } from '../fixtures/seed';

test('my flow', async ({ page, request }) => {
  const { projectId, sceneId } = await seedProjectScene(request);
  const nodeId = await seedNode(request, sceneId, 'MyNode', 'group');

  await page.goto(`/editor/${projectId}`);
  await page.locator('.vs-my-control').click();

  await expect.poll(async () => {
    const res = await request.get(`/api/scene-nodes/${nodeId}`);
    return (await res.json()).data.someProp;
  }, { timeout: 10_000 }).toBe('expected');
});
```

The Playwright `webServer` block (in `e2e/playwright.config.ts`) boots a real backend + Vite frontend on ports `PW_BACKEND_PORT` / `PW_FRONTEND_PORT` (defaults 3031/5193) against a pid-stamped temp DB — override these env vars to run specs concurrently on different ports.

### Controlled inputs (PATCH round-trips)

Checkbox / select values driven by server state must be clicked, not `.check()`-ed — `.check()` requires the checkbox to flip synchronously, but the state only updates after the PATCH round-trip. Use `.click()` and verify via REST poll.

## UI control coverage signals

Two complementary metrics share an honest denominator: every interactive control enumerated from the TS AST by `e2e/scripts/controls.mjs`.

### 4a — Control coverage (which controls does a test exercise?)

```bash
pnpm --filter @vspark/e2e e2e   # control coverage prints at the end of every run
```

Output:
```
UI control coverage: 65 / 453 controls exercised (14.3%)  [12 opted out]
Instrumentation:     90 / 453 controls have a vs- handle (19.9%)
```

A control counts as **exercised** when one of its `vs-` CSS handles was interacted with during a spec. A control counts as **instrumented** when it carries a `vs-` class in the source.

To add a control to the exercised set:
1. Add a `vs-<name>` class to the element in the source (forward it via `className` if it's a reusable component).
2. Run `node e2e/scripts/controls.mjs bless` to update `e2e/controls-manifest.json`.
3. Write or extend a `e2e/tests/cov-*.spec.ts` that interacts with `.vs-<name>`.

To opt out a control that can't be meaningfully e2e-tested, add it to `e2e/coverage-ignore.json` (by handle, file path, or glob). Never put opt-out metadata in the `src/` markup.

**Staleness gate:** `node e2e/scripts/controls.mjs check` prints STALE for files whose control surface changed without a bless. Wire `controls:check --strict` into CI or a pre-commit hook to prevent unblessed changes from slipping through.

### 4b — E2E code coverage (Istanbul, trend signal)

```bash
pnpm --filter @vspark/e2e e2e:coverage   # runs specs with COVERAGE=1 frontend build
pnpm --filter @vspark/e2e coverage:trend  # compare vs baseline; warns on drop
```

A sharp **drop** vs `e2e/coverage-baseline.json` is a strong negative signal (new code with no e2e path, orphaned functionality). The **absolute %** is inflated (mount alone executes large swaths); treat it as informational, not a hard gate.

## Coverage thresholds (Vitest)

Thresholds are enforced only when collecting coverage (`test:coverage` / CI), not on plain `pnpm test`.

| Package | Gate | Achieved baseline |
|---------|------|-------------------|
| `shared` | 95/90/95/95 stmt/br/fn/ln | 98.4%/92.9%/98.9%/99.2% |
| `backend` | 50/38/48/50 stmt/br/fn/ln | 56.1%/42.4%/53.0%/56.5% |
| `frontend` | 10/9/11/10 stmt/br/fn/ln | ~11.7%/~10.2%/~12.6%/~11.7% |

Frontend thresholds are low because R3F/WebGL paths (`Viewport.tsx`, `Avatar.tsx`, etc.) are excluded from jsdom coverage and exercised by the e2e tier instead. Raise the ratchet as non-visual coverage grows.

## Adding tests for a new feature

1. **Backend logic or route** → add a Vitest test in `packages/backend/test/`. Use `makeTestApp()` for routes, `buildGraph` for signal nodes, `resetDb` for DB-only code.
2. **Frontend store/hook** → add a Vitest/jsdom test in `packages/frontend/test/`. Use `renderWithProviders` for components.
3. **UI flow (end-to-end)** → add a Playwright spec in `e2e/tests/`. Seed via REST, assert via REST read-back.
4. **New interactive control** → add a `vs-<name>` CSS class to the element, run `node e2e/scripts/controls.mjs bless`, and add or extend a `cov-*.spec.ts` to exercise it.

When a new feature touches a module that already has a `dev-notes/modules/<name>.md`, read that file first — it describes patterns and harnesses specific to that module.

## Key files

| File | Purpose |
|------|---------|
| `packages/backend/test/helpers/testApp.ts` | Express app + in-memory DB per test |
| `packages/backend/test/helpers/testDb.ts` | Lightweight DB reset (no Express) |
| `packages/backend/test/helpers/nodeHarness.ts` | `buildGraph` / `pullValue` / `loneNode` |
| `packages/frontend/test/helpers/render.tsx` | `renderWithProviders` (i18n + Router) |
| `packages/frontend/test/setup.ts` | `afterEach(cleanup)` global |
| `e2e/fixtures/seed.ts` | `seedProjectScene` / `seedNode` / etc. |
| `e2e/fixtures/controlCoverage.ts` | Playwright fixture with coverage recorder |
| `e2e/scripts/controls.mjs` | AST enumeration + bless/check/report |
| `e2e/scripts/coverage-trend.mjs` | Delta check vs `coverage-baseline.json` |
| `e2e/coverage-ignore.json` | Opt-out config (no test-only markup in src/) |
| `e2e/controls-manifest.json` | Per-file control surface hash (committed) |
