# Plan: Multiplayer Phase 6 — owner-authoritative multi-writer

> Branch: `feature/multiplayer-phase6`, **off `claude/preset-object-sync-wn2HT`**
> (not `dev` — `dev` doesn't have the multiplayer tier yet). · Status:
> **decided — implementing**
> Builds on [permissioned-sync-mesh.md](permissioned-sync-mesh.md) and the
> shipped read/live-preview tier (object-share + `MeshRouter`). This adds the
> *write* tier: a remote client editing a shared Object, persisted by the owner.
>
> **Decided:** v1 includes **create/delete** (full structural edits), edits are
> **optimistic with rollback**, and this lives on a branch off the multiplayer
> feature branch. (The recommendations below were overridden in favour of the
> fuller scope.)
>
> Naming: UI word is **Object**, code identifier stays `scene_node` (per
> [vocabulary-rename.md](vocabulary-rename.md)).

## Goal

Let a remote participant with an **update** grant edit a shared Object and have
the change **persist at the owner** and propagate to all subscribers — staying
**owner-authoritative** (the owner's SQLite is the single source of truth; no
peer writes another peer's DB). Today the receiver's projection is read-only and
ephemeral; this turns it into a live collaborative edit surface for granted
peers.

## Constraints (preserve)

- **Owner-authoritative.** Only the owning backend writes its own DB. A remote
  write is a *request*; the owner validates, applies, persists, then the existing
  `forwardDocOp` echo fans the authoritative result back to every subscriber
  (including the originator). No peer-to-peer DB writes.
- **Reuse the grant model as-is.** `Grant.rights` already has `update`/`create`/
  `delete` distinct from `read` (`shared/src/sync.ts:235,237`), the `grants`
  table already has `can_update/can_create/can_delete` (migration 030), and
  `canAccess(requester, key, need, isDescendant)` already evaluates them
  (`backend/src/sync/grants.ts:123`). **No schema migration needed.**
- **Don't disturb the read tier.** Read-only sharing, snapshot, pose/override/
  data-channel/clip fan-out, and the `MeshRouter` registry stay exactly as they
  are. This adds one inbound rtype + one owner-side persist path.
- **Reuse the transport + subscription registry.** The write request rides the
  same `MeshTransport` edge (direct WebRTC or server relay) and the same
  `_share_*` dispatch; authorization reuses `MeshRouter`/grant checks.
- Keep the core extractable (the owner-apply path should be a thin vspark adapter
  over a generic "validate → persist → emit" step).

## In scope (v1, decided)

- **`update` + `create` + `delete`** of `scene_node`s inside a shared subtree.
  Create/delete use writer-generated UUIDs (collision-free) and AuthZ via the
  `create`/`delete` rights; a create's parent must resolve into the shared
  subtree (owning-root check, same `findOwningRoot`/`isDescendant` the read tier
  uses).
- **Optimistic apply + rollback** on the writer: apply to the local projection
  immediately, reconcile/replace when the owner's authoritative echo arrives, and
  **roll back** if the owner rejects (no grant) or times out. Keep a small
  pending-write log keyed by the entity id + the writer's HLC so the echo can be
  matched and the optimistic state reverted to the last authoritative snapshot.

## Out of scope (defer to a later pass)

- Writes to **behaviours / camera-effects / compose-layers / clips** of a shared
  Object (v1 is `scene_node` documents only).
- Offline edit queue / multi-hop relay write routing.

## Files in scope

- `backend/src/sync/registry.ts` + `backend/src/sync/resources.ts` — add an
  optional `persist?(op, id, dto)` hook to `ResourceDescriptor`; implement it for
  `scene_node` by **extracting** the DB-write currently inlined in the PUT route
  (`routes/scene-nodes.ts:194–265`) into a shared `persistSceneNode(dto)` so the
  REST route and the remote-write handler share one code path. (Alternative: a
  standalone `applyAuthoritativeWrite` module — see Decision 3.)
- `backend/src/multiplayer/sharing.ts` — new `_share_write` rtype + a `case` in
  `handleEnvelope` (owner side): AuthZ via `canAccess(from, 'scene_node:<id>',
  'update', …)`, then persist + `sync.document.touch(...)` (which already drives
  `forwardDocOp` to echo subscribers). Add it to `SHARE_RTYPES`.
- `backend/src/multiplayer/shares.ts` — `addShare` gains a `rights` arg (default
  `{read:true}`); a write share sets `{read:true, update:true}`.
- `backend/src/multiplayer/manager.ts` — `share()` gains a write/read-write mode;
  `listSharesForPeer`/advertise payload carries a `canWrite` flag per offer.
- `frontend/src/sync/shareDirect.ts` (+ relay equivalent in `useWsSync`) — a
  `sendShareWrite(owner, env)` that emits `_share_write` to the owner; thread
  `canWrite` from offers into `connectionsStore`.
- `frontend` edit entry points — where a transform/property edit on a node fires
  the REST PUT (`Viewport` transform commit, properties panel), branch on
  `node.remote && canWrite(owner, objectId)` to route a `_share_write` to the
  owner **instead of** the local PUT; and stop gating the gizmo/inputs off for
  remote nodes when the peer has write.
- Share-with UI (`SceneGraph.tsx` share submenu) — per-grantee **read / can-edit**
  toggle.
- i18n + help: new "can edit" share control needs en/de keys + a help note
  (per repo CLAUDE.md cross-cutting rule).

## Approach

1. **Write grant + advertise.** Extend `addShare`/`share()` with a rights mode;
   write shares add `update`. Advertise (`listSharesForPeer` → offer) includes
   `canWrite` so the receiver knows which Objects it may edit. Receiver stores it
   in `connectionsStore`.
2. **Owner persist path.** Extract `persistSceneNode(dto)` from the PUT route;
   the route and the new handler both call it, then `sync.document.touch`. One
   authoritative write path, no behavioural change to local edits.
3. **`_share_write` (receiver → owner).** Carries `{ env }` where `env` is a
   `scene_node` `upsert` **or** `remove` (for create the writer mints the UUID;
   for remove it carries the `route` ancestor hint like the read tier). Owner
   `handleEnvelope`: `canAccess(from, 'scene_node:'+env.key, need, isDescendant)`
   with `need` = `create`/`update`/`delete` by op (a create also checks the
   parent resolves into a granted subtree) → denied ⇒ **NACK** (`_share_write_nak`
   carrying the rejected entity id so the writer rolls back); allowed ⇒
   `persistSceneNode(env)` (upsert or delete) → `sync.document.touch/remove`. The
   **existing** `forwardDocOp` then echoes the authoritative result to *all*
   subscribers, originator included.
4. **Receiver edit routing + optimism.** On a create/update/delete of a `remote`
   node the peer can write: (a) apply optimistically to the local projection;
   (b) record a pending write (entity id + writer HLC + pre-image for rollback);
   (c) send `_share_write` to the owner. The owner's `_share_update` echo (or a
   `remove`) **clears** the matching pending write and replaces the optimistic
   state with the authoritative DTO. A `_share_write_nak` (or timeout) **rolls
   back** to the pre-image.
5. **Reconciliation.** Owner serialises writes (single-threaded) and stamps the
   echo with its HLC (`sync.document` already does). Concurrent writers → owner
   applies in arrival order, last write wins per entity; clients converge on the
   echo. Mirror the `registry.ts:24` HLC stale-drop guard in `applySharedUpdate`
   so a late echo can't clobber a newer one, and so an owner echo always beats a
   peer's stale optimistic state.
6. **Revocation.** `update`/`create`/`delete` revoke reuses
   `revokeUnauthorized`/`revalidate`; a peer that loses write keeps read (or
   loses both) per the share toggle.

## Decided

- **Scope:** `update` + `create` + `delete` (writer-minted UUIDs).
- **Responsiveness:** optimistic apply + rollback (pending-write log).
- **Owner persist:** extract `persistSceneNode` shared with the REST route (one
  authoritative write path; least duplication).
- **Conflict:** owner arrival-order authority + HLC-guarded client apply.
- **Write-share UX:** per-grantee read / can-edit toggle in the existing share
  submenu.
- **Branch:** `feature/multiplayer-phase6` off `claude/preset-object-sync-wn2HT`.

## Acceptance / verification

- `pnpm lint` clean across packages.
- Headless: a granted peer's `_share_write` persists on the owner (DB row
  changes) + echoes to subscribers; an **ungranted** peer's `_share_write` is
  rejected (no DB change, no echo); revoke-update stops further writes.
- Manual (two backends + a browser, the established harness): B shares an Object
  to A **with edit**; A moves/recolours it; the change persists on B (survives B
  reload) and shows on every subscriber; A without edit cannot.
- Read-tier regression: unshared/read-only sharing, pose, overrides, clips
  unaffected.

## Output

Built on `feature/multiplayer-phase6` (off `claude/preset-object-sync-wn2HT`).
It merges back into the multiplayer feature branch, since it depends on the
unmerged multiplayer tier — not directly into `dev`.
