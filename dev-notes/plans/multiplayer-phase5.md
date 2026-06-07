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

- **WebRTC direct (Shape B).** A small public **rendezvous** (outbound-only; only it needs a
  public address) handles **signaling + presence**; actual sync flows **peer-to-peer over WebRTC
  data channels**: pose on an *unreliable/unordered* channel (low latency, lossy-OK at 90 Hz),
  documents on a *reliable/ordered* channel. **STUN** hole-punch, **TURN** relay fallback (both
  outbound). Relay-broker mode (rendezvous relays everything) is the zero-WebRTC fallback.
- A `ServerMesh` transport implements the same port as today's `ClientHub`, carrying the same
  `SyncEnvelope`. No producer/consumer changes; pose uses the Phase 3 stream class.
- Node WebRTC: `werift` (pure TS) or `node-datachannel`. TURN: self-host `coturn` or managed.

## Identity, pairing & contacts (decided)

- **Peer id = a long-lived Ed25519 keypair** generated on first run; the pubkey/fingerprint is the
  stable id, equal to the envelope `origin` / HLC `n`. Survives IP changes.
- **`known_peers` table** (per-server SQLite) — the contacts list:
  `known_peers(peer_id PK, display_name, paired_at, last_seen, auto_accept, created_at)`.
- **Pair once (code):** A creates a session → short code/link → B enters it → rendezvous matches →
  mutual pubkey exchange → both rows written to `known_peers`.
- **Reconnect (no code):** servers announce **signed presence** to the rendezvous (sign a nonce
  with the private key); to connect, route by peer id → **mutual nonce/signature challenge against
  the stored pubkey** (the rendezvous only routes, can't impersonate) → `auto_accept` ? connect :
  prompt → WebRTC. Revoke = delete the contact. Prior art: Syncthing.

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
  **Connect**/Disconnect buttons; per-contact `auto_accept` toggle; remove (revoke).
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

- **`auto_accept` default** — auto-reconnect trusted contacts vs always prompt. (Lean: auto; scope
  limits exposure.)
- **On revoke / source-delete:** keep the wrapper as a "no longer shared" placeholder (user deletes)
  vs auto-remove it. (Lean: placeholder — avoids surprising layout changes.)
- **Multiple placements** of the same shared object (several wrappers → one source): allow vs single.
  (Lean: allow.)
- **Transitive re-share** (B re-shares A's avatar to C): disallow for v1 (only owners share their own).
- **Rendezvous + TURN:** self-host vs managed (Cloudflare Calls / metered.ca / Twilio for TURN).

## Phase 6 — shared scenes (separate, gated)

Same UX shape (`share_kind = 'scene'`, "Share scene with"), but the whole scene is added to the
receiver's scene list, **persisted on both servers and editable by anyone** → full bidirectional
document sync + **authority-coordinated reconciliation on reconnect** (authority = scene owner/host;
apply-both with owner tiebreak; dirty-since markers + tombstones — see the main plan). This is the
hard distributed-systems work; build only after object-share is solid.

## Output

Phased PRs into `dev` (transport+pairing, then sharing+UX), one coherent unit each.
