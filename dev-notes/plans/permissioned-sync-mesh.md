# Plan: Permissioned hierarchical sync over a full mesh

> Branch: `claude/preset-object-sync-wn2HT` · Status: design (converged)
> Refines/extends [unified-sync-layer.md](unified-sync-layer.md) and
> [live-mesh.md](live-mesh.md). This is the target architecture for the
> synced-state layer; it supersedes the "full flat mesh" wording in live-mesh.md
> and adds the grant + hierarchy model. Designed to be **extractable** as a
> standalone package later, so it separates a reusable core from vspark adapters.

> Naming: per [vocabulary-rename.md](vocabulary-rename.md), the UI word is
> **Object** but the code identifier stays **`scene_node`/`SceneNode`** (`Object`
> is a reserved global). This doc says "Object" for the concept and `scene_node`
> only for the literal rtype/type. "Entity" = the generic synced item (Object |
> Layer | clip | behaviour | …).

## Goal

A single synced-state layer that every participant (browser client **and**
backend server) speaks, so that: collaborative live editing works between local
*and* remote clients; object/scene sharing, live pose, and graph-driven state
all become "subscribe to a namespace, receive matching updates"; and persistence
stays owner-authoritative. Built so the core could be lifted out as a generic
"permissioned hierarchical document sync over a pluggable transport."

## 1. Topology — full mesh, per-edge transport

Every participant has a **logical edge to every other** and manages its own
subscriptions; a write goes directly to each subscriber that matches. Only the
**transport per edge** varies:

- **co-located server↔client** → the existing WebSocket (no WebRTC).
- **everything remote** (client↔remote-client, client↔remote-server,
  server↔server) → WebRTC.
- **relay over other hops** → only a fallback when a direct link can't be
  established (NAT). **Not planned yet** — assume direct links.

Above the wire sits a transport-agnostic `send(participantId, envelope)` that
resolves the id to its link (WS if local, WebRTC if remote). The
subscription/routing logic never sees the transport.

**Missing transport piece (new build):** full mesh including FrontA↔BackB means
backends must accept WebRTC from *remote browsers*, not just other backends.
Today werift peers backend↔backend (`ServerMesh`) and the client mesh is
browser↔browser only. Backends need to join as full WebRTC participants.

Participant id stays `${serverPeerId}#${tabUuid}` for clients, the Ed25519 peer
id for servers (also the HLC `origin`).

## 2. Trust — per-peer authority, connection-based

- **Grant authority is per-peer, not per-namespace.** A client trusts exactly
  one source for grants: **its own server**. It never reasons about who owns
  what. The server hands its clients a broad local grant set and folds in extra
  grants negotiated with remote servers on share.
- **Connection-based trust, no per-grant signing.** Server↔server links are
  already authenticated by pairing (Ed25519); a grant arriving over an
  authenticated link is trusted *by virtue of the connection*. Client↔own-server
  is the direct WS. Client↔remote WebRTC inherits authentication from the
  signaling relay **provided the relay vouches**: a server only relays signaling
  for *its own* clients and the `serverId#tab` prefix is assigned by that server,
  so a remote node can trust an incoming peer's claimed identity. Signing only
  buys something with untrusted multi-hop relay — deferred with relay itself.
- **The hard gate is source-side admission**, not client belief. Each server
  admits subscriptions/writes **to its own namespaces against its own grant
  table**; the client-side grant view is only an optimisation (knowing what to
  subscribe to / where it may write). A malicious peer can't grant real access to
  data it doesn't own, because the owner controls its own subscriber/writer lists
  and is the only one that broadcasts/persists its data.
- **Validate-on-receive everywhere.** Even from an authorised/own source, every
  inbound op is re-validated before mutating local state (a corrupt or buggy peer
  could send a malformed op; once extracted, the "authority" may be a different
  implementation). Failed checks → silently drop.

## 3. Grant model

A grant is two **orthogonal axes** × rights, matched independently, mapping
directly onto the sync key `rtype:id:subPath`:

- **Entity selection** = `rtype:id` + `includeDescendants`. "A node," "a node and
  its subtree," and "a scene" all collapse into *(entity, descendants?)* — a
  scene is just the Object whose subtree is the scene.
- **Path selection** = the `subPath` prefix — `''`/all, `position`, `position.x`.
- **Rights** = a subset of **RUCD**: `read`, `update`, `create`, `delete`.
  read/update use the path axis; **create/delete are structural** (entity +
  descendants, path-independent).

```
grants(
  id, grantee,                 -- peer id (server OR participant) or '*'
  entity_rtype, entity_id,     -- '*' allowed
  include_descendants  INTEGER,
  path_prefix          TEXT,   -- '' = all paths
  can_read, can_update, can_create, can_delete,
  created_at
)
```
This generalises the existing `shares` table (object_id → entity selector; add
the path axis + RUCD rights). The owning server self-issues itself full RUCD on
its own namespaces, so even its own edits run the same grant-checked path — no
`if (owner) bypass`. **Local clients aren't rows**: a local *editor* connection
gets broad `{R,U,C,D}` over local namespaces by role rule, a local *viewer* gets
`{R}`; only cross-server shares are persisted rows.

Grantee is usually a **server peer id** (covers all its clients via
`participantServer(id)`), or `'*'`, or a specific participant for finer control.

### Admission (the two table edges; hot path stays clean)
- **admit-on-subscribe:** `subscribe(peer, ns)` → `canRead` ? add to the live
  `subscribers` table : drop. (Generalises today's `isSharedWith`.)
- **discard-unauthorised-write:** inbound write to key K from peer P →
  `canAccess(P, K, need)` (need = update/create/delete) ? apply : drop.
- **evict-on-revoke:** grant/revoke re-evaluates the live subscriber table and
  drops/notifies entries that no longer pass; re-pushes effective grants.

`canAccess(requester, key, need)`: resolve `{rtype,id,subPath}`; for each grant
where `grantee ∈ {requester, participantServer(requester), '*'}`, check
`entityOk (rtype + id/'*'/descendant) && pathOk (keyMatches on subPath) &&
right`. Per-peer access is the **union** of matching grants.

Per-write fan-out never does a permission check — it's a path match over the
already-admitted subscriber table; `canAccess` runs only at the edges + on
inbound-write validation.

### Materialised effective table (kill the per-write walk)
Declarative grants are the source of truth; compile them into a flat
**`entityId → rights/paths` table** by expanding each subtree grant against the
current tree **once**, and **invalidate only the affected subtree** when the tree
mutates. Hot path = direct id lookup. (A node created under a granted subtree
inherits the grant in the materialised table — coupling create to expansion.)
High-frequency streams are keyed at the entity root, so their match is O(1) and
the descendants walk only touches low-frequency document/child ops.

### Client-side effective-grant view (advisory)
The owner pushes each client its `effectiveGrantsFor(peer)` set on connect + on
change (held in `connectionsStore`); the client uses it only to drive
subscriptions and gate edit affordances. Non-authoritative — re-checked at the
owner's edges, so a stale/tampered view grants nothing.

## 4. Hierarchy — a typed containment index (first-class)

Not a homogeneous tree — a **typed containment hierarchy**: every entity declares
a parent that may be a different type. **Subtree = transitive closure over the
parent relation, across types.** This unifies snapshots/grants (sharing an Object
covers its behaviours/effects/clips for free) and removes the per-type
special-casing `gatherObjectSnapshot` does today.

The sync layer **maintains the index** (incrementally, per op), exposing **both**:
- **id-addressing** — `byId(id)`, the primary access (don't traverse for normal
  reads/writes), and
- **tree view** — `childrenOf(id, type?)` / `roots(scope)` / `subtree(id)`,
  type-filterable so the SceneGraph renders the homogeneous Object tree while
  behaviours/clips are fetched by type.

Transport stays **per-entity by id** (a leaf change never reships a subtree); the
layer *owns the index*, it doesn't put trees on the wire. Justified because we
already need this exact index for grant subtree resolution + the materialised
table.

### Ordering — string fractional index
Sibling order is a **string fractional key** (lexicographic, unbounded inserts):
sort = plain string compare (keep the alphabet ASCII so JS `<` and SQLite
`BINARY` agree); insert = `generateKeyBetween(a,b)` (~30 lines, inlined — **no
dependency**). Total order under concurrency = `(orderKey, originId)`; the
`originId` tiebreak only fires when two peers insert at the same gap and generate
an identical key. Beats floats (no precision wall / renormalisation). Order is
per sibling-set, scoped to `(parent[, childType])`.

### Structural integrity gate (validate-on-receive)
Schema validation is a **core gate next to AuthZ**, because an authorised peer
can still send a structurally invalid op (e.g. an Object whose parent is a
behaviour) and a naive consumer would orphan/corrupt its tree. Every inbound
structural op runs: **grant-check (AuthZ) → schema-check → apply/persist**, where
schema-check =
1. **parent type allowed** — each rtype declares `allowedParentTypes`
   (`scene_node` → `{scene_node, root}`, `behaviour` → `{scene_node}`, `lane` →
   `{track_clip}`, …); reject otherwise. (Nips the corrupt-parent case.)
2. **parent exists**, and
3. **no cycle**.
Failed → drop (same disposition as an unauthorised write). Kept **declarative**
(an `allowedParentTypes` set per rtype in the provider) — not a rules engine.

### Lifecycle ops map onto envelope ops + a right each
- **create** = `upsert` of a new id → needs `create` on the target parent/subtree
- **delete** = `remove`/tombstone → needs `delete`
- **update** = `upsert`/`patch` of fields → needs `update` (gated by path)
- **reparent** = `update` of `parentId` (+order) → needs `update` on the node
  **and** `create` on the new parent
Delete-vs-update races use the HLC tombstone model already in place.

## 5. Reusable core vs vspark adapters

**General core (the extractable "permissioned hierarchical document sync"):**
- envelope + `rtype:id:subPath` addressing; document/field/stream classes; HLC
  ordering + tombstones
- the grant model (`entity × path × RUCD`, per-peer authority, union, materialised
  effective table, admit/discard/evict)
- the typed containment index (id-primary + tree view, string-fractional order,
  subtree closure) + the structural integrity gate
- the per-edge transport abstraction (`send(participant, envelope)`) +
  subscription routing

**vspark adapters (injected, not in the core):**
- a **hierarchy provider** declaring per rtype `{ parentRtype, allowedParentTypes,
  parentField, orderField, scope }` and the topology source (the `scene_node`
  `parent_id` tree, the compose tree, clip→lane→event)
- the concrete entity catalogue + leaf/stream payload shapes (VRM, pose)
- the transport (WebRTC/werift + WS) and the identity/connection-trust adapter
  (pairing/rendezvous)

Keep a **single designated parent relationship** per rtype (a tree, not a graph);
other cross-references stay plain id fields, so the core never commits to
arbitrary graphs.

## 6. Tiers / phasing

- **Read / live-preview tier (first):** read-grant-gated pub/sub over the live
  classes — see other clients' edits, pose, previews, overrides, data channels,
  local *and* remote. No persistence on receivers; lossy is fine. This is the
  `(c)` slice; most of its plumbing (subscriber model, forwarding, projection)
  already exists from object-share and just needs generalising to namespaces.
- **Persisted multi-writer tier (Phase 6):** a remote client's edit persists at
  the owner. = write-grant AuthZ **+** owner-authoritative persistence +
  HLC/last-writer-wins reconciliation (apply locally, broadcast, owner validates
  + persists + re-broadcasts canonical on reject). The "scene editable by all"
  mode lives here.

## How it relates to what's built

This generalises the shipped object-share: `shares` table → `grants`;
`SharingManager.subscribers` → the live admitted-subscription table;
`isSharedWith` → `canAccess`; `gatherObjectSnapshot`'s hand-collected
nodes+behaviours+effects → the typed subtree closure; `findOwningRoot` → the
maintained containment index. The per-object `_share_*` protocol becomes the
namespace-subscription special case (subscribe to `scene_node:<root>` + subtree).

## Open / non-goals
- Multi-hop relay + per-grant signing — deferred (assume direct authenticated
  links).
- Interest/role edge-pruning for large audiences — full mesh now; the
  `shouldConnect` seam tightens it later.
- Persisted-write reconciliation specifics (CRDT vs LWW per field) — settle in
  Phase 6; HLC LWW is the default.

## Output
Captured for design alignment. Build order is the read/preview tier first
(generalise namespaces + grants over the existing mesh), with the backend↔remote-
client WebRTC edge and persisted-write tier as subsequent slices.

### Progress

- **Backend↔remote-browser WebRTC edge — IMPLEMENTED** (transport/connectivity
  only). `BrowserPeerMesh` (`packages/backend/src/multiplayer/browserMesh.ts`) is
  an answer-only werift answerer speaking the client mesh's single-`mesh`-channel
  protocol; `SharingManager` is now transport-agnostic via a `MeshTransport`
  facade (browsers over `BrowserPeerMesh`, servers over `ServerMesh`); the
  frontend `clientMesh.setRoster` dials remote backends. The signaling relay
  gained backend-as-endpoint support. See [../modules/multiplayer.md](../modules/multiplayer.md).
- **Still to do:** migrate object-share *delivery* (snapshot + live updates) onto
  this direct edge, plus frontend consumption of `_share_*` envelopes arriving
  over the direct WebRTC channel.
- **Open blocker — asset transport to a remote browser.** Today assets localize
  at the receiver's backend (content-addressed via `BlobManager` into a
  shared/HTTP `uploads/_shared/` dir served by `/uploads`). Over a direct browser
  edge there is no receiver backend in the path, so either blobs stream over the
  data channel into browser-side object URLs, or the snapshot/asset path stays on
  the server-relay while only live data uses the edge. Undecided.
