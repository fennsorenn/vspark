# Mesh — Replicated Store (@vspark/mesh, @vspark/mesh-react, @vspark/mesh-transports)

**Status:** Core package implemented with 29 vitest tests; three packages (mesh / mesh-react / mesh-transports WS pair) shipped; backend hydration + persistence complete; reads fully mesh-fed (`sync/meshStoreFeeder.ts`); writes mesh-authored for `scene_node` and `compose_layer`, still REST for `behavior` / `camera_effect` / `track_clip`. See [Remaining](#remaining) for the rest.

A **schema-agnostic in-memory replicated store** with symmetric read/write API on both frontend and backend, HLC last-write-wins convergence, grant-gated access control, and authority-driven ack lifecycle. No durability in the package itself; durable peers hydrate from persistent store and persist incoming mutations via observe taps. Designed to replace both the legacy sync layer and the entity-aware collab-scene sharing model.

### Which plan is which

Several plan documents describe this system and they are **not** alternatives —
they are a chain, and only reading them in order makes the code legible. Each
plan now opens with a status blockquote (shipped / live / superseded); this table
is the index into that chain:

| Plan | What it is |
|---|---|
| [plans/permissioned-sync-mesh.md](../plans/permissioned-sync-mesh.md) | A **design-alignment** doc, not an execution plan. Its §4 is where the fractional-index ordering rule first appears — as semantics only; the phasing in §6 contains no slice that adopts it, which is why `fracIndex.ts` sat written, unit-tested and *unreachable* (missing from the `@vspark/shared` exports map, the frontend tsconfig paths, and the vite/vitest aliases) until migration 036. Do not read this plan as a record of what was built. |
| [plans/mesh-sync-refactor.md](../plans/mesh-sync-refactor.md) | The plan that was actually **executed**. §8 defines the interface; the code cites §§8/9/10/11 by name. This is the spec. |
| [plans/mesh-native-undo.md](../plans/mesh-native-undo.md) | Undo/redo as a peer primitive. |
| [plans/mesh-drop-legacy-sync-and-undo.md](../plans/mesh-drop-legacy-sync-and-undo.md) → [plans/mesh-frontend-writes.md](../plans/mesh-frontend-writes.md) | Retiring the legacy envelope, then moving UI writes onto the tab peer. |

**Comments claiming a legacy path is deliberate are debt, not design.** Several
in this area ("kept on purpose", "low value", "smoothing-aware broadcast") turned
out to describe what nobody got to, and two of them had gone actively wrong when
the model underneath them changed. Judge a path by whether a mesh-native
equivalent *exists and is wired* — read the collection registration and the
feeder — never by what a comment next to it asserts.

## Core principles

**Decided by the user, 2026-08-13.** These are prescriptive: they constrain what
may be built, and reversing one needs the user's agreement. Everything else in
this document describes how the code behaves today and may be changed by whoever
has a reason to.

### 1. Sync the inputs, derive the outputs

Stream only what cannot be computed — external sensor data (mocap pose,
blendshapes, IK targets). Anything derivable from documents is derived locally,
on every peer, from the same inputs.

Worked example: animation clip playback does **not** stream evaluated
transforms. The clip document and the playback state (`state`, `startEpoch`,
`speed`) sync; every peer derives the playhead from `startEpoch` against the
wall clock and evaluates the clip itself. A "peer that can't evaluate" is a peer
that is missing an input — widen its grant, never reintroduce the stream.

### 2. A document has exactly one truth

Never deliberately different between clients. A document's content is the same
everywhere, whoever is asking. It may be in flight, or divided across
documents — it is never per-client.

If a client needs a diverging view, it takes a **local copy**, or writes a
**local patch document merged at render time**. It does not rewrite the shared
document's fields for itself.

> Note this indicts current code: `meshStoreFeeder`'s `scene_node` observer
> preserves local `projectId`/`rootSceneNodeId` while taking remote content, and
> `mountSharedScene` localizes `projectId` per peer. Both give one id different
> parent links on different peers, which makes "what is this document" answerable
> only by knowing who is asking. This is recorded as a defect to fix, not as a
> pattern to copy.

### 3. Mounting is rendering, not merging

A shared tree stays whole and unmodified — the owner's ids, the owner's parent
links. It is **not** spliced into the receiver's tree. The receiver's tree holds
a share container node, and the renderer walks into the foreign tree at that
point. Two trees, joined at display time.

The mesh transports trees; it does not merge them. This is what makes principle
2 achievable: the field rewriting exists only to force a foreign tree into the
local one, so removing that job removes the reason to rewrite.

### 4. A mount is not a reconnect

Two distinct operations, and they must not be inferred from each other:

- **Reconnect** — peers with shared history, comparable clocks. Reconcile
  normally through last-write-wins.
- **Mount** — no shared history with the incoming scene. The mount records its
  own timestamp as **local metadata on the share**, and reconciliation compares
  against `max(document write stamp, mount stamp)`.

Without this, mounting a scene whose ids you once deleted lets your tombstones
out-stamp the author's live documents: the mount lands empty, and the mutual
subscription then propagates those tombstones back and deletes the author's
scene.

**The mount stamp goes on the share, never on the document.** Re-stamping the
incoming documents would work, and it would violate principle 2 — the same
document would carry a different stamp on the receiver than on its author. Two
things follow from keeping it beside the document instead:

- Nothing can leak back to the author. The document is untouched, so there are
  no receiver-authored stamps to re-publish and no way for the receiver to
  appear as the author of the owner's scene (which would put it on the wrong
  undo stack). This is structural, not a rule to remember.
- It expires by itself. Once a document's own write stamp passes the mount
  stamp, `max` is the write stamp and ordinary LWW resumes — no flag to clear,
  no state to go stale.

The mount must still be an **explicit act** rather than inferred from "we hold
no state for this": a dropped socket and a fresh mount look alike at the
transport level.

### 5. The REST API stays — it writes THROUGH the mesh

Migrating a write off REST means changing what the endpoint does, never deleting
it. `/api` is a **public surface for outside services** (stream tooling,
automation, integrations), and it keeps working regardless of what the editor UI
does.

So a migrated endpoint becomes a thin adapter: validate, then write the
collection, exactly as a tab would. It does not touch SQLite directly and does
not broadcast its own WS message — persistence and fan-out both fall out of the
mesh write.

The one thing an external caller does not get is undo, and that is correct
rather than a gap: a REST write is authored by the SERVER, so it lands on no
peer's undo stack. Undo belongs to the peer that made the edit, and an HTTP
client is not one.

What DOES get deleted is the bespoke machinery beside the mesh — in-memory state
that duplicates a collection, WS kinds that re-send what the mesh already fanned
out, and snapshot-on-connect handlers that reimplement retention.

### 6. Seed at create

"Set this only if nobody has set it" is a read-then-write, and last-write-wins
cannot protect the gap between the read and the write — two peers can both
observe "absent" and both write. So defaults are written **when the document is
created**, where there is no gap.

If a field must be backfilled onto documents created before it existed, that is
an ordinary update, and it gets a **single owning writer** so there is no race.

## Architecture overview

### Three packages

**`@vspark/mesh`** — Core replicated store (no React, no IO, no DB):
- `MeshPeer` — peer identity + transport registry + subscription management.
- `Collection<T>` — typed id-keyed store with parent-child hierarchy (containment index), channel-tagged writes, read + write API, observe taps for durability.
- `Replica` — per-path HLC LWW storage (atomic history per key), tombstones, ephemeral overlays with composed-read cache, snapshot + apply mechanics.
- `ChannelRegistry` — named delivery channels with declared semantics (reliable/lossy, stamped/ephemeral, acking).
- Transport SPI + loopback implementation for testing.

**`@vspark/mesh-react`** — React hooks (useSyncExternalStore):
- `useMeshDoc(collection, id)` — read a single document.
- `useMeshSubtree(collection, rootId)` — read a subtree + descendant list.
- `useMeshChildren(collection, parentId)` — read immediate children only.
- `useMeshAll(collection)` — read all entries.
- `useMeshValue(collection, id, path)` — read a single scalar/path value.
- `useMeshStatus(collection)` — connection + ack status.
- `useMeshCanWrite(collection)` — authority reachability gate.
- `useMeshSelector(collection, selector)` — composable selector helper.

All subscribe to the replica via `useSyncExternalStore` and auto-unsubscribe on unmount.

**`@vspark/mesh-transports`** — Transport implementations:
- `WsServerTransport` — `/mesh` route (hello handshake, participant id composition `${serverPeerId}#${tabUuid}`).
- `WsBackendTransport` — Browser client with auto-reconnect and offline write gating.
- WebRTC adapters (ServerMesh, BrowserPeerMesh wrapping) — planned.

### Core invariants

**One retained channel per collection.** Retained = what the replica stores, snapshots serialize, acks guard, durable peers persist. Ephemeral channels are transient per-key overlays (e.g., preview drag frames; never snapshots, never acked, never persisted).

**Subscribing to ephemeral auto-includes retained.** Opting out of model updates is never the intent — preview subscribers always also get the base state.

**Channels are delivery semantics, not data layers.** A channel declares transport reliability, HLC stamping, retention, and ack requirements. Composition of multiple sources driving one value (e.g., base / clip-override / runtime-override) happens via app-level conventions on sub-paths with a shared deterministic resolver, not via channels. But the channel a write arrived on *is* the authoritative statement of what the write means — see [Committed vs preview](#committed-vs-preview--the-channel-is-the-discriminator).

**At most one ack authority per collection**, gated while reachable, with three-outcome acks:
- `acked` — applied + persisted by authority.
- `corrected` — authority applied a normalized/clamped value; the corrected value supersedes everywhere.
- `rejected` — authority refused; current value included in the nack so no refetch round-trip needed.

**Recency-gated revert on ack timeout.** Authority unreachable mid-flight: reverted *only if the current value still carries the write's HLC stamp* — a read-only check that's safe under concurrent writes. Revert is *local-only* (no compensating broadcast); reconnect reconciliation from the authority is the real repair. Brief divergence among non-authority peers during an outage is accepted.

**Legacy bridge echo guard.** The legacy sync.document ↔ mesh replica mirror taps sync.document.upsert to watch for writes from the mesh side; when a write originates from the mesh (`origin === peerId`), the bridge skips applying it back to the document (detected via `applyFromMesh` ids). This prevents echo feedback while the two layers converge.

## Collection API

### Reads (synchronous, local replica)

```ts
collection.get(id)          // T | undefined (retained + ephemeral overlay)
collection.all()            // Map<id, T>
collection.children(id)     // immediate children (from containment index)
collection.subtree(rootId)  // descendants + flat array [root, ...children]
```

The containment index is maintained automatically from the `parent?(doc) → {rtype, id} | null` function declared in the collection schema.

### Writes (apply local → fan out → ack lifecycle)

```ts
collection.create(doc: T): WriteHandle       // new id, apply, broadcast
collection.update(id, partial: Partial<T>): WriteHandle  // path merge
collection.set(id, path: string, value): WriteHandle     // single cell
collection.remove(id): WriteHandle           // tombstone + broadcast
```

All writes are subject to:
- Authority reachability gating (if authority is known down, guarded writes reject synchronously, and UIs consult `canWrite()`).
- Remote grant validation on receive.
- Ack lifecycle: authority applies, persists, and acks; timeout triggers recency-gated revert.

### Hydration (durable peers, boot)

```ts
collection.put(doc: T, { v: HLC }): void   // apply with HLC stamp; LWW vs live replicas
collection.putTombstone(id, v: HLC): void  // mark deleted
```

These apply without broadcasting and never trigger acks (the source of truth for the stamps — the persistent store — is already responsible for ordering).

### Observation

```ts
collection.observe(selector, callback): Unsubscribe
//   selector: id | { subtree: id } | '**' (all changes)
//   Change<T> = { op: 'upsert' | 'patch' | 'remove', id, path?, doc?, v?, origin, channel }

collection.onCommitted(callback): Unsubscribe
//   sugar: only remote-origin, retained-channel changes
//   (for durable peers' persist taps)
```

### Status & authority

```ts
collection.canWrite(): boolean  // false while ack authority is known down
```

## Undo / redo (per peer)

Undo/redo is a **first-class primitive of the peer** (`MeshPeer`, in
`packages/mesh/src/peer.ts`), so any client that mutates through the mesh gets
it for free, collaboration-safe by construction.

- **Logging.** In `localWrite`, every committed (retained-channel, non-hydrate)
  write this peer *authors* pushes a `{ rtype, id, op, before, after }` entry —
  `before`/`after` read from the replica (`raw(id)`, overlay-free) around the
  apply. **Preview/ephemeral writes are never logged**: the commit is the action
  boundary, so gizmo-drag coalescing is a non-issue. Remote-authority writes are
  logged only once the authority confirms (acked / corrected value); a rejected
  or timed-out optimistic write leaves no entry. Depth-capped (default 100).
- **Opting out.** `WriteOpts.undo: false` keeps a committed write off the stack.
  It suppresses the entry only — the write applies, replicates, persists and acks
  like any other. For changes that are not document edits: **Decided:** transport
  controls (play / pause / stop, and scrub-release) pass `undo: false`, because
  otherwise pressing Play makes the next Ctrl+Z un-pause rather than undo the
  user's last edit.

  Sharp edge worth knowing before using it on a doc users also edit: the guarded
  policy skips an inverse when the doc changed since the entry was logged, and it
  compares values — so it cannot tell a collaborator's edit from a non-undoable
  one. An `undo: false` write therefore **guards the doc against its own earlier
  entries**, and an undo that would otherwise apply is skipped. That is the
  conservative direction (skip rather than clobber), and transport state does not
  hit it because it lives in its own collection with no undoable writes. Pinned
  by "SHARP EDGE: an opted-out write blocks a later undo of the same doc" in
  `packages/mesh/test/undo.test.ts`.
- **Replay.** `peer.undo()` re-emits the inverse as a fresh committed write
  (`created→remove`, `removed`/`modified`→restore prior doc); `redo()` re-applies
  the forward direction. Because the inverse is a normal write, propagation,
  persistence, and LWW convergence all fall out of the standard path — no bespoke
  protocol. A new committed write clears redo.
- **Per-peer stacks.** Undo only ever replays *this peer's* own actions (the
  agent loopback peer, once it exists, has its own stack).
- **Grouping (`peer.batch`).** `batch(fn)` groups every committed write `fn`
  *issues* into one `UndoGroup`, undone and redone as a unit; a write outside a
  batch is its own group of one, and nested batches join the outer one. Two
  properties matter and are easy to break:
  - **Membership is bound at ISSUE time, not at log time.** With a remote
    authority the entry is only pushed on ack, by which point the batch has long
    since closed — so `localWrite` captures `this.currentGroup` alongside the
    pending ack (`peer.ts`, `undoGroup`). The consequence for callers: **issue
    every write inside the batch and await the acks afterwards.** Awaiting one
    write's ack before issuing the next puts them in different actions. See
    `commitPromoteLayerToNode` in `frontend/src/mesh/layerWrites.ts`, which
    creates the 3D node and removes the 2D layer in one `meshBatch` for exactly
    this reason — grouped wrongly, undo leaves the node behind while the layer
    returns, a state the user never authored.
  - **A group reaches the stack on its first CONFIRMED write** (`pushUndo`), so a
    batch whose writes are all rejected leaves no action behind, and later
    confirmations append to the group already placed. Undo is all-or-nothing
    across the group and replays entries in reverse issue order (children were
    removed before their parent, so the parent must come back first).
- **Concurrency policy** (`MeshPeerConfig.undo.policy`): `guarded` (default)
  skips an inverse when the doc's current committed value diverged from what this
  peer left it at (a collaborator edited it since); `naive` is last-writer-wins.
- **API:** `undo()`, `redo()`, `canUndo()`, `canRedo()`, `undoStatus()`,
  `clearUndoHistory()`, `onUndoChange(cb)`. Test matrix in
  `packages/mesh/test/undo.test.ts`. Design:
  [plans/mesh-native-undo.md](../plans/mesh-native-undo.md).

**Who authors decides who can undo.** Undo logs on the peer that *authors* the
committed write, and nowhere else. A UI write that travels over REST is authored
by the **server** peer — it lands on the backend's process-global stack (shared
across every tab) and on nobody's tab stack, so the user cannot undo it. This is
the single reason the write migration matters beyond tidiness.

Current state, per rtype:

| rtype | UI write path | Undoable in the tab |
|---|---|---|
| `scene_node` | tab peer (`frontend/src/mesh/writes.ts`) | yes |
| `compose_layer` | tab peer (`frontend/src/mesh/layerWrites.ts`) | yes |
| `behavior` | tab peer (`frontend/src/mesh/behaviorWrites.ts`) | yes |
| `camera_effect` | tab peer (`frontend/src/mesh/effectWrites.ts`) | yes |
| `track_clip` | tab peer (`frontend/src/mesh/writes.ts` adapter) | yes |
| `logic` | tab peer (`frontend/src/mesh/logicWrites.ts`) | yes |
| `clip_playback` | tab peer (`frontend/src/mesh/playbackWrites.ts`), `undo: false` | no — deliberately; transport is a view action, not a document edit |

The fallback ladder in `writes.ts` drops a *mesh-eligible* write back to REST
when the doc is owner-authoritative (a Phase-6 projection), the tab peer isn't
armed / the authority is offline (`canWrite()`), or the replica doesn't hold the
doc. A write that took the fallback is likewise not undoable — by design, since
the tab never authored it.

Frontend plumbing (`meshUndo` / `meshRedo` / `meshBatch` / `onMeshUndoChange` in
`frontend/src/mesh/peer.ts`, keybindings, TopBar buttons, i18n, help) is in place
and lights up per write path as it migrates. A dedicated **agent loopback peer**
for assistant undo is not yet built.

**Commit granularity is a UI decision, and it is part of the undo model.** Every
committed write is one undo step, so a control that commits per keystroke makes
undo useless. `frontend/src/hooks/useMeshField.ts` owns that split for bound
controls (`onChange` previews locally, `onBlur` commits once; `set()` for
discrete controls that have no gesture); call the imperative helpers directly
only from call sites that can't obey hook rules.

## Channel mechanics

Channels are declared when creating the collection:

```ts
const nodes = mesh.collection<Node>('scene_node', {
  validate?: (data: unknown, originId?: string) => Node,  // originId = origin peer (peer-clock localization)
  channels?: string[],  // default ['committed', 'preview']
  authority?: 'self' | PeerId,
});

// Built-in channels:
//   'committed' → reliable, stamped (HLC), retained (snapshot), ack:'authority'
//   'preview'   → lossy, unstamped, ephemeral (drag previews, IK targets)
//
// App-defined channels (declared in packages/backend/src/mesh/streams.ts):
//   'control'   → reliable, unstamped, unretained — for event traffic (playback
//                 controls, runtime relay) where ordering matters but there is no
//                 state to snapshot or persist
```

A write targets a channel via `set(id, path, value, { channel: 'preview' })`. Writes to the retained channel flow through ack authority; ephemeral writes always flow (no authority gating).

### Snapshot & apply

On subscription with an unmet grant, the subscriber receives:
1. Snapshot of the retained channel's current state (all entries + their HLC stamps).
2. A watermark (HLC timestamp) bounding the snapshot's consistency.
3. Live ops after the watermark.

Applying a remote op validates the source has write permission (via the grant store) and runs the resource's `validate` function before touching the replica.

### Peer-clock localization (validate origin id)

`validate` receives the **origin peer id** as a second argument, so a collection can localize peer-relative fields (clock-anchored timestamps) when a foreign doc arrives:

```ts
validate?: (data: unknown, originId?: string) => T   // packages/mesh/src/collection.ts
```

`Collection.validateDoc(data, originId?)` forwards it. `MeshPeer` (`packages/mesh/src/peer.ts`) threads the origin through every apply path: `this.id` for local writes, `env.origin` for remote ops, and `senderId` for snapshots. The peer also exposes a peer-clock API `toLocalTime(originId, t)` that maps a timestamp authored on `originId`'s clock onto the local clock (identity when `originId` is this peer, since local writes are already local).

First use: the `scheduled_animation` collection's `validate` rewrites `startEpoch` via `peer.toLocalTime(originId, startEpoch)` so a timeline authored on one peer activates at the same wall-clock instant everywhere (see [animation.md](animation.md)). The clock is a synchronized-clocks stub today, so the translation is numerically a no-op, but the mechanism and call sites are final.

## Committed vs preview — the channel is the discriminator

Every user-visible edit exists in two forms and they ride two different channels.
Getting the split right is what makes gestures smooth *and* keeps a cold page
load from animating.

| | `committed` | `preview` |
|---|---|---|
| transport / stamping | reliable, HLC-stamped | lossy, unstamped |
| replica | retained: stored, snapshotted, tombstoned | per-key **overlay** composed over the retained doc |
| authority | guarded — ack / correct / nack | ungated, always flows |
| durability | persisted by the backend `onCommitted` tap | never persisted |
| undo | one entry on the authoring peer | never logged |
| meaning | model state | an in-flight gesture |

**The channel is the discriminator — do not re-derive intent from the payload.**
`Replica.get()` composes overlays over the retained doc, and the change handed to
`observe()` carries its `op` and `channel`. So in
`frontend/src/sync/meshStoreFeeder.ts` an `op === 'ephemeral'` change *is* an
in-flight gesture by construction and is routed into the tween
(`smoothComposeLayer`), while a retained op is model state and is applied
directly. Two things fall out of that for free:

- **A cold page load cannot animate.** Snapshots only carry retained channels
  (`Replica`/`peer.ts` skip collections with no retained channel on both the send
  and apply side), so nothing arriving at mount can be mistaken for a gesture and
  tween in from wherever the store happened to sit.
- **Mid-gesture the committed value retargets the running tween** rather than
  snapping, because the preview channel is lossy and the last preview frame may
  never have landed (`hasLayerTween` branch in the feeder).

**Overlays are cleared by the committed write itself.** A retained upsert deletes
the doc's overlay map (`Replica.upsert` → `overlays.delete(id)`), so a gesture
needs no explicit "clear preview" message: committing ends it.

### One overlay per field

An ephemeral write with an **empty path is a ROOT overlay**: `Replica.ephemeral`
clears every per-path overlay for that id and the composed read then returns the
root value *instead of* the retained doc — not merged with it. So a pathless
preview of `{x: 400}` composes to a doc that is only `{x: 400}`, losing the `id`
and everything else with it.

Therefore: **write previews one overlay per field**, as
`previewLayerFields` does —

```ts
for (const [field, value] of Object.entries(patch))
  col.set(id, field, value, { channel: 'preview' });
```

The root form is only correct when the whole document really is the unit being
previewed (a pure-stream collection like `node_stream`, where each frame replaces
the last).

## Structural writes — a subtree delete must remove descendants explicitly

Deleting a document that has children is **not** one write. The helpers in
`frontend/src/mesh/writes.ts` walk the containment index and issue a remove for
every descendant, each before its own parent, inside one `meshBatch`:

```ts
const acks = meshBatch(() => [
  ...descendantsBottomUp(adapter, id).map((d) => col.remove(d.id).ack),
  col.remove(id).ack,
]);
await Promise.all(acks);
```

Leaving the children to the server's SQL foreign-key cascade **looks** correct —
the rows do disappear — but only the root gets a `col.remove`, so only the root
gets a tombstone and only the root gets an undo entry. Undo would then restore a
parent whose children are gone from the database for good, and gone from every
other peer's replica with no tombstone to explain it. The same rule covers the
"delete but keep children" variant (`commitDocDeleteKeepChildren`): reparent the
children, then remove the doc, all in one batch so the reparents don't unwind
separately.

Ordering matters in both directions: depth-first preorder puts a parent ahead of
its descendants, so *reversing* it gives the bottom-up removal order, and undo —
which replays a group in reverse — restores parents first.

## Data shapes

### Document collection (e.g., scene nodes)

```ts
const nodes = mesh.collection<SceneNode>('scene_node', {
  parent: (doc) => doc.sceneRootId ? { rtype: 'scene', id: doc.sceneRootId } : null,
  channels: ['committed', 'preview'],
  authority: 'self',  // on the home peer; other peers have `authority: homeServerId`
});

nodes.create({ name, transform, ... });
nodes.update(id, { name: 'new' });
nodes.remove(id);
nodes.observe('**', (change) => console.log(change));

// React hook
const node = useMeshDoc(nodes, id);
const tree = useMeshSubtree(nodes, rootId);
const [pos, setPos] = useMeshValue(nodes, id, 'transform.position');
```

### Stream collection (e.g., pose frames)

```ts
const pose = mesh.collection<PoseFrame>('vmc_pose', {
  channels: ['frames'],  // only ephemeral, no retention
});

pose.set(avatarId, '', frame, { channel: 'frames' });
pose.observe({ subtree: avatarId }, (change) => applyPoseFrame(change));
```

## Backend parallel-run wiring

Location: `packages/backend/src/mesh/index.ts`.

**Collection definitions (BINDINGS):**
- `scene_node` (parent: owning scene)
- `behavior` (parent: owning node)
- `camera_effect` (parent: owning scene)
- `compose_layer` (parent: owning scene)
- `track_clip` (parent: owning scene)
- `scheduled_animation` (parent: owning avatar `scene_node`) — per-avatar clip timeline; see [animation.md](animation.md). Its `validate` localizes the author-anchored `startEpoch` onto the receiver clock (peer-clock localization, below).

**Hydration (boot):**
```ts
for (const row of db.allSceneNodes()) {
  nodes.put(rowToNode(row), { v: HLC.parse(row.syncV) });
}
for (const t of db.tombstones('scene_node')) {
  nodes.putTombstone(t.id, HLC.parse(t.v));
}
```

**Persistence tap (replaces per-rtype `applyClipDto` / etc.):**
```ts
nodes.onCommitted(({ op, id, doc, v }) => {
  if (op === 'remove') {
    db.deleteSceneNode(id);
    db.tombstone('scene_node', id, v);
  } else {
    db.saveSceneNode(doc, v);  // v stored as syncV column
  }
});
```

All collections are wired identically (`scene_node`, `behavior`, `camera_effect`, `compose_layer`, `track_clip`, `animation_clip`, `scheduled_animation`). A generic `(rtype, id, hlc)` tombstone table replaces the legacy `collab_tombstones`; tombstones are GC'd by age (offline peer may resurrect a deletion — accepted policy).

## Frontend wiring

Location: `packages/frontend/src/mesh/peer.ts` — one peer per tab, created once by
`initMeshPeer()` (idempotent; started from both `Editor.tsx` and `ViewerPage.tsx`,
since both render live state). It registers a collection per rtype in `RTYPES`
(`scene_node`, `behavior`, `camera_effect`, `compose_layer`, `track_clip`,
`animation_clip`, `scheduled_animation`) with `authority: serverPeerId`, and the
containment schema from `PARENTS` in the same file.

**Participant ID:** `${serverPeerId}#${tabUuid}` (stable across reloads via
sessionStorage), so HLC origins and grants stay consistent per tab.

**Auto-subscription re-arming:** the peer marks outgoing subscriptions stale on
disconnect and they do not auto-renew, so `armSubscriptions()` re-subscribes every
rtype (`entityId: '*'`) on each `onStatus` transition back to connected.

**Vite proxy:** `/mesh` route proxied to backend during dev.

**Reads** are mesh-fed but not yet mesh-*bound*: `sync/meshStoreFeeder.ts` mirrors
the replica into Zustand `editorStore` and components read the store. Moving
components onto `@vspark/mesh-react` hooks is still open.

**Writes** go through `mesh/writes.ts` / `mesh/layerWrites.ts` for `scene_node`
and `compose_layer`; everything else is still REST. See the Undo/redo table for
what that costs.

## Extending: adding a new synced rtype

**Every step is load-bearing, and a missed one fails SILENTLY** — this is the
`fracIndex` failure mode: a module with passing unit tests that nothing can
reach. The list below was re-derived by adding `clip_playback` end to end;
the previous version of this section named three steps that do not exist
(`load`/`save`/`remove` on `BINDINGS`, a per-table `syncV` column, manual
hydration) and omitted three that do.

Two failures worth knowing in advance, because neither announces itself:

- An rtype registered on only ONE peer: the receiving side drops the op and
  sends no ack, so the write reverts ~4s later with nothing logged.
- A collection missing from the frontend list: the feeder throws on
  `.observe`, catches it into a console warning, and **every other observer
  stops being registered too**. The tab goes quiet, not red.

### Backend

1. **Migration** — a `.sql` file in `packages/backend/src/db/migrations/`, then
   `node packages/backend/scripts/buildMigrations.mjs` for its `.ts` mirror.
2. **Register the migration** in the `MIGRATIONS` array in
   `packages/backend/src/db/index.ts` (import + list entry). Easy to miss: the
   generated mirror existing is not the same as it running.
3. **Resource descriptor** — `defineResource({ rtype, cls: 'document', load,
   save, remove })` in `packages/backend/src/sync/resources.ts`. This is where
   row ⇄ DTO mapping lives (snake_case ⇄ camelCase). Persistence, hydration and
   tombstone rehydration are all driven from it; `bindCollection` returns early
   without one, leaving a replicate-only collection.
4. **Binding** — a row in `BINDINGS` in `packages/backend/src/mesh/index.ts`:
   `rtype`, `table`, `parent`, optional `validate`, and `persists` (which gates
   SQLite only — a doc that fails it still fans out to every replica).

### Frontend

5. **`RTYPES`** in `packages/frontend/src/mesh/peer.ts` — creates the collection
   and subscribes to it.
6. **`PARENTS`** in the same file. It must match the backend `parent` **exactly**;
   the two containment indexes diverge with no error otherwise.
7. **Store slice** — state + actions in
   `packages/frontend/src/store/editorStore.ts`.
8. **Feeder observer** — `packages/frontend/src/sync/meshStoreFeeder.ts`,
   mirroring the replica into that slice. Handle `remove` explicitly, and decide
   whether `ephemeral` ops mean anything for this rtype.
9. **Writes** — a `MeshDocAdapter` in `packages/frontend/src/mesh/writes.ts`
   (or a sibling like `layerWrites.ts`) rather than REST calls, so the write is
   authored by the tab and lands on its undo stack.

### Two constraints on the doc shape

- **Ids are globally unique across rtypes.** The `ContainmentIndex`
  (`packages/shared/src/containment.ts`) keys by id alone, so a doc must not
  reuse its parent's id — carry the parent as a field instead. `clip_playback`
  has its own uuid plus a `clipId`, precisely for this.
- **Nothing in `packages/shared` needs changing.** `SyncEnvelope.rtype` is a
  free-form string; there is no rtype union or zod schema to extend. Nor is
  `backend/src/sync/containmentIndex.ts` a registration point — that index
  serves the legacy object-share code, and `MeshPeer` keeps its own private one.

### Gate it

Add a backend test asserting `getMeshCollection('<rtype>')` is defined after
init, that a committed write reaches SQLite, and that the containment parent is
what you intended — see `packages/backend/test/mesh.clipPlayback.test.ts`. Those
three catch every wiring break above; behaviour tests do not.

## Integration roadmap

**Completed (through collab live-ops migration):**
- Core package (@vspark/mesh) — 29 tests, all APIs. New: snapshot relay topology + one-way place isolation tests + pure-stream containment routing test. `handleSubOk` now relays snapshot-applied docs/tombstones onward to the peer's own subscribers (tabs subscribed before a reconcile were previously blind to snapshot state).
- React hooks (@vspark/mesh-react) — all hooks.
- Transports (@vspark/mesh-transports) — WS pair shipped; WebRTC pending.
- Backend hydration + persistence (five collections, generic onCommitted taps).
- Frontend per-tab peer + auto-subscribe (wired, mounted in Editor).
- **Collab-scene LIVE OPS + RECONCILE:** standing RUCD mesh grant on scene subtree, mutual subscription re-armed per connect, snapshot-on-subscribe replaces reconcile. Verified 8/8 two-backend live.
- **Legacy bridge:** sync.document ↔ mesh replica mirror (`packages/backend/src/mesh/index.ts`) with echo guard.
- **ServerMeshTransport:** mesh over legacy WebRTC channels namespaced `_mesh2` (`packages/backend/src/mesh/serverMeshTransport.ts`).
- **Grants + subscription arming:** `packages/backend/src/mesh/collab.ts`.
- **Tombstone persistence:** `mesh_tombstones` table (migration 032), HLC storage, 30-day prune.
- **Object-share document plane (step D) — DONE, verified 8/8 two-backend live** (commits ccbfa80 + 8d6bda5). See [plans/mesh-sync-refactor.md §9 status](../plans/mesh-sync-refactor.md) for the full verification log.
  - `packages/backend/src/mesh/shares.ts` — new: mirrors legacy share grants into the mesh grant store (cross-type subtree grants); revoke evicts the receiver's subscription. `initMeshShares()` wired into index.ts boot.
  - `packages/backend/src/mesh/index.ts` — per-rtype `persists(dto)` predicates: foreign docs (mismatched owner projectId or missing parent rows) skip the persistence tap entirely — replica-only fan-out to tabs, never touching SQLite. Only removes persist/tombstone if a local row existed.
  - `packages/backend/src/multiplayer/sharing.ts` — `forwardDocOp` and the `_share_update` relay deleted; `_share_snapshot` demoted to asset manifest + stream-routing registration (broadcast now includes `assetUrls: ownerPath→localURL`); `_share_unshared` also drops the receiver's placed mesh subscription. `subscribeShared(peerId, objectId, streams)` — mesh sub always; legacy subscribe only when `streams=true`. REST `/connections/peers/:peerId/subscribe` gained the `streams` flag. Pre-existing bug fixed in `shares.ts listSharesForPeer`: reused PreparedStatement (single-use wrapper finalizes after first `.get()`) caused advertise 500 once a peer held ≥2 share grants; replaced with a single batched IN query.
  - `packages/frontend/src/sync/meshProjection.ts` — new: feeds the existing `sharedProjection` store from the mesh `scene_node` collection (observes `'**'`, projects subtrees of placed containers gated on `connectionsStore.subscribed`, incremental `applyUpdate` with Phase-6 stale-drop/pending-write reconciliation, `registerAssetUrls()` localizes file paths and re-projects). `useWsSync`'s `mp_shared_snapshot` handler now only records `assetUrls` + subscribed state; `mp_shared_update` handler removed. Started from Editor.tsx alongside `initMeshPeer`.
  - `packages/frontend/src/sync/shareDirect.ts` — now carries only streams + blob fetches.
- **Collab live streams (b4d55c5, 2530c3f) — DONE, verified 5/5 two-backend live:**
  - `packages/backend/src/mesh/streams.ts` (new) — `node_stream` pure-stream collection (no retained channel; lossy `preview` channel keyed by node id) for pose/blendshape/IK/drag-preview frames on collab-scene nodes. Existing collab `'*'`-subtree subscriptions route frames via cross-type containment (`collabSceneForNode()` gates sender + bridge). Receiving backends bridge remote frames onto `/ws` under the original kind. `_collab_stream` + `forwardCollabStream` deleted. Object-share streams stay on legacy `_share_stream` (direct browser edges).
- **Collab clip playback (b4d55c5, 2530c3f) — DONE, verified 5/5 two-backend live:**
  - `clip_control` collection (also in `streams.ts`) on a new `control` channel (reliable, unstamped, unretained — events not state), keyed by clip id (containment: clip → owning node → scene). Receiver applies on its local `TrackClipPlaybackManager` via an injected applier. `_collab_playback` + `forwardClipPlayback` deleted.
- **Collab runtime events (e181d9d) — DONE, verified 4/4 two-backend live:**
  - `runtime_control` collection (also in `streams.ts`) on the `control` channel, one publish per shared collab scene id (no containment anchor for global/spawn scopes), deduped per receiver by `eventId`. Set Data / runtime overrides / media control / spawn broadcasts now ride this path. `_collab_runtime` + `forwardCollabRuntime` + `allCollabPeers` deleted. `COLLAB_RELAY_KINDS` stays as sender whitelist. Legacy collab protocol is now only `_collab_subscribe`/`_collab_snapshot` (mount + asset transfer).
- **Werift stale-slot reconnect wedge — FIXED, verified 4/4.** `ServerMesh.onSignal` tears down a connected slot when that peer sends a fresh offer (a live peer never re-dials), then answers. See [plans/mesh-sync-refactor.md §9](../plans/mesh-sync-refactor.md).

- **REST write-through — DONE, verified live (commits 768ea2d, bfa3839, 27be0b2, 86a6e8c):** all five mutation rtypes (behaviors, camera-effects, scene-nodes, compose-layers, track-clips) now call `collection.set(id, '', dto)` / `collection.remove(id)` in their REST routes. Routes keep all validation, ordering, and side effects, and build the canonical camelCase DTO before writing. The `onCommitted` tap persists via the resource registry (`sync/resources.ts` `save`/`remove`) and emits `sync.document.upsert/remove` for legacy tabs. Direct SQL writes and route-side `sync.document` emissions are deleted — one write path, one HLC stamp. Track clips are a single aggregate doc: routes mutate the replica DTO in memory (lanes/keyframes/events) and `set` the whole doc; the save is delete-then-reinsert with `created_at` falling back DTO → prior row → now (86a6e8c). Bug fixes shipped: behavior PUT previously emitted no sync event; behavior `sortOrder` now rides the DTO; scene-node collab `validate` fires only for foreign docs (projectId differs from the collab link) so local model swaps on collab-author scenes are not reverted; lane routes 404 on unknown clip/lane instead of FK 500s. Replica docs lack DB-generated created/updated timestamps (display-only; the tap's sync envelopes re-load the row so legacy tabs get them). The legacy bridge's remaining job is read-side compatibility only (template bulk creation and any remaining `sync.document` callers still mirror into the mesh via the bridge).
- Frontend behavior sync binding — fixed (09cca24): remote updates were being skipped when the id already existed in the store (the recurring add-dedupes-then-drops-updates class noted in §8.8). *Historical:* the file it lived in, `packages/frontend/src/sync/resources.ts`, has since been deleted along with the rest of the `'sync'`-envelope bindings.

- **Frontend mesh store feeder — ALL document rtypes DONE, verified browser-live** (commits 0d21329, c4e4f04, a0d4da0, ed47972; 5/5 then 6/6 with Playwright across live tabs):
  - `packages/frontend/src/sync/meshStoreFeeder.ts` (new) — observes each collection via `collection.observe('**')` and writes changes into the editorStore's synced slices: `scene_node`, `behavior`, `camera_effect`, `compose_layer` (incl. the `compose_scene` kind branch) and `track_clip`. The whole `'sync'`-envelope bindings file (`sync/resources.ts`) is deleted; no tab reads the envelope. The replica does HLC LWW internally, so `observe()` only ever fires for applied changes and the client-side stale-drop (`lastVersion`) is obsolete.
  - Foreign docs riding placed-object subscriptions are filtered by the parent node's `remote` flag (projections stay inert and remain owned by `sync/meshProjection.ts`).
  - ViewerPage starts the mesh peer + feeder alongside the editor, since it renders the same live state.
  - The migration re-points the store's TRANSPORT (envelope → replica observation); components still read the Zustand store (mesh-react hooks remain open). Its file header still says "Smoothing-sensitive patches … still ride their dedicated /ws messages" — true for `node_transform_preview` and `node_updated`, **stale for `compose_layer_preview`**, which now rides the mesh `preview` channel a few lines below.
- **Compose containment scope DONE** (a0d4da0): top-level compose layers anchor to their compose scene via `rootComposeSceneId` (scene_node-style fallback) in both backend BINDINGS (`packages/backend/src/mesh/index.ts`) and frontend PARENTS (`packages/frontend/src/mesh/peer.ts`). Closes the 'compose layers need a containment scope' deferred item from §9 status; compose subtrees are now correctly grant-routed.
  - See [plans/mesh-sync-refactor.md §11](../plans/mesh-sync-refactor.md) for the full slice spec and verification log.

- **Mid-session mesh asset transfer — DONE, verified 4/4** (commits c756b77 + two fixes). Closes the model-swap/first-assign gap for both the COLLAB and PLACE paths.
  - `packages/backend/src/mesh/assets.ts` (new) — `initMeshAssets()` wired from `packages/backend/src/index.ts` after `initMeshStreams`. Inert without multiplayer (blob access and `/ws` broadcast injected via `setAssetTransfer` by the multiplayer manager). Two paths:
    - **COLLAB path**: triggered from the `scene_node` collection's `validate` transform in `packages/backend/src/mesh/index.ts`. When a foreign collab doc arrives with a `filePath` the local server can't resolve, `assets.ts` queues a follow-up; after the blob is cached, the node is written back through the mesh store (so the COLLAB persistence tap records the `/uploads/_shared/<hash><ext>` URL) and an `asset_files` row is recorded (`recordCollabAsset`).
    - **PLACE path**: a scene_node observer (`initMeshAssets`) watches foreign (placed-projection) docs inside placed subtrees; after caching it broadcasts `mp_shared_assets {peerId, assetUrls:{ownerPath: localUrl}}` on `/ws`, and the frontend projection feeder (`sync/meshProjection.ts` `registerAssetUrls`) re-projects.
  - **`_blob_meta` / `_blob_meta_ok`** protocol addition in `packages/backend/src/multiplayer/blobTransfer.ts`: a receiver→owner "resolve this owner file PATH to asset metadata (hash/ext/mime/size)" round-trip (`BlobManager.metaForPath`). The blob itself then rides the existing chunked `_blob_*` transfer into `uploads/_shared/<hash><ext>`.
  - **Content-hash guard** (`alreadyHaveContent`): the author recognises a peer's `_shared/<hash>` write-back as content it already holds (matched by hash under any path), so it doesn't re-fetch or re-point its own local path. Net: paths stay per-server, content converges, no ping-pong.
  - Covers both mid-session **model swap** (a node that had a previous model gets a new one) and **first assignment** (a node that had no model receives its first). Nodes present at mount time still localize via the existing snapshot path (`persistCollabAssets`); `assets.ts` is the live mid-session complement.
  - Frontend handler: `mp_shared_assets` case in `packages/frontend/src/hooks/useWsSync.ts`.

- **Frontend writes, `scene_node` + `compose_layer` — DONE.** UI edits, creates,
  deletes, reparents and compose sibling ordering are authored by the **tab**
  peer: `frontend/src/mesh/writes.ts` (generic over rtype via `MeshDocAdapter`)
  plus the compose-specific half in `mesh/layerWrites.ts`, bound to controls
  through `hooks/useMeshField.ts`. Dotted-path writes are native, so an edit
  stamps exactly its own path and two clients editing different fields of one doc
  no longer clobber each other the way the whole-doc REST `PUT` did. REST survives
  only as the fallback ladder. Compose-layer **drag previews** ride the mesh
  `preview` channel, replacing the bespoke `compose_layer_preview` WS kind.
- **Sibling ordering — DONE (compose layers).** Order is a string fractional
  `orderKey` (`packages/shared/src/fracIndex.ts`, migration 036); sort
  `(orderKey, id)` ascending = back-to-front, per sibling set scoped to
  `(rootComposeSceneId, parentId)`. This is a convergence property, not a UI
  detail: a move writes ONE row, so concurrent moves commute under LWW. The
  integer scheme it replaced renumbered every sibling per drag, which LWW merged
  into a stack neither peer asked for.

<a id="remaining"></a>

**Remaining:**
- **Writes for `behavior` / `camera_effect` / `track_clip`** — still REST, so
  still server-authored and undoable by nobody (see the table under Undo/redo).
  `behavior` additionally needs its manager lifecycle side effects moved into the
  `onCommitted` tap before the route can stop being the write path.
- **Node drag previews** — `previewNodePath` writes the local store only; the
  in-flight transform still rides the `node_transform_preview` WS kind
  (`backend/src/index.ts` relay → `useWsSync.ts` → `previewSmoother`). The
  mesh-native form is the same one-overlay-per-field `preview` write compose
  layers already use, plus an `ephemeral` branch in the `scene_node` feeder.
- **Clip playback state** — the playhead is backend-authoritative
  (`track_clips/playback.ts`, broadcast as `track_clip_started` / `_paused` /
  `_stopped` / `_playback_snapshot`), and a clip animating a *shared* object
  streams an evaluated transform per frame as a `node_transform_preview` frame.
  That last part is self-contradictory: clip evaluation is frontend-local, so the
  thing to sync is the INPUTS — the clip doc (already a mesh rtype) plus a
  retained play anchor — and let every peer evaluate. A persisted `clip_playback`
  collection replaces both the streaming chain and the snapshot kind.
- **Document WS kinds that are pure double-applies** — `node_updated`,
  `camera_effect_updated`, `track_clip_updated`,
  `track_clip_keyframes_replaced`, `track_clip_events_replaced`,
  `track_clip_lane_removed`. Each is broadcast by a route that has *already*
  written the same doc through the collection, and the feeder has already applied
  it. The "smoothing-aware" / "local smoothing broadcast" comments on those
  broadcasts are false — `previewSmoother` exports only `smoothNodeTransform` and
  `smoothComposeLayer`, and neither is reachable from those handlers.
- **`scene_updated` / `scene_removed` are NOT yet redundant** — two real gaps
  keep them load-bearing. (a) The feeder's `scene_node` observer routes
  `kind='scene'` docs into the `nodes` slice and never into the `scenes` slice,
  so `scenes[].runtimeSettings` would go stale on other tabs; it also has no
  `activeSceneId` reselection. (b) `DELETE /api/scenes/:id` deletes the scene's
  behaviors / camera_effects / compose_layers / track_clips with **raw SQL that
  bypasses the collection**, so those docs live on in the backend replica with no
  tombstone and a later subscriber gets a snapshot of rows that no longer exist.
  Route the deletions through `getMeshCollection(...).remove()` in one batch
  first.
- **Runtime-control kinds ride three transports at once** —
  `runtime_override_set` / `_clear` (+`_snapshot`), `data_channel_set` / `_clear`
  (+`_snapshot`) and `media_control` travel the local `/ws` hop, the collab
  `COLLAB_RELAY_KINDS` tap onto the mesh `runtime_control` rtype, *and* the legacy
  object-share `_share_override` / `_share_datachannel` envelopes. Note
  `runtime_override_*` is not in the `WSMessageKind` union at all. Overrides are
  **durable state**, not events — held in `_bySceneId` and replayed to every new
  WS client — so the mesh-native home is a stamped + reliable + **retained**
  channel *without* `ack` (retained ⇒ snapshot-on-subscribe replaces the
  `_snapshot` kind; no `ack` ⇒ graph-driven overrides can't pollute a tab's undo
  stack, since only `ch.ack === 'authority'` writes are logged), keyed
  `${targetKind}:${targetId}:${paramPath}` with the target as containment parent
  so existing scene-subtree grants route it. The existing `control` channel is
  `retained: false` and would silently drop the late-joiner guarantee.
- **Logic** has no mesh collection at all: `LogicSection.tsx` re-fetches over REST
  on a 3s `setInterval` (as does the behaviors list in `SceneGraph.tsx`).
- Component reads → mesh-react hooks (`useMeshDoc` / `useMeshSubtree` / etc.),
  with ack outcomes surfaced as toasts.
- Phase-6 guarded writes (`_share_write`/NAK) onto guarded mesh writes (per-doc authority).
- Advertise/offer flow: still legacy.

## Key files

- `packages/mesh/src/` — core implementation (MeshPeer, Collection, Replica, ChannelRegistry).
- `packages/mesh-react/src/` — hooks.
- `packages/mesh-transports/src/` — WsServerTransport, WsBackendTransport.
- `packages/backend/src/mesh/index.ts` — backend bindings, hydration, persistence.
- `packages/backend/src/mesh/streams.ts` — `node_stream`, `clip_control`, `runtime_control` collections + the `control` channel; collab live-ops bridging helpers.
- `packages/backend/src/mesh/assets.ts` — `initMeshAssets()`: mid-session asset fetch for mesh docs with unresolvable file paths (COLLAB + PLACE paths; inert without multiplayer).
- `packages/frontend/src/mesh/peer.ts` — frontend peer creation + wiring, the containment schema (`PARENTS`) and the subscribed rtype list (`RTYPES`), plus `meshUndo` / `meshRedo` / `meshBatch`.
- `packages/frontend/src/mesh/writes.ts` — generic UI write helpers (`MeshDocAdapter`, fallback ladder, batched bottom-up subtree delete) + the `scene_node` wrappers.
- `packages/frontend/src/mesh/layerWrites.ts` — the compose-layer half: fractional `orderKey` generation and the one-overlay-per-field `preview` write.
- `packages/frontend/src/hooks/useMeshField.ts` — binds one control to one field; owns the preview/commit split that makes undo usable.
- `packages/frontend/src/sync/meshStoreFeeder.ts` — replica → Zustand feeder; where the committed/ephemeral channel discrimination is applied.
- [plans/mesh-sync-refactor.md](../plans/mesh-sync-refactor.md) — full design spec (§8). See [Which plan is which](#which-plan-is-which) before reading the other plan docs.
