# Batch plan: raise 4a control-coverage + Phase 6/7 deferred breadth

> **Status:** shipped — all 13 work units landed. Units 1–6 are the six `cov-*.spec.ts`
> files in `e2e/tests/`; units 7–9 are `packages/backend/test/api.behaviors.test.ts`,
> `db.migrations.test.ts`, `managers.persist.test.ts` and the `multiplayer.*`/`mesh.*`
> unit tests; unit 13 is the istanbul coverage gate in
> `packages/frontend/vitest.config.ts`.
> **Executes part of:** [`automated-testing-strategy.md`](./automated-testing-strategy.md)
> (Phases 4a / 6 / 7).

> *(Historical.)* Branch: `claude/automated-testing-strategy-zlryx4`. Orchestrated via parallel
> worktree-isolated background agents. (No `EnterPlanMode` tool in this harness;
> approval gated via AskUserQuestion before spawning.)

## Research summary

- **4a control coverage** is at **7 / 453 controls exercised**. Two metrics over the
  same AST denominator: *instrumentation* (controls carrying a `vs-` handle) and
  *exercised* (handles actually interacted with by an e2e run). Raising *exercised*
  requires BOTH adding `vs-` handles to controls AND clicking them in an e2e spec.
  Control distribution (editor): PropertiesPanel 151, SceneGraph 46, AssetManager 38,
  ComposeLayerProperties 37, TrackClipTimeline 34, Overlive 31, PresetLibrary 16, …
  Convention (unchanged): role+name first; `vs-` class where ambiguous; one `vs-` =
  one logical control; handles are a public targeting layer (ship in prod).
- **Phase 6 deferred:** behaviors write-route, routes connections/overlive-accounts/
  update/signal, multiplayer+mesh internals, DB migration runner, manager
  `_persistNodeState`/`_writeSchedule`. Mostly additive backend vitest/supertest tests.
- **Phase 7 deferred:** uplink hooks, previewSmoother + particle GPU utils,
  editorStore compose-layer/lane CRUD, frontend coverage gate. Additive frontend tests.

## Execution model

Each unit runs as an **isolated git worktree, background agent**. Most units are
**additive** (new test files) and slice into **disjoint file sets**, so they never
conflict. 4a units also edit disjoint src component areas. e2e-running units each use a
**distinct `PW_FRONTEND_PORT`/`PW_BACKEND_PORT`** pair so concurrent app boots + the
per-run `.coverage` artifacts stay isolated. **No `gh` here** → workers commit + push
their worktree branch and report the branch name; the coordinator merges each branch
into the feature branch, runs the full suite, and pushes (no PR sprawl).

## Work units

### 4a — instrument + EXERCISE common controls (edits src + e2e; runs Playwright)
1. **SceneGraph controls** — `vs-` handles on tabs / node-row actions / add buttons; e2e clicks them. Ports 5191/3021.
2. **AssetManager controls** — handles on tab bar / upload / per-asset actions; e2e. 5192/3022.
3. **PropertiesPanel common controls** — handles on name/opacity/visibility/shadow + transform extras + 1–2 kind sections; e2e. 5193/3023.
4. **Compose controls** — ComposeLayerProperties + ComposeTree handles; e2e. 5194/3024.
5. **TrackClip controls** — TrackClipTimeline + ClipsSection handles; e2e. 5195/3025.
6. **Preset/TopBar/dialog controls** — PresetLibrary + TopBar + DialogProvider handles; e2e. 5196/3026.

### Phase 6 deferred (additive backend tests; vitest/supertest)
7. **Behaviors write-route + remaining routes** — `api.behaviors.test.ts` (mesh harness) + connections/update/signal/overlive-accounts validation+read.
8. **Multiplayer/mesh internals** — unit tests for pure logic in `src/multiplayer/**` + mesh transport/collab/shares/streams helpers.
9. **DB migration runner + manager persist paths** — migration runner test; `_persistNodeState`/`_writeSchedule` with seeded behavior/animation_clip rows.

### Phase 7 deferred (additive frontend tests; vitest)
10. **Uplink + remaining hooks** — `useLipsyncUplink`/`useTrackingUplink`/`useSharedSubscriptions`/`useClientMesh` (mocked transports).
11. **Math/util breadth** — `previewSmoother`, particle GPU helpers, remaining pure utils (`feedTemplate`, `materialOverrides`, `composeLayerInteractions`).
12. **editorStore breadth** — compose-layer + track-clip-lane CRUD + any remaining untested actions.
13. **Frontend coverage gate** — add `@vitest/coverage-istanbul`, `coverage.exclude` for R3F (`Viewport.tsx`/`Avatar.tsx`/R3F nodes), ratcheted thresholds, `test:coverage` script.

## e2e / verification recipe (per unit type)

- **4a units:** `cd packages/frontend && pnpm lint` (tsc) → `cd /home/user/vspark/e2e && pnpm lint` →
  `PW_FRONTEND_PORT=<p> PW_BACKEND_PORT=<p2> pnpm exec playwright test <your-spec>` →
  must pass AND the printed "control coverage … exercised" count must be **> 7**.
- **Backend units (7–9):** `cd packages/backend && npx vitest run <files>` green + `pnpm lint`.
- **Frontend units (10–13):** `cd packages/frontend && npx vitest run <files>` green + `pnpm lint`.
  (Unit 13 also runs `pnpm --filter @vspark/frontend test:coverage` and confirms the gate passes.)
