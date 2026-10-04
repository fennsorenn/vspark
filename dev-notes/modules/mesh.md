# Mesh — Replicated Store (@vspark/mesh, @vspark/mesh-react, @vspark/mesh-transports)

**Status:** Core package implemented (119 vitest tests across `packages/mesh/test/`); three packages (mesh / mesh-react / mesh-transports WS pair) shipped; backend hydration + persistence complete; reads fully mesh-fed (`sync/meshStoreFeeder.ts`); writes mesh-authored for every document rtype (see the per-rtype table under [Undo / redo](#undo--redo-per-peer)); whitelist grants with one egress filter ([Grants](#grants)); every tab authenticates before joining ([Tab authentication](#tab-authentication)). See [Remaining](#remaining) for the rest.

A **schema-agnostic in-memory replicated store** with symmetric read/write API on both frontend and backend, HLC last-write-wins convergence, grant-gated access control, and authority-driven ack lifecycle. No durability in the package itself; durable peers hydrate from persistent store and persist incoming mutations via observe taps. Designed to replace both the legacy sync layer and the entity-aware collab-scene sharing model.

### Which plan is which

Several plan documents describe this system and they are **not** alternatives —
they are a chain, and only reading them in order makes the code legible. Each
plan now opens with a status blockquote (shipped / live / superseded); this table
is the index into that chain:

| Plan | What it is |
|---|---|
| [plans/permissioned-sync-mesh.md](../plans/permissioned-sync-mesh.md) | A **design-alignment** doc, not an execution plan. Its §4 is where the fractional-index ordering rule first appears — as semantics only; the phasing in §6 contains no slice that adopts it, which is why `fracIndex.ts` sat written, unit-tested and *unreachable* (missing from the `@vspark/shared` exports map, the frontend tsconfig paths, and the vite/vitest aliases) until migration 037. Do not read this plan as a record of what was built. |
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

Those three are what is left on the stream path. Everything else that used to
ride it is gone: the clip playhead (derived from the transport document), and
the drag preview for a shared object (`node_transform_preview`, which the
receiver now reads as preview-channel overlays on `scene_node` — the same ones
a local tab gets).

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

**Held for scene documents** (migration 040). Mounting used to copy the
author's tree into the receiver's project and rewrite `project_id` on the way
in; the feeder then had to re-preserve the local values on every incoming edit,
so the two rewrites kept each other necessary. Both are gone: a mounted tree is
stored with its author's `project_id`, and the receiver holds a **peer-owned
project row** (`projects.owner_peer_id`) so the foreign key holds. The share
link (`collab_scenes`) carries "this scene is mounted into that project", which
is where a per-peer relationship belongs — beside the documents, not inside
them.

Consequences worth knowing:

- "Everything with my project id" no longer finds a mounted scene, so the scene
  bundle unions own scenes with the links, and the feeder adopts a node when its
  SCENE is one we hold rather than when its project matches.
- Peer-owned projects are excluded from the project list. They are places to
  keep documents, not places to author.
- `persists` for `scene_node` can no longer be "does a projects row exist" —
  peer rows exist now. It is "our own project, or a collab scene we keep", so a
  placed-object projection still stays replica-only.

### 3. Mounting is rendering, not merging

A shared tree stays whole and unmodified — the owner's ids, the owner's parent
links. It is **not** spliced into the receiver's tree. The receiver's tree holds
a share container node, and the renderer walks into the foreign tree at that
point. Two trees, joined at display time.

The mesh transports trees; it does not merge them.

**Scope: placed objects, not collab scenes.** `sync/sharedProjection.ts`
implements this — a receiver-owned `remote_object` container carrying
`components.remoteRef`, with the owner's subtree projected under it, dropped and
restocked on (re)subscribe.

> **Decided by the user, 2026-08-15:** collab scenes deliberately do NOT take
> this shape. Migration 031 states the distinction outright — object sharing is a
> read-only ephemeral projection, while a collab scene is "a real, persisted,
> editable scene in EACH peer's project", backed by a mutual RUCD grant on the
> scene subtree (`mesh/collab.ts`). Giving them a container node would either
> nest a peer's scene inside one of yours instead of opening it, or — in the
> version that matches the placed-object path exactly — remove co-editing
> altogether. Neither is wanted, so the container is not coming to mounted
> scenes.

This principle no longer carries principle 2, which is the job it was originally
written for. The field rewriting existed to force a foreign tree into the local
one; that rewriting is gone (see principle 2 above), and it went without the
container, because what principle 2 needed was for the documents to stop being
edited on the way in — not for the trees to be joined at a node.

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

**Implemented** (`MeshPeer.mount(rootId, v?)` / `unmount(rootId)`, and
`collab_scenes.mounted_at`, migration 039). `Collection.applyOp` raises an
incoming op's stamp to the mount stamp when the document is in a mounted scope,
so it lands on the way IN only — what the peer relays onward still carries the
origin's stamp, which is what keeps the document itself unstamped by us.

Two details worth knowing before touching it:

- The scope is resolved from the containment index **and from the parent the
  incoming document declares**. The index alone is not enough, and not as an
  edge case: the receiver deleted this subtree, so the index forgetting it is
  exactly what happened. A document that arrives has to be placed by what it
  says about itself.
- Re-mounting moves the stamp forward, deliberately. Deleting a mounted scene
  and mounting it again is two acts, and the second one is a request for the
  tree to come back.

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

### 7. The mesh is the only client↔server channel

**Decided by the user, 2026-10-04.**

The mesh carries all communication between vspark clients and servers. Its
point is to abstract away shared-state handling entirely, so every other data
stream (an app WS kind, a frontend REST call, a legacy `_share_*` / `_collab_*`
/ `_blob_*` message) is a failure to use it properly. **A reason not to use the
mesh is evidence of a missing mesh feature.** Build the feature, don't route
around it.

- Only traffic with **outside services** stays off the mesh: VMC/iFacialMocap
  UDP, obs-websocket, Twitch/StreamElements, the assistant's LLM endpoint,
  GitHub Releases. What they produce becomes mesh documents.
- **Files are a mesh matter.** A document that needs a file needs it on local
  and remote peers alike, so asset bytes travel through the mesh too.
- **New channel types are allowed** when genuinely needed, but the lossy
  `preview` channel already exists for high-frequency data. If it is too heavy,
  optimize it; don't bypass it.
- Principle 5 still holds: REST stays for outside callers and writes through
  the mesh. Only the editor stops using it.

The gap inventory and the migration order are in
[plans/mesh-sole-channel.md](../plans/mesh-sole-channel.md).

### 8. Every subscription takes the most direct path

**Decided by the user** (an instruction from the start, first recorded in
[plans/permissioned-sync-mesh.md](../plans/permissioned-sync-mesh.md) §1;
restated 2026-10-04 after the implementation was found to have dropped it).

A subscription is served over a direct WebRTC link between the two
participants when one can be established: browser↔browser, browser↔remote
server, server↔server. One or two server hops are a **fallback only**, used
while the direct path is unavailable.

- Relays are limited to the two endpoints' own servers. Each client already
  trusts its own server as its grant source of truth, so relayed traffic is not
  end-to-end encrypted. A third server is never a relay.
- A co-located server counts as direct (tabs on one machine meet through it).
- Persisting servers subscribe to what they persist like any other participant;
  guarded writes keep one authority per document.
- When several subscribers sit behind one next hop, the op is sent once.

### 9. Authenticated participants, whitelist grants

**Decided by the user, 2026-10-04.**

- Every participant authenticates; an unauthenticated connection is refused at
  the handshake.
- Grants are a whitelist with no deny rules, granular to grantee (down to one
  tab) × rtype × entity × path prefix × right. Read grants may be field-level;
  every outgoing message is projected through the recipient's grants at one
  egress point, and a peer with a partial view never overwrites what it cannot
  see.
- Collections declare their default grants; nothing is reachable by default.
- Grants for a direct link are delivered by the brokering server at link setup.
- Blob grants are derived from the documents that reference the blob.
- Secrets are a grant pattern (own rtype, write-only, never granted to remote
  peers, encrypted at rest), not a separate channel.

## Architecture overview

### Three packages

**`@vspark/mesh`** — Core replicated store (no React, no IO, no DB):
- `MeshPeer` — peer identity + transport registry + subscription management.
- `Collection<T>` — typed id-keyed store with parent-child hierarchy (containment index), channel-tagged writes, read + write API, observe taps for durability.
- `Replica` — per-path HLC LWW storage (atomic history per key), tombstones, ephemeral overlays with composed-read cache, snapshot + apply mechanics.
- `ChannelRegistry` — named delivery channels with declared semantics (reliable/lossy, stamped/ephemeral, acking); four built in (`channels.ts`).
- `GrantStore` + pure projection functions (`grants.ts`) — the whitelist access model; see [Grants](#grants).
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
- `WsServerTransport` — `/mesh` route (authenticated hello handshake, participant id composition `${serverPeerId}#${tabUuid}`); see [Tab authentication](#tab-authentication).
- `WsBackendTransport` — Browser client with auto-reconnect and offline write gating; sends the token in each hello and calls `onUnauthorized` on close code 4401.
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
collection.removeTree(id): WriteHandle[]     // id + its cross-type containment subtree, one undo action
```

`WriteOpts` (last argument of every write): `channel`, `undo: false` (see
[Undo / redo](#undo--redo-per-peer)), and `to` — addressed delivery, see
[Addressing and request/reply](#addressing-and-requestreply). `to` is
only allowed on unstamped channels: a write with `to` on a stamped channel
throws (`Collection.writeChannel` → `requireUnstamped`; covered in
`control.test.ts`), because shared state is never per-recipient.

All writes are subject to:
- Authority reachability gating (if authority is known down, guarded writes reject synchronously, and UIs consult `canWrite()`).
- Write-grant checks on receive, per leaf (see [Grants](#grants)).
- Ack lifecycle: authority applies, persists, and acks; timeout triggers recency-gated revert.

**`removeTree(id)`** (`MeshPeer.removeTree`, also on `Collection`) walks the
peer's containment index from `id` — across rtypes, so a node's behaviors,
effects, clips, graphs and animation clips are included — and removes every
document it holds, children first, inside one `batch` (one undo action). Only
document collections take part (retained channel with `ack: 'authority'`);
runtime-channel state is left to its author. Ids the peer no longer holds are
skipped, which is what lets the backend persistence tap call it on a doc that
was just removed to sweep its dependents. See
[Structural writes](#structural-writes--a-subtree-delete-must-remove-descendants-explicitly).

### Hydration (durable peers, boot)

```ts
collection.put(doc: T, { v: HLC }): void   // apply with HLC stamp; LWW vs live replicas
collection.putTombstone(id, v: HLC, ancestors?: string[]): void  // mark deleted
```

These apply without broadcasting and never trigger acks (the source of truth for the stamps — the persistent store — is already responsible for ordering).

`ancestors` (nearest first) is the chain persisted from the remove's
`AppliedChange.ancestors`; it restores where the deleted entity sat, so
subtree-scoped grants can still decide who may receive the tombstone (see
[Tombstone ancestry](#tombstone-ancestry)). The backend stores it in
`mesh_tombstones.ancestors` (migration 042).

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

### Config

Document types are declared once and handed to every peer:
`createMeshPeer({ models, channels })`. A `ModelDecl`
(`packages/mesh/src/collection.ts`) holds what every peer knows about a type:
`parent`, `validate`, `channels`, `clockFields`. vspark's declarations live in
`@vspark/shared/models` (`MODELS`, plus `TAB_MODELS`, the types a tab opens),
so backend and frontend can't disagree on a parent or a channel list.
`peer.collection(rtype, local)` opens a declared type, and `local` adds what
only this peer contributes. A local `validate` runs after the declared one, on
its result.

`CollectionConfig` adds two peer-local fields to a `ModelDecl`: `authority`, and `clients` — the rights (`read` / `update` /
`create` / `delete`) this peer's own tabs hold on every document of the
collection. Declaring `clients` adds one grant to the peer's own id, which
covers its client participants and no one else. A collection without it is
unreachable from tabs. See [Grants](#grants).

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
| `track_clip` | tab peer (`frontend/src/mesh/clipWrites.ts`, per element) | yes |
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

A collection's channels come from its declaration (or the local config):

```ts
const mesh = createMeshPeer({ identity, models: MODELS, transports });
const nodes = mesh.collection<Node>('scene_node', {
  authority?: 'self' | PeerId,
  clients?: { read?, update?, create?, delete? },  // tab rights, see Grants
  validate?: (doc: unknown, ctx: { origin, prev }) => Node,  // runs after the declared one
});
// ModelDecl: { parent?, validate?, channels? (default ['committed', 'preview']), clockFields? }
```

Four channels are built in (`BUILTIN_CHANNELS` in `packages/mesh/src/channels.ts`),
so every peer shares them without declaring anything:

| channel | transport | stamped | retained | ack | used for |
|---|---|---|---|---|---|
| `committed` | reliable | yes | yes | `authority` | document state: persisted by durable peers, acked, undoable |
| `preview` | lossy | no | no | — | high-frequency latest-wins data (gestures, sensor streams) |
| `runtime` | reliable | yes | yes | — | retained state that lives only while its author runs (server status, runtime overrides, data fields) — see [Runtime state](#runtime-state-the-runtime-channel) |
| `control` | reliable | no | no | — | commands: delivered once, never retained (media commands, collab runtime events) |

`ChannelRegistry.define` still accepts app channels; nothing in the app defines
one today.

A write targets a channel via `set(id, path, value, { channel: 'preview' })`. Writes to the retained channel flow through ack authority; ephemeral writes always flow (no authority gating).

### Unstamped ops are applied once

Unstamped ops (`preview`, `control`) carry no HLC, so LWW cannot discard a
duplicate. Each one carries an `(epoch, seq)` identity instead (`qe` / `q` on
the envelope): `epoch` is fixed per `MeshPeer` instance, `seq` counts up. A
receiver keeps, per origin, the current epoch and a window of seen sequence
numbers (`alreadySeen` in `peer.ts`; window 1024, at most 4096 origins tracked)
and drops an op it has already applied or one from an older epoch of that
origin. This is what lets the same op arrive over more than one path.

### Addressing and request/reply

`WriteOpts.to` addresses an unstamped write to one participant. The author does
not apply it; it sends it to `nextHop(to)` and resolves `unguarded` (or
`rejected: 'unreachable'` when there is no hop). A peer that receives an op
addressed to someone else forwards it to its own next hop and applies nothing;
only the addressee applies it.

`nextHop` is the **routing seam**: today it picks the first linked candidate of
the participant itself, its server (`participantServer`), then this peer's
`home`. Direct links (principle 8) are meant to plug in here without changing
callers.

On top of addressing:

```ts
collection.request(id, data, { to, channel?: 'control', timeoutMs?: 5000 }): Promise<RequestOutcome>
collection.reply(change, data): void   // change.request is set on the receiver
// RequestOutcome: { status: 'replied', data } | 'timeout' | 'unreachable' | { status: 'error', reason }
```

`request` throws on a stamped channel. The receiver sees an applied change with
`change.request = { mid, from }` and answers with `reply`. A hop that cannot
forward a request answers `unreachable` on the addressee's behalf; any other
reply is accepted only from the addressee. Delivery is at most once, so a lost
request or reply ends in `timeout`. Tests: `packages/mesh/test/control.test.ts`.

### Link state

A peer with a `home` tells it which participants it reaches directly: a `links`
message (`LinksMsg` in `wire.ts`) on every link change. The home records it per
sender (`directLinks`) and, when relaying a **lossy** op, skips recipients that
reach the op's origin directly — they already have it first-hand. Reliable ops
are still relayed, as the path that survives a direct link dropping silently;
the receiver's dedup (or LWW, for a stamped op) absorbs the second copy. A link
counts only once a subscription over it is active — a link whose subscription
was refused doesn't stop the relay. Tests: `packages/mesh/test/links.test.ts`.

### Direct links (tabs)

A tab links over WebRTC to tabs of **other** servers (`DirectTransport` in
`frontend/src/mesh/directTransport.ts`, carried by `clientMesh.ts`) and takes an
`exact` subscription to each with `channels: ['preview']`: no snapshot and no
committed ops. Committed state keeps arriving through the tab's own server,
which validates it. A refused subscription is retried with backoff while the link
is up, because the other tab may not hold its grants yet. Tabs of the same server
don't link; they meet through it.

- `relay: false` makes a peer an endpoint: it doesn't forward what it receives,
  so a direct subscriber gets only what that tab authored.
- Grants for a direct link: the backend mirrors every grant it issued to someone
  other than itself into the `peer_grant` runtime collection (tabs read it,
  `backend/src/mesh/peerGrants.ts`). The tab copies them into its `GrantStore`.
  A grant to a server covers that server's tabs (`granteeCandidates`).
- Admission: an op matching our own subscription to a *server* is accepted as is.
  The same op from a *tab* must pass that tab's write grants, as any write
  does.

### Snapshot & apply

On subscription with an unmet grant, the subscriber receives:
1. Snapshot of the retained channel's current state (all entries + their HLC stamps).
2. A watermark (HLC timestamp) bounding the snapshot's consistency.
3. Live ops after the watermark.

Applying a remote op checks the origin's write grants ([Grants](#grants)), translates declared clock fields, and runs the collection's `validate` before touching the replica. The snapshot and every later op are projected through the subscriber's read grants on the way out.

### Validation: one check, on the composed document

`validate(doc, { origin, prev })` always receives the **whole document a
committed write would leave behind**, whatever shape the write had: a create, a
whole-document upsert, a merge-patch or a single-path `set`. The peer composes
the patch onto its current copy first (`MeshPeer.composeCandidate`), so a check
can't be bypassed by editing one field. It runs on every peer, for local writes
(fail fast), incoming ops and snapshot documents. Previews aren't checked.

- Throwing rejects. On the authority this nacks the author, who rolls back.
- Returning a different document corrects. A corrected write is applied as an
  upsert of the corrected document; on the authority it is issued with a fresh
  stamp as its own write, and the `corrected` ack carries the whole document,
  which the author applies in place of its write.
- A patch to a document this peer doesn't hold yet isn't checked: the replica
  parks it until the document arrives.

Before this, `validate` ran on whole-document upserts only and the backend had a
second hook, `guard`, on the composed document in the persistence tap. A check
in the wrong one was skipped by field edits (a scene instance could be made to
embed its own scene by setting `properties.sourceSceneId`). `guard` is gone.

### Clock fields

A declaration's `clockFields` lists top-level wall-clock timestamps (ms) that a
writer sets on its own clock (`startEpoch` on `scheduled_animation` and
`clip_playback`). Each peer translates them onto its own clock as data arrives,
using the measured offset to the peer that **sent** it (`toLocalTime(senderId,
t)`): ops, snapshot documents, and the documents carried by correction and
rejection acks. Translation is per hop, so data on a link is always on its
sender's clock, and a relay forwards it already translated. Local writes keep
the writer's frame. A browser tab translates too: it reads `startEpoch`
against its own `Date.now()`, whatever the clock of the machine its server
runs on.

This used to live inside the backend's `validate` hooks. Run on the composed
document, that would have translated again on every field edit, and it used
the author's id, which has no measured offset when the op was relayed.

## Grants

Implements principle 9's whitelist (`packages/mesh/src/grants.ts`, wired in
`peer.ts`). Tests: `packages/mesh/test/grants.test.ts` (core) and
`packages/backend/test/mesh.grants.test.ts` (backend bindings).

**Shape.** A `Grant` (from `@vspark/shared/sync`) gives one `grantee` rights
(`read` / `update` / `create` / `delete`) on `entityRtype × entityId` (optionally
`includeDescendants` through the containment index) `× pathPrefix`. A
participant's access is the union of every grant that names it, its server
(`participantServer`) or `'*'` (`granteeCandidates`). There are no deny rules,
and nothing is reachable without a grant. API: `peer.grants.grant(g) → gid`,
`revoke(gid)` (re-checks admitted subscriptions and drops those no grant
overlaps any more), `list()`, `observe(cb)`.

**Where grants come from today.**
- `CollectionConfig.clients` — the tab rights a collection declares (one grant
  to the peer's own id, which `granteeCandidates` matches for its tabs only).
  The backend sets them per binding in `packages/backend/src/mesh/index.ts`:
  `TAB_AUTHORED` (all four rights) for the rtypes tabs author (`scene_node`,
  `behavior`, `camera_effect`, `compose_layer`, `track_clip`, `logic`,
  `clip_playback`), `TAB_READ_DELETE` for `animation_clip` and
  `scheduled_animation` (servers write them; a tab removes them only as part of
  deleting their node via `removeTree`). The runtime collections
  (`runtime_override`, `data_field`, `media_control`, `server_status`) are
  `{ read: true }`. `node_stream` and `runtime_control` declare none — they are
  server-to-server only. The former blanket `'*'/'*'` grant to tabs is gone.
- Collab-scene grants (`mesh/collab.ts`) and object-share grants
  (`mesh/shares.ts`) for server peers, as before.

**Reads are projected at one egress point.** Every message a peer sends goes
through `MeshPeer.transmit` → `egress`, which cuts it down to what the recipient
may read: `readScope` computes `all` / `none` / a set of readable path prefixes
for one entity; `projectValue` trims a document (or the subtree at a path) to
that scope; `projectOp` returns the op the recipient may see, or null. Ops,
subscription snapshots (`sub_ok` docs and tombstones) and ack values all pass
through it. Removes go out whole to anyone who can read some part of the entity.
A nack's `value` is projected too, so a rejected writer does not learn a value
it cannot read. Field-level read grants depend on nothing bypassing `transmit`.

**Exempt recipients.** Two recipients are not projected: the peer's `home`
(`MeshPeerConfig.home` — a tab's own server, which is the source of its grants
rather than a recipient they gate), and, for ops, a collection's `authority`
(writes flow to it to be decided). Tabs set `home: serverPeerId`; the backend
peer has no home.

**Subscription admission.** A subscription is admitted when any read grant
*overlaps* it (entity and path, either direction — `grantOverlapsSubscription`),
not only when one covers it. What it then receives is the union of the paths
its grants allow, by projection per message.

**Writes are checked per leaf.** `admitOp` accepts an op that matches one of
this peer's own active subscriptions to the sender without a grant check (data
we asked for). Otherwise: a remove needs `delete`; an upsert of an unknown id
needs `create`; a patch needs `update` on its path, a merge-patch on every leaf.
An upsert of an existing doc from an origin without whole-document `update` is
applied as a **merge-patch of the leaves it may write** — a peer with a partial
view never overwrites what it cannot see. A refused guarded write is nacked
with `reason: 'denied'`.

<a id="tombstone-ancestry"></a>
**Tombstone ancestry.** Whether a subtree-scoped grant covers a deleted entity
depends on where it sat, which the containment index forgets on removal. The
peer keeps each removed id's chain (`tombChains`, consulted by
`isDescendantOrWas`), `AppliedChange.ancestors` carries it to observers, the
backend persists it with the tombstone (`mesh_tombstones.ancestors`, migration
042) and rehydrates it via `putTombstone(id, v, ancestors)`. Snapshot tombstones
are filtered by subscription scope with it, then by egress. Tombstones written
before migration 042 have no chain and reach only rtype-wide grants.

**Not done yet** (see [plans/mesh-sole-channel.md](../plans/mesh-sole-channel.md)
F6): delivering grants for direct links at link setup, and blob grants derived
from referencing documents.

## Tab authentication

Every tab authenticates before it joins its server's mesh (principle 9).

- **Handshake** (`mesh-transports`): the tab sends
  `{ t: 'hello', participantId, token }`; the server answers `{ t: 'welcome' }`
  or closes with code **4401**. No mesh message is handled before the welcome,
  and the client announces the backend as a peer only after it. The backend's
  `authenticate` callback is `verifyClientToken` (`initBackendMesh`).
- **Credentials** (`packages/backend/src/auth/clients.ts`): a browser enrolls
  once and keeps a random bearer token; the server stores only its SHA-256 in
  `client_credentials` (migration 043, with `last_seen` / `revoked_at`;
  `revokeClient` locks a browser out at its next connection).
- **Enrollment** (`packages/backend/src/auth/routes.ts`):
  `POST /api/mesh/enroll { label?, code? }` issues a token directly to a
  loopback caller; any other caller must send the current pairing code or gets
  403 `PAIRING_REQUIRED`. `GET /api/mesh/pairing-code` answers loopback callers
  only. The code is six digits, single-use, rotates after five wrong guesses,
  and is printed to the server log at start and on every rotation. `browserAddress` reads
  `X-Forwarded-For` only when the socket itself is loopback (the Vite proxy,
  which `vite.config.ts` sets to `xfwd`) and then only its last entry.
- **Frontend** (`packages/frontend/src/mesh/peer.ts`): the token lives in
  `localStorage` (`vspark.mesh.token`); a missing or refused token triggers
  `enroll()`, which asks for the pairing code through the prompt registered with
  `setPairingPrompt` (`Editor.tsx`). `ConnectionsWindow` shows the code to a
  local user; help: `multiplayer.md#device-code`.
- Servers authenticate to each other through the rendezvous (Ed25519) as before.

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

Deleting a document that has children is **not** one write. `commitDocDelete`
in `frontend/src/mesh/writes.ts` calls `col.removeTree(id)` (see
[Collection API](#writes-apply-local--fan-out--ack-lifecycle)), which removes
every document in the cross-type containment subtree — child docs and the
behaviors, effects, clips, graphs and animation clips hanging off them — each
before its own parent, as one undo action:

```ts
const outcomes = await Promise.all(col.removeTree(id).map((h) => h.ack));
```

The server side follows the same rule: the backend persistence tap calls
`peer.removeTree(c.id)` on every committed remove before deleting the row, so a
delete from REST, a tab, an undo or a collab peer sweeps dependents through
their collections (each with a tombstone). The node and scene DELETE routes
call `removeTree` too.

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
- `scheduled_animation` (parent: owning avatar `scene_node`) — per-avatar clip timeline; see [animation.md](animation.md). `startEpoch` is a declared clock field, translated onto each receiver's clock (see [Clock fields](#clock-fields)).

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
sessionStorage), so HLC origins and grants stay consistent per tab. The peer is
created with `home: serverPeerId` (exempt from egress projection, receives the
`links` announcements) and connects with a stored token — see
[Tab authentication](#tab-authentication).

**Auto-subscription re-arming:** the peer marks outgoing subscriptions stale on
disconnect and they do not auto-renew, so `armSubscriptions()` re-subscribes every
rtype (`entityId: '*'`) on each `onStatus` transition back to connected.

**Vite proxy:** `/mesh` route proxied to backend during dev.

**Reads** are mesh-fed but not yet mesh-*bound*: `sync/meshStoreFeeder.ts` mirrors
the replica into Zustand `editorStore` and components read the store. Moving
components onto `@vspark/mesh-react` hooks is still open.

**Writes** are tab-authored for every document rtype (`mesh/writes.ts`,
`mesh/layerWrites.ts` and the sibling `*Writes.ts` files); see the Undo/redo
table. Bound controls go through `hooks/useMeshField.ts`: `useMeshField` for
node fields, `useLayerField` for compose-layer fields, with a `livePreview`
option (default on) that fields which must not apply half-typed — browser URL,
feed template/CSS — turn off so they commit only on blur.

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
   `rtype`, `table`, `clients` (the tab rights — `TAB_AUTHORED`,
   `TAB_READ_DELETE`, or narrower; required by the type, and without a read
   right the tab's subscription is denied), optional `validate` (checks that
   need this server's data; it sees the composed document of every write, see
   [Validation](#validation-one-check-on-the-composed-document)), and
   `persists` (which gates SQLite only — a doc that fails it still fans out to
   every replica). Parent, channels and clock fields come from the shared
   declaration (step 5).

### Frontend

5. **Declaration** in `@vspark/shared/models` (`packages/shared/src/models.ts`):
   `parent`, `channels` if not the default pair, `clockFields`. Backend and
   frontend both read it, so the two containment indexes can't diverge.
6. **`TAB_MODELS`** in the same file, if tabs should open and subscribe to the
   type.
7. **Store slice** — state + actions in
   `packages/frontend/src/store/editorStore.ts`.
8. **Feeder observer** — `packages/frontend/src/sync/meshStoreFeeder.ts`,
   mirroring the replica into that slice. Handle `remove` explicitly, and decide
   whether `ephemeral` ops mean anything for this rtype.
9. **Writes** — a `MeshDocAdapter` in `packages/frontend/src/mesh/writes.ts`
   (or a sibling like `layerWrites.ts`) rather than REST calls, so the write is
   authored by the tab and lands on its undo stack.

### Three constraints on the doc shape

- **A list of things is a keyed map, never an array.** An array field is ONE
  path, so two peers editing different elements write the same path and LWW
  throws one edit away whole. Key by id and each element is its own path
  (`lanes.<laneId>.keyframes.<kfId>`). See `@vspark/shared/idMap` for the read
  helpers and the two consequences: a deleted element is present as `null`
  (`set` writes a key, it cannot remove one), and a map has no order, so order
  must come from the data (`t`) or a field (a fractional index). Persistence
  writes rows for the live elements only, so tombstones never reach SQLite.
- **Ids are globally unique across rtypes.** The `ContainmentIndex`
  (`packages/shared/src/containment.ts`) keys by id alone, so a doc must not
  reuse its parent's id — carry the parent as a field instead. `clip_playback`
  has its own uuid plus a `clipId`, precisely for this.
- **Only the declaration in `packages/shared/src/models.ts` changes in
  shared.** `SyncEnvelope.rtype` is a free-form string; there is no rtype union
  or zod schema to extend. Nor is
  `backend/src/sync/containmentIndex.ts` a registration point — that index
  serves the legacy object-share code, and `MeshPeer` keeps its own private one.

### Gate it

Add a backend test asserting `getMeshCollection('<rtype>')` is defined after
init, that a committed write reaches SQLite, and that the containment parent is
what you intended — see `packages/backend/test/mesh.clipPlayback.test.ts`. Those
three catch every wiring break above; behaviour tests do not.

## Integration roadmap

**Completed (through collab live-ops migration):**
- Core package (@vspark/mesh) — 29 tests at the time (118 now), all APIs. New: snapshot relay topology + one-way place isolation tests + pure-stream containment routing test. `handleSubOk` now relays snapshot-applied docs/tombstones onward to the peer's own subscribers (tabs subscribed before a reconcile were previously blind to snapshot state).
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
  - `clip_control` collection (also in `streams.ts`) on a new `control` channel (reliable, unstamped, unretained — events not state), keyed by clip id (containment: clip → owning node → scene). Receiver applies on its local `TrackClipPlaybackManager` via an injected applier. `_collab_playback` + `forwardClipPlayback` deleted. *(Superseded: clip playback is now the `clip_playback` document, and the `clip_control` collection was removed in 604b776.)*
- **Collab runtime events (e181d9d) — DONE, verified 4/4 two-backend live:**
  - `runtime_control` collection (also in `streams.ts`) on the `control` channel, one publish per shared collab scene id (no containment anchor for global/spawn scopes), deduped per receiver by `eventId`. Set Data / runtime overrides / media control / spawn broadcasts now ride this path. `_collab_runtime` + `forwardCollabRuntime` + `allCollabPeers` deleted. `COLLAB_RELAY_KINDS` stays as sender whitelist. Legacy collab protocol is now only `_collab_subscribe`/`_collab_snapshot` (mount + asset transfer).
- **Werift stale-slot reconnect wedge — FIXED, verified 4/4.** `ServerMesh.onSignal` tears down a connected slot when that peer sends a fresh offer (a live peer never re-dials), then answers. See [plans/mesh-sync-refactor.md §9](../plans/mesh-sync-refactor.md).

- **REST write-through — DONE, verified live (commits 768ea2d, bfa3839, 27be0b2, 86a6e8c):** all five mutation rtypes (behaviors, camera-effects, scene-nodes, compose-layers, track-clips) now call `collection.set(id, '', dto)` / `collection.remove(id)` in their REST routes. Routes keep all validation, ordering, and side effects, and build the canonical camelCase DTO before writing. The `onCommitted` tap persists via the resource registry (`sync/resources.ts` `save`/`remove`) and emits `sync.document.upsert/remove` for legacy tabs. Direct SQL writes and route-side `sync.document` emissions are deleted — one write path, one HLC stamp. Track clips are a single aggregate doc: routes mutate the replica DTO in memory (lanes/keyframes/events) and `set` the whole doc; the save is delete-then-reinsert with `created_at` falling back DTO → prior row → now (86a6e8c). Bug fixes shipped: behavior PUT previously emitted no sync event; behavior `sortOrder` now rides the DTO; scene-node collab `validate` fires only for foreign docs (projectId differs from the collab link) so local model swaps on collab-author scenes are not reverted; lane routes 404 on unknown clip/lane instead of FK 500s. Replica docs lack DB-generated created/updated timestamps (display-only; the tap's sync envelopes re-load the row so legacy tabs get them). The legacy bridge's remaining job is read-side compatibility only (template bulk creation and any remaining `sync.document` callers still mirror into the mesh via the bridge).
- Frontend behavior sync binding — fixed (09cca24): remote updates were being skipped when the id already existed in the store (the recurring add-dedupes-then-drops-updates class noted in §8.8). *Historical:* the file it lived in, `packages/frontend/src/sync/resources.ts`, has since been deleted along with the rest of the `'sync'`-envelope bindings.

- **Frontend mesh store feeder — ALL document rtypes DONE, verified browser-live** (commits 0d21329, c4e4f04, a0d4da0, ed47972; 5/5 then 6/6 with Playwright across live tabs):
  - `packages/frontend/src/sync/meshStoreFeeder.ts` (new) — observes each collection via `collection.observe('**')` and writes changes into the editorStore's synced slices: `scene_node`, `behavior`, `camera_effect`, `compose_layer` (incl. the `compose_scene` kind branch) and `track_clip`. The whole `'sync'`-envelope bindings file (`sync/resources.ts`) is deleted; no tab reads the envelope. The replica does HLC LWW internally, so `observe()` only ever fires for applied changes and the client-side stale-drop (`lastVersion`) is obsolete.
  - Foreign docs riding placed-object subscriptions are filtered by the parent node's `remote` flag (projections stay inert and remain owned by `sync/meshProjection.ts`).
  - ViewerPage starts the mesh peer + feeder alongside the editor, since it renders the same live state.
  - The migration re-points the store's TRANSPORT (envelope → replica observation); components still read the Zustand store (mesh-react hooks remain open). Its file header still says "Smoothing-sensitive patches … still ride their dedicated /ws messages" — true at the time for `node_transform_preview` and `node_updated`, **stale for `compose_layer_preview`**, which now rides the mesh `preview` channel a few lines below. (`node_transform_preview` has since been deleted outright.)
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
  `orderKey` (`packages/shared/src/fracIndex.ts`, migration 037); sort
  `(orderKey, id)` ascending = back-to-front, per sibling set scoped to
  `(rootComposeSceneId, parentId)`. This is a convergence property, not a UI
  detail: a move writes ONE row, so concurrent moves commute under LWW. The
  integer scheme it replaced renumbered every sibling per drag, which LWW merged
  into a stack neither peer asked for.

### Runtime state: the `runtime` channel

Graph-driven param overrides, published data fields and server status are
**state**, not events, and they never touch SQLite. They live on the built-in
`runtime` channel (collections registered in
`packages/backend/src/mesh/runtime.ts` and `mesh/status.ts`):

```
runtime : reliable, stamped, retained, NO ack
```

Both halves are load-bearing:

- **retained** — a tab that connects an hour later must see the current
  override, so the subscription snapshot carries it. This is what replaced the
  hand-rolled `runtime_override_snapshot` / `data_channel_snapshot` messages
  that were replayed per WS connect. The `control` channel is
  `retained: false` and would have dropped that guarantee silently.
- **no `ack`** — only `ch.ack === 'authority'` writes are logged for undo, so an
  unacked channel keeps a graph firing overrides at frame rate off the authoring
  tab's undo stack. That is a deliberate use of the ack flag, not a default.

Collections on it, both parented to the entity they describe so existing
scene-subtree grants route them cross-type:

| rtype | key | notes |
|---|---|---|
| `runtime_override` | `${targetKind}:${targetId}:${paramPath}` | one document per overridden path, so two graphs overriding different params of one node cannot clobber each other; a clear is a `remove` |
| `data_field` | `${scope}:${field}` | one document per published field, which is what makes `set`'s merge structural; carries `scopeKind` so both peers derive the same parent without a DB lookup. Scope `''` is global and has no parent |
| `server_status` | `${kind}:${key}` | server-authored status (`mesh/status.ts`), see below |

All three declare `clients: { read: true }`: tabs read them, only the server
writes them.

**Server status** (`packages/backend/src/mesh/status.ts`) replaces the
`vmc_status`, `vmc_tracking_state`, `obs_connection_status`,
`output_window_status` and `overlive_account_status` WS messages and their
per-producer "send current state to each new client" handlers. Kinds:
`tracking` (mocap receivers — VMC, iFacialMocap, MediaPipe — keyed by behavior
id), `obs_connection`, `overlive_account`, `output_window` (key `main`).
Producers call `publishStatus(kind, key, fields, of?)` (merges into the existing
doc) or `publishTracking({ behaviorId, ... })`, and `clearStatus(kind, key)` to
drop one. A status about a document names it in `of`, which becomes its
containment parent: it is visible wherever that document is, and
`clearStatusOf(id)` — called from the persistence tap on every remove — drops it
with the document. All of these no-op before the mesh is up. The frontend feeder
maps the docs into the existing store slices (`applyStatus` in
`sync/meshStoreFeeder.ts`).

**Media commands are the counter-example.** They are events, so they stay on the
unretained `control` channel (`media_control`, keyed by target). Retaining them
would replay every past `play`/`seek` to each new tab — the opposite of what a
late joiner wants.

### Write outcomes are visible

A committed write is optimistic — the value is in the replica, the store and on
screen before the authority has agreed to it — and a refusal makes the peer
restore the pre-write state. So a rejected edit reads as a field reverting on its
own, which is indistinguishable from a bug.

Every write path used to drop the outcome, each in its own way: `commitDocPath`
(the bound-field path, and the most common write in the app) never read the ack
at all; the create/delete helpers threw into callers that caught and ignored it;
the REST fallback ended in `.catch(() => {})`.

`frontend/src/mesh/writeFeedback.ts` is the one place an outcome becomes a
message, and the write helpers call it so no call site has to remember:

- `settled(outcome, subject)` where the outcome is already awaited;
- `watch(handle.ack, subject)` for a fire-and-forget write — the bound-field
  path cannot await, since a control commits synchronously from the UI's side;
- `reportRejected` / `reportFailed` at the sites that still throw, called
  *before* the throw so a caller's `catch` cannot swallow the notice.

Only refusals surface. An accepted write says nothing (a toast per
keystroke-commit would be worse than silence), and a **preview-channel write is
unguarded by construction** — its outcome is never `rejected`, so a gesture never
raises one.

### Reading a document directly

`@vspark/mesh-react` shipped written, tested, and imported by nothing — because
its hooks take a `Collection` argument and this tab's collections only exist once
`initMeshPeer()` resolves, so a component had no way to obtain one. The bridge is
`frontend/src/mesh/hooks.ts`: `useMeshCollection(rtype)`, `useMeshPeer()`,
`useMeshCanWrite(rtype)`, and the per-document `useSceneNode` / `useComposeLayer`.
`onMeshReady` (in `mesh/peer.ts`) is what re-renders a component that mounted
before the peer arrived.

**What this buys is granularity, not liveness.** The feeder already keeps the
store live and most components read it perfectly well. What a per-document hook
adds is that `useSceneNode(id)` re-renders when THAT node changes, where
`useEditorStore((s) => s.nodes)` re-renders every subscriber whenever any node
anywhere changes. So it is worth reaching for when a component watches one
document out of many — `CameraViewLayer` (the first conversion) owns a Three.js
canvas per instance and was re-rendering all of them on every unrelated node
edit — and not worth it for a component that wants the whole slice anyway.

**The store is still the load path**, and that is what gates converting the rest.
The editor hydrates from the REST scene bundle, which usually lands before the
mesh subscription snapshot; a component reading only the replica would render
empty in that window. `useSceneNode` therefore falls back to the store when the
replica has no document yet — the two cannot disagree, since the feeder is what
fills the store — and that fallback is written once, in the hook, so it can be
deleted in one place when the snapshot becomes the load path. Converting reads
wholesale before then would trade a working editor for a flashing one.

<a id="remaining"></a>

**Remaining:**

The open work — making the mesh the only client↔server channel (principles
7–9) — is inventoried and ordered in
[plans/mesh-sole-channel.md](../plans/mesh-sole-channel.md); that plan is the
source of truth for what is left, so it is not copied here. In short: a general
per-subscription path choice and direct links (foundation items F4/F6),
unmigrated resources (W1), high-rate streams on `preview` (W3), commands on
`control` (W4, incl. `server_update`), blobs (W5), the snapshot as the load path
(W6) and the multiplayer legacy protocol (W7, incl. Phase-6 guarded writes and
the advertise/offer flow).

Outside that plan:

- Component reads → mesh-react hooks, **partially done**. The bridge exists
  (`frontend/src/mesh/hooks.ts`) and the first read is converted; the rest is
  case-by-case, not a sweep — see "Reading a document directly" above for when
  it is worth it and what still gates a wholesale conversion.

**Closed, not done:** principle 3's share container for mounted scenes. It was
on this list; it is now a decision instead — see principle 3 above. Collab
scenes stay scenes because they are co-edited by design (migration 031), and the
container belongs to the placed-object path, which already has it.

**Done since this list was first written** (kept short deliberately — the
details live in the sections above): writes are mesh-authored for every document
rtype; `logic` has a collection and no polls; clip playback is a document and
the backend playhead is gone; node and clip previews ride the `preview` channel,
including for object-share subscribers, so `node_transform_preview` is deleted;
scene deletion cascades through the collection; list-shaped document fields
(clip lanes/keyframes/events, graph nodes/edges) are keyed by id; preset
instantiation commits its documents rather than inserting rows; runtime
overrides, published data fields and media commands are collections rather than
WS kinds; the document WS kinds that duplicated a collection write are deleted.
On `feature/mesh-foundation`: whitelist grants with one egress filter, the
`control` channel's dedup / addressing / request-reply, `removeTree`, tab
authentication, link state, server status as `server_status` documents, and the
last editor document writes (compose layer fields and toggles, scene-tree hide,
`PUT /scenes/:id`) moved onto the mesh — with `scene_updated` / `scene_removed`
and the dead `camera_effect_added` / `camera_effect_removed` handlers removed
from the frontend. Also: a collection with no retained channel delivers its ops
to observers without keeping them (commands and stream frames are not stored);
a peer renews its stale subscriptions when a link returns; and snapshots carry
per-field stamps, so a field edit a subscriber missed while offline is no longer
lost to its own copy of the document.

## Key files

- `packages/mesh/src/` — core implementation (MeshPeer, Collection, Replica, ChannelRegistry).
- `packages/mesh-react/src/` — hooks.
- `packages/mesh-transports/src/` — WsServerTransport, WsBackendTransport.
- `packages/backend/src/mesh/index.ts` — backend bindings, hydration, persistence.
- `packages/mesh/src/grants.ts` — `GrantStore`, `readScope` / `projectValue` / `projectOp`, `grantOverlapsSubscription`.
- `packages/mesh/src/channels.ts` — the four built-in channels.
- `packages/backend/src/mesh/streams.ts` — `node_stream` and `runtime_control` collections (server-to-server only); collab live-ops bridging helpers.
- `packages/backend/src/mesh/runtime.ts` — the `runtime_override`, `data_field` and `media_control` collections. Registered from `initBackendMesh` so a mesh peer cannot exist without them.
- `packages/backend/src/mesh/status.ts` — the `server_status` collection and its `publishStatus` / `publishTracking` / `clearStatus` / `clearStatusOf` helpers.
- `packages/backend/src/auth/clients.ts`, `auth/routes.ts` — tab credentials, pairing code, enrollment routes.
- `packages/backend/src/mesh/assets.ts` — `initMeshAssets()`: mid-session asset fetch for mesh docs with unresolvable file paths (COLLAB + PLACE paths; inert without multiplayer).
- `packages/frontend/src/mesh/peer.ts` — frontend peer creation + wiring, the containment schema (`PARENTS`) and the subscribed rtype list (`RTYPES`), plus `meshUndo` / `meshRedo` / `meshBatch`.
- `packages/frontend/src/mesh/writes.ts` — generic UI write helpers (`MeshDocAdapter`, fallback ladder, batched bottom-up subtree delete) + the `scene_node` wrappers.
- `packages/frontend/src/mesh/layerWrites.ts` — the compose-layer half: fractional `orderKey` generation and the one-overlay-per-field `preview` write.
- `packages/frontend/src/hooks/useMeshField.ts` — binds one control to one field; owns the preview/commit split that makes undo usable.
- `packages/frontend/src/sync/meshStoreFeeder.ts` — replica → Zustand feeder; where the committed/ephemeral channel discrimination is applied.
- [plans/mesh-sync-refactor.md](../plans/mesh-sync-refactor.md) — full design spec (§8). See [Which plan is which](#which-plan-is-which) before reading the other plan docs.
