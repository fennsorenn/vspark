# Plan: Multiplayer Phase 6 — owner-authoritative multi-writer

> Branch: `claude/preset-object-sync-wn2HT` · Status: **design — needs sign-off before coding**
> Builds on [permissioned-sync-mesh.md](permissioned-sync-mesh.md) and the
> shipped read/live-preview tier (object-share + `MeshRouter`). This adds the
> *write* tier: a remote client editing a shared Object, persisted by the owner.
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

## Out of scope (defer to a v2)

- **Structural edits** (create / delete of nodes inside a shared subtree) — they
  add id-allocation and subtree-membership-of-a-not-yet-existing-node questions.
  **v1 is `update` only** (transform / properties / material / model-swap of
  nodes already in the shared snapshot).
- Writes to **behaviours / camera-effects / compose-layers / clips** of a shared
  Object (v1 is `scene_node` documents only).
- **Optimistic local apply** on the writer (v1 takes the owner round-trip; the
  edit shows when the authoritative echo returns). Optimism + rollback is a v2.
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
   `scene_node` `upsert`. Owner `handleEnvelope`:
   `canAccess(from, 'scene_node:'+env.key, 'update', isDescendant)` → if denied,
   drop (optionally NACK); if allowed, `persistSceneNode(env.data)` →
   `sync.document.touch('scene_node', env.key)`. The **existing** `forwardDocOp`
   then echoes the authoritative DTO to *all* subscribers, originator included.
4. **Receiver edit routing.** On committing an edit to a `remote` node the peer
   can write, send `_share_write` instead of the local PUT. The change renders
   when the owner's `_share_update` echo arrives (round-trip; v1).
5. **Reconciliation.** Owner serialises writes (single-threaded) and stamps the
   echo with its HLC (`sync.document` already does). Two concurrent remote
   writers → owner applies in arrival order, last write wins per entity; all
   clients converge on the owner's echo. Client apply already drops stale by HLC
   in `registry.ts:24`; mirror that guard in `applySharedUpdate` so a late echo
   can't overwrite a newer one (**Decision 4**).
6. **Revocation.** `update` revoke reuses `revokeUnauthorized`/`revalidate`; a
   peer that loses write keeps read (or loses both) per the share toggle.

## Open decisions (need your call before coding)

1. **v1 scope** — `update` only (recommended), or include create/delete now?
2. **Round-trip vs optimistic** — v1 round-trip (recommended; simpler/correct) or
   optimistic-with-rollback immediately?
3. **Owner persist mechanism** — extract `persistSceneNode` shared with the REST
   route (recommended, least duplication), or a separate `persist` hook on
   `ResourceDescriptor`, or a standalone apply module?
4. **Conflict policy** — owner arrival-order + HLC-guarded client apply
   (recommended), or full per-field LWW merge on the owner?
5. **Write-share UX** — per-grantee read/can-edit toggle in the existing share
   submenu (recommended), or a separate "collaborators" surface?

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

Open a PR into `dev` when done (this is a new tier; consider a fresh
`feature/multiplayer-phase6` branch off `dev` rather than continuing this one).
