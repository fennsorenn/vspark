# Plan: user-facing undo/redo (Ctrl+Z)

Per-session, per-action undo/redo for the editor. Complements the already-shipped
**agent** undo (`assistant/checkpoint.ts` + `revert_last_change`, auto-checkpoint
per turn). This plan is the **user** half.

## Decisions (locked)

- **Per-session scope.** Each tab undoes only the edits it made — never a
  collaborator's. The per-tab undo stack inherently contains only this tab's
  actions, so scope falls out of *where* we record (local edits only).
- **Granularity:** per user action (one Ctrl+Z = one edit), with coalescing for
  rapid streams (drag).
- **In-memory, session-scoped** (lost on reload — normal editor-undo behaviour).

## The one clean seam

Every UI mutation is a scattered `store.X(...)` + `api.X(...)` pair across dozens
of call sites, and the **mesh feeder calls the same store actions** for remote
edits. So:

- Don't wrap call sites (too many, error-prone).
- **Record undo inside the editorStore mutation actions** — they see the
  before-state (current entity) before applying. The inverse closure replays
  through `api.X` (persist + sync) **and** the local store action.
- Distinguish local from remote with an **`opts` flag**: the feeder +
  projection feeders pass `{ remote: true }` (skip recording). UI calls omit it.

### Actions to hook (editorStore)

| Resource | actions | api inverse |
|---|---|---|
| scene node | `addNode` / `updateNode` / `deleteNode` | `createNode` / `updateNode` / `deleteNode` |
| compose layer | `addComposeLayer` / `updateComposeLayerLocal` / `removeComposeLayer` | `createComposeSceneLayer` / `updateComposeLayer` / `deleteComposeLayer` |
| compose scene | `addComposeScene` / `updateComposeSceneLocal` / `removeComposeScene` | create/update/delete compose-scene |
| behavior | `addBehavior` / `updateBehavior` / `removeBehavior` | `createBehavior` / `updateBehavior` / `deleteBehavior` |
| camera effect | `addCameraEffect` / `updateCameraEffect` / `removeCameraEffect` | create/update/delete camera-effect |
| track clip | `addTrackClip` / `updateTrackClipLocal` / `removeTrackClip` | create/update/delete track-clip |

### Remote call sites to flag `{ remote: true }`
`sync/meshStoreFeeder.ts` (all collection observers), `sync/sharedProjection.ts`,
`sync/meshProjection.ts`. Grep for `s.addNode|s.updateNode|s.deleteNode` etc.

## The hard parts (must handle for correctness)

1. **Delete cascades.** Deleting a node cascades behaviors / track clips / camera
   effects (DB FK + the store's `deleteNode` prunes them). The inverse must
   restore the node **and** every cascaded doc. Capture them at delete time
   (snapshot the node + its dependent docs from the store) and recreate all on
   undo, **preserving ids** so references hold. Easiest reuse: the same
   snapshot/restore shape as `assistant/checkpoint.ts`, scoped to the deleted
   subtree. Confirm `createNode`/`create*` accept a client-supplied `id` (the
   REST create endpoints take an optional `id` — verify) so undo restores the
   same id.
2. **Update coalescing.** A gizmo drag commits many `updateNode`s. Coalesce
   consecutive updates to the same `(entity, fieldset)` within a short window
   (or only record on interaction-commit). Check the transform path: live drag
   uses `node_transform_preview` (WS, not `api.updateNode`) and commits once on
   release — if so, recording per `api.updateNode` is already one-per-commit and
   coalescing is only needed for rapid property-panel edits (debounce by id+key).
3. **Redo invalidation.** Recording a new command clears the redo stack.
4. **No self-recording on replay.** undo()/redo() must run the inverse with
   `{ noUndo: true }` so they don't push new commands; the undoStore moves the
   command between stacks itself.
5. **Echo loop.** undo()'s `api.X` syncs to the backend → echoes back via the
   feeder → feeder applies with `{ remote: true }` → no re-record. Verify no loop.

## Pieces

1. `store/undoStore.ts` — `{ undoStack, redoStack, record(cmd), undo(), redo(),
   clear(), canUndo, canRedo }`. `cmd = { label, undo(), redo() }`.
2. `editorStore` actions — add `opts?: { remote?; noUndo? }`; when local +
   !noUndo, build `{ undo, redo }` and `undoStore.record(...)`.
3. Feeder/projection call sites — pass `{ remote: true }`.
4. `pages/Editor.tsx` keydown — Ctrl/Cmd+Z → undo, Ctrl+Shift+Z / Ctrl+Y → redo
   (extend the existing handler; skip when focus is in an input/textarea).
5. TopBar undo/redo buttons (disabled via `canUndo`/`canRedo`) + i18n
   (`editor` namespace) + a help note.
6. Tests: jsdom store tests — record→undo restores prior state, redo re-applies,
   delete→undo restores the node + a dependent behavior with the same ids,
   remote edits don't record, coalescing collapses a rapid update stream.

## Sequencing
Foundation (undoStore + node add/update with coalescing + Ctrl+Z/redo) → node
delete with cascade-restore → compose layers/scenes → behaviors → camera effects
→ track clips → buttons/i18n/help. Commit per stage.

## Risk
The delete-cascade restore and the remote-flag completeness are the bug-prone
parts. A missed remote flag records a collaborator's edit onto your undo stack;
a missed cascade leaves orphaned references after undo. Both need the jsdom tests
above before shipping.
