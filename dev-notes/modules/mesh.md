# Mesh — Replicated Store (@vspark/mesh, @vspark/mesh-react, @vspark/mesh-transports)

**Status:** Core package implemented with 25 vitest tests; three packages (mesh / mesh-react / mesh-transports WS pair) shipped; backend + frontend parallel-run wiring complete; app integration WIP.

A **schema-agnostic in-memory replicated store** with symmetric read/write API on both frontend and backend, HLC last-write-wins convergence, grant-gated access control, and authority-driven ack lifecycle. No durability in the package itself; durable peers hydrate from persistent store and persist incoming mutations via observe taps. Designed to replace both the legacy sync layer and the entity-aware collab-scene sharing model.

See the design spec in [plans/mesh-sync-refactor.md](../plans/mesh-sync-refactor.md) (§8 defines the interface).

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

**Channels are delivery semantics, not data layers.** A channel declares transport reliability, HLC stamping, retention, and ack requirements. Composition of multiple sources driving one value (e.g., base / clip-override / runtime-override) happens via app-level conventions on sub-paths with a shared deterministic resolver, not via channels.

**At most one ack authority per collection**, gated while reachable, with three-outcome acks:
- `acked` — applied + persisted by authority.
- `corrected` — authority applied a normalized/clamped value; the corrected value supersedes everywhere.
- `rejected` — authority refused; current value included in the nack so no refetch round-trip needed.

**Recency-gated revert on ack timeout.** Authority unreachable mid-flight: reverted *only if the current value still carries the write's HLC stamp* — a read-only check that's safe under concurrent writes. Revert is *local-only* (no compensating broadcast); reconnect reconciliation from the authority is the real repair. Brief divergence among non-authority peers during an outage is accepted.

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

## Channel mechanics

Channels are declared when creating the collection:

```ts
const nodes = mesh.collection<Node>('scene_node', {
  validate?: (data: unknown) => Node,
  channels?: string[],  // default ['committed', 'preview']
  authority?: 'self' | PeerId,
});

// Built-in channels:
//   'committed' → reliable, stamped (HLC), retained (snapshot), ack:'authority'
//   'preview'   → lossy, unstamped, ephemeral (drag previews, IK targets)
```

A write targets a channel via `set(id, path, value, { channel: 'preview' })`. Writes to the retained channel flow through ack authority; ephemeral writes always flow (no authority gating).

### Snapshot & apply

On subscription with an unmet grant, the subscriber receives:
1. Snapshot of the retained channel's current state (all entries + their HLC stamps).
2. A watermark (HLC timestamp) bounding the snapshot's consistency.
3. Live ops after the watermark.

Applying a remote op validates the source has write permission (via the grant store) and runs the resource's `validate` function before touching the replica.

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

All five collections are wired identically. A generic `(rtype, id, hlc)` tombstone table replaces the legacy `collab_tombstones`; tombstones are GC'd by age (offline peer may resurrect a deletion — accepted policy).

## Frontend parallel-run wiring

Location: `packages/frontend/src/mesh/peer.ts`.

**Per-tab peer (mounted from Editor.tsx):**
```ts
const peer = useMemo(() => createMeshPeer({
  identity: { peerId: sessionStorage.peerId ||= uuid(), displayName },
  transports: [new WsBackendTransport(WebSocket, '/mesh')],
  containment: ...,  // schema from PARENTS
}), []);
```

**Participant ID:** `${serverPeerId}#${tabUuid}` (stable across reconnects via sessionStorage).

**Auto-subscription re-arming:** subscriptions are re-opened automatically on transport reconnect.

**Vite proxy:** `/mesh` route proxied to backend during dev.

**Current UI state:** Zustand `editorStore`, not mesh-react bindings (transition in progress).

## Extending: adding a new synced rtype

### Backend

1. Add a row to the `BINDINGS` schema in `packages/backend/src/mesh/index.ts`:
   ```ts
   {
     rtype: 'my_entity',
     parent: (doc) => ({ rtype: 'scene', id: doc.sceneId }),
     load: async (id) => db.getMyEntity(id),
     save: async (doc, v) => db.saveMyEntity(doc, v),
     remove: async (id) => db.deleteMyEntity(id),
   }
   ```

2. Migrate the database: add `syncV` column to the entity table (or a generic `(rtype, id, hlc)` version table), add tombstone retention.

3. Add hydration in the boot sequence (same pattern as scene_node above).

4. Add a persistence tap (same pattern as scene_node above).

### Frontend

1. Add to `PARENTS` in `packages/frontend/src/mesh/bindings.ts` (containment schema).

2. Add to `RTYPES` (registered in the frontend peer at creation).

3. Bind reads: dispatch from `useMeshDoc` / `useMeshSubtree` / `useMeshValue` where the UI currently reads from Zustand.

4. Bind writes: replace Zustand mutations with `collection.create` / `collection.update` / `collection.remove` calls.

## Integration roadmap (remaining)

**Completed:**
- Core package (@vspark/mesh) — 25 tests, all APIs.
- React hooks (@vspark/mesh-react) — all hooks.
- Transports (@vspark/mesh-transports) — WS pair; WebRTC pending.
- Backend hydration + persistence (five collections, generic onCommitted taps).
- Frontend per-tab peer + auto-subscribe (wired, not in UI yet).

**Planned (next):**
- REST mutation routes writing through the store (instead of direct DB writes).
- Frontend store migration: UI bindings to mesh-react hooks instead of Zustand reads.
- HLC persistence: sync_v column + generic tombstone table for full convergence/reconcile.
- WebRTC transport adapters (wrapping ServerMesh and BrowserPeerMesh).
- Collab-scene / object-share unification onto mesh grants and subscriptions.

## Key files

- `packages/mesh/src/` — core implementation (MeshPeer, Collection, Replica, ChannelRegistry).
- `packages/mesh-react/src/` — hooks.
- `packages/mesh-transports/src/` — WsServerTransport, WsBackendTransport.
- `packages/backend/src/mesh/index.ts` — backend bindings, hydration, persistence.
- `packages/frontend/src/mesh/peer.ts` — frontend peer creation + wiring.
- `packages/frontend/src/mesh/bindings.ts` — containment schema (PARENTS, RTYPES).
- [plans/mesh-sync-refactor.md](../plans/mesh-sync-refactor.md) — full design spec (§8).
