# Mesh / Multiplayer — State & Structural Issues (handoff)

> Branch: `feature/multiplayer-phase6` (not yet merged to `dev`). This is a
> handoff for a fresh session that will **refactor the mesh onto a clean
> abstraction**. It summarizes what exists, why the architecture is wrong, and the
> target design. Read this first, then `dev-notes/plans/collaborative-scene-share.md`
> for the original collab-scene plan.

## 1. What's built (and works, verified)

A peer-to-peer multiplayer system between vspark backends over WebRTC, plus an
in-app Connections UI. Everything below is on the branch and was tested live with
two backends (often two browsers):

- **Rendezvous** (`packages/rendezvous/src/index.ts`): WSS signaling — pairing
  codes, SDP/ICE relay, TURN cred minting, presence. Stateless except short-lived
  pair codes + a pending-pair buffer (so the creator still learns the joiner if
  its socket raced a reconnect).
- **ServerMesh** (`mesh.ts`): WebRTC between backends, **two data channels per
  peer** — reliable `doc` (envelopes) + lossy `stream` (pose). `BrowserPeerMesh`
  does the same to remote browser tabs.
- **Pairing / connection lifecycle**: pair create/join, connect/accept/reject/
  disconnect, mutual unpair (rendezvous-relayed so it lands even when
  disconnected), re-dial on a stale half-open slot. Display-name (“profile”)
  exchange with a courtesy re-send so names converge despite the on-connect race.
- **Object sharing** (`sharing.ts`, `shares.ts`): owner-authoritative, **read-only
  projection**. advertise → subscribe → snapshot → project; Phase-6 writes let a
  granted peer edit (owner persists + echoes).
- **Collaborative scenes** (`collabScene.ts` — the big one): persisted + editable
  on BOTH peers. share-collab → offer → subscribe → snapshot → **mount** (writes a
  real scene into the receiver's project). Then bidirectional last-write-wins sync
  of: scene_node CRUD, track_clip (clip/lanes/keyframes/events), camera_effect,
  compose_layer; clip **playback control**; pose/blendshape/IK + drag-preview
  **streams**; **reconnect reconciliation** (updated_at versions + `collab_tombstones`,
  author-wins ties); **asset transfer** (mount + mid-session model swaps, content-
  addressed blob protocol); and a **runtime relay** for non-persisted data
  (Set Data / data channels, runtime overrides, media control, spawn).
- **UI** (`ConnectionsWindow.tsx`, `SceneGraph.tsx`): contacts/connect/share,
  "Shared by you" + unshare, collab-scene **chain badge** (blue=author,
  green=connected, red=disconnected). `connectionsStore.ts` + `useWsSync.ts` on
  the client.

Migration `031_collab_scenes.sql` adds `collab_scenes` + `collab_tombstones`.

## 2. The core structural problem

**The mesh is entity-aware.** It knows what scenes, nodes, clips, and effects are,
and there are **two parallel sharing models** bolted together. The user's intended
design was a generic "write a value to the store and it syncs to peers" abstraction
that is schema-agnostic. The implementation drifted because each turn fixed a
reported bug on top of the existing split instead of unifying.

Concrete smells:

1. **Per-entity code in the mesh.** `collabScene.ts` (1105 lines) hardcodes
   `applyClipDto`, `applyCameraEffectDto`, `applyComposeLayerDto`, `mountSharedScene`,
   `gatherSceneSnapshot`, plus per-rtype scene resolvers and `forwardCollabOp`'s
   `if (rtype === 'track_clip') … 'camera_effect' … 'compose_layer'` switch. **Every
   new entity type needs bespoke writer + resolver + mount-write + reconcile code.**
2. **Two models, not one.** Object-share = owner-authoritative, read-only
   projection. Collab-scene = bidirectional, persisted both. They should be a
   single grant-gated sync where the grant level (read vs read+write) is the only
   difference.
3. **Mounting is bespoke.** The owner persists edits from *its own frontend* and a
   receiver runs a one-off `mountSharedScene` with hand-written writers. It should
   just be *subscribe to a namespace with a write grant; both sides persist incoming
   ops through the same path.*
4. **The backend resource registry is half-built.** `sync/resources.ts` (backend)
   only defines `load`/`scope` per rtype — **no generic `apply`/`write`** — so
   persistence of remote ops *had* to be hardcoded into the mesh. This one missing
   method is the root reason writers leaked out of the registry and into the mesh.
5. **The sync.document migration was never finished.** Many mutations still use raw
   `_ws.broadcast(...)` (camera_effect_updated, compose_layer_updated/reordered,
   data_channel_*, runtime_override_*, media_control, spawn's node/clip add/remove,
   playback) instead of emitting a `sync` op. This is the direct cause of the last
   wave of bugs (clips, effects, Set Data not syncing) and forced an ugly
   **whitelist relay** at `wsSync.broadcast` (`COLLAB_RELAY_KINDS` in `manager.ts`)
   to paper over it.
6. **The mesh reaches into app internals.** It directly reads/writes app SQLite
   tables (`scene_nodes`, `track_clips`, `camera_effects`, `compose_layers`,
   `asset_files`) and calls app managers (`dataChannelManager`, `runtimeOverrideManager`,
   `_trackClipPlayback`, `spawnManager`). It is not a clean module.

User's own framing (keep these as the north star):
- *"Scenes and Objects are project-specific entities and shouldn't be part of the
  abstraction."*
- *"Mounting should just be a special case of the sync, with write grants on both
  sides, and both sides persisting the incoming changes, instead of the owner
  persisting changes from its own frontend."*
- *"Just write values in the [React] store and they get synced to other peers, with
  all the plumbing abstracted underneath."*

## 3. Target architecture

**Mesh core knows only `(rtype, id)` envelopes, namespaces (opaque strings), and
grants.** No project schema anywhere in it.

```
SyncStore  (per peer; frontend AND backend)
  resources register { load(id), apply(op), namespaceOf(id), snapshot(namespace) }
  mutate an entry  → emit HLC-stamped op
  applyRemote(op)  → resource.apply(op)  // persists (backend) / updates store (frontend)

MeshTransport  (the extractable part — no schema)
  subscribe(namespace, grant)     // read = receive; read+write = also send
  local op   → route to peers subscribed to namespaceOf(op), gated by canAccess
  remote op  → applyRemote(op)     // generic, no rtype switch
  on subscribe → send snapshot(namespace), then live ops
```

- **"Write to store → it syncs"** becomes the literal contract.
- **Mount = `subscribe(namespace, grant=read+write)`. Place = read grant.** One path.
  Both peers persist incoming ops via the same `apply()`; no owner-authoritative.
- A namespace is just a string the *app* supplies via `namespaceOf` (a scene id, a
  project id, `'*'`). The mesh routes by it and gates with the grant store.

## 4. The pieces that ALREADY exist (this is consolidation, not a rewrite)

- `sync/index.ts`: `sync.document.upsert/remove` (HLC), `sync.stream`, `onDocument`.
- `sync/resources.ts` (backend) + `frontend/src/sync/resources.ts` (`bindResource`):
  the resource registries — need a generic `apply`/`write` added on the backend.
- `frontend/src/sync/registry.ts`: `applyRemote(env)` already routes by rtype.
- `sync/grants.ts` (`canAccess`, grant store) + `sync/meshRouter.ts` (grant-gated
  subscribe/publish) + `sync/containmentIndex.ts` (node→owning-root resolution).

## 5. Refactor order (keep it working at each step)

1. Add `apply(op)` / `write(dto)` + `namespaceOf(id)` to the **backend** resource
   registry, so `applyRemote` persists generically. Delete the `apply*Dto` writers.
2. Make the mesh forward **generic sync envelopes by namespace** through `MeshRouter`
   + `canAccess`. Delete `forwardCollabOp`'s rtype switch and `collabScene.ts`'s
   per-entity branches.
3. Replace `shareCollabScene` / `mountCollabScene` / `mountSharedScene` with
   `subscribe(namespace, grant)` + a generic snapshot. "Mount" = `grant=write`.
4. Finish the migration: every app-state mutation emits a `sync` op; nothing uses
   raw `_ws.broadcast` for app state. Then `COLLAB_RELAY_KINDS` / the runtime relay
   whitelist disappears.
5. Result: the mesh package's only required port is the resource registry
   `{ load, apply, namespaceOf, snapshot }`. No DB access, no app managers, no
   scene/object knowledge.

## 6. File map (what splits out vs stays)

**Extractable mesh package** (schema-agnostic after the refactor): `mesh.ts`,
`rendezvous_client.ts`, `clientMeshRelay.ts`, `browserMesh.ts`, `transport.ts`,
`blobTransfer.ts`/`blobs.ts` (asset port), `peers.ts`, `identity.ts`,
`sync/grants.ts`, `sync/meshRouter.ts`, `packages/rendezvous/*`, and a slimmed
`manager.ts` (lifecycle + transport wiring only).

**Stays in the app** (becomes the resource registry / ports): everything
entity-specific now in `collabScene.ts`, `sharing.ts`, `shares.ts`,
`sceneNodeWrite.ts`, the per-rtype `sync/resources.ts` definitions, and the
`db/migrations` for `collab_scenes`/`collab_tombstones` (which may collapse into a
generic per-namespace subscription + tombstone table).

## 7. Known caveats carried in (verify after refactor)

- Reconnect reconcile uses second-granularity `updated_at` versions, not the live
  HLC; concurrent same-second edits resolve by author-wins. The unified design
  should use one version scheme (HLC) end to end.
- Clip/effect/compose data sync had a recurring **frontend dedupe bug**
  (`addX` skips existing → updates dropped); fixed per-resource but the generic
  `applyRemote` should be upsert-by-default so it can't recur.
- Compose layers aren't collab-scene-scoped; they currently fan out to all collab
  peers "for consistency" with a try/catch writer — a namespace model removes this
  special-casing.
- `data_channel`/runtime relay fans project-global data to all collab peers
  (coarse). Namespaced grants would scope it properly.

## 8. Agreed target interface (design session 2026-06-11)

Refines §3 after a design discussion. Headline decisions:

1. **No durability in the package.** The mesh store is a pure in-memory replica
   + pub/sub on every peer. The backend hydrates it from SQLite on boot and
   persists changes via an observe tap — plain app code, not a package port.
   Version stamps round-trip through that tap so convergence survives restarts.
2. **Peers are symmetric in how they handle data** (identical read/write API
   everywhere); authority, reachability and durability are *roles* carried by
   config + app code, hidden under the surface. The backend's own browser tabs
   become ordinary participants on a local-WS transport — one delivery path,
   which deletes `sync.document.touch` and `COLLAB_RELAY_KINDS`.
3. **Channels** generalize the transient/committed split. Every write is tagged
   with a named channel whose delivery semantics (transport, stamping,
   retention, acking) are declared up front. Subscriptions select channels —
   the backend simply doesn't subscribe to ephemeral channels, so transient
   data never reaches persistence. The stream class folds into "a collection
   whose only channel is ephemeral".
4. **Single ack authority per collection**, three-outcome acks
   (accept / accept-with-correction / reject-with-current-value), writes gated
   while the authority is known down, recency-gated **local-only** revert on
   ack timeout.
5. **Channels ≠ layers.** Composition of multiple sources driving one value
   (base / clip / override) stays an app-level convention on sub-paths with one
   shared deterministic resolver. A channel carries the *same* logical value at
   different fidelity/durability. Do not model `clip` as a channel.

### 8.1 Package layout

```
packages/mesh/             core — no IO, no React, no DB, no app schema
                           (absorbs shared/sync.ts: envelope, HLC, grants,
                            SubscriptionHub, containment; adds replica,
                            channels, ack lifecycle, snapshot/orphan logic)
packages/mesh-transports/  rendezvous client, ServerMesh (WebRTC backend↔backend),
                           browser-peer link, local-clients WS (server side),
                           backend-link WS (browser side)
packages/mesh-react/       hooks (useSyncExternalStore-based)
packages/rendezvous/       unchanged
```

The app keeps: collection definitions (schemas, parent fns), hydration +
persistence taps, the grant-management UI, layer-resolution helpers, blob
storage behind the blob port.

### 8.2 Peer creation — identical on frontend and backend

```ts
const mesh = createMeshPeer({
  identity: { peerId: string; displayName?: string },
  transports: MeshTransport[],
  containment: ContainmentSchema,        // rtype nesting (existing shared code)
});

mesh.id: string
mesh.status(): MeshStatus                 // per-peer link state, pending ack counts
mesh.onStatus(cb): Unsubscribe
mesh.close(): void
```

### 8.3 Channels

```ts
mesh.channel(name: string, {
  transport: 'reliable' | 'lossy';
  stamped:   boolean;       // HLC stamps, per-path LWW, tombstones
  retained:  boolean;       // stored in replica + snapshots; ≤1 per collection
  ack?:      'authority';   // only valid on a retained channel
});

// built-ins:
//   'committed' → reliable, stamped, retained, ack:'authority'
//   'preview'   → lossy, unstamped, ephemeral
```

Invariants:
- **At most one retained channel per collection.** Retained = what the replica
  stores, snapshots serialize, acks guard, durable peers persist. Ephemeral
  channels are per-key overlays (last-seen value, never persisted).
- **Subscribing to an ephemeral channel auto-includes the retained one** —
  opting out of model updates is never what anyone means.
- A collection with *no* retained channel is a pure stream (pose frames):
  no snapshot, no acks, no tombstones.

### 8.4 Collections and values

```ts
const nodes = mesh.collection<StageObject>('scene_node', {
  parent?:    (doc) => ({ rtype, id } | null);  // feeds the containment index
  validate?:  (data: unknown) => StageObject;   // applied to INCOMING remote ops
  channels?:  string[];                         // default ['committed','preview']
  authority?: 'self' | PeerId;                  // who acks; 'self' on the home peer
});

// reads — synchronous, local replica (retained state + ephemeral overlay)
nodes.get(id)            nodes.all()
nodes.children(id)       nodes.subtree(rootId)

// writes — same call on every peer: apply local → fan out → ack lifecycle
nodes.create(doc): WriteHandle
nodes.update(id, partial): WriteHandle            // path-level patches, merged
nodes.set(id, path, value, opts?: { channel?: string }): WriteHandle
nodes.remove(id): WriteHandle

// hydration (durable peers, boot): apply with a restored stamp; LWW vs anything
// newer already in the replica; fans out like any write; never acked
nodes.put(doc, { v: HLC }): void
nodes.putTombstone(id, v: HLC): void

// observation
nodes.observe(selector, cb): Unsubscribe
//   selector: id | { subtree: id } | '**'
//   Change<T> = { op:'upsert'|'patch'|'remove', id, path?, doc?, v?, origin, channel }
nodes.onCommitted(cb): Unsubscribe   // sugar: remote-origin, retained-channel only
nodes.canWrite(): boolean            // false while the ack authority is unreachable

// single-cell sugar (scalar / quat / arbitrary JSON like the feed object):
const vol = mesh.value<number>('mixer_volume', mixerId, { validate });
vol.get(); vol.set(v, opts?); vol.observe(cb);

// pure stream example (no retained channel):
const pose = mesh.value<PoseFrame>('vmc_pose', avatarId, {
  channels: ['frames'],   // 'frames' declared lossy/unstamped/ephemeral
});
```

### 8.5 Write lifecycle and acks

```ts
interface WriteHandle {
  ack: Promise<
    | { status: 'acked' }
    | { status: 'corrected'; value: unknown }   // authority clamped/normalized;
                                                // correction supersedes everywhere
    | { status: 'rejected'; current?: unknown; reason: string }
    | { status: 'reverted' }                    // ack timeout → local revert
    | { status: 'unguarded' }                   // non-acked channel: resolves at once
  >;
}
```

- **Ack means applied+persisted**, not received: the authority acks after its
  observe/persist tap for the op returns without throwing; a throw nacks.
- **Nack carries the authority's current value** — no separate re-fetch round
  trip. Correction = authority applies the corrected value and re-emits it as
  its own stamped write.
- **Timeout** (authority died mid-flight — the race gating can't cover):
  recency-gated revert from the pending-buffer pre-image, *only if the current
  value still carries the write's stamp*, and **local-only** — no compensating
  broadcast (it would itself be unackable). Reconnect reconciliation from the
  authority is the real repair; brief divergence among non-authority peers
  during an outage is accepted.
- **Gating:** while the authority is known unreachable, guarded writes are
  rejected synchronously and not applied locally; UIs consult `canWrite()` /
  `useMeshStatus` to disable controls. Ephemeral-channel writes always flow.
- No offline write queue — deliberately out of scope (gate instead).

### 8.6 Sharing — grants and subscriptions (one model)

The existing grant machinery from `shared/sync.ts` is kept as-is (entity × path
× rights, union semantics, source-side admission) and becomes the ONLY sharing
mechanism: "place" = read grant, "mount" = read+write grant. Object-share and
collab-scene collapse into it.

```ts
mesh.grants.grant(grantee, {
  entityRtype, entityId, includeDescendants, pathPrefix,
  rights: { read?, update?, create?, delete? },
}): GrantId
mesh.grants.revoke(grantId)
mesh.grants.observe(cb)        // durable peer persists grants like data

const sub = await mesh.subscribe({
  entityRtype, entityId, includeDescendants, pathPrefix,
  channels?: string[],         // ephemeral picks auto-include the retained channel
});
// admitted iff covered by a read grant → snapshot (retained state, HLC
// watermark), then live ops. Rejects if not covered.
sub.unsubscribe();
```

Defense in depth: receiving peers also run `validate` and re-check write grants
on apply — a remote op never reaches a persistence tap unvalidated.

### 8.7 Hydration & persistence — the whole backend story, in app code

```ts
// boot
for (const row of db.allSceneNodes()) nodes.put(rowToNode(row), { v: row.syncV });
for (const t of db.tombstones('scene_node')) nodes.putTombstone(t.id, t.v);

// persist tap (this replaces applyClipDto & friends, generically)
nodes.onCommitted(({ op, id, doc, v }) => {
  if (op === 'remove') { db.deleteSceneNode(id); db.tombstone('scene_node', id, v); }
  else db.saveSceneNode(doc, v);          // v stored alongside the row (one column)
});
```

Stamp round-tripping is the one place durability touches the design: HLC
versions, tombstones and grants must survive a durable peer's restart or
reconnect reconciliation degrades (resurrections, clobbered offline edits).
The package treats stamps as data it hands in and out — never as internal
state. A generic `(rtype, id, hlc)` tombstone table replaces
`collab_tombstones`; tombstones + the version map are GC'd by age (a peer
offline longer than the window may resurrect a deletion — accepted).

### 8.8 React bindings (`@vspark/mesh-react`)

```ts
const node = useMeshDoc(nodes, id);
const tree = useMeshSubtree(nodes, rootId);
const [pos, setPos] = useMeshValue(nodes, id, 'transform.position');
//   read: retained value overlaid by fresh ephemeral frames (drag previews render free)
//   write: setPos(v, { channel: 'preview' }) while dragging; setPos(v) on release
const { connected, canWrite, pendingAcks } = useMeshStatus(nodes);
```

Recommendation: the mesh replica **becomes the store** for synced state
(`useSyncExternalStore`); the Zustand `editorStore` keeps only local UI state.
The mirror approach (`bindResource`) is where the recurring
add-dedupes-then-drops-updates bug class lives; if kept transitionally, make
apply upsert-by-default in the registry, not per resource.

### 8.9 Transport SPI and blob port

```ts
interface MeshTransport {
  start(h: { onPeer, onMessage, onFrame }): void;
  peers(): PeerId[];
  send(peer, bytes): void;        // reliable, ordered per pair
  sendLossy(peer, bytes): void;   // may alias send (plain WS)
  stop(): void;
}
```

Provided: `serverMeshTransport` (WebRTC backend↔backend), `browserPeerTransport`
(WebRTC to remote tabs), `localClientsTransport` (WS, server side),
`backendLinkTransport` (WS, browser side). Blob/asset transfer stays a separate
content-addressed port beside the store; documents reference blobs by hash.

### 8.10 Semantics & invariants

- **Convergence:** LWW per dotted path via HLC. Whole-doc upserts only for
  create + snapshot; edits travel as path patches (fixes the
  concurrent-edit-clobber and stale-upsert classes). List order via fracIndex.
- **Snapshots:** serialized replica slice (retained channels only) with an HLC
  watermark; live ops arriving during snapshot apply are buffered and replayed
  if newer.
- **Orphan parking:** ops whose parent ref is unresolved are buffered and
  applied when the parent arrives (cross-key ordering is best-effort:
  per-sender FIFO on the reliable channel + parking + reconcile).
- **Envelope cleanup:** `scope` and `route` drop off the wire — routing is
  key + containment only. The deprecated `event` class is removed; temporal
  state uses retained anchors as per live-mesh.md.
- **Authority is unique per collection** (the home peer that persists it);
  grant minting and acking live there. API symmetry, role asymmetry.

### 8.11 REST API stays — as an edge adapter

The existing REST routes are kept through the refactor (external clients use
them). What changes is *how they write*: a mutation handler becomes a thin
adapter that validates the request and writes into the mesh collection as the
local peer — it does NOT write the DB directly or broadcast.

```ts
// e.g. PATCH /api/scene-nodes/:id
const handle = nodes.update(req.params.id, body);
const result = await handle.ack;            // backend is the authority: ack = persist tap ran
// acked → 200 with canonical DTO · corrected → 200 with the corrected value
// rejected → 4xx with reason
```

Because the backend is the collection's authority and better-sqlite3 is
synchronous, awaiting the local ack gives REST the same durability semantics it
has today (200 ⇒ persisted), and the write fans out to all subscribed peers
like any other — an external client's edit shows up live everywhere with zero
extra code. Reads serve from DB or replica (identical by construction).

The app frontend still migrates off REST for synced state (that's what kills
the upsert-dedupe hacks); REST remains the door for everything that isn't a
mesh peer. The invariant to protect: **REST is a producer into the store, never
a parallel persistence/broadcast path** — that parallel path is exactly the §2
drift this refactor removes.

### 8.12 Deliberate non-features

- No CRDT merging (LWW per path is the model; fits poses/transforms/configs).
- No offline write queue (gate writes instead).
- No cross-key transactions (parking + reconcile only).
- No layer semantics in the package (app convention on sub-paths + shared
  resolver; the package merely doesn't prevent it).
- Opaque JSON values (feed object) are whole-value LWW — anything needing
  concurrent editing must be path-addressable. State this rule in the docs.

## 9. Collab cutover plan (from the legacy-protocol survey)

Protocol survey artifacts: legacy wire kinds (`_share_*`, `_collab_*`,
`COLLAB_RELAY_KINDS`), entry points, state, reconcile, lifecycle — see the
session survey; key facts baked into the steps below.

**Already done:** `ServerMeshTransport` (backend/src/mesh/serverMeshTransport.ts)
rides the legacy WebRTC doc/stream channels, namespaced as `rtype:'_mesh2'`
(doc) / `k:'_mesh2'` (stream) so both protocols coexist; attached after
`multiplayerManager.init` via `MeshPeer.addTransport`.

**Design decisions:**
1. **Backend↔backend collab is unguarded + mutually subscribed.** Both peers
   are durable authorities of their own store; acks only guard tab→backend
   writes. Mount = mutual RUCD grant + mutual subscribe on the scene subtree
   (`entityRtype:'scene_node', entityId:sceneId, includeDescendants:true`).
   Place (object share) = one-way read grant + subscribe. Grant level is the
   only difference — the original design goal.
2. **track_clip needs a containment parent** (clip→scene_node via its node
   column) so subtree grants/subscriptions cover clips, effects, behaviors
   cross-type. Add to backend BINDINGS + frontend PARENTS.
3. **Legacy-bridge (parallel-run keystone):** REST mutations bypass the mesh
   replica today. Bridge module (backend/src/mesh/legacyBridge.ts):
   - `sync.onDocument(env)` → `col.put(load(id), {v: env.v ?? clock})` /
     `putTombstone` — mirrors every legacy mutation into the mesh (put skips
     taps, fans out to subscribers).
   - The backend persistence tap, after `r.save(doc)`, calls
     `sync.document.upsert(rtype, id)` so the receiving backend's own tabs see
     remote mesh edits via the legacy WS path.
   - **Echo guard**: an `applying` set (rtype:id) — the tap adds before
     upsert, the bridge skips guarded ids. (Legacy `applyingFromPeer` pattern.)
4. **Cut over, don't duplicate:** the moment mesh carries collab ops, the
   legacy `forwardCollabOp` wiring in manager.ts (sync.onDocument hook) and
   the `_collab_op/_collab_subscribe/_collab_snapshot/_collab_reconcile`
   handlers must be disabled for those rtypes, or every edit double-applies
   via both pipelines (ping-pong risk).
5. **Reconcile = re-subscribe.** Mesh snapshot-on-subscribe replaces
   `_collab_reconcile`: on mesh peer connect, the backend re-subscribes for
   every `collab_scenes` row (`role='mounted'` → subscribe to owner;
   `role='author'` → subscribe back to the granted peer), and re-issues
   grants. Grants are in-memory in MeshPeer — hydrate them at init from
   `collab_scenes` + the legacy share grant store.
6. **Keep on legacy for now** (migrate later, separately): asset/blob
   transfer (`_blob_*` port), `_collab_playback` + spawn/ephemeral clips,
   `_collab_runtime` whitelist (Set Data / overrides / media) — these are
   runtime/event traffic, not document state; they map to mesh
   streams/values in a later step. Compose layers stay legacy until they get
   a real containment scope.

**Step order (keep green at each step):**
A. track_clip parent fns; legacyBridge (mirror + tap-upsert + echo guard).
   DONE. **Loop hazard (traced)**: mutual mesh subscriptions must NOT go live
   while legacy forwardCollabOp still runs — A's bridge put → B applies → B
   tap re-emits via sync.document.upsert (fresh stamp) → B's legacy
   forwardCollabOp sends _collab_op back → A re-applies → A re-emits → ∞
   (identical data, ever-fresher stamps). The applyingFromMesh guard only
   covers the same-process echo, not the cross-backend round trip. Therefore
   grant hydration is safe to land early (no traffic), but SUBSCRIPTION
   hydration + mutual mount subscribe land in the SAME commit as the legacy
   cut (B).
B. shareCollabScene/mountCollabScene gain mesh grants + mutual subscribe;
   THEN cut legacy: remove forwardCollabOp hook + _collab_op/_subscribe/
   _snapshot/_reconcile dispatch in manager.ts envelope handler for
   scene_node/track_clip/camera_effect (compose_layer stays via
   _collab_runtime for now). mountSharedScene's node/clip/effect writers die;
   mount keeps registerCollabScene + asset blob prefetch.
C. Delete dead collabScene.ts code (lastVersion/applyingFromPeer/nodeScene/
   clipScene/effectScene maps, apply*Dto, gatherReconcile/applyReconcile),
   collab tombstones move to mesh putTombstone + a generic table later.
D. Object-share onto the same path (read-grant subscribe), then
   COLLAB_RELAY_KINDS shrink/delete.

**Verify after B (two backends):** share→mount, bidirectional node edit,
clip keyframe edit, effect edit, delete + offline-delete reconcile via
re-subscribe, pose stream still legacy.

### §9 status (2026-06-11, post-cutover verification)

- **Step A (bridge) — DONE.** Verified single-server: REST CRUD mirrors into
  the mesh, tombstones persist (mesh_tombstones), no loops.
- **Step B (cut) — DONE and live-verified 8/8** with two backends over a
  local rendezvous (commit d53a1c0): mount with projectId localization,
  bidirectional live edits, provisional admission of brand-new child nodes,
  top-level deletes (identical HLC tombstone rows both sides), zero op
  storms, both-restart reconcile, and an offline edit converging via
  snapshot-on-subscribe (~7s incl. WebRTC connect). Five verification bugs
  fixed in d53a1c0; regression test added for subtree create admission.
- **Step C (dead-code removal) — DONE** (25a9e35; collabScene.ts 1106→~530
  lines, nodeScene re-index kept via `indexCollabNode`). Re-verified 8/8.
- **Step D (object-share doc plane) — DONE and live-verified 8/8** with two
  backends (commit ccbfa80 + the listSharesForPeer fix): place = legacy
  share grant mirrored into mesh grants (mesh/shares.ts) + one-way receiver
  subscription; receiver persistence tap skips foreign docs via per-rtype
  `persists()` predicates (replica-only projection); frontend
  `sync/meshProjection.ts` feeds the projection store from the mesh
  `scene_node` collection. Core fix shipped with it: `handleSubOk` relays
  snapshot-applied docs/tombstones to the peer's own subscribers (tabs
  subscribed before a reconcile were blind). Verified: snapshot-through-
  relay ordering (tab attached first), ~40ms live edits, zero receiver
  persistence + no FK errors, subtree create/remove, unshare eviction,
  re-share fresh snapshot, collab persistence regression (persists() has no
  false negatives). Legacy `_share_snapshot` now = asset manifest +
  stream-routing registration; `forwardDocOp`/`_share_update` deleted.
  Found+fixed pre-existing: `listSharesForPeer` reused a PreparedStatement
  (single-use wrapper finalizes after first `.get()`) → advertise 500 once a
  peer held ≥2 share grants; now one batched IN query.
- **Streams + clip playback (collab) — DONE and live-verified 5/5**
  (b4d55c5, 2530c3f): pose/preview frames ride a `node_stream` pure-stream
  collection (lossy `preview` channel) keyed by node id — the existing
  collab '*'-subtree subscriptions route them via containment; receivers
  bridge remote frames for their collab scenes onto /ws under the original
  kind. Clip playback controls ride a `clip_control` collection on a new
  reliable unstamped `control` channel keyed by clip id. `_collab_stream`,
  `_collab_playback`, forwardCollabStream, forwardClipPlayback deleted.
  Verified: A→B and B→A frame relay, non-collab isolation, trigger/pause/
  stop mirroring with re-anchored playhead, zero legacy rtypes in logs.
  Object-share streams stay on `_share_stream` (direct browser edges).
- **Runtime events (collab) — DONE and live-verified 4/4** (e181d9d):
  Set Data / overrides / media / spawn broadcasts ride a `runtime_control`
  collection on the `control` channel, one publish per shared scene id
  (these events have no containment anchor), deduped per receiver by
  eventId. Verified: 12ms A→B `data_channel_set`, exactly-once with two
  shared scenes, non-whitelisted kinds don't cross, zero `_collab_runtime`
  in logs. The legacy collab protocol is now just `_collab_subscribe` /
  `_collab_snapshot` (mount + asset transfer).
- **Known issues / deferred:**
  - ~~werift stale slot blocks single-side reconnects~~ **FIXED + live-verified
    4/4**: an offer from a peer we hold as `connected` proves our slot is
    stale (a live peer never re-dials — `connect()` no-ops), so `onSignal`
    now tears the slot down (peerDisconnected + pc.close, pendingIce kept)
    and answers the fresh dial. Verified: kill -9 one backend, restart, one
    POST connect → pair + placed-share data plane recover in <10s without
    touching the survivor; half-open glare handling unchanged.
  - Backends don't auto-dial paired peers at boot (user-initiated connect by
    design); the standing session grant auto-accepts, so one side's Connect
    suffices after restarts.
  - Mid-session model swaps don't carry assets over the mesh (receiver keeps
    its local filePath / owner path until the blob port rides the mesh; for
    placed objects the initial assets still arrive via the legacy snapshot
    manifest + `assetUrls` re-projection).
  - Phase-6 writes (`_share_write`/`_share_write_nak`) stay legacy: the
    receiver tab edits optimistically, the owner persists, and the
    authoritative echo returns over the placed mesh subscription. Migrating
    them to guarded mesh writes needs per-doc (not per-collection) authority
    — revisit with the REST write-through step.
  - Compose layers (containment scope), advertise/offer flow, asset/blob
    transfer, object-share streams (`_share_stream`, kept for direct
    browser edges), Phase-6 writes: still legacy. Collab streams, clip
    playback, and runtime events are on the mesh (see above).

## 10. REST write-through (next step — spec)

Goal: REST mutation routes become edge adapters that write THROUGH the mesh
store instead of writing SQLite directly + emitting sync.document (which the
legacy bridge then mirrors with a fresh stamp). One write path, one stamp
authority, and the bridge shrinks to read-side compatibility.

Shape (per rtype, ~1900 route lines across the five):
1. Route keeps ALL of its validation / side effects (file moves, instance
   checks, ordering); it builds the canonical full DTO (or merge partial
   onto `col.get(id)` for PATCH-like routes) and calls
   `col.set(id, '', dto)` / `col.remove(id)` (authority 'self' → the
   onCommitted tap persists via the resource registry's save/remove and
   emits sync.document.upsert for legacy tabs — both already in place).
2. The route responds with `col.get(id)` (canonical post-validate state).
3. Delete the route's direct SQL writes + its sync.document emissions (the
   tap emits). Watch for routes whose SQL does MORE than r.save covers
   (track_clips: lanes/keyframes aggregates — r.save is delete+reinsert of
   the whole aggregate, so build the full DTO first).
4. Order: behaviors (131 lines, simplest) → camera-effects → scene-nodes →
   compose-layers → track-clips. Keep each rtype's cutover its own commit;
   verify CRUD via REST + a live two-backend collab echo after each.
5. Hazards: (a) the bridge's sync.onDocument mirror must NOT double-apply —
   tap-emitted sync.document events are already guarded by applyingFromMesh;
   (b) scene POST creates many entities atomically (route emits touch today)
   — write each through the store in dependency order; (c) REST responses
   used to return route-built shapes — diff against col.get(id) output for
   parity; (d) blob/file-path side effects stay in the route, BEFORE the
   store write, so the DTO carries final paths; (e) **scene_node validate
   runs on LOCAL writes too** once routes write through the store — its
   collab file-path preservation must only fire when the doc's projectId
   was actually foreign (re-scoped), or a local REST model swap on a
   collab-author scene gets silently reverted. Same for any future
   incoming-only transform: gate on the foreign-doc discriminator, not
   unconditionally.

Slice 1 (DONE, 768ea2d, verified 5/5): behaviors + camera-effects. Also
fixed: behavior PUT emitted no sync event at all; behavior sortOrder
dropped by save.
Slice 2 (DONE, bfa3839, verified 6/6): scene-node POST/PUT/DELETE.
Field-presence semantics preserved; hazard-e validate gate confirmed both
ways (local model swap not reverted on author; foreign docs still
re-scoped). DELETE's ancestor-route capture removed. scenes.ts bulk
creation (templates) still emits touch via the bridge — fold it in when
compose/track slices land.
Slices 3+4 (DONE, 27be0b2 + 86a6e8c, verified 6/6 after one fix):
compose-layers (ordering/re-anchoring computed in the route, full DTOs
written per affected layer — reorder + delete-re-anchor verified) and
track-clips (aggregate: replica DTO mutated in memory, whole doc set;
keyframe/event replacement sorted by t; lane routes 404 on unknown
ids; playback routes untouched; collab echo verified A→B incl. delete).
Fix from verification: created_at fell back DTO → prior row → now in
the aggregate save (replica DTOs carry no timestamps).

**All five rtypes now write through the store.** The legacy bridge's
remaining job is read-side compatibility: scenes.ts bulk emissions
(template scene creation: touch per created node/layer) and any other
sync.document callers still mirror INTO the mesh via the bridge; route
mutations no longer emit directly. Next: Phase-6 writes onto guarded
mesh writes (per-doc authority), frontend mesh-react bindings, blob
port, compose containment scope.

After write-through, Phase-6 writes can move onto guarded mesh writes by
giving collections per-doc authority resolution (doc → owning peer), and the
frontend can drop optimistic+NAK for ack-based outcomes.

(Compose containment scope: DONE, a0d4da0 — root layers anchor to their
compose scene via rootComposeSceneId, scene_node-style fallback.)

## 11. Frontend mesh bindings (next step — spec)

Goal: UI reads come from the tab's mesh replica via @vspark/mesh-react;
writes go `collection.set` (guarded against the server) instead of REST +
optimistic Zustand mutation. The editorStore shrinks to UI-only state
(selection, panels, viewport); `sync/registry.ts` bindResource mirrors and
the legacy 'sync' WS envelopes retire per-rtype as their readers migrate.

Order (lowest blast radius first; one slice per commit, run the app after
each — `verify`/`smoketest` skills with Playwright, since UI regressions
don't show in headless REST runs):
1. **behaviors panel** — reads `useMeshSubtree(behaviors, nodeId)`-ish per
   node, writes col.set with ack outcome surfaced (toast on rejected).
   Simplest panel, already has the freshest sync path.
2. **camera effects panel** — same shape.
3. **track-clips timeline** — aggregate doc maps 1:1 onto the editor's
   clip state; keyframe drag stays on the local preview path, commit =
   col.set of the aggregate (replaces the keyframes REST PUT — or keep
   REST and only migrate READS first; reads-first is the safer default
   for every slice).
4. **scene tree + node properties** — the big one; Avatar/Viewport keep
   reading the Zustand store, which becomes a projection OF the mesh
   docs (one writer: a store-feeder like sync/meshProjection.ts but for
   local docs) before components migrate to hooks one by one.
5. **compose view** — after 4 proves the feeder pattern.

Slices 1+2 (DONE, 0d21329, browser-verified 5/5 with Playwright across
two live tabs): behaviors + camera-effects feed the editorStore from the
mesh replica via sync/meshStoreFeeder.ts; their legacy bindings removed;
the viewer page gained its own mesh peer. Foreign (placed-projection)
docs filtered by the parent node's remote flag.
Slice 3 (DONE, c4e4f04, browser-verified 6/6): track_clip +
compose_layer (incl. the compose_scene kind branch) joined the feeder —
live create/rename/delete across tabs, single rows (no double-apply).
Only scene_node remains on the legacy envelope (step 4). Note: the
"reads" migration so far re-points the store's TRANSPORT (envelope →
replica observation); components still read the store. Moving component
READS to mesh-react hooks + writes to col.set stays open per surface.

Hazards: (a) reads-first per slice — never flip reads+writes together;
(b) the tab replica misses DB timestamps (display: fall back to REST GET
or live with it); (c) smoothing paths (node_transform_preview,
compose_layer_preview) stay on /ws + previewSmoother — only committed
state moves; (d) mesh subscription arming races page load — gate panels
on useMeshStatus or keep initial REST hydration as the fallback read
until the snapshot lands (initial REST load stays regardless — it seeds
faster than the WS subscribe round-trip).
