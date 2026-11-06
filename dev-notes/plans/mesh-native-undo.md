# Plan: mesh-native undo/redo

> **Status:** shipped — the engine is `packages/mesh/src/peer.ts` (undo log,
> `undo()/redo()/canUndo()/canRedo()/undoStatus()/clearUndoHistory()/onUndoChange()`,
> guarded-vs-naive policy), with the 17-test matrix in `packages/mesh/test/undo.test.ts`.
> `peer.batch(fn)` — grouping many committed writes into ONE undo action — was added
> later than this design and is not described below; grouping is bound when a write is
> *issued*, not when it is logged, because with a remote authority the entry is only
> pushed on ack. The design's step 5 ("optional action grouping") is therefore done.
> **Supersedes:** `user-undo.md` (frontend command-journal, since deleted) and the agent
> snapshot/checkpoint approach (built then reverted on `claude/intelligent-turing-pjs4tf`).
> **Executed as:** workstream B of
> [`mesh-drop-legacy-sync-and-undo.md`](./mesh-drop-legacy-sync-and-undo.md); made
> user-visible by [`mesh-frontend-writes.md`](./mesh-frontend-writes.md), because undo
> logs on the peer that *authors* a committed write and REST-authored writes are
> authored by the server.

Make undo/redo a **first-class primitive of the mesh** (`@vspark/mesh`), so every
client that mutates through the mesh — user editor tabs **and** the assistant
agent (its loopback peer) and any future client — gets undo for free, with one
mechanism and collaboration-safety by construction.

## Why the mesh is the right layer

It already carries the hard prerequisites:

- **Authorship** — every write carries `originId` (the peer it came from). This
  is the "author" we were trying to thread by hand; it's native here.
- **Ordering** — HLC stamps per committed write.
- **One chokepoint** — `Collection.{create,update,set,remove}` → `peer.localWrite`.
  All mutations funnel here; no per-route/per-store/per-resource wiring.
- **A change tap** — `AppliedChange` taps + observers.
- **A revert primitive already exists** — local-revert for ack corrections
  (authority rejects an optimistic write → revert). Undo generalizes this.

What it lacks (it's *state*-based LWW, not op-history): a per-peer **undo-log**
of before-values, **undo/redo stacks**, and **inverse replay**.

## Key simplifier: the committed / preview channel split

`committed` = reliable, HLC-stamped, retained (durable). `preview` = lossy,
unstamped, unretained (live drag overlays). **Only `committed` writes are
logged for undo.** A gizmo drag streams many `preview` writes and exactly one
`committed` write on release — so **the commit is the action boundary**, and the
coalescing/grouping problem from the old plan largely disappears. Explicit
action-grouping is then only needed for genuinely multi-doc atomic actions (e.g.
a cascade delete), and even that is optional (see below).

## Design

1. **Undo-log (per peer).** In `localWrite`, when the write targets the
   collection's retained (`committed`) channel, push an entry:
   `{ rtype, id, op, before, after }`. `before` is read from the replica *before*
   applying (`replica.get(id)`); `after` is the new value. Preview/ephemeral
   writes are never logged. Cap depth (e.g. 100 actions).
2. **Inverse replay.** `undo()` pops the last entry and emits the inverse as a
   normal **committed** write with a fresh HLC:
   - created (`before` undefined) → `remove(id)`
   - removed (`after` undefined) → `upsert(before)`
   - modified → `set(id, '', before)` (or a path-scoped patch for `patch` ops)
   The inverse propagates + persists + LWW-merges like any edit, so other peers
   see it and **collaboration-safety falls out of HLC LWW** — no bespoke guard.
3. **Redo.** Inverse pushes onto a redo stack; a *new* (non-undo) committed write
   clears redo. `redo()` re-applies.
4. **Per-peer stacks.** Undo only ever replays *this peer's* own logged actions,
   so scope is per-session by construction (the agent peer has its own stack).
5. **Optional action grouping** — `mesh.action(label, fn)` opens a group;
   committed writes inside it pop/replay together on undo. Needed only for atomic
   multi-doc actions (cascade delete of a node + its behaviors/clips). If
   cascades are issued as a contiguous run of committed removes, an alternative
   is to undo the contiguous same-timestamp run together — decide during build.

### Collaborative-undo semantics (decide + test)

Inverse-as-fresh-write means an undo *wins* (newer HLC) even if a peer edited the
doc concurrently. Two reasonable policies:
- **Naive:** undo always wins (last-writer-wins). Simple; an undo can override a
  collaborator's interleaved edit to the same doc.
- **Guarded:** skip the inverse if the doc's current value ≠ this peer's `after`
  (someone changed it since) — the same rule the reverted agent change-set used.
  Safer for shared docs; an undo silently no-ops on a contested doc.

Recommend **guarded** as the default, configurable. Add tests for both.

## Wiring (consumers)

- **`@vspark/mesh`:** the undo-log, stacks, `peer.undo()/redo()`, optional
  `mesh.action()`, and config (depth, policy). Self-contained in the package.
- **Frontend (`clientMesh`):** expose `undo()/redo()`; wire Ctrl/Cmd+Z and
  Ctrl+Shift+Z / Ctrl+Y in `pages/Editor.tsx` (skip when focus is in an
  input/textarea); TopBar buttons (disabled via `canUndo/canRedo`); i18n
  (`editor` namespace) + a help note.
- **Assistant:** "undo that" → call the agent's loopback peer `undo()`. The agent
  half folds in for free; **delete the snapshot approach** (already reverted).
  Optionally re-add a tiny `revert_last_change` tool that calls `peer.undo()`.

## Risks / open questions

- Capturing `before` for `patch` ops (partial): log the affected paths' prior
  values, or the whole doc (simpler, more memory). Whole-doc is fine at our scale.
- Cascade deletes: confirm whether the app issues N committed removes or the mesh
  cascades containment; that decides whether `mesh.action()` grouping is needed.
- Memory: bounded log; preview writes excluded keeps it small.
- It's a **core-package** change (backend + frontend + transports depend on it) —
  needs mesh-level unit tests and careful review.

## Tests (mesh package)

modify→undo restores prior committed value; create→undo removes; remove→undo
re-upserts; redo re-applies; **preview writes are never logged**; new write clears
redo; guarded policy skips a contested doc; per-peer isolation (peer A's undo
doesn't touch peer B's actions).

## Sequencing

1. Undo-log + `peer.undo()/redo()` + inverse replay (committed-only) + mesh tests.
2. Guarded concurrency policy + tests.
3. Frontend Ctrl+Z/redo + buttons + i18n/help.
4. Assistant `peer.undo()` (+ optional tool).
5. `mesh.action()` grouping for cascades (if needed).
