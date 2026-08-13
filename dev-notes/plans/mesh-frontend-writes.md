# Plan: Migrate frontend writes onto the tab mesh peer (make undo real)

> **Status:** in progress — **this is the LIVE plan.** Step 0 was decided as shape
> **(b)**: free functions in `packages/frontend/src/mesh/writes.ts` (generic over rtype,
> with `mesh/layerWrites.ts` for compose layers) and `canMeshWrite()` as the gate; REST
> survives only as the in-helper fallback for foreign/unwritable docs. Landed: `scene_node`
> update + create + delete + reparent (undo is no longer inert), compose-layer CRUD,
> compose-layer drag previews on the mesh `preview` channel, fractional sibling ordering
> (`packages/shared/src/fracIndex.ts`, migration `036_compose_layer_order_key`), and
> `peer.batch()` grouping. Verified by `e2e/tests/editor-mesh-undo.spec.ts` (9 tests —
> the plan calls it `cov-undo.spec.ts`). **Not yet migrated:** `behavior`,
> `camera_effect`, `track_clip` and `logic` writes (still `api.update*`), and node
> transform previews (still `node_transform_preview` on `/ws`).
> **Follows:** [`mesh-drop-legacy-sync-and-undo.md`](./mesh-drop-legacy-sync-and-undo.md)
> (this plan is that document's "B frontend/assistant are inert" blocker) and
> [`mesh-sync-refactor.md`](./mesh-sync-refactor.md) §11.

> *(Historical handoff note — the base branch below is stale.)*
> Branch: `feature/mesh-frontend-writes` — **create from
> `claude/mesh-cleanup-legacy-sync-undo-qgev05` (PR #63), not from `dev`.**
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — the worker is interactive and may ask to refine it.
>
> **Why that base:** #63 is unmerged, and it carries everything this plan builds on
> — the undo engine in `packages/mesh/src/peer.ts`, the tab-peer bindings in
> `frontend/src/mesh/peer.ts`, the TopBar ↶/↷ buttons, the Ctrl+Z handler, and this
> plan file itself. None of it exists on `dev` (`git show origin/dev:packages/mesh/src/peer.ts`
> has zero undo references). Branching from `dev` would give you nothing to migrate
> onto. If #63 has since merged, branch from `dev` as normal and ignore this note.

## Goal

Move frontend UI writes from `REST → backend peer` onto the **tab's own mesh peer**,
so the tab authors its own writes and mesh-native undo/redo actually works.

The undo engine already exists and is well tested (`packages/mesh/src/peer.ts`,
17-test matrix in `packages/mesh/test/undo.test.ts`). The frontend plumbing exists
too — `meshUndo`/`meshRedo`/`onMeshUndoChange`, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y in
`Editor.tsx`, TopBar ↶/↷ buttons, i18n, `scene.md#undo` help. **All of it is inert.**

The reason is one sentence: *undo logs on the peer that authors the write*. Every
frontend UI edit currently goes browser → REST → backend, so the **backend** peer
authors it and the tab peer's undo stack stays empty. The buttons are permanently
disabled and Ctrl+Z does nothing.

This plan closes exactly that gap. When it lands, Ctrl+Z undoes your last edit in
the tab you made it in.

## Context — read these first

- [dev-notes/modules/mesh.md](../modules/mesh.md) — mesh core, channels, HLC LWW,
  and the **"Undo / redo (per peer)"** section (logging rules, replay, guarded vs
  naive policy, and the "Consumer status" paragraph that describes this gap).
- [dev-notes/plans/mesh-native-undo.md](./mesh-native-undo.md) — the undo design.
- [dev-notes/plans/mesh-sync-refactor.md](./mesh-sync-refactor.md) — **§11** (frontend
  bindings, done through slice 4) and **§12** (Phase-6 guarded writes — why per-doc
  authority writes stay legacy). The "Hazards" list at the end of that file is
  directly relevant; read it before slicing.
- [dev-notes/plans/mesh-drop-legacy-sync-and-undo.md](./mesh-drop-legacy-sync-and-undo.md)
  — the predecessor. Its "Implementation status" section records what landed and
  why A4/A5 are blocked. **This plan is the "B frontend/assistant are inert" item
  from that document's blocked list.**

## Current state (verified 2026-08-11, on the PR #63 merge)

Confirm these still hold before editing — the point of listing them is that the
worker should not have to re-derive them, not that they are eternal.

- **Reads are already fully migrated.** `packages/frontend/src/sync/meshStoreFeeder.ts`
  feeds the Zustand store from the tab's replica via `observe('**')` for all
  document rtypes: `scene_node`, `behavior`, `camera_effect`, `compose_layer`,
  `track_clip`, `scheduled_animation`, `animation_clip`. The legacy `'sync'`-envelope
  bindings file is deleted and `applyRemote` has zero bindings.
- **Writes are entirely REST.** `editorStore.ts` contains **no** `collection.set`
  calls. Roughly **130 `api.create*/update*/delete*` call sites** live across ~20
  files, not centralised in the store. By volume:

  | Call | Sites | Main homes |
  |---|---|---|
  | `api.updateNode` | 30 | `PropertiesPanel.tsx`, `SceneGraph.tsx`, `Viewport.tsx`, `dnd.ts` |
  | `api.updateComposeLayer` | 11 | `ComposeLayerProperties.tsx`, `composeLayerInteractions.ts`, `ComposeTree.tsx` |
  | `api.updateBehavior` | 10 | `PropertiesPanel.tsx` |
  | `api.updateLogic` | 9 | `LogicSection.tsx`, `SignalNodeCard.tsx`, macros |
  | `api.createNode` | 9 | `createKinds.ts`, `dnd.ts`, `composeSendTo3D.ts` |
  | `api.deleteNode` | 7 | `useDeleteElement.ts`, `SceneGraph.tsx` |

  (Full inventory: `grep -rhoE "api\.(update|create|delete)[A-Za-z]*\(" packages/frontend/src`.)
- **The tab peer exposes only undo controls today.** `packages/frontend/src/mesh/peer.ts`
  exports `initMeshPeer`, `getMeshHandles`, `meshUndo`, `meshRedo`,
  `getMeshUndoStatus`, `onMeshUndoChange`. There is **no `canWrite()` and no
  `useMeshStatus` hook** — §12 and the hazards list assume both exist for write
  gating, so they are new work in this plan (see step 2).
- **Neither path Zod-validates scene-node writes.** The REST route
  (`routes/scene-nodes.ts`) and the mesh resource tap (`sync/resources.ts`) both
  just `JSON.parse` the blobs. So moving a write off REST does not skip a
  validation layer for these rtypes. **Verify per rtype before moving it** — this
  was checked for `scene_node` only.

## Constraints

- **Reads-first, per slice. Never flip reads and writes together.** Reads are
  already done, so each slice here is writes-only — but the rule still governs
  ordering *within* a slice: land the write path, verify the feeder round-trips it,
  then delete the REST call.
- **Preview/smoothing paths stay on `/ws`.** `node_transform_preview` and
  `compose_layer_preview` keep using the ephemeral channel + `previewSmoother`.
  Only *committed* state moves. This is also what keeps undo sane: the commit is
  the action boundary, so a gizmo drag logs one entry, not sixty.
- **Phase-6 guarded writes stay legacy.** Per-doc authority writes are explicitly
  out of scope per §12. If a slice turns out to need one, stop and ask.
- **Initial REST hydration stays.** It seeds faster than the WS subscribe
  round-trip; do not remove it as part of "migrating reads" — reads are done.
- **Do not change the undo engine.** `packages/mesh/src/peer.ts` undo logic and its
  17-test matrix are settled. If a slice seems to need an engine change, that is a
  signal to stop and ask, not to edit `peer.ts`.
- **Server-side effects must keep firing.** Several REST routes do more than write a
  row (behavior CRUD re-syncs managers; scene DELETE has FK-ordered cleanup). A
  write moved onto the mesh must still trigger those. See the hazard in step 1.

## Files in scope

- `packages/frontend/src/mesh/peer.ts` — add `canWrite()` + a `useMeshStatus` hook;
  export typed per-rtype write helpers.
- `packages/frontend/src/store/editorStore.ts` — the natural home for the write
  helpers if they end up as store actions rather than free functions (**decide this
  first — see step 1**).
- Per-slice call-site files, in the order given in the Approach.
- `packages/frontend/test/` — jsdom tests per migrated slice.
- `e2e/tests/` — a `cov-undo.spec.ts` exercising real undo/redo once slice 1 lands.
- `dev-notes/modules/mesh.md` — update the "Consumer status" paragraph as slices land.
- `dev-notes/plans/mesh-drop-legacy-sync-and-undo.md` — tick off the "B frontend is
  inert" blocked item when undo goes live.

## Out of scope

- **A4/A5** (killing the mesh→`sync.document` emission). Still blocked on re-feeding
  `containmentIndex.ts` and `multiplayer/manager.ts` from the replica, plus a
  two-backend verify. Different plan.
- **`routes/presets.ts`** still emitting `sync.document.upsert` directly — belongs
  with A4/A5.
- **The agent loopback peer** for assistant undo. Related and enabled by this work,
  but a separate build.
- **Redesigning undo semantics** (grouping, labelled transactions, per-panel scopes).
  Ship the primitive first.

## Approach

### Step 0 — decide the write-helper shape (ask before building)

Two viable shapes, and this is an architectural call the worker should **put to the
user before writing code**:

- **(a) Store actions** — `useEditorStore().updateNode(id, patch)` writes to the
  collection and lets the feeder echo back. Call sites change from `api.updateNode(...)`
  to a store action. Keeps mesh knowledge in one place; store gains write
  responsibility it does not have today.
- **(b) Free functions in `mesh/peer.ts`** — `meshWrite.node.update(id, patch)`.
  Keeps the store read-only (its current character) and mesh concerns in the mesh
  module; call sites import from a second place.

(b) is the smaller change and preserves the existing separation, but (a) reads
better at ~130 call sites. **Do not pick unilaterally.**

### Step 1 — one vertical slice: `scene_node` update

Deliberately the highest-volume, best-understood rtype, and the one whose validation
story is already confirmed.

1. Add `canWrite()` + `useMeshStatus` to `mesh/peer.ts`; gate write controls on it
   (hazard (d): mesh subscription arming races page load).
2. Implement the chosen write-helper shape for `scene_node` update only.
3. Migrate **one** call site first — a simple `PropertiesPanel.tsx` field — and
   verify by hand: edit → feeder echoes → **Ctrl+Z undoes it**. This is the moment
   undo becomes real; do not proceed until it does.
4. **Hazard — server-side effects.** Confirm what `PATCH /api/scene-nodes/:id`
   does besides writing the row. If it triggers anything (manager re-sync, asset
   re-link, containment reindex), the mesh write must trigger it too — via the
   `onCommitted` tap, not by keeping the REST call. Enumerate this before migrating
   the remaining 29 sites.
5. Migrate the rest of `api.updateNode`, then delete the REST call from those paths.

### Step 2 — widen by rtype, one slice per PR-sized chunk

Order chosen by (volume × independence), easiest first:

1. `scene_node` create + delete (`createKinds.ts`, `dnd.ts`, `useDeleteElement.ts`)
   — **delete is the risky one**: check FK-ordered cleanup and tombstone emission,
   mirroring what `routes/scenes.ts` had to do in A2.
2. `compose_layer` update/create/delete.
3. `behavior` update/create/delete — **check the manager re-sync effect first**;
   behavior CRUD drives `syncBehaviors`, so a mesh write that skips it would leave
   graphs stale.
4. `camera_effect`, `track_clip`.

`logic` (`api.updateLogic`, 9 sites) is deliberately **last** and may not belong
here at all — graphs are large documents and the write pattern is different. Assess
it separately; do not fold it in without asking.

### Step 3 — make undo legible

Once real writes flow, undo will surface UX questions the engine does not answer:

- A single UI gesture may produce several committed writes (e.g. create node + set
  transform). Ctrl+Z undoing "half a gesture" reads as a bug. If this shows up,
  **stop and ask** — the fix is transaction grouping in the engine, which is out of
  scope here.
- Confirm the `guarded` policy behaves sensibly with two clients: a collaborator
  edits a doc you touched, then you press Ctrl+Z. The inverse should be *skipped*,
  not applied over their change.

## Acceptance / verification

- `pnpm lint` clean, `pnpm test` green.
- **The headline check**: in one client, make an edit, press Ctrl+Z, and see it
  revert. Redo restores it. The TopBar ↶/↷ buttons enable/disable in step with
  `canUndo`/`canRedo`. This is the whole point of the plan — if it does not hold,
  nothing else matters.
- Undo history is per tab: two tabs on the same project have independent stacks,
  and Ctrl+Z in tab A never reverts tab B's edit.
- **Two-client guarded-policy check**: tab A edits node X; tab B edits node X; tab A
  presses Ctrl+Z. Under `guarded` (default) A's inverse is skipped rather than
  clobbering B. Worth also running once under `naive` to confirm the policy switch
  is actually load-bearing.
- Preview paths unaffected: a gizmo drag still smooths over `/ws` and logs **one**
  undo entry on commit, not one per frame.
- Per-slice: the migrated writes still round-trip through the feeder, and any
  server-side effect the REST route performed still fires (see step 1 hazard).
- New jsdom tests per slice; `cov-undo.spec.ts` e2e covering undo/redo.

## Output

Open a PR when done. Slices are independently landable — prefer several small PRs
over one large one; step 1 alone is worth shipping, because it is the point where
undo stops being inert.

**Target the base you branched from.** While #63 is unmerged, PR into
`claude/mesh-cleanup-legacy-sync-undo-qgev05` so this work stacks on it rather than
dragging the whole undo engine into an unrelated diff. Once #63 lands on `dev`,
rebase onto `dev` and retarget. If that ordering looks wrong when you get there,
ask — do not merge #63 yourself to simplify your own base.
