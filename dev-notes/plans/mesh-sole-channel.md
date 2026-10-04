# Plan: The mesh as the sole client↔server channel

> **Status:** in progress — foundation largely done on `feature/mesh-foundation`
> **Follows:** [`mesh-frontend-writes.md`](./mesh-frontend-writes.md) (shipped, in `dev`
> at 77bfdb4). **Supersedes** the Phase-6 recommendation in
> [`mesh-sync-refactor.md`](./mesh-sync-refactor.md) §12 ("keep Phase-6 on the legacy
> path"). That was an agent's recommendation, not a user decision, and principles 7–9
> below reverse it.
> **Catalog:** every entity and stream, with its current transport and target channel,
> is in the Mesh Entity Catalog artifact. This plan holds the decisions and the order.

> Branch: `feature/mesh-foundation` for the foundation workstream, then one
> `feature/mesh-<workstream>` branch per later workstream, each merged into `dev`.

## Goal

Every byte that moves between a vspark client and a vspark server goes through
`@vspark/mesh`, over the most direct path available, between authenticated
participants, gated by a whitelist of grants. The only traffic outside the mesh is
traffic with **outside services**. When this is done, the `/ws` socket and the
frontend's REST client are gone.

## Decisions

All of these were decided by the user on 2026-10-04. They are recorded as principles
7–9 in [`../modules/mesh.md`](../modules/mesh.md#core-principles); the rest are
constraints on this plan.

### Principle 7: the mesh is the only client↔server channel

A reason not to use the mesh is evidence of a missing mesh feature. Build the feature,
don't route around it.

- **Outside services stay outside**: VMC/iFacialMocap UDP, obs-websocket,
  Twitch/StreamElements, the assistant's LLM endpoint, GitHub Releases, the Cubism
  CDN. What they produce becomes mesh documents.
- **The REST API stays** for outside callers and writes through the mesh
  (principle 5). The editor stops using it.
- **Files are a mesh matter**: a document that needs a file needs it on local and
  remote peers alike.
- **New channel types are allowed** when genuinely needed, but high-frequency data
  stays on `preview`, and that channel gets optimized if it's too heavy.

### Principle 8: every subscription takes the most direct path

This was the user's instruction from the start (recorded in
[`permissioned-sync-mesh.md`](./permissioned-sync-mesh.md) §1, promised as
`browserPeerTransport` in `mesh-sync-refactor.md` §8.9). The executed implementation
dropped it and built a star (every tab ↔ its own server only).

- A direct WebRTC link between the two participants when one can be established
  (browser↔browser, browser↔remote server, server↔server).
- One or two server hops **only as a fallback**, when the direct path fails, with
  failover back to direct when it recovers.
- **Relays are limited to the two endpoints' own servers.** Each client trusts its own
  server (it is the grant source of truth), so endpoint relays are trusted and relayed
  traffic is **not** end-to-end encrypted. A third, unrelated server is never a relay.
  This matters if the mesh is ever extracted into its own package.
- **A co-located server counts as direct**: tabs on the same machine as their server
  reach each other through it (localhost WS), not through N² WebRTC links.
- **Committed state is ordinary subscription**: the persisting servers subscribe to the
  entities they persist, exactly like tabs do. Tabs still take the direct route for
  latency. Guarded writes keep **one authority per document**, which decides
  validation and rejection; a per-document authority resolver replaces the
  per-collection `authority`.
- **Send once per next hop**: when several subscribers sit behind the same next hop
  (e.g. server A already subscribes to what tab B wants via A), send one copy.

### Principle 9: authenticated participants, whitelist grants

- **Every participant authenticates**, and a connection that doesn't is refused at the
  handshake. Servers already have Ed25519 identities; tabs get enrolled identities.
- **Grants are whitelist-only**, with no deny rules, and granular enough that the
  whitelist works: grantee (down to a single tab) × rtype × entity × path prefix ×
  right.
- **Path-prefix read grants stay** (GraphQL-style field scoping: a permissive prefix
  grants the whole document, a deep prefix one field). They are made safe by:
  - **one egress filter**: every outgoing message (op, relayed op, snapshot, nack
    value, undo emission) is projected through the recipient's grants at a single
    choke point;
  - **subscriptions deliver the union of granted paths** instead of being refused when
    no single grant covers them;
  - **a peer with a partial view never overwrites what it can't see**: an upsert from
    an origin without write coverage of the whole document is applied as a merge-patch
    of the paths it may write.
- **Collections declare their default grants at registration**, so a new rtype without
  grants is visibly unreachable, never silently reachable. The `'*'/'*'` grant for a
  server's own tabs goes away.
- **Grants for a direct link are delivered while the link is set up**: the brokering
  server tells its tab which grants the remote participant holds, over their
  authenticated link. No per-message or per-subscription signatures.
- **Blobs are grantable entities** (`rtype: 'blob'`, entity = content hash). The server
  **derives** blob grants from the documents that reference the hash; that is the only
  way they come into existence.
- **The nack leak and the tombstone leak are fixed through grants**: a nack carries the
  current value projected to what the requester may read; a snapshot carries only the
  tombstones inside the subscriber's granted scope.
- **Secrets are a grant pattern, not a channel**: their own rtype, write-only for tabs
  (update without read), never granted to remote peers, encrypted at rest by the
  persistence layer. A readable `has…` flag is derived next to them.

### Channels

Four channels, plus a blob store beside them:

| Channel | Properties | Carries |
|---|---|---|
| `committed` | reliable, stamped, retained, authority-acked, undo | document state |
| `preview` | lossy, unstamped, unretained | gestures, mocap streams (optimized: coalescing, real lossy delivery on WS, compact encoding) |
| `runtime` | reliable, stamped, retained, volatile (no persistence) | server status, runtime overrides, data fields, spawned entities |
| `control` | reliable, unstamped, unretained, deduplicated in core, addressable (`to`), replies (`re`) | commands and request/reply (media control, UI actions, assistant, captures) |

- **`control` and "command" are one channel.** Targeting is an addressing field on the
  message, authorized by grants; it is not built out of grants. Replies carry the
  request's id and get a timeout and an `unreachable` outcome, because delivery is at
  most once.
- **Anything that must survive while the receiver is offline is state**, a document on
  `runtime` or `committed`, never a `control` message.
- **Blobs** are a content-addressed store (fetch by hash, chunked, binary frames,
  cached) over the same authenticated links and routing; documents reference blobs by
  hash.

### Out of this plan, flagged for later

- **REST and MCP security.** Both are designed for local use only for now. Securing
  them (authentication, a grant principal for outside callers) is future work. Two
  local-only gaps are fixed separately on `bugfix/secrets-quick-fixes`: the server
  bound every interface, and secrets were returned by REST/MCP.

## Constraints

- **[decided]** Principles 1–9 in `../modules/mesh.md`.
- **[decided]** MCP descriptors use the list shape (see
  [`../modules/mcp-assistant.md`](../modules/mcp-assistant.md)).
- **[observed]** Core facts as of 77bfdb4 (full inventory in the catalog):
  - channels have exactly four properties (`transport`, `stamped`, `retained`, `ack`);
  - grants are `{grantee, entityRtype, entityId, includeDescendants, pathPrefix,
    rights}`, enforced at the serving peer; a grant to a server id covers its tabs;
  - delivery is at most once, with no core dedup and no addressing;
  - payloads are JSON only;
  - topology is tab↔own server (WS) and server↔server (WebRTC); the browser WebRTC
    mesh in `frontend/src/mesh/clientMesh.ts` is legacy, outside `@vspark/mesh`;
  - the `/mesh` hello carries a participant id the client chooses itself.

## Workstreams

### F: Foundation (`feature/mesh-foundation`)

In this order, each with core tests in `packages/mesh/test/` before any consumer uses
it:

1. **Grants module.** ✅ Done (4a333bf). Whitelist-only `GrantStore`, one egress
   filter (`MeshPeer.transmit`), overlap admission with union-of-paths delivery,
   per-leaf write checks, partial-view upserts applied as merge-patches, nack and
   tombstone leaks fixed (tombstone ancestry persisted, migration 042).
2. **Collection-declared default grants.** ✅ Done (4a333bf). `CollectionConfig.clients`;
   the `'*'/'*'` tab grant is gone.
3. **`control` channel.** ✅ Done (3f4d10e). Per-origin (epoch, seq) dedup, `to`
   addressing through `nextHop`, `Collection.request` / `reply`.
4. **Routing seam.** ✅ Partly done. `nextHop` resolves a destination to a link
   (direct link → the participant's server → our home); link state (feef226): a peer
   announces its direct links to its home, which stops relaying *lossy* ops those
   participants get first-hand. Not done: a general per-subscription path choice
   (today a subscriber picks the peer it subscribes to).
5. **Participant authentication.** ✅ Done for tabs (07e3f0c): token hello →
   welcome / 4401, browsers enroll once (automatic on the vspark machine, device code
   elsewhere), token hashes in `client_credentials` (migration 043). Servers already
   authenticate through the rendezvous (Ed25519).
6. **Direct links.** ⏳ Not started; design below. Blocked on a two-backend test
   harness (the e2e suite runs one backend with multiplayer disabled, so a real
   browser↔browser or browser↔remote-server link can't be verified yet).

Also done on this branch, outside the numbered list:
- **`removeTree`** (20ccf98): deleting a document removes its cross-type containment
  subtree as one undo action. Fixed live ghost documents: a node deleted through the
  mesh left its behaviors/effects/clips/graphs alive in every replica.
- **W0** (604b776) and **W2** (550b9c9), see their sections.

#### F6 design (for review)

- **Transports.** The pieces exist outside the mesh: browser↔browser WebRTC
  (`frontend/src/mesh/clientMesh.ts`, signaling via `clientMeshRelay`) and
  backend↔remote-browser WebRTC (`multiplayer/browserMesh.ts`). Wrap both as
  `MeshTransport`s (as `ServerMeshTransport` already wraps the server↔server mesh)
  so their links appear in `MeshPeer.links`. Signaling moves onto addressed
  `control` messages.
- **Grants at link setup.** A tab serving a direct subscriber needs that
  participant's grants. The brokering server writes them into a runtime collection
  only its own tabs can read, scoped to the participants they link with; the tab
  mirrors them into its `GrantStore`. Revocation is a removal there.
- **Admission on direct links.** Today an op is accepted without a grant check when
  it matches one of our subscriptions to the sender. That shortcut is right for a
  home or authority link and wrong for a direct link from another tab, which must
  pass the write grants.
- **Open problem: committed writes over a direct link.** Validation, corrections and
  peer-relative fields (clock-anchored `startEpoch`) are handled by the authority
  server. A committed op that arrives tab-to-tab skips all of it; if the authority
  then rejects or corrects it, the receiving tab never hears about it and diverges.
  Proposal: treat a committed op from a non-authority direct link as a provisional
  overlay (latency win, rendered immediately) that the authoritative write
  replaces, with an expiry for one that never gets confirmed. Needs the user's call;
  until then direct links carry `preview` and `control` only.

### W0: Missed writes and leftovers (no new mesh features)

✅ Mostly done (604b776). Remaining: scene create (template seeding still inserts SQL
rows and mirrors them), `Home.tsx` scene seeding, cross-scene move via preset, compose
scene create, and the unused tables (awaiting the go-ahead).

- Frontend writes still on REST for rtypes that have a collection:
  `ComposeLayerProperties.tsx` config fields; `ComposeTree.tsx` layer config and
  compose-scene create; `SceneGraph.tsx` hide toggle, scene create/delete, cross-scene
  move; `Home.tsx` scene seeding.
- `routes/scenes.ts` writes around the mesh (SQL + `mirrorRow`).
- `scene_updated` / `scene_removed` WS kinds: feed `scenes[]` from the replica.
- Dead code: `camera_effect_added/removed` handlers, `clip_control`, the stale
  `COLLAB_RELAY_KINDS` docstring.
- Unused tables (`audit_logs`, `avatars`, `players`, `preferences`, `presence`,
  `sessions`, `triggers`, `collab_tombstones`): drop only with the user's go-ahead.

### W1: Unmigrated resources become collections

projects, asset metadata, presets, OBS connections, Overlive app credentials and
accounts, app config, and the multiplayer control plane (grants, known peers, session
grants, collab scenes). Secrets follow the grant pattern above.

### W2: Server-authored live status on `runtime`

✅ Partly done (550b9c9): receiver tracking/connected, OBS connection, streaming
account and output-window status are `server_status` documents. Remaining: the
multiplayer `mp_*` status, static catalogs, and `server_update` (a command → W4).

`obs_connection_status`, `overlive_account_status`, `output_window_status`,
`vmc_status`, `vmc_tracking_state`, `server_update`, `mp_status` / `mp_peer` /
`mp_browser_peer` / `mp_presence` / `mp_shares`, static catalogs (behavior kinds, node
kinds, param paths, built-in presets).

### W3: High-rate streams on `preview`

`vmc_pose`, `vmc_blendshapes`, `pose_ik_targets` (server → tab), `tracking_input`,
`lipsync_input` (tab → server). Benchmark `/ws` against `node_stream` first; optimize
the channel where it falls short.

### W4: Commands on `control`

`ui_action`, the assistant turn loop, feed preview and viewport screenshot round-trips,
`mp_connect_request`, editor-triggered actions (update check/apply, asset rescan, OBS
reconnect). `session_hello` / `ui_register` / `client_hello` disappear: the
participant id and the roster cover them.

### W5: Blobs

Asset upload and download, peer transfer (`_blob_*`), preset thumbnails, screenshots.
Viewport loaders take a hash → `blob:` URL resolver.

### W6: The snapshot as the load path

Replace the REST scene bundle in `Editor.tsx` with the subscription snapshot
(`subscribe()` resolving is the ready signal); then reads can move to mesh-react hooks.

### W7: Multiplayer legacy

Placed-object writes (`_share_write`), object-share streams (`_share_*`, `mp_shared_*`),
advertise/offer, the collab mount handshake, `peer_profile`, spawned temp entities,
and the `sync.document` envelope with its three backend consumers. With direct links
(F6), placed-object writes reach the owning server in one hop, so multi-hop acks
remain only for the fallback path.

## Acceptance

- **No `/ws`.** `packages/backend/src/ws/` and `hooks/useWsSync.ts` are gone; `/mesh` is
  the only socket.
- **No frontend REST.** `packages/frontend/src/api/client.ts` is gone or unused by the
  editor.
- **No legacy multiplayer messages**: no `_share_*`, `_collab_*`, `_blob_*`.
- **No `sync.document`.**
- **REST writes go through the mesh**: no `INSERT`/`UPDATE`/`DELETE` in
  `packages/backend/src/routes/`.
- **No unauthenticated connection and no `'*'` grant** in production code.
- Per workstream: `pnpm lint` + `pnpm test` green, Playwright green (including
  multi-client and undo specs), new mesh primitives covered in `packages/mesh/test/`.
