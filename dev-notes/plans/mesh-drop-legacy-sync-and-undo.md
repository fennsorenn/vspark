# Plan: Retire the legacy sync envelope + mesh-native undo/redo

> **Status:** in progress — **workstream B (mesh-native undo) shipped**; workstream A
> (retire the `SyncEnvelope`) is partly done and partly blocked. A2 (`routes/scenes.ts`
> onto the store) and A3 (collab mount appliers) landed; A4/A5 are blocked because the
> mesh→`sync.document` emission is *not* dead code on the backend — it still feeds
> `backend/src/sync/containmentIndex.ts` and `multiplayer/manager.ts`. See the
> "Implementation status" section at the foot of this file for the verified detail;
> `routes/presets.ts` still emits `sync.document.upsert` directly.
> **Follows:** [`mesh-sync-refactor.md`](./mesh-sync-refactor.md) ·
> **Its workstream B design is** [`mesh-native-undo.md`](./mesh-native-undo.md) ·
> **Its "B is inert" blocker is planned out in**
> [`mesh-frontend-writes.md`](./mesh-frontend-writes.md).

> *(Historical handoff note.)* Branch: work off `feature/mesh-cleanup` (create from `dev`)
> This plan is the seed context for a cloud/interactive session. It is a starting
> point, not an airtight spec — refine it interactively and ask before guessing on
> anything underspecified.

## Goal

Two related, independently-landable workstreams on the `@vspark/mesh` layer:

- **A — Retire the legacy `SyncEnvelope` (`sync.document`) bridge.** The mesh
  migration is done: all five mutation rtypes write through the mesh store, and
  every editor/viewer tab already feeds its Zustand store from the tab's mesh
  replica (the frontend legacy `'sync'`-envelope bindings are deleted). What
  remains is a handful of server-side `sync.document` *emitters* and the
  bridge that mirrors them, plus dead mesh→envelope mirroring. Fold the tractable
  emitters into direct store writes and delete the envelope surface.
- **B — Mesh-native undo/redo.** Make undo/redo a first-class primitive of
  `@vspark/mesh` so every client that mutates through the mesh — editor tabs, the
  viewer, the assistant's loopback peer — gets undo for free, collaboration-safe
  by construction. (Supersedes the reverted frontend command-journal and agent
  snapshot approaches.)

Do **A first** (it cleans the write path B builds on), but they can ship in
either order.

## Context — read these first

- [dev-notes/modules/mesh.md](../modules/mesh.md) — the mesh core, channels,
  HLC LWW, the "Remaining" section.
- [dev-notes/plans/mesh-sync-refactor.md](./mesh-sync-refactor.md) — the full
  refactor spec. §10 (REST write-through, DONE), §11 (frontend bindings, DONE
  through slice 4), §12 (**Phase-6 guarded writes — why they stay legacy**), and
  "Remaining mesh work, by value" at the end.
- [dev-notes/modules/sync.md](../modules/sync.md) — the legacy envelope, its
  four resource classes, and the deferred/not-yet-done list.
- The mesh-native undo design already exists as a standalone plan on the
  `feature/mesh-undo` branch: `dev-notes/plans/mesh-native-undo.md`
  (`git show origin/feature/mesh-undo:dev-notes/plans/mesh-native-undo.md`).
  **Bring that file onto your branch** and treat it as the detailed spec for
  workstream B; this document is the umbrella + the sequencing.

---

## Workstream A — Retire the legacy sync envelope

### Current state (verified)

- All five rtypes (`behavior`, `camera_effect`, `scene_node`, `compose_layer`,
  `track_clip`) write through `collection.set/remove` in their REST routes; the
  `onCommitted` tap persists via the resource registry and emits
  `sync.document.upsert/remove` for legacy consumers.
- Frontend: `sync/meshStoreFeeder.ts` feeds the store from the replica for all
  five rtypes; the legacy `'sync'`-envelope bindings file is deleted. **No tab
  reads the envelope anymore.**
- So the mesh→`sync.document` mirror direction is effectively dead (no consumer),
  and the remaining live use of `sync.document` is a few server-side *emitters*.

### Remaining `sync.document` emitters (inventory — confirm before editing)

Grep `sync\.document` under `packages/backend/src` (excluding tests). As of this
writing:

1. **`routes/scenes.ts`** — template / bulk scene creation emits
   `sync.document.touch('scene_node' | 'compose_layer', id)` per created entity
   (lines ~313–314, ~397, and `.remove` at ~471). These are the main tractable
   emitters: fold them into direct store writes (write each created node/layer
   through its collection in dependency order, mirroring what the per-resource
   routes already do). This was explicitly left for "when compose/track slices
   land" in §10 — they've landed.
2. **`multiplayer/collabScene.ts`** — collab-applied ops emit
   `sync.document.upsert('track_clip' | 'camera_effect', id)` (~417, ~467).
   Route these through `collection.set` on the collab-apply path so collab writes
   use the one write path too. Watch the echo-guard / `applyingFromMesh` flag.
3. **`multiplayer/sceneNodeWrite.ts`** — the **Phase-6** placed-object write path
   (`sync.document.upsert/remove('scene_node', …)`). **Leave this on the legacy
   path** — see "Out of scope" below. This is the one emitter that keeps a
   minimal internal document-notify alive; decide whether to (a) keep a thin
   internal notify decoupled from the public `sync.document` API, or (b) keep the
   envelope but shrink its API to exactly what Phase-6 needs. Prefer (a).

### Steps

1. **Inventory + freeze.** Re-grep the emitters; confirm the list above against
   the current tree. Write down which stay (Phase-6) and which migrate.
2. **Fold `scenes.ts` bulk creation** through the store (one commit). Verify:
   create a project from a template, confirm all nodes/layers appear via REST
   read-back **and** live in a second tab (mesh feeder), no doubles.
3. **Fold `collabScene.ts`** collab-apply emits through `collection.set` (one
   commit). Verify with a live two-backend collab echo (A creates clip/effect →
   B sees it, single row).
4. **Kill the dead mirror direction.** Remove the mesh→`sync.document` mirror in
   `mesh/index.ts` (the `onCommitted`→`sync.document.upsert/remove` emission at
   ~410–415) once nothing consumes the envelope. Keep the resource-registry
   persistence tap — only the envelope emission goes.
5. **Decouple Phase-6** from the public `sync.document` API (option (a) above):
   give `sceneNodeWrite.ts` a small internal "notify placed subscribers" call
   that doesn't route through the generic envelope. Then the public
   `SyncEnvelope` / `sync.document.*` surface (`packages/backend/src/sync/`,
   `packages/shared/src/sync.ts`, `frontend/src/sync/registry.ts` legacy bits)
   can be deleted.
6. **Delete the envelope surface** and update `sync.md` + `ARCHITECTURE.md`
   (the "Unified sync layer" row and the "Scene state mutations" data-flow block).

### Constraints / hazards (from §10–§11)

- **Reads-first, one rtype per commit**; run the app after each (this is UI —
  headless REST won't catch regressions; use the `verify` / `smoketest` skills
  with Playwright).
- The `scene_node` `validate` transform runs on **local** writes too now — its
  collab file-path preservation must only fire for genuinely foreign docs
  (projectId re-scoped), or a local REST model swap on a collab-author scene gets
  silently reverted. Don't regress hazard-e from §10.
- Replica docs lack DB-generated timestamps — the tap re-loads the row for
  display fields; preserve that.
- The live **pose pipeline** (`vmc_pose`/`vmc_blendshapes`/`ik_targets`, ~60–90 Hz)
  stays on its legacy WS kinds — it is NOT the sync envelope and is out of scope
  here (folding it onto `sync.stream` is a separate, runtime-verify-gated effort).

---

## Workstream B — Mesh-native undo/redo

Full design is in `mesh-native-undo.md` (bring it onto the branch). Summary of
what to build:

1. **Undo-log in `@vspark/mesh`** (`peer.localWrite`): when a write targets the
   collection's retained `committed` channel, push
   `{ rtype, id, op, before, after }` (`before` read from the replica *before*
   apply). **Preview/ephemeral writes are never logged** — the commit is the
   action boundary, which sidesteps drag-coalescing entirely. Cap depth (~100).
2. **Inverse replay** (`peer.undo()`): pop, emit the inverse as a normal
   committed write with a fresh HLC (created→`remove`, removed→`upsert(before)`,
   modified→`set(id,'',before)`). Propagation + persistence + LWW-merge fall out
   for free; collaboration-safety comes from HLC LWW.
3. **Redo stack**: inverse pushes onto redo; a new non-undo committed write clears
   redo; `redo()` re-applies.
4. **Per-peer stacks** (undo only replays this peer's own actions — the agent peer
   has its own stack).
5. **Concurrency policy**: default **guarded** (skip the inverse if the doc's
   current value ≠ this peer's logged `after` — someone else changed it since),
   configurable to naive last-writer-wins. Test both.
6. **Optional `mesh.action(label, fn)` grouping** for atomic multi-doc actions
   (cascade delete of a node + its behaviors/clips). Only needed if cascades
   issue N separate committed removes — confirm during build; may be deferrable.

### Wiring

- **Core** (`@vspark/mesh`): undo-log, stacks, `peer.undo()/redo()`, config,
  mesh-package unit tests (the design lists the exact test matrix).
- **Frontend** (`clientMesh` / `pages/Editor.tsx`): `undo()/redo()`, Ctrl/Cmd+Z
  and Ctrl+Shift+Z / Ctrl+Y (skip when focus is in an input/textarea), TopBar
  buttons gated on `canUndo/canRedo`, i18n (`editor` namespace, EN+DE) + a help
  note (per the repo i18n/help "done" bar).
- **Assistant**: "undo that" → the agent loopback peer's `undo()`. Optionally a
  tiny `revert_last_change` tool. Delete any remnants of the snapshot approach.

### Sequencing

1. Undo-log + `undo()/redo()` + inverse replay (committed-only) + mesh tests.
2. Guarded concurrency policy + tests.
3. Frontend keybindings + buttons + i18n/help (drive with `verify`/`smoketest`).
4. Assistant `peer.undo()` (+ optional tool).
5. `mesh.action()` grouping for cascades (only if needed).

---

## Explicitly OUT of scope (keep legacy — do NOT migrate)

Per `mesh-sync-refactor.md` §12 + "Remaining mesh work, by value":

- **Phase-6 guarded writes** (`_share_write`/`_share_write_nak`,
  `sceneNodeWrite.ts`). Migrating placed-object edits onto mesh acks needs
  **multi-hop ack routing** (tab → backend → owner → backend → tab); the mesh
  core's guarded-write protocol is single-hop. The legacy path is purpose-built,
  implemented, and user-verified. Keep it. Only revisit if multi-hop acks become
  valuable for another reason — and then design them as a first-class core
  feature with their own test matrix, not a bolt-on.
- **Object-share streams** (`_share_stream`) — deliberately ride direct
  browser↔owner WebRTC edges (no relay hop). Keep.
- **Advertise/offer flow** (`_share_advertise`/`mp_shares`) — small, UI-coupled,
  works. Low value; leave unless you're already in that code.
- **Component reads → mesh-react hooks** — the store feeder already delivers live
  updates, so this is read-path polish with marginal user-visible benefit. Do it
  opportunistically when touching a panel, not as a sweep.

## Definition of done

- **A:** No `sync.document.*` calls remain except the intentionally-retained
  Phase-6 notify (or that too is decoupled from the public envelope, which is then
  deleted). Template creation, collab-apply, and all CRUD converge live across two
  tabs / two backends. `sync.md` + `ARCHITECTURE.md` updated. `pnpm lint`, `pnpm
  build`, `pnpm test` green; a Playwright smoke pass over create/collab flows.
- **B:** Undo/redo works in the editor (keyboard + buttons), the mesh package has
  the full test matrix green, guarded concurrency is the default, and the agent
  loopback peer can undo its own writes. i18n (EN+DE) + help note shipped.

## Notes

- Conventional commits; commit per slice. Spawn the `doc-updater` agent at
  start (mark mesh/sync modules WIP) and end (record what changed).
- Open a PR into `dev` when each workstream is complete (they can be two PRs).

---

## Implementation status (session 2026-07-08)

### Done

- **A2 — `scenes.ts` folded onto the store.** Template/bulk creation, scene PUT,
  and scene DELETE write through `getMeshCollection(...)` instead of
  `sync.document.touch/remove`. DELETE removes each node through the store
  *before* the SQL cleanup (FK off) so the persist tap's `persists` guard still
  records a tombstone + emit per node. Test: `api.scenes.mesh.test.ts`.
- **A3 — collab mount appliers folded.** `applyClipDto` / `applyCameraEffectDto`
  now `collection.set(...)`; the tap's `save` is byte-equivalent to the old inline
  SQL. Test: `multiplayer.collabScene.mesh.test.ts`. (Two-backend collab-echo
  convergence is a live check outside the vitest harness — not yet run.)
- **B core — mesh-native undo/redo in `@vspark/mesh`.** Undo-log +
  `undo()/redo()/canUndo()/canRedo()/undoStatus()/clearUndoHistory()/onUndoChange()`
  + inverse replay + guarded/naive policy, all in `peer.ts`. Full matrix in
  `undo.test.ts` (17 tests). See [mesh-native-undo.md](./mesh-native-undo.md).
- **B frontend plumbing.** `meshUndo/meshRedo/onMeshUndoChange` on the tab peer;
  Editor Ctrl/Cmd+Z + Ctrl+Shift+Z/Ctrl+Y (input-guarded); TopBar ↶/↷ buttons
  gated on canUndo/canRedo; i18n EN+DE; `scene.md#undo` help; controls blessed.
- Docs: `sync.md` + `mesh.md` corrected (they wrongly claimed `scene_node` still
  reads the legacy envelope — the frontend bindings file is deleted and
  `applyRemote` has zero bindings; the envelope is a client-side no-op) and the
  undo feature recorded.

### Blocked / needs a decision (the plan's premise was off here)

- **A4/A5 — killing the mesh→`sync.document` emission is NOT a dead-code
  deletion.** The plan assumed "no consumer," which is true on the *frontend* but
  **not the backend**: that emission still feeds `sync/containmentIndex.ts`
  (object-share fan-out root resolution) and `multiplayer/manager.ts` →
  `indexCollabNode` (collab pose/preview stream routing). Both are Phase-6 /
  object-share / collab-stream infra that "Out of scope" keeps on legacy. To
  finish A4/A5 the right way: **re-feed those two consumers from the mesh replica**
  (a `collection.observe('**')`/`onCommitted` tap that updates the containment
  index and the collab node→scene map), *then* drop the envelope emission and
  delete the `sync/` surface — and verify with a **two-backend live collab +
  object-share run** (headless REST won't catch a routing regression). Not done
  here because that verification isn't available in this environment.
- `routes/presets.ts` also still emits `sync.document.upsert` directly (not in the
  plan's original A inventory); fold it the same way as A2 when doing A4/A5.

- **B frontend/assistant are inert until writes author through a mesh peer.**
  Undo logs on the *authoring* peer. Today all frontend UI writes go via REST →
  the backend authority peer, so the tab peer's stack is empty and the ↶/↷
  buttons stay disabled. Making undo functional needs the separately-tracked
  **"writes → `collection.set`"** migration (route `api/client.ts` node/behavior/
  etc. writes through the tab peer's collections — the `meshStoreFeeder` already
  reflects them back into the store). Start with a bounded slice (e.g. node
  create/delete) and verify with `verify`/`smoketest`. The **assistant** undo
  additionally needs a dedicated **agent loopback mesh peer** (doesn't exist yet)
  so the agent has its own per-peer stack rather than sharing the backend's.

  > **Planned out** in [mesh-frontend-writes.md](./mesh-frontend-writes.md) — the
  > write-path migration, sliced by rtype, with the ~130 call sites inventoried and
  > the `canWrite()`/`useMeshStatus` gap (both assumed by §12 but not built) called
  > out. Step 1 of that plan is the point where undo stops being inert.
