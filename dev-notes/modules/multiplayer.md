# Multiplayer / Mesh

> **WIP: REST + frontend bindings.** Collab-scene LIVE OPS + RECONCILE have moved onto `@vspark/mesh` grants + subscriptions (see [mesh.md](mesh.md)). File now covers mount/assets/streams/relays only (~530 lines, down from 1106). Remaining work: REST mutation routes writing through the mesh store, frontend store migration to mesh-react bindings. See [dev-notes/plans/mesh-sync-refactor.md](../plans/mesh-sync-refactor.md) for the full design and architecture context.

Peer-to-peer connectivity between vspark instances: server↔server WebRTC, a
signaling relay for browser clients, object sharing over the mesh, a
**backend↔remote-browser WebRTC edge** so backends can be full mesh participants
of remote browser tabs (not just other backends), and **direct-edge P2P
object-share delivery** — snapshot, live updates, and asset blobs stream straight
from owner to a remote browser when an edge exists, skipping the relay hop. Asset
transfer is a **symmetric mesh capability** (same `_blob_*` protocol for backend
and browser receivers; only the sink differs).

Source: `packages/backend/src/multiplayer/` + `packages/frontend/src/mesh/clientMesh.ts`.
Design context: [plans/multiplayer-phase5.md](../plans/multiplayer-phase5.md),
[plans/live-mesh.md](../plans/live-mesh.md), and the target architecture in
[plans/permissioned-sync-mesh.md](../plans/permissioned-sync-mesh.md).

## Source layout

| File | Role |
|------|------|
| `identity.ts` | Per-install Ed25519 identity; `peerId` (also the HLC `origin`), `signBytes`. |
| `peers.ts` | Known-peers DAO + prompt-once session grants (`grantSession`/`hasActiveGrant`/`revokeSessionGrant`). |
| `rendezvous_client.ts` | Pairing + presence + TURN creds against the rendezvous server. |
| `mesh.ts` | `ServerMesh` — server↔server WebRTC. Opens `doc`+`stream` channels, waits for `doc`. Events: `incomingOffer`, `peerConnected`, `peerDisconnected`, `streamFrame`, `envelope`. |
| `browserMesh.ts` | **`BrowserPeerMesh`** — backend↔remote-browser WebRTC edge (see below). |
| `clientMeshRelay.ts` | Signaling relay (browser↔browser + browser↔backend) and the cross-server participant roster. |
| `transport.ts` | The neutral `MeshTransport` interface (`sendEnvelope` / `sendStream`). Both object-share **and** blob transfer ride it, so neither couples to a concrete mesh. |
| `sharing.ts` | `SharingManager` — object-share protocol (`_share_*`), transport-agnostic via `MeshTransport`. |
| `shares.ts` | `shares` table DAO + `gatherObjectSnapshot` / `findOwningRoot`. |
| `blobs.ts`, `blobTransfer.ts` | Content-addressed asset transfer (`BlobManager`, `_blob_*` rtypes) over any `MeshTransport` — symmetric across server and browser receivers. |
| `manager.ts` | `MultiplayerManager` singleton — wires identity → rendezvous → meshes → sharing; accept policy; broadcasts `mp_*` WS events; dispatches inbound `_blob_*` from browsers into the owner's `BlobManager`. |
| `frontend .../mesh/clientMesh.ts` | Browser-side WebRTC mesh participant; envelope send/sink (`sendEnvelope` / `onEnvelope` / `isConnected`). |
| `frontend .../mesh/blobReceiver.ts` | Browser-side mirror of the backend blob receiver — same `_blob_*` protocol, caches to object URLs. |
| `frontend .../sync/shareDirect.ts` | Receiver-side consumption of `_share_*` over the direct edge (mirrors the WS `mp_shared_*` path); browser-side asset localization via `blobReceiver`. |

Participant ids: backends use the Ed25519 `peerId`; browser tabs use
`${serverPeerId}#${tabUuid}` (`isClientParticipant` = has a `#tab` suffix,
`participantServer(id)` strips it).

## Transport topology

Every participant has a logical edge to every other; only the per-edge transport
varies:

- **co-located client↔own-server** → WebSocket (never WebRTC). A browser reaches
  its own backend over WS, so the frontend skips its own server id when dialing.
- **server↔server** → `ServerMesh` WebRTC.
- **client↔remote-browser** → browser-to-browser WebRTC (`clientMesh`).
- **client↔remote-server** → `BrowserPeerMesh` WebRTC (new).

Signaling for all WebRTC edges is relayed through backends (`clientMeshRelay`);
browsers never get rendezvous credentials.

## Backend↔remote-browser edge (`BrowserPeerMesh`) — IMPLEMENTED

The full mesh requires FrontA↔BackB links: a backend must accept WebRTC from
*remote browsers*. `ServerMesh` can't serve this — it opens `doc`+`stream`
channels and waits for `doc`, whereas a browser opens a single `mesh` channel.
So `BrowserPeerMesh` speaks the **client mesh's wire protocol** instead:

- one ordered `mesh` data channel carrying JSON;
- `__ping`/`__pong` clock-sync via `makeOffsetTracker` (symmetric with
  `clientMesh`, so each side learns its offset to the other);
- bare `SyncEnvelope`s (anything with an `rtype` field) for data.

Key properties:

- **Answer-only.** Browsers always *dial* the backend (the frontend treats
  backend peer ids — those without `#tab` — as always-initiate), so this mesh
  only ever answers. An unexpected inbound `answer` is ignored.
- **Auto-accepts inbound offers.** Trust comes from the signaling relay per the
  connection-based trust model (a backend only relays for its own clients and the
  `serverId#tab` prefix is server-assigned). Source-side grant admission still
  gates what actually flows. A re-dial after reconnect replaces the stale slot.
- ICE that arrives before the remote description is buffered (`pendingIce`) and
  flushed after `setRemoteDescription`.

Public API: `send(participant, env): boolean` (false, never throws, if the
channel isn't open), `isConnected`, `connectedParticipants`, `offsetFor`,
`disconnect`, `close`. Events: `peerConnected(participantId)`,
`peerDisconnected(participantId)`, `envelope({from, env})`. Signaling is injected
(`MeshSignaling`) so the mesh is loopback-testable; headless-verified 13/13.

### Manager wiring (`manager.ts`)

- Instantiates `BrowserPeerMesh` with a signaling adapter onto `clientMeshRelay`:
  `send → clientMeshRelay.sendFromBackend`, `onSignal → clientMeshRelay.onBackendSignal`;
  and calls `clientMeshRelay.setSelfPeerId(id.peerId)` so signaling addressed to
  this backend's own peer id is dispatched to the browser-facing mesh instead of
  being treated as a client relay target.
- On `peerConnected`/`peerDisconnected` it broadcasts `mp_browser_peer`
  (`{participant, connected}`) over WS.
- Inbound `_share_*` envelopes from a browser dispatch into
  `SharingManager.handleEnvelope` — a remote browser can subscribe/unsubscribe
  directly to the owning backend over this edge; replies route back over the same
  channel via the transport facade.
- Inbound `_blob_*` envelopes from a browser dispatch into the owner's
  `BlobManager` — the owner serves a content-addressed asset to a browser exactly
  as it serves another backend (see *Asset transfer* below).

### Signaling relay extension (`clientMeshRelay.ts`)

The relay gained a backend-as-endpoint role: `setSelfPeerId`, `onBackendSignal`
(sink for SDP/ICE addressed to this backend), and `sendFromBackend` (the
backend's own SDP/ICE to a local or remote browser). `onSignal`/`onServerRelay`
recognise `to === selfPeerId` and hand it to the backend mesh. `fullRoster()` now
includes connected remote backends so clients learn to dial them.

### Frontend dialing (`clientMesh.ts`)

`setRoster` now dials **remote backend** participants (ids without a `#tab`
suffix) as always-initiator, skipping the browser's own server (reached over WS).
Browser↔browser keeps the deterministic smaller-id-initiates glare rule.

## `MeshTransport` (`transport.ts`)

Both object-share and blob transfer ride a single neutral interface, extracted to
its own module so nothing couples to a concrete mesh:

```ts
interface MeshTransport {
  sendEnvelope(participant, env): boolean;   // reliable
  sendStream(participant, frame): void;      // lossy (reliable on the browser edge)
}
```

`SharingManager` no longer holds a `ServerMesh`; the manager supplies a facade
that resolves a participant id to its link via `isClientParticipant`: browser
participants (`serverId#tab`) go over `BrowserPeerMesh`, servers over
`ServerMesh`. The existing server-relay path is behaviour-preserving.

## Object sharing (`SharingManager`) — transport-agnostic

Protocol rtypes (`SHARE_RTYPES`): `_share_advertise` / `_subscribe` /
`_unsubscribe` / `_snapshot` / `_update` / `_unshared` / `_stream` / `_override`
/ `_datachannel`. The owner tracks subscribers, sends the snapshot on subscribe,
forwards live document updates of shared subtrees, and advertises grants on
connect/change.

## Asset transfer is a symmetric mesh capability — IMPLEMENTED

Content-addressed blob transfer (`BlobManager`, `_blob_*` rtypes: REQUEST →
BEGIN / CHUNK… / END / ERROR) now rides the `MeshTransport`, not a `ServerMesh`.
The owner serves an asset by sha256 hash identically to **any** participant — a
remote backend's disk cache or a remote browser's object-URL cache. The sink is
the only difference, never the protocol:

- **Backend receiver** (`blobTransfer.ts`): reassembles → verifies sha256 →
  writes to the shared `uploads/_shared/<hash><ext>` disk cache.
- **Browser receiver** (`frontend .../mesh/blobReceiver.ts`): the mirror image —
  reassembles base64 chunks → verifies sha256 via Web Crypto → caches as
  `URL.createObjectURL`. Deduped per hash, `ensureBlob(owner, meta)` resolves to
  an object URL, 60 s fetch timeout, 256 MB cap.

`manager.ts` dispatches inbound `_blob_*` from a browser into the owner's
`BlobManager`. Headless-verified: the owner serves a browser-participant id and
the browser-style assembler reproduces the bytes with a matching sha256 (4/4).
Server↔server behaviour is preserved.

## Direct-edge object-share delivery (P2P) — IMPLEMENTED

When a browser holds a direct mesh edge to a remote owner, the heavy data —
snapshot, live `scene_node` updates, pose/blendshape/IK stream, runtime
overrides, data channels, and asset blobs — flows **peer-to-peer** over that
edge, skipping the relay hop through the receiver's own server. **Offers still
ride the relay** (`mp_shares`); only the heavy data goes direct.

- **`clientMesh.ts`** gained `sendEnvelope(id, env)`, an `onEnvelope` sink, and
  `isConnected(id)`; inbound rtype messages route to the sink (`ping`/`pong`
  stays internal).
- **`shareDirect.ts`** is the receiver-side consumer of `_share_*` over the edge,
  mirroring the WS `mp_shared_*` path (it calls the same `sharedProjection` /
  pose / override / data-channel store methods). Because there is **no receiver
  backend in the path**, it does browser-side asset localization itself: fetch
  each asset by hash via `blobReceiver` → object URL → rewrite node `filePath`s
  (the browser equivalent of the backend's relaySnapshot/relayUpdate). On a fetch
  failure it keeps the owner path (still resolves when both servers share an
  uploads dir). Exports `subscribeDirect` / `unsubscribeDirect` / `hasDirectEdge`.
- **`useClientMesh.ts`** wires a mesh-envelope dispatcher into
  `clientMesh.configure`: `_blob_*` → `blobReceiver.handleBlobEnvelope`,
  `_share_*` → `shareDirect.handleShareEnvelope`.
- **`useSharedSubscriptions.ts`** prefers the direct edge (`subscribeDirect`) when
  the owner is mesh-connected, falling back to the server relay (`peerSubscribe`)
  otherwise. **Exactly one path subscribes** → no double-delivery.
  `ConnectionsWindow.tsx` unsubscribes over **both** paths on container removal
  (the owner ignores an unheld subscription).

**Direct-edge drop → relay fallback.** `shareDirect` tracks which subscriptions
are served over the edge; when an owner leaves the mesh (`onDirectEdgeGone`, wired
from `useClientMesh`'s connection-change diff), it drops exactly those projections
and marks them unsubscribed, so `useSharedSubscriptions` re-subscribes over the
server relay (the server link may still be up). Relay-path subscriptions to the
same owner are untouched; a full disconnect still uses the `mp_shared_gone`
teardown without a spurious re-subscribe.

**Unshare eviction.** `unshare` calls `SharingManager.revokeUnauthorized(objectId)`,
which notifies every current subscriber that can no longer read it — server peers
**and** direct-edge browser participants — and only those actually revoked (a
surviving `'*'` grant keeps a peer subscribed).

## Phase 6 — owner-authoritative multi-writer (write tier) — IMPLEMENTED

The read/live-preview tier above makes a remote projection read-only and
ephemeral. Phase 6 adds the **write tier**: a granted remote peer can EDIT a
shared Object and have the change **persist at the owner** and propagate to all
subscribers, staying **owner-authoritative** — the owner's SQLite is the single
source of truth; a remote write is a *request* the owner validates, applies, and
echoes. Implemented + user-verified end-to-end on both transports (direct WebRTC
edge and server relay). Design context: [plans/multiplayer-phase6.md](../plans/multiplayer-phase6.md).

### `_share_write` / `_share_write_nak` protocol

Two new rtypes added to `SHARE_RTYPES`:

- **`_share_write`** (receiver → owner): carries a `scene_node` env — an `upsert`
  (create or update) or a `remove` (delete, with the owner-ancestor `route` hint
  like the read tier).
- **`_share_write_nak`** (owner → receiver): carries the rejected entity id so the
  writer rolls its optimistic edit back. Sent on a denied write (no grant) or a
  failed/malformed apply.

### Owner side — AuthZ + persistence

Owner `handleWrite` (`sharing.ts`) authorizes the write against the grant store
via `canAccess`, with the `need` and the checked key derived from the op:

- **create** → authorize against the **parent** id (the new node's own id isn't in
  the tree yet), `need = create`;
- **update** → the node id, `need = update`;
- **delete** → the node id, `need = delete`.

Writes outside a granted subtree are rejected. The whole apply is wrapped in
try/catch: a malformed or failing write sends a NAK (rollback) instead of crashing
the owner process.

Persistence lives in `sceneNodeWrite.ts` (new):

- **`applySceneNodeUpdate`** — **content-only** UPDATE (name / kind / file_path /
  components / properties / hidden). It deliberately **preserves**
  `project_id` / `root_scene_node_id` / `parent_id`, which are
  owner-authoritative and **NOT trusted from the wire**.
- **`applySceneNodeCreate`** — derives `project_id` / `root_scene_node_id` from the
  parent row; returns `false` (→ NAK) if the parent is gone.
- **`applySceneNodeRemove`**, **`sceneNodeExists`** — delete + existence check.

All emit via `sync.document.upsert/remove`, so the existing `forwardDocOp` echoes
the authoritative result to **every** subscriber (including the owner's own
clients), exactly as the read tier's live updates do.

### Write shares — grant + advertise

A single **"can edit"** toggle grants `update + create + delete` together. It is
threaded `addShare(canWrite)` → `manager.share` → the
`/connections/objects/:id/share` REST route (`canWrite` body field) and advertised
**per-offer** as `canWrite`. `connectionsStore` gained `SharedOffer.canWrite` +
`canWriteObject(owner, objectId)`.

### Receiver side — routing seam + optimism/rollback

- **Central routing seam** (`frontend/src/api/client.ts`): `setRemoteWriteRouter`
  lets `updateNode` / `deleteNode` of a writable-remote node divert to the owner
  with **no commit-site changes** (the gizmo/Properties/scene-graph call sites are
  untouched).
- **`frontend/src/sync/remoteEdit.ts`** (new) is the router: it confirms
  `node.remote` + `canWriteObject`, builds the `scene_node` env, records a pending
  write, and sends.
- **Transport.** `shareDirect.ts` `sendShareWriteDirect` is the direct edge; the
  **relay fallback** goes via a `setShareWriteRelay` hook registered by
  `useWsSync` (posts `mp_share_write` → backend `index.ts` handler →
  `manager.relayWrite` → `SharingManager.relayWrite`, which forwards to the owner
  over the mesh).
- **Reconciliation** (`sync/sharedProjection.ts`): an authoritative-DTO map; an
  **HLC stale-drop guard** in `applyUpdate` (so a late echo can't clobber a newer
  one, and an owner echo always beats a peer's stale optimistic state); a
  pending-write log; and `rollbackWrite` (update → re-apply the DTO, create →
  delete, delete → re-add). A `_share_write_nak` (direct via `shareDirect`; relay
  via `mp_shared_write_nak` in `useWsSync`) rolls the optimistic edit back.

### Writable-subtree un-hide + share toggle (UI)

Read-only projections stay hidden under their opaque container. For an object the
local user has **edit rights** on (`isWritableRemote` = remote + `canWriteObject`),
`SceneGraph.tsx` now **shows** the projected subtree so its inner nodes are
selectable and edited with the existing gizmo / Properties panel — coordinates are
node-local (the container's placement is not baked in). The share submenu gained an
**"Allow editing"** toggle (en/de i18n added in `sceneGraph.json`).

### Known gap — create-routing unwired (frontend)

Adding a **new child** under a writable remote node still hits local REST and
fails with an alert (no corruption). The **backend** create path exists and is
tested; only the frontend `createNode` seam is unwired. This is the one remaining
piece before the write tier is feature-complete.

### Verified (user)

Gizmo move on a subscriber persists at the owner and survives an owner reload;
coordinates are node-local; delete persists; read-only shares keep the subtree
hidden and reject writes; denied/malformed writes NAK without crashing the owner.

## Status

| Concern | Status |
|---------|--------|
| Server↔server `ServerMesh` + pairing/rendezvous | Implemented (Phase 5) |
| Object share over server mesh (snapshot + live doc updates + assets) | Implemented |
| Browser↔browser `clientMesh` (channel + clock offset) | Implemented (live-mesh slice 2) |
| Signaling relay backend-as-endpoint + cross-server roster | Implemented |
| Backend↔remote-browser WebRTC edge (transport/connectivity) | Implemented |
| **Symmetric blob transfer over `MeshTransport` (server + browser receivers)** | **Implemented** |
| **Direct-edge P2P object-share delivery (snapshot + live updates + asset blobs)** | **Implemented** |
| **Frontend consumption of `_share_*` over the direct WebRTC channel** | **Implemented** |
| `MeshRouter` as the live grant-gated subscription registry (object-share subscribers) | **Implemented** |
| `router.publish()` / `publishStream()` fan-out — overrides, data channels, pose, clip transforms | **Implemented** |
| `_share_update` doc op (needs per-subscriber owning-root) | Stays on the custom path (see below) |
| Live config-sync of behaviours/effects | **Non-goal** (output-synced; see below) |
| Track-clip animation of a shared object (root + child subtree transforms) | **Implemented** |
| **Phase 6 — owner-authoritative write tier: `update`/`delete` of a shared `scene_node`** | **Implemented + user-verified** (`_share_write`/NAK, owner AuthZ + content-only-update / parent-derived-create persistence, both transports, optimistic + rollback, crash-safe) |
| **Phase 6 — `create` of a new child under a writable remote node** | Backend implemented + tested; **frontend `createNode` seam unwired** (hits local REST, alerts, no corruption) |

### Resolved — asset transport to a remote browser

The earlier blocker (no receiver backend in a direct browser edge) is resolved by
the user's choice: **blobs stream P2P over the data channel into browser-side
object URLs**, via the symmetric `_blob_*` protocol (see *Asset transfer*). Asset
transfer is now a mesh capability shared by backend and browser receivers; only
the sink differs (disk vs object URL). See
[plans/permissioned-sync-mesh.md](../plans/permissioned-sync-mesh.md).

### Non-goal — live config-sync of behaviours/effects

A behaviour (signal graph) runs only on the **owner's** backend; the receiver's
projection is frontend-only, `remote: true`, inert (the receiver's backend never
instantiates graphs for projected nodes — graphs come from its own
`node_components`). Everything a graph produces that affects rendered state exits
through the **pose / runtime-override / data-channel** buses, all of which are
forwarded to subscribers (`forwardStream` / `forwardOverride` /
`forwardDataChannel`). So a shared behaviour is synced **by its output, not its
config** — forwarding behaviour config edits live would change nothing on an
output-driven receiver. Config rides the initial snapshot for completeness only.

**Track-clip animation of shared objects — IMPLEMENTED.** Clip evaluation runs on
the **frontend** (`useTrackClipEvaluator`) and writes local override slots — no
graph output, no persisted edit — so it can't ride the override/doc forwarders.
Instead the evaluator forwards clip-driven transforms over the
`node_transform_preview` stream: each frame it emits the live transform for
animated nodes (throttled ~30 Hz, gated on a connected contact), and re-emits the
**base** transform for a few frames when a node stops so the receiver smooths back
(the preview path has no auto-clear; repeating guards the revert against a dropped
frame on the lossy channel). A forward-only `shared_node_transform` WS kind
forwards to subscribers **without** the local co-editor broadcast (co-editors
evaluate the same clip themselves and would otherwise double-apply); the backend
reuses the `node_transform_preview` stream kind toward subscribers, so the
receiver applies it via the existing `smoothNodeTransform` on the projected node.

Children inside the subtree are covered: `shared_node_transform` routes through
`SharingManager.forwardNodeTransform`, which resolves the owning root via
`findOwningRoot` (so a clip animating a child of the shared object forwards too,
not just the root). Remaining boundary: **opacity** isn't carried by the transform
preview (would need a separate field on the frame) — a later refinement if needed.
Note the live drag path (`node_transform_preview`) is still root-only by design.

### `MeshRouter` — live subscription registry

The `MeshRouter` (grant store + `SubscriptionHub` + per-participant link
registry) is now the **live** source of truth for object-share subscriptions:

- **Admit-on-subscribe.** `SUBSCRIBE` → `router.subscribe(participant, {scene_node,
  objectId, includeDescendants})`, admitted iff a read grant covers the
  entity×subtree (evaluated against the real grant store + the containment index's
  `isDescendant`). Replaces the bespoke `subscribers` Map + `isSharedWith` check.
- **Evict-on-revoke.** `unshare` → `revokeUnauthorized` → `router.revalidate` per
  participant drops + notifies exactly the subscriptions a grant change unseats
  (a surviving `'*'` grant keeps a peer).
- **Forwarding** queries `router.participants()` + `subscriptionsOf` for each
  subscriber's owned roots; the `_share_*` wire protocol + receiver are unchanged.
- **Links + live fan-out.** The manager attaches per-participant links on connect
  (a reliable link + a lossy `streamLink`; servers via `ServerMesh`
  `sendEnvelope`/`sendStream`, browsers via `BrowserPeerMesh` — one ordered
  channel, so both links are the same send) and `detach`es on disconnect. The
  router is now the **single grant-gated fan-out** for every namespace-keyed
  class, routing by `env.key` (`subscriptionMatches` ≡ the old `findOwningRoot`
  membership):
  - `router.publish(env)` (reliable) — **runtime overrides**, **data channels**
    (`forwardOverride`/`forwardDataChannel`, keyed `scene_node:<targetId>`).
  - `router.publishStream(key, frame)` (lossy) — **pose/blendshape/IK**
    (`forwardStream`, keyed at the root) and **clip transforms**
    (`forwardNodeTransform`, keyed at the node, subtree-matched).
- **What stays on the custom path:** only the `_share_update` doc op, because it
  needs a *per-subscriber* `objectId` (the subscriber's own subscribed root
  containing the changed node) in its payload, which a single broadcast frame
  can't carry. It keeps querying `participants()` + `rootsOf` and sends via the
  transport facade. Generalising it is the collab-editing tier's job (it'll likely
  move the per-subscriber root resolution to the receiver).
