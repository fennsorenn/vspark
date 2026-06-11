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
