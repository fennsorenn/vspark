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
- **v1 = STUN-only, no TURN (P2P-only).** Use **public STUN** (e.g. Google) for hole-punching.
  Symmetric-NAT / CGNAT pairs *can't* form a direct path and simply fail — show a clear
  "couldn't connect directly (strict NAT)" error. **TURN is a documented later fallback** (self-host
  `coturn` or managed: Cloudflare Calls / metered.ca / Twilio), added only if failures prove common.
  Relay-broker mode (rendezvous relays everything) is the other zero-WebRTC fallback.
- **Rendezvous hosting:** self-host the small app-specific rendezvous for production; **PeerJS**'s
  free public PeerServer is fine for prototyping (rate-limited). (There's no generic production
  public signaling server — signaling carries app room/identity logic.)
- A `ServerMesh` transport implements the same port as today's `ClientHub`, carrying the same
  `SyncEnvelope`. No producer/consumer changes; pose uses the Phase 3 stream class.
- Node WebRTC: `werift` (pure TS) or `node-datachannel`.

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
- **Accept policy = session grant, not a persisted flag.** An *incoming* connection from a known
  contact **prompts once**; on accept, the peer is **auto-accepted for the session** — a runtime
  grant `(peer_id → expires_at)`, TTL ~12h, cleared on server restart. **Manually disconnecting a
  peer revokes its grant** (next incoming prompts again). Outgoing connections I initiate are
  implicitly accepted on my side. (In-memory by default; persist with `expires_at` only if
  surviving a restart within the window is wanted.)

## Session topology (group call · decided)

- A **session is a room**: connecting is **transitive** — there is never a state where you're
  connected to B and C but B and C can't see each other. Adding a peer merges them into one session
  (full mesh among members). Members **see each other** (presence) and **may share with each other**,
  but visibility ≠ content: every share stays an **explicit per-peer grant**.
- **No re-sharing received objects** — you can only share *your own* objects (with anyone in the
  room). A received `remote_object` cannot be forwarded.
- Mesh is fine at collab scale (2–4 peers); N² connections, not a concern here.
- **Open sub-decision:** trust flow for a peer pulled in **transitively** who isn't a saved contact
  (B & C never paired, both invited by A). Lean: transitive members **connect for presence
  automatically** (you trust the room you're in), but saving each other to `known_peers` for future
  *direct* code-free reconnect still requires explicit pairing.

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

Resolved (see sections above): accept policy = **prompt-once-then-session-grant** (TTL ~12h,
revoked on manual disconnect); revoke/source-delete → **keep placeholder**; **multiple placements
allowed**; **no re-sharing** received objects; topology = **transitive group-call**; connectivity =
**STUN-only P2P v1, no TURN**, self-host rendezvous (PeerJS for prototyping).

Still open:
- **Transitive-member trust:** auto-connect-for-presence vs prompt, for peers pulled into a session
  who aren't saved contacts. (Lean: auto presence; pairing still required to save as a contact.)
- **Session-grant persistence:** in-memory only (re-prompt after restart) vs persist `expires_at`
  (survive restart within the ~12h window). (Lean: in-memory.)
- **TURN later:** if STUN-only failure rate proves high, add TURN (self-host coturn vs managed).

## Phase 6 — shared scenes (separate, gated)

Same UX shape (`share_kind = 'scene'`, "Share scene with"), but the whole scene is added to the
receiver's scene list, **persisted on both servers and editable by anyone** → full bidirectional
document sync + **authority-coordinated reconciliation on reconnect** (authority = scene owner/host;
apply-both with owner tiebreak; dirty-since markers + tombstones — see the main plan). This is the
hard distributed-systems work; build only after object-share is solid.

## Output

Phased PRs into `dev` (transport+pairing, then sharing+UX), one coherent unit each.
