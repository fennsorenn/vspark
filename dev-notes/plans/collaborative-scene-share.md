# Plan: Collaborative scene sharing (peer-to-peer, persisted on both)

> Branch: `feature/multiplayer-phase6`. Status: **backend engine done + API-
> verified; frontend + reconnect-reconcile remaining.** Builds on the multiplayer
> object-share + Phase 6 write tier, but is a distinct model.

## Progress

- **Done + verified (API level, two connected backends):** migration 031
  (collab link + tombstones); `collabScene.ts` (mount-persist, two-way
  `forwardCollabOp`/`applyCollabOp` with echo guard + HLC LWW, `upsertCollabNode`
  that sets structure from the scene not a parent); `gatherSceneSnapshot`;
  manager wiring (`shareCollabScene`/`mountCollabScene` + offer→subscribe→snapshot
  handshake); REST `share-collab` + `collab/mount`. Verified: mount copies the
  whole scene to the receiver, and create/update/delete from **either** peer
  persist on **both**.
- **Remaining:** frontend (route the scene-row "Share with" to the collab share;
  show the `mp_collab_offer` + a Mount button; reload scenes on
  `mp_collab_mounted`; reflect live `applyCollabOp` edits in the editor — the
  receiver's apply emits `sync.document` but the editor still hydrates scene_nodes
  via REST, so it needs either a sync-layer consumer or a coarse "collab changed →
  refetch scene" event); **reconnect reconciliation** (re-snapshot + LWW merge,
  author-wins ties, tombstones); i18n + help. Replace the old read-only scene
  projection (`5128c6b`).

## Why this is different from object sharing

| | Object share (built) | Collaborative scene share (this) |
|---|---|---|
| Receiver storage | **ephemeral projection** (in-memory, dropped on disconnect) | **persisted** real `scene_node` rows in the receiver's own project |
| Authority | owner-authoritative (only owner persists; echoes to subscribers) | **peer-to-peer**, no owner; both persist + both edit |
| Conflict | owner arrival-order | **last-write-wins** (HLC per node) |
| On disconnect | projection vanishes | receiver **keeps** the scene; **sync resumes on reconnect** |

The current "Share with" on a scene row (commit `5128c6b`) wrongly reuses the
object path (read-only projection). **That behaviour must be replaced** by the
below; the share-menu UI itself can stay.

## Decisions (from the user)

- **Sync model:** peer-to-peer, **last-write-wins** (no single authority).
- **On unshare/disconnect:** receiver **keeps** its persisted copy; **sync is
  restored on reconnect** (re-reconcile, don't re-clone).

## Model

A collaborative scene lives as a **real scene in each peer's project**, sharing
one **id space** (the same `scene_node` UUIDs on both sides — UUID collisions
across servers are negligible, same assumption the projection already makes).
Each side persists locally; every structural edit is mirrored to the peer and
applied LWW. The scene's `root_scene_node_id` is the shared scene id; only
`project_id` differs per side (each peer's own project).

### 1. Share + mount
- Owner A: scene-row "Share with" → grants B **read+write** on `scene_node:<sceneId>`
  + subtree (Phase 6 grants already model this), tagged **collaborative** so the
  receiver mounts-persist instead of projecting. Advertised as `shareKind:'scene'`
  with a `collaborative:true` flag on the offer.
- Receiver B: on accept, fetch the snapshot (`gatherObjectSnapshot` already walks
  the whole scene subtree) and **INSERT** it as a new scene in B's active project:
  same node ids, `project_id` = B's, `root_scene_node_id` = the shared scene id.
  Mark the local scene as collaborative + remember the peer + shared scene id
  (new table `collab_scenes(scene_id, peer_id, project_id)` or a flag on `scenes`).

### 2. Bidirectional live sync
- Hook every `scene_node` doc op (create/update/delete) that belongs to a
  collaborative scene: persist locally (already happens via REST), then **forward
  the op to the peer** with an HLC stamp. Reuse `sync.onDocument` + a new
  collaborative forwarder (sibling of `forwardDocOp`, but two-way).
- On receiving a peer op: **LWW apply** — compare the op's HLC to the local node's
  last-applied version (`lastVersion` map / a `version` column); drop if older,
  else upsert/delete + persist + re-broadcast to own clients. **Tag applied-from-
  remote ops so they are NOT re-forwarded** (echo-loop guard).

### 3. Reconnect reconciliation
- On (re)connect to a collab peer, exchange per-scene state and converge LWW.
  Simplest first cut: each side re-sends a snapshot with per-node HLCs; the other
  applies LWW (newer wins, missing-on-one-side = create, deleted = tombstone).
  Tombstones (a `deleted_at`/version) are needed so a delete isn't resurrected by
  a stale create on reconnect — **design tombstones in from the start.**
- **Reconnect tiebreaker:** when the two sides diverged while disconnected and a
  node's versions can't be cleanly ordered (equal/concurrent HLC), the **original
  author — the peer that shared the scene — wins.** Live edits stay pure LWW; this
  only breaks ties during the reconnect merge.

### 4. Lifecycle
- Unshare/disconnect: stop forwarding; **keep** both scenes. The collab link
  (peer + scene id) persists so reconnect resumes sync.

## Files in scope (anticipated)
- `backend/src/multiplayer/collabScene.ts` (new) — mount-persist a snapshot,
  the two-way forwarder, LWW apply, reconnect reconcile, echo guard.
- `backend/src/multiplayer/sharing.ts` / `manager.ts` — `collaborative` flag on
  scene shares + advertise; route scene shares to `collabScene` not the projection.
- `backend/src/db/migrations/0xx_collab_scenes.sql` — collab-link table +
  per-node version/tombstone columns (HLC).
- `shared/src/sync.ts` — a collab op envelope (carries HLC + scene id).
- `frontend` — scene shares mount as a real selectable scene (not a 📡 container);
  the scene-row share menu offers "collaborative"; receiver UI to accept/mount.
- i18n + help.

## Open risks / to settle during build
- **Id space:** persisting a peer's node ids in your DB — confirm no FK/uniqueness
  clash with the receiver's existing nodes (UUIDs ⇒ fine) and that
  `root_scene_node_id` pointing at a non-local-origin scene id is OK everywhere.
- **Echo loops & ordering:** the applied-from-remote guard + HLC stale-drop must be
  airtight or edits ping-pong.
- **Tombstones:** required for delete-vs-stale-create on reconnect.
- **Assets:** same limitation as Phase 6 — asset *files* aren't transferred yet, so
  asset-backed nodes sync structurally but won't render the asset on the peer until
  blob transfer is wired. Note in help.

## Acceptance
- B mounts A's shared scene as a **persisted, editable** scene; both DBs hold it.
- An edit (move/create/delete) on **either** side persists on **both** and shows on
  both, LWW under concurrency.
- Disconnect → both keep the scene; reconnect → diverged edits reconcile (LWW,
  deletes stick via tombstones).
- Object sharing + the Phase 6 write tier are unchanged.
