# Plan: Multiplayer — Phase 5 (object share) implementation spec

> Branch: `feature/multiplayer-object-share` · Status: spec (ready to refine into tasks)
> Companion to [`unified-sync-layer.md`](./unified-sync-layer.md) (Phase 5) and its
> [diagrams](./unified-sync-layer-diagrams.md). Phase 6 (shared scenes / full sync) is sketched
> at the end but is a separate, gated effort.

## Goal

Let two independently-hosted servers (each behind NAT, **no port forwarding**) pair once, then
connect code-free thereafter, and let one **share individual objects** (avatars, props) that the
other **embeds into its own scene** — live, low-latency, dropping on disconnect and re-projecting
on reconnect.

## Connectivity & transport (decided)

- **WebRTC direct (Shape B).** A small **rendezvous** (outbound-only; only it needs a public
  address) handles **signaling + presence**; actual sync flows **peer-to-peer over WebRTC data
  channels**: pose on an *unreliable/unordered* channel (low latency, lossy-OK at 90 Hz), documents
  on a *reliable/ordered* channel.
- **ICE prefers direct/STUN; TURN is the capped last-resort relay.** Most home-broadband pairs go
  direct (free, low latency); only strict-NAT / CGNAT pairs fall back to TURN. Both are outbound
  (no port forwarding). All three pieces (rendezvous, STUN, TURN) ship in a **self-host bundle**
  (see below) so there's no third-party dependency and strict-NAT users still connect.
- **Rendezvous hosting:** the self-host bundle is the production path; **PeerJS**'s free public
  PeerServer + public STUN are fine for early prototyping (rate-limited).
- A `ServerMesh` transport implements the same port as today's `ClientHub`, carrying the same
  `SyncEnvelope`. No producer/consumer changes; pose uses the Phase 3 stream class.
- Node WebRTC: `werift` (pure TS) or `node-datachannel`.

## Self-host bundle (decided)

One drop-on-a-server `docker compose` bundle running all the coordination infra, so an operator
hosts it once for their collab group (no managed services, no app-server impact):

- **`rendezvous`** — the small Node WS service (signaling + presence relay + room/pairing). The only
  piece that must be publicly reachable.
- **`coturn`** — a single container is **both STUN and TURN** (one image covers hole-punching +
  relay fallback).
- **`caddy`** (or nginx) — TLS termination: `wss://` for the rendezvous and `turns:` for coturn
  (auto-cert via Let's Encrypt).

**Keeping TURN load off the host** (it only engages when P2P fails, but cap it anyway):
- coturn: `total-quota`, `bps-capacity` (global bandwidth ceiling), `max-bps` per session,
  `user-quota`, a bounded `min-port/max-port` relay range, `no-cli`, `no-multicast-peers`, and
  **short-lived HMAC credentials** (`use-auth-secret` shared with the rendezvous, which mints
  time-limited TURN creds) so it can't be used as an open relay.
- Compose `deploy.resources.limits` (cpu/memory) on the coturn service as a hard backstop.
- Because ICE only uses TURN as a last resort, the steady-state relay load is just the strict-NAT
  minority — the caps protect against abuse/spikes, not normal use.

The bundle is built alongside the rendezvous in the first implementation PR (the coturn config +
compose are off-the-shelf and can be scaffolded now; the rendezvous image needs its source first).

## Identity, pairing & contacts (decided)

- **Peer id = a long-lived Ed25519 keypair** generated on first run; the pubkey/fingerprint is the
  stable id, equal to the envelope `origin` / HLC `n`. Survives IP changes.
- **`known_peers` table** (per-server SQLite) — the contacts list:
  `known_peers(peer_id PK, display_name, paired_at, last_seen, blocked, created_at)`.
- **Pair once (code):** A creates a session → short code/link → B enters it → rendezvous matches →
  mutual pubkey exchange → both rows written to `known_peers`.
- **Reconnect (no code):** servers announce **signed presence** to the rendezvous (sign a nonce with
  the private key); to connect, route by peer id → **mutual nonce/signature challenge against the
  stored pubkey** (the rendezvous only routes, can't impersonate) → see the session-grant policy
  below → WebRTC. Revoke = delete (or `block`) the contact. Prior art: Syncthing.
- **Accept policy = a persisted session grant.** An *incoming* connection from a known contact
  **prompts once**; on accept, the peer is **auto-accepted** until the grant expires — a
  `session_grants(peer_id PK, expires_at)` row, TTL ~12h. **Persisted on purpose:** a disconnect is
  often a *crash*, and in a live-stream context reconnecting must be friction-free — so a server
  restart within the window still auto-reconnects (no re-prompt). **Manually disconnecting a peer
  deletes its grant** (an explicit "I'm done" → next incoming prompts again). Outgoing connections I
  initiate are implicitly accepted on my side.

## Session topology (group call · decided)

- **Direct connection requires pairing; awareness is transitive.** You hold direct WebRTC links only
  to peers you've paired + connected with. A connected peer **relays the presence of its other
  connected peers** to you (so if A is connected to both B and C, A tells B that C exists and vice
  versa) — there's never a state where two of your co-members are invisible to each other.
- **Transitive peers are introduced, not auto-connected.** A relayed presence shows up as a
  "discoverable" peer with a **one-click pair shortcut**: one side clicks *Send pair request*
  (pubkey travels through the relaying member A — no code to type), the other clicks *Accept*. Only
  then do they form a direct connection. No silent mesh to strangers.
- **No re-sharing received objects** — you can only share *your own* objects (with any connected
  peer). A received `remote_object` cannot be forwarded.

## Data model

Owner side (the sharer is authoritative):

```
-- grant/ACL: which peers may subscribe to which of my objects. peer_id = '*' means "All".
shares(
  id PK, share_kind TEXT,            -- 'object' | 'scene'
  object_id TEXT,                    -- scene_node id (object) or scene id (scene)
  grantee_peer_id TEXT,              -- a known_peers.peer_id or '*'
  created_at
)

-- persisted accept policy: auto-accept this peer's incoming connections until expiry.
-- survives a crash/restart so reconnect stays friction-free; deleted on manual disconnect.
session_grants(
  peer_id PK,                        -- known_peers.peer_id
  expires_at                         -- ~12h after the accepted prompt
)
```

Receiver side (subscriber owns placement, never persists the content):

- The **wrapper** is a normal persisted scene node of a new kind `remote_object` (a group). It owns
  its transform/placement (the "wrapper transform" from the design) and stores the **remote ref**
  in its `properties`: `{ ownerPeerId, remoteObjectId, remoteKind }`. Its projected children/content
  are live and **non-persisted**.
- Cached assets reuse the existing content-addressed (sha256) asset store.

Runtime (in-memory, per process): active `ServerMesh` peer connections + presence; the set of
publications each connected peer has advertised to us.

## Protocol (over the mesh)

1. **On connect** (both directions): `share_advertise` — list the objects granted to this peer
   (owner side queries `shares` where `grantee_peer_id IN (peerId, '*')`). Populates the receiver's
   "shared by <peer>" list.
2. **Subscribe:** receiver → `subscribe(remoteObjectId)`. Owner validates the grant, replies with an
   **object snapshot** (the document subtree: the node + its behaviors/effects/clips, as canonical
   DTOs) and starts streaming that object's `SyncEnvelope`s + pose stream, **scoped to a publication
   id = remoteObjectId**. Read-only on the receiver.
3. **Assets:** for any referenced asset hash the receiver lacks → `asset_request(sha256)` →
   `asset_chunk(...)`; cache locally.
4. **Unsubscribe / disconnect:** receiver drops the projected content (keeps the wrapper +
   remote ref); owner stops streaming. On next connect, the receiver re-subscribes automatically
   for every wrapper whose `ownerPeerId` just came online.
5. **Revoke:** owner deletes the grant → sends `share_revoked(objectId)` → receiver drops content
   and marks the wrapper "no longer shared" (see open decision).

Object-share is publisher-authoritative, so there are no write-backs and no reconciliation.

## UX

A **Connections window** (sibling of the media window):
- **Contacts:** paired peers with online/offline state; **Pair** (enter/append a code) and
  **Connect**/Disconnect buttons; remove/block; disconnect revokes the peer's session grant.
- **Incoming shares:** per *connected* peer, the list of objects they're sharing with me. Each entry
  can be **dragged into the scene** (creates a `remote_object` wrapper at root) or **placed into the
  selected object** via a button (wrapper parented to the selection).
- **Outgoing shares:** what I'm sharing and with whom (mirror of the context-menu grants; lets me
  review/revoke).

**Object context menu → "Share with" submenu:** one entry per connected peer + **All** (`*`). Toggling
writes/removes a `shares` row and (if connected) advertises/revokes live.

i18n + help (per CLAUDE.md, part of "done"): new namespace (e.g. `connections`) in EN/DE, a
`HelpButton` + `help/content/{en,de}/connections.md` page, and `kinds.json` entry for the
`remote_object` node kind.

## Object-share lifecycle (summary)

| Event | Owner | Receiver |
| --- | --- | --- |
| Grant ("Share with") | write `shares` row; advertise if connected | entry appears under that peer |
| Placed | stream object scoped to its id | `remote_object` wrapper persisted (ref only); content projects |
| Disconnect | stop streaming | content drops; wrapper + ref persist |
| Reconnect | re-advertise; stream on subscribe | auto re-subscribe per wrapper; content re-projects |
| Revoke / delete source | `share_revoked` | content drops; wrapper → placeholder |
| Receiver removes wrapper | (unsubscribe) | wrapper + ref deleted |

## Open decisions

All resolved (see sections above): accept policy = **prompt-once → persisted session grant** (~12h
TTL, survives crash/restart, deleted on manual disconnect); revoke/source-delete → **keep
placeholder**; **multiple placements allowed**; **no re-sharing** received objects; topology =
**pairing-gated direct connections + transitive presence relay with one-click pairing**;
connectivity = **WebRTC (direct/STUN preferred, capped TURN fallback)**, all infra in a
**self-host docker-compose bundle** (rendezvous + coturn + caddy).

Nothing blocking remains — open items are now tuning knobs surfaced during build: exact TURN
caps/quota values, session-grant TTL, and the relay-broker fallback (only if WebRTC proves
unreliable in practice).

## Phase 6 — shared scenes (separate, gated)

Same UX shape (`share_kind = 'scene'`, "Share scene with"), but the whole scene is added to the
receiver's scene list, **persisted on both servers and editable by anyone** → full bidirectional
document sync + **authority-coordinated reconciliation on reconnect** (authority = scene owner/host;
apply-both with owner tiebreak; dirty-since markers + tombstones — see the main plan). This is the
hard distributed-systems work; build only after object-share is solid.

## Output

Phased PRs into `dev` (transport+pairing, then sharing+UX), one coherent unit each.
