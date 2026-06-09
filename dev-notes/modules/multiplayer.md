# Multiplayer / Mesh

Peer-to-peer connectivity between vspark instances: server↔server WebRTC, a
signaling relay for browser clients, object sharing over the mesh, and (new) a
**backend↔remote-browser WebRTC edge** so backends can be full mesh participants
of remote browser tabs — not just other backends.

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
| `sharing.ts` | `SharingManager` — object-share protocol (`_share_*`), transport-agnostic via `MeshTransport`. |
| `shares.ts` | `shares` table DAO + `gatherObjectSnapshot` / `findOwningRoot`. |
| `blobs.ts`, `blobTransfer.ts` | Content-addressed asset transfer (`BlobManager`, `_blob_*` rtypes) over `ServerMesh`. |
| `manager.ts` | `MultiplayerManager` singleton — wires identity → rendezvous → meshes → sharing; accept policy; broadcasts `mp_*` WS events. |
| `frontend .../mesh/clientMesh.ts` | Browser-side WebRTC mesh participant. |

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

## Object sharing (`SharingManager`) — transport-agnostic

`SharingManager` no longer holds a `ServerMesh`. It sends through the exported
`MeshTransport` interface:

```ts
interface MeshTransport {
  sendEnvelope(participant, env): boolean;   // reliable
  sendStream(participant, frame): void;      // lossy (reliable on the browser edge)
}
```

The manager supplies a facade that resolves a participant id to its link via
`isClientParticipant`: browser participants (`serverId#tab`) go over
`BrowserPeerMesh`, servers over `ServerMesh`. The existing server-relay path is
behaviour-preserving.

Protocol rtypes (`SHARE_RTYPES`): `_share_advertise` / `_subscribe` /
`_unsubscribe` / `_snapshot` / `_update` / `_unshared` / `_stream` / `_override`
/ `_datachannel`. The owner tracks subscribers, sends the snapshot on subscribe,
forwards live document updates of shared subtrees, and advertises grants on
connect/change.

## Status

| Concern | Status |
|---------|--------|
| Server↔server `ServerMesh` + pairing/rendezvous | Implemented (Phase 5) |
| Object share over server mesh (snapshot + live doc updates + assets) | Implemented |
| Browser↔browser `clientMesh` (channel + clock offset) | Implemented (live-mesh slice 2) |
| Signaling relay backend-as-endpoint + cross-server roster | Implemented |
| **Backend↔remote-browser WebRTC edge (transport/connectivity)** | **Implemented** |
| Object-share *delivery* (snapshot + live updates) migrated onto the direct edge | WIP / planned |
| Frontend consumption of `_share_*` envelopes over the direct WebRTC channel | WIP / planned |
| Generalised namespace subscription + grant model (permissioned-sync-mesh) | Planned |

### Open decision — asset transport to a remote browser

The blocker for migrating object-share *delivery* onto the direct edge: today
shared assets localize at the **receiver's backend** (content-addressed by
sha256, fetched via `BlobManager` into a shared/HTTP `uploads/_shared/<hash><ext>`
dir served by the `/uploads` mount). Over a direct browser edge there is **no
receiver backend in the path**, so either:

- blobs stream over the data channel into **browser-side object URLs**, or
- the snapshot/asset path stays on the server-relay while only **live data**
  (pose/blendshapes/overrides) uses the direct edge.

Unresolved; see [plans/permissioned-sync-mesh.md](../plans/permissioned-sync-mesh.md).
