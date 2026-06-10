# Plan: Live P2P mesh — full-mesh participants + temporal state

> Branch: `claude/preset-object-sync-wn2HT` · Status: draft
> Seed context for implementation. Starting point, not an airtight spec.

## Goal

Cut latency on live updates by letting **every participant — browser clients
*and* backend servers — connect peer-to-peer and broadcast live state directly
to all others**, instead of relaying every message through the owning backend.
Persistent (document) state may still pass through a server, but optimistically.
Events stop being fire-and-forget commands and become **temporal state**: a
retained "this started at timestamp X" fact that any participant (including late
joiners) renders in sync.

This builds on the unified sync layer (`@vspark/shared/sync`) and the
server↔server `ServerMesh` already shipped in Phase 5. See
[unified-sync-layer.md](unified-sync-layer.md) and
[multiplayer-phase5.md](multiplayer-phase5.md).

## Decisions already made

- **Full mesh, everyone↔everyone.** Accepted N² connection cost for now. Edge
  selection MUST sit behind a policy seam (`shouldConnect(a, b, scope)`) so an
  interest/role-pruned topology can replace it later with no call-site changes.
- **Live tier first.** Route `stream` + `field` (pose, blendshapes, IK,
  transform preview, runtime overrides) over the client mesh. Documents keep
  working through the server unchanged in this phase; the optimistic-document
  path is a later slice.
- **Events fold into temporal state.** No more fire-and-forget `event` class as
  a distinct behaviour. An "event" (clip started/paused/stopped, media control)
  becomes a retained keyed value `{ anchorT, ... }` in the `field` class:
  latest-wins, snapshotable, and the consumer derives the current frame from
  `sharedNow − anchorT`. This generalises the existing `track_clip_started`
  (`startedAt` + `clockOffsetMs`) model to every event.
- **Signaling via backends.** Browsers do not get rendezvous credentials. A
  client sends SDP/ICE to its own backend over the existing WS; the backend
  routes it — locally to another of its clients, or across the `ServerMesh` to a
  remote backend, which hands it to the target client. TURN creds are minted by
  rendezvous as today and handed down to clients through their backend.

## The hard sub-problem: shared clock

A flat P2P mesh has no single server clock, but "render the clip so it lines up
with start timestamp X" needs a common time base.

Approach: timestamps travel in the **origin's clock** (the HLC already carries
`t` + origin `n`). Each participant maintains a measured **offset per origin**
via lightweight ping/pong over the data channel (RTT/2 estimate, smoothed).
Converting a remote anchor to local time = `anchorT + offset[origin]`. This is
the per-server `clockOffsetMs = serverNow − Date.now()` generalised to
per-origin. For temporally exact resources (clips), the **object/scene owner's
origin is the reference** — everyone syncs anchors to the owner's clock.

## Participant model

- A **participant** is any mesh endpoint: a backend (werift) or a browser
  (`RTCPeerConnection`). Symmetric at the DataChannel level.
- **Participant id**: backends already have an Ed25519 peer id. A client gets
  `${serverPeerId}#${ephemeralClientUuid}` (per tab). This id is the HLC
  `origin`/`n` and the loop-suppression tag.
- **Roster / membership**: a participant joins the mesh for a scene when it
  opens/shares that scene. The backend, which sees the server mesh + its own WS
  clients, advertises the participant roster for a scene; each participant then
  dials every other (full mesh) via backend-relayed signaling.

## Files in scope

New:
- `packages/frontend/src/mesh/clientMesh.ts` — browser WebRTC peer manager
  (mirror of backend `ServerMesh`): dial/accept, data channel per peer,
  buffered ICE, send/broadcast envelope, per-origin clock offset ping/pong.
- `packages/frontend/src/mesh/signaling.ts` — SDP/ICE exchange over the editor
  WS (`mesh_signal` messages) + roster handling.
- `packages/shared/src/sync.ts` — add participant-id helpers; fold `event` into
  the `field`/temporal model (mark `event` deprecated; add a temporal-anchor
  value convention + `sharedNow(origin)` doc note). Add `originKind` (server |
  client) if needed for policy.

Backend:
- `packages/backend/src/multiplayer/mesh.ts` / `manager.ts` — relay client
  signaling across the server mesh; advertise rosters.
- `packages/backend/src/index.ts` (WS handler) — accept `mesh_signal` from a
  client and route it (local client or across the server mesh).
- `packages/backend/src/sync/index.ts` — let `stream`/`field` producers emit to
  the mesh path; keep the WS as fallback for non-meshed (passive) clients.

Frontend wiring:
- `packages/frontend/src/hooks/useWsSync.ts` (or a new `useClientMesh`) — bring
  up the mesh, route inbound mesh envelopes through `applyRemote`, and prefer
  the mesh for outbound live producers (pose/preview/overrides) with WS
  fallback.

## Out of scope (this phase)

- Optimistic-document path + server-authoritative rollback (next slice; the HLC
  stale-drop already supports it — server-origin wins ties, reject re-emits the
  prior canonical doc with a higher stamp to reset everyone).
- Interest/role pruning (full mesh now; seam only).
- ~~Cross-machine asset transfer~~ — **implemented** (commit 5afd312): content-addressed
  blob transfer over the backend↔backend `ServerMesh`. When an object is shared, the
  receiver fetches each referenced asset by sha256 hash (`BlobManager`,
  `multiplayer/blobTransfer.ts`), caches it under `uploads/_shared/<hash><ext>` served by
  the existing `/uploads` mount, and `SharingManager` rewrites the projected nodes' file
  paths to the local cache URL (falling back to the owner path on fetch failure, preserving
  the shared-uploads-dir one-box case). v1 routes the transfer over the server mesh (the
  authoritative copy lives on the owner's disk); because it's content-addressed behind a
  path-rewrite seam, a future client-mesh-direct fetch can drop in behind the same
  addressing. Live pose forwarding to share-subscribers remains a Phase 5 follow-up.
- SFU/viewer fan-out for large audiences.

## Approach (live-tier-first slices)

1. **Shared primitives** — participant id helpers; fold events into temporal
   `field` state; document `sharedNow`/per-origin offset. Type-checks only.
2. **Client mesh manager + WS signaling** — `clientMesh.ts` + `signaling.ts`;
   backend relays `mesh_signal` locally and across the server mesh; roster
   advertise. No producer rerouting yet — just establish channels + clock sync.
3. **Route the live tier** — emit `stream`/`field` over the mesh; inbound mesh
   envelopes go through `applyRemote`. WS stays as fallback for clients not (yet)
   meshed. Migrate transform preview + runtime overrides + pose onto it.
4. **Temporal events** — re-express clip start/pause/stop + media control as
   retained temporal `field` values rendered via `sharedNow(ownerOrigin)`.

## Acceptance / verification

- `pnpm lint` clean across packages at every slice.
- Two browsers on one box (two backends, shared uploads dir): a tracked avatar's
  pose/transform updates on B with visibly lower latency than the WS relay path;
  a clip started on A plays in phase on B; a late-joining tab picks up the
  in-progress clip at the right position.
- Mesh teardown on disconnect/reload leaves no stuck channels.
- NOTE: browser WebRTC + multi-participant timing is **not verifiable in the
  dev harness** — needs the user's two-browser runtime test at each slice.

## Output

Commit per slice on the feature branch (conventional commits). No PR unless
asked.
