/**
 * Collaborative scene sharing (multiplayer): peer-to-peer, last-write-wins,
 * persisted on BOTH peers — unlike the read-only ephemeral object projection.
 *
 * A shared scene is mounted as a *real* scene (kind `scene` scene_node + its
 * subtree) in the receiver's own project, keeping the author's node ids so the
 * two copies share one id space and edits map straight across. Both sides edit;
 * every structural edit is mirrored to the peer and applied LWW. The receiver
 * keeps its copy on disconnect and re-reconciles on reconnect (author wins ties).
 *
 * This module owns the collab-link bookkeeping + mount-persist. The live two-way
 * forward/apply and reconnect reconciliation build on top (see the plan).
 * See dev-notes/plans/collaborative-scene-share.md.
 */
import { randomUUID } from 'crypto';
import { basename } from 'path';
import { getDb } from '../db/index.js';
import { sync } from '../sync/index.js';
import { compareHLC, type HLC, type SyncEnvelope } from '@vspark/shared/sync';
import {
  gatherSceneSnapshot,
  type ObjectSnapshot,
  type SnapshotAsset,
} from './shares.js';
import { assetForPath, type AssetMeta } from './blobs.js';
import { applySceneNodeRemove, type SceneNodeDto } from './sceneNodeWrite.js';

/** Lossy stream frame (pose / blendshapes / IK / drag preview) for a collab node.
 *  Rides the mesh stream channel, not the doc channel. */
export const COLLAB_STREAM_RTYPE = '_collab_stream';

/** Control rtypes for collaborative scene sharing (over the mesh doc channel). */
export const COLLAB_OP_RTYPE = '_collab_op'; // one scene_node edit, peer→peer
export const COLLAB_RECONCILE_RTYPE = '_collab_reconcile'; // full state, on reconnect
export const COLLAB_PLAYBACK_RTYPE = '_collab_playback'; // clip play/pause/seek control

export type ClipPlaybackAction = 'trigger' | 'stop' | 'pause' | 'resume' | 'seek';
export const COLLAB_OFFER_RTYPE = '_collab_offer'; // owner→grantee: "mount this scene?"
export const COLLAB_SUBSCRIBE_RTYPE = '_collab_subscribe'; // grantee→owner: "send it"
export const COLLAB_SNAPSHOT_RTYPE = '_collab_snapshot'; // owner→grantee: the scene
export const COLLAB_RTYPES = new Set<string>([
  COLLAB_OP_RTYPE,
  COLLAB_OFFER_RTYPE,
  COLLAB_SUBSCRIBE_RTYPE,
  COLLAB_SNAPSHOT_RTYPE,
]);

export type CollabRole = 'author' | 'mounted';

export interface CollabLink {
  sceneId: string;
  peerId: string;
  role: CollabRole;
  projectId: string;
}

/** Record (or refresh) a collab link: this scene is collaboratively shared with
 *  `peer`. `role` is 'author' for the sharer, 'mounted' for the receiver. */
export function registerCollabScene(
  sceneId: string,
  peerId: string,
  role: CollabRole,
  projectId: string
): void {
  getDb()
    .prepare(
      `INSERT INTO collab_scenes (scene_id, peer_id, role, project_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scene_id, peer_id)
       DO UPDATE SET role = excluded.role, project_id = excluded.project_id`
    )
    .run(sceneId, peerId, role, projectId);
}

export function removeCollabScene(sceneId: string, peerId: string): void {
  getDb()
    .prepare('DELETE FROM collab_scenes WHERE scene_id = ? AND peer_id = ?')
    .run(sceneId, peerId);
}

/** Whether a scene id participates in any collaboration (drives whether a local
 *  edit must be mirrored to peers). */
export function isCollabScene(sceneId: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM collab_scenes WHERE scene_id = ? LIMIT 1')
    .get(sceneId);
}

/** Peers we collaborate with on a given scene (the live-edit fan-out targets). */
export function collabPeersForScene(sceneId: string): CollabLink[] {
  return (
    getDb()
      .prepare(
        'SELECT scene_id, peer_id, role, project_id FROM collab_scenes WHERE scene_id = ?'
      )
      .all(sceneId) as {
      scene_id: string;
      peer_id: string;
      role: CollabRole;
      project_id: string;
    }[]
  ).map((r) => ({
    sceneId: r.scene_id,
    peerId: r.peer_id,
    role: r.role,
    projectId: r.project_id,
  }));
}

/** All collab scenes linked to a peer (for reconnect reconciliation). */
export function collabScenesForPeer(peerId: string): CollabLink[] {
  return (
    getDb()
      .prepare(
        'SELECT scene_id, peer_id, role, project_id FROM collab_scenes WHERE peer_id = ?'
      )
      .all(peerId) as {
      scene_id: string;
      peer_id: string;
      role: CollabRole;
      project_id: string;
    }[]
  ).map((r) => ({
    sceneId: r.scene_id,
    peerId: r.peer_id,
    role: r.role,
    projectId: r.project_id,
  }));
}

interface SnapshotNode {
  id: string;
  parentId: string | null;
  boneAttachment: string | null;
  name: string;
  kind: string;
  filePath: string | null;
  components: Record<string, unknown>;
  properties: Record<string, unknown>;
  hidden?: boolean;
}

/** Localize a collab scene's assets before mounting: fetch each blob from the
 *  owner (so the file lands on disk), record it as a managed `asset_files` row in
 *  the mount-target project, and rewrite the snapshot nodes' file paths to the
 *  local copy — so the mounted scene both PERSISTS (backend) and RENDERS
 *  (frontend). `ensure` fetches a blob and returns its `/uploads/_shared/…` URL.
 *  An asset that fails to transfer keeps the owner path (renders only if present),
 *  so a missing asset never blocks the rest of the mount. */
/** Record a fetched collab asset as a managed `asset_files` row in `projectId`
 *  (idempotent by project + hash). `url` is the local `/uploads/_shared/…` URL —
 *  kept with its leading slash so it matches normal asset stored_paths and the
 *  node's rewritten file_path (== the served URL). */
function recordCollabAsset(
  projectId: string,
  url: string,
  hash: string,
  mime: string,
  size: number,
  originalName: string
): void {
  const db = getDb();
  if (
    db
      .prepare('SELECT 1 FROM asset_files WHERE project_id = ? AND hash = ? LIMIT 1')
      .get(projectId, hash)
  )
    return;
  db.prepare(
    `INSERT INTO asset_files
       (id, project_id, original_name, stored_path, mime_type, size, hash, is_deduplicated)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(randomUUID(), projectId, originalName, url, mime, size, hash);
}

export async function persistCollabAssets(
  snapshot: ObjectSnapshot,
  projectId: string,
  ensure: (a: SnapshotAsset) => Promise<string>
): Promise<void> {
  const assets = snapshot.assets ?? [];
  if (assets.length === 0) return;
  const localByAuthorPath = new Map<string, string>();
  await Promise.all(
    assets.map(async (a) => {
      try {
        const url = await ensure(a); // /uploads/_shared/<hash><ext>; file on disk
        recordCollabAsset(projectId, url, a.hash, a.mime, a.size, basename(a.filePath));
        localByAuthorPath.set(a.filePath, url);
      } catch {
        /* asset unavailable on the owner — keep the author path */
      }
    })
  );
  for (const n of snapshot.nodes as { filePath?: string }[])
    if (n.filePath && localByAuthorPath.has(n.filePath))
      n.filePath = localByAuthorPath.get(n.filePath);
}

/** Mount a received scene snapshot as a real, persisted scene in `projectId`,
 *  preserving the author's node ids (shared id space) and the scene id as the
 *  `root_scene_node_id`. Idempotent: an existing node is upserted, so a re-mount
 *  (resubscribe) refreshes rather than duplicates. Records the 'mounted' link.
 *  Nodes arrive BFS-ordered (root first) so parent rows exist before children. */
export function mountSharedScene(
  snapshot: ObjectSnapshot,
  projectId: string,
  peerId: string
): void {
  const db = getDb();
  const sceneId = snapshot.objectId; // the scene root node id
  const SQL = `INSERT INTO scene_nodes
       (id, project_id, root_scene_node_id, parent_id, bone_attachment,
        name, kind, file_path, components, properties, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, file_path = excluded.file_path,
       components = excluded.components, properties = excluded.properties,
       hidden = excluded.hidden, updated_at = datetime('now')`;
  // Nodes are BFS-ordered (root first) so parent rows exist before children.
  // Prepare per row — the wasm driver finalizes a statement after run().
  for (const n of snapshot.nodes as unknown as SnapshotNode[]) {
    db.prepare(SQL).run(
      n.id,
      projectId,
      sceneId,
      n.parentId,
      n.boneAttachment ?? null,
      n.name,
      n.kind,
      n.filePath ?? null,
      JSON.stringify(n.components ?? {}),
      JSON.stringify(n.properties ?? {}),
      n.hidden ? 1 : 0
    );
  }
  applyCollabClips(sceneId, (snapshot.clips ?? []) as unknown as ClipDto[]);
  registerCollabScene(sceneId, peerId, 'mounted', projectId);
}

// --- live two-way sync ------------------------------------------------------
//
// Both peers persist + edit; every local scene_node op in a collab scene is
// mirrored to the peer and applied last-write-wins. Two guards keep it sane:
//   - `applyingFromPeer`: an op being applied from a peer must NOT be forwarded
//     back (sceneNodeWrite re-emits it through sync.onDocument) — else it echoes.
//   - `lastVersion`: per-node HLC; a peer op older-or-equal is dropped (LWW).
const lastVersion = new Map<string, HLC>();
const applyingFromPeer = new Set<string>();
/** nodeId → sceneId, so a `remove` (whose row is already gone) still resolves
 *  its scene for fan-out. Filled on mount + every upsert. */
const nodeScene = new Map<string, string>();

/** Resolve the collab scene a node belongs to (its `root_scene_node_id`), via
 *  the cache first (works after the row is deleted), then the DB. */
function sceneOf(nodeId: string): string | undefined {
  const cached = nodeScene.get(nodeId);
  if (cached) return cached;
  const row = getDb()
    .prepare('SELECT root_scene_node_id FROM scene_nodes WHERE id = ?')
    .get(nodeId) as { root_scene_node_id: string } | undefined;
  return row?.root_scene_node_id;
}

/** Seed the node→scene map for an already-mounted/known scene so removes resolve. */
export function indexCollabScene(sceneId: string): void {
  const rows = getDb()
    .prepare('SELECT id FROM scene_nodes WHERE root_scene_node_id = ?')
    .all(sceneId) as { id: string }[];
  for (const r of rows) nodeScene.set(r.id, sceneId);
  indexCollabSceneClips(sceneId);
}

/** Re-seed the node→scene map for every persisted collab scene. Called on boot so
 *  the in-memory index survives a restart (the links persist, the map doesn't). */
export function indexAllCollabScenes(): void {
  const scenes = getDb()
    .prepare('SELECT DISTINCT scene_id FROM collab_scenes')
    .all() as { scene_id: string }[];
  for (const s of scenes) indexCollabScene(s.scene_id);
}

// --- reconnect reconciliation helpers ---------------------------------------
//
// Versions are derived from scene_nodes.updated_at (already bumped on every
// write) rather than a separate HLC column — coarse (second granularity) but
// persistent across disconnect/restart, which the in-memory live HLC isn't.
// Deletes are recorded as collab_tombstones so a stale create can't resurrect
// them. The original author (collab role 'author') wins exact-time ties.

/** Parse a SQLite `datetime('now')` string (UTC) to epoch ms. */
function sqlTimeMs(s: string): number {
  const ms = Date.parse(s.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? 0 : ms;
}

/** Record (or refresh) a tombstone for a removed collab node. */
function recordTombstone(sceneId: string, nodeId: string, versionMs: number): void {
  getDb()
    .prepare(
      `INSERT INTO collab_tombstones (scene_id, node_id, version)
       VALUES (?, ?, ?)
       ON CONFLICT(scene_id, node_id)
       DO UPDATE SET version = excluded.version, deleted_at = datetime('now')`
    )
    .run(sceneId, nodeId, String(versionMs));
}

function clearTombstone(sceneId: string, nodeId: string): void {
  getDb()
    .prepare('DELETE FROM collab_tombstones WHERE scene_id = ? AND node_id = ?')
    .run(sceneId, nodeId);
}

/** Forward a lossy stream frame (pose / blendshapes / IK / drag preview) for a
 *  collab-scene node to every collab peer, so the mounted copy animates live.
 *  HOT PATH (per pose frame, per avatar): resolves the scene from the in-memory
 *  index only — a node not in the index isn't collaborative, so this returns in
 *  O(1) without touching the DB for the common (non-shared) avatar. */
export function forwardCollabStream(
  kind: string,
  nodeId: string,
  payload: Record<string, unknown>,
  send: (peerId: string, frame: Record<string, unknown>) => void
): void {
  const sceneId = nodeScene.get(nodeId);
  if (!sceneId) return;
  for (const link of collabPeersForScene(sceneId))
    send(link.peerId, { rtype: COLLAB_STREAM_RTYPE, kind, nodeId, payload });
}

// --- timeline clips ---------------------------------------------------------
//
// Clips (and their keyframes/lanes/events) sync as DATA like behaviours/logic,
// not as the resulting transform params — each peer evaluates the synced clip
// locally. A clip is owned by a scene_node (owner_node_id); its scene is that
// node's root_scene_node_id. clipScene caches that so a `remove` resolves after
// the row is gone. Layer-owned clips (compose scenes) aren't collab-synced yet.

/** nodeId-keyed map mirror for clips: clipId → sceneId. */
const clipScene = new Map<string, string>();

interface ClipKeyframeDto {
  id: string;
  t: number;
  value: number;
  easing: string;
  inHandleTFraction: number;
  inHandleVFraction: number;
  outHandleTFraction: number;
  outHandleVFraction: number;
}
interface ClipLaneDto {
  id: string;
  targetKind: string;
  targetId: string;
  paramPath: string;
  defaultValue: number;
  keyframes: ClipKeyframeDto[];
}
interface ClipEventDto {
  id: string;
  t: number;
  action: string;
  targetKind: string;
  targetId: string;
  payload: Record<string, unknown> | null;
}
interface ClipDto {
  id: string;
  ownerNodeId: string | null;
  ownerLayerId: string | null;
  name: string;
  duration: number;
  loop: boolean;
  mode: string;
  autoplay: boolean;
  lanes: ClipLaneDto[];
  events: ClipEventDto[];
}

/** Resolve a clip's collab scene (its owner node's root scene), cache-first. */
function resolveClipScene(clipId: string): string | undefined {
  const cached = clipScene.get(clipId);
  if (cached) return cached;
  const clip = getDb()
    .prepare('SELECT owner_node_id FROM track_clips WHERE id = ?')
    .get(clipId) as { owner_node_id: string | null } | undefined;
  if (!clip?.owner_node_id) return undefined; // layer-owned clips: not synced yet
  const node = getDb()
    .prepare('SELECT root_scene_node_id FROM scene_nodes WHERE id = ?')
    .get(clip.owner_node_id) as { root_scene_node_id: string } | undefined;
  return node?.root_scene_node_id;
}

/** Seed clipScene for every clip owned by a scene's nodes (mount/index/boot). */
function indexCollabSceneClips(sceneId: string): void {
  const rows = getDb()
    .prepare(
      `SELECT c.id FROM track_clips c
       JOIN scene_nodes n ON n.id = c.owner_node_id
       WHERE n.root_scene_node_id = ?`
    )
    .all(sceneId) as { id: string }[];
  for (const r of rows) clipScene.set(r.id, sceneId);
}

/** Write a full clip from its DTO (delete + reinsert clip/lanes/keyframes/events;
 *  cascade clears the children). started_at is dropped — playback anchors are
 *  peer-local (synced separately) — and the re-emit updates our own clients. */
function applyClipDto(dto: ClipDto): void {
  const db = getDb();
  db.prepare('DELETE FROM track_clips WHERE id = ?').run(dto.id);
  db.prepare(
    `INSERT INTO track_clips
       (id, owner_node_id, owner_layer_id, name, duration, loop, mode, autoplay, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    dto.id,
    dto.ownerNodeId ?? null,
    dto.ownerLayerId ?? null,
    dto.name,
    dto.duration,
    dto.loop ? 1 : 0,
    dto.mode,
    dto.autoplay ? 1 : 0
  );
  for (const lane of dto.lanes ?? []) {
    db.prepare(
      `INSERT INTO track_clip_lanes (id, clip_id, target_kind, target_id, param_path, default_value)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(lane.id, dto.id, lane.targetKind, lane.targetId, lane.paramPath, lane.defaultValue);
    for (const kf of lane.keyframes ?? [])
      db.prepare(
        `INSERT INTO track_clip_keyframes
           (id, lane_id, t, value, easing, in_handle_t_fraction, in_handle_v_fraction,
            out_handle_t_fraction, out_handle_v_fraction)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        kf.id, lane.id, kf.t, kf.value, kf.easing,
        kf.inHandleTFraction, kf.inHandleVFraction,
        kf.outHandleTFraction, kf.outHandleVFraction
      );
  }
  for (const ev of dto.events ?? [])
    db.prepare(
      `INSERT INTO track_clip_events (id, clip_id, t, action, target_kind, target_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ev.id, dto.id, ev.t, ev.action, ev.targetKind, ev.targetId,
      ev.payload ? JSON.stringify(ev.payload) : null
    );
  sync.document.upsert('track_clip', dto.id);
}

function deleteClip(clipId: string): void {
  getDb().prepare('DELETE FROM track_clips WHERE id = ?').run(clipId);
  sync.document.remove('track_clip', clipId);
}

/** Write a collab scene's clips at mount/reconcile time, indexing them. */
export function applyCollabClips(sceneId: string, clips: ClipDto[]): void {
  for (const c of clips) {
    applyClipDto(c);
    clipScene.set(c.id, sceneId);
  }
}

/** Mirror a local clip playback control (play/pause/seek) to every collab peer
 *  of the clip's scene, so playback stays in step. Each peer anchors locally on
 *  receipt (no clock sync needed); seek carries the playhead. */
export function forwardClipPlayback(
  clipId: string,
  action: ClipPlaybackAction,
  t: number | undefined,
  send: (peerId: string, env: SyncEnvelope) => void
): void {
  const sceneId = resolveClipScene(clipId);
  if (!sceneId || !isCollabScene(sceneId)) return;
  for (const link of collabPeersForScene(sceneId))
    send(link.peerId, {
      rtype: COLLAB_PLAYBACK_RTYPE,
      op: 'event',
      key: clipId,
      data: { clipId, action, t },
    });
}

/** Mirror a local track_clip op to every collab peer of the clip's scene. */
function forwardCollabClipOp(
  env: SyncEnvelope,
  send: (peerId: string, env: SyncEnvelope) => void
): void {
  if (applyingFromPeer.has(env.key)) return;
  let sceneId: string | undefined;
  if (env.op === 'remove') {
    sceneId = clipScene.get(env.key);
    clipScene.delete(env.key);
  } else {
    sceneId = resolveClipScene(env.key);
    if (sceneId) clipScene.set(env.key, sceneId);
  }
  if (!sceneId || !isCollabScene(sceneId)) return;
  for (const link of collabPeersForScene(sceneId))
    send(link.peerId, {
      rtype: COLLAB_OP_RTYPE,
      op: 'event',
      key: sceneId,
      data: { sceneId, env },
    });
}

/** A local scene_node op fired — mirror it to every collab peer of its scene.
 *  No-op for non-collab scenes or ops we're mid-applying from a peer (echo). */
export function forwardCollabOp(
  env: SyncEnvelope,
  send: (peerId: string, env: SyncEnvelope) => void
): void {
  if (env.rtype === 'track_clip') return forwardCollabClipOp(env, send);
  if (env.rtype !== 'scene_node') return;
  if (applyingFromPeer.has(env.key)) return; // don't echo a peer's op back
  let sceneId: string | undefined;
  if (env.op === 'remove') {
    sceneId = nodeScene.get(env.key);
    nodeScene.delete(env.key);
    if (sceneId)
      recordTombstone(sceneId, env.key, env.v ? env.v.t : Date.now());
  } else {
    sceneId = sceneOf(env.key);
    if (sceneId) nodeScene.set(env.key, sceneId);
  }
  if (!sceneId || !isCollabScene(sceneId)) return;
  if (env.v) lastVersion.set(env.key, env.v);
  // If the op carries a file_path with a known asset, ride its metadata along so
  // the peer can fetch + localize it (model swaps, or just re-localizing an
  // avatar edit to the peer's own copy).
  const filePath =
    env.op === 'upsert'
      ? (env.data as { filePath?: string } | undefined)?.filePath
      : undefined;
  const asset = filePath ? assetForPath(filePath) : null;
  for (const link of collabPeersForScene(sceneId))
    send(link.peerId, {
      rtype: COLLAB_OP_RTYPE,
      op: 'event',
      key: sceneId,
      data: { sceneId, env, asset: asset ?? undefined },
    });
}

/** Apply a peer's collab scene_node op to our own persisted copy, last-write-wins.
 *  Reuses the Phase-6 node-write primitives; structure stays owner-local (create
 *  derives project/root from the local parent). Guarded so the re-emit isn't
 *  forwarded back. Returns true if applied. */
export function applyCollabOp(
  sceneId: string,
  env: SyncEnvelope,
  forceFilePath = false
): boolean {
  if (!isCollabScene(sceneId)) return false;
  if (env.rtype === 'track_clip') {
    applyingFromPeer.add(env.key);
    try {
      if (env.op === 'remove') {
        deleteClip(env.key);
        clipScene.delete(env.key);
      } else if (env.op === 'upsert' && env.data) {
        applyClipDto(env.data as ClipDto);
        clipScene.set(env.key, sceneId);
      }
      return true;
    } finally {
      applyingFromPeer.delete(env.key);
    }
  }
  if (env.rtype !== 'scene_node') return false;
  if (env.v) {
    const prev = lastVersion.get(env.key);
    if (prev && compareHLC(env.v, prev) <= 0) return false; // stale (LWW)
    lastVersion.set(env.key, env.v);
  }
  applyingFromPeer.add(env.key);
  try {
    if (env.op === 'remove') {
      applySceneNodeRemove(env.key, undefined, env.route);
      nodeScene.delete(env.key);
      recordTombstone(sceneId, env.key, env.v ? env.v.t : Date.now());
    } else if (env.op === 'upsert' && env.data) {
      nodeScene.set(env.key, sceneId);
      upsertCollabNode(sceneId, env.data as SceneNodeDto, forceFilePath);
    }
    return true;
  } finally {
    applyingFromPeer.delete(env.key);
  }
}

/** Apply a collab op that carries asset metadata (a node with a model/texture):
 *  fetch + persist the asset locally (cached if we already have it), rewrite the
 *  op's file_path to our own copy, then apply forcing the file_path update — so a
 *  mid-session model swap propagates and every avatar edit re-localizes to a path
 *  we can actually serve. A transfer failure falls back to a plain apply (which
 *  preserves our existing local path). */
export async function applyCollabAssetOp(
  sceneId: string,
  env: SyncEnvelope,
  asset: AssetMeta,
  ensure: (a: AssetMeta) => Promise<string>
): Promise<void> {
  const dto = env.data as SceneNodeDto | undefined;
  if (dto) {
    try {
      const url = await ensure(asset); // /uploads/_shared/<hash><ext>
      const link = getDb()
        .prepare('SELECT project_id FROM collab_scenes WHERE scene_id = ? LIMIT 1')
        .get(sceneId) as { project_id: string } | undefined;
      if (link)
        recordCollabAsset(
          link.project_id,
          url,
          asset.hash,
          asset.mime,
          asset.size,
          basename(dto.filePath ?? `${asset.hash}${asset.ext}`)
        );
      dto.filePath = url; // localize to our copy
      applyCollabOp(sceneId, env, true);
      return;
    } catch {
      /* transfer failed — fall through to a plain apply (keeps local path) */
    }
  }
  applyCollabOp(sceneId, env);
}

export interface ReconcilePayload {
  sceneId: string;
  snapshot: ObjectSnapshot;
  /** nodeId → updated_at epoch ms (the per-node version for LWW). */
  versions: Record<string, number>;
  tombstones: Array<{ nodeId: string; version: number }>;
}

/** Gather this server's full state for a collab scene to (re)send on connect:
 *  every node + its version, plus tombstones for deleted nodes. */
export function gatherReconcile(sceneId: string): ReconcilePayload | null {
  const snapshot = gatherSceneSnapshot(sceneId);
  if (!snapshot) return null;
  const db = getDb();
  const rows = db
    .prepare('SELECT id, updated_at FROM scene_nodes WHERE root_scene_node_id = ?')
    .all(sceneId) as { id: string; updated_at: string }[];
  const versions: Record<string, number> = {};
  for (const r of rows) versions[r.id] = sqlTimeMs(r.updated_at);
  const tombs = db
    .prepare('SELECT node_id, version FROM collab_tombstones WHERE scene_id = ?')
    .all(sceneId) as { node_id: string; version: string }[];
  return {
    sceneId,
    snapshot,
    versions,
    tombstones: tombs.map((t) => ({ nodeId: t.node_id, version: Number(t.version) })),
  };
}

/** Merge a peer's reconcile state into ours after a (re)connect, last-write-wins
 *  by node version (updated_at ms); the original author wins exact-time ties.
 *  Tombstones delete a node we still hold (unless our copy is newer), and block a
 *  stale create from resurrecting it. Assets are localized like a mount. Returns
 *  true if anything changed (so the caller can refresh the editor). */
export async function applyReconcile(
  from: string,
  payload: ReconcilePayload,
  ensure: (a: SnapshotAsset) => Promise<string>
): Promise<boolean> {
  const { sceneId, snapshot, versions, tombstones } = payload;
  const link = collabPeersForScene(sceneId).find((l) => l.peerId === from);
  if (!link) return false; // we don't collaborate on this scene with this peer
  const iAmAuthor = link.role === 'author'; // author wins exact-time ties
  const db = getDb();
  await persistCollabAssets(snapshot, link.projectId, ensure);
  let changed = false;
  const localVer = (id: string): number => {
    const r = db
      .prepare(
        'SELECT updated_at FROM scene_nodes WHERE id = ? AND root_scene_node_id = ?'
      )
      .get(id, sceneId) as { updated_at: string } | undefined;
    return r ? sqlTimeMs(r.updated_at) : -1;
  };

  for (const node of snapshot.nodes as unknown as SceneNodeDto[]) {
    const incV = versions[node.id] ?? 0;
    const tomb = db
      .prepare(
        'SELECT version FROM collab_tombstones WHERE scene_id = ? AND node_id = ?'
      )
      .get(sceneId, node.id) as { version: string } | undefined;
    if (tomb && Number(tomb.version) >= incV) continue; // our delete wins
    const localV = localVer(node.id);
    const incomingWins =
      localV < 0 || incV > localV || (incV === localV && !iAmAuthor);
    if (!incomingWins) continue;
    applyingFromPeer.add(node.id);
    try {
      upsertCollabNode(sceneId, node, true, incV);
    } finally {
      applyingFromPeer.delete(node.id);
    }
    clearTombstone(sceneId, node.id);
    nodeScene.set(node.id, sceneId);
    changed = true;
  }

  for (const t of tombstones) {
    const localV = localVer(t.nodeId);
    if (localV < 0) {
      recordTombstone(sceneId, t.nodeId, t.version); // already gone; remember it
      continue;
    }
    const delWins = t.version > localV || (t.version === localV && !iAmAuthor);
    if (!delWins) continue; // our copy is newer → keep it (resurrect)
    applyingFromPeer.add(t.nodeId);
    try {
      applySceneNodeRemove(t.nodeId, undefined, undefined);
    } finally {
      applyingFromPeer.delete(t.nodeId);
    }
    recordTombstone(sceneId, t.nodeId, t.version);
    nodeScene.delete(t.nodeId);
    changed = true;
  }

  // Clips added while disconnected: write any we don't already have. Existing
  // clips are left alone (no per-clip version yet — see the plan).
  for (const clip of (snapshot.clips ?? []) as unknown as ClipDto[]) {
    const exists = db
      .prepare('SELECT 1 FROM track_clips WHERE id = ? LIMIT 1')
      .get(clip.id);
    if (exists) continue;
    applyingFromPeer.add(clip.id);
    try {
      applyClipDto(clip);
      clipScene.set(clip.id, sceneId);
    } finally {
      applyingFromPeer.delete(clip.id);
    }
    changed = true;
  }
  return changed;
}

/** Upsert a node into our local copy of a collab scene. Structure is set from the
 *  scene, not derived from a parent (a scene's top-level nodes have parent_id
 *  NULL, so the parent-derived object-write path can't create them): project_id
 *  comes from our collab link, root_scene_node_id is the scene, parent_id is taken
 *  verbatim (shared id space). Then emit so our own clients update.
 *
 *  `file_path` is NOT overwritten on a plain update: asset paths are peer-local
 *  (each side localizes a shared asset to its own /uploads/_shared copy), so
 *  taking the peer's path would point at a file we don't have and break the
 *  avatar. `forceFilePath` is set only by the asset-op path, which has already
 *  fetched + rewritten the path to OUR local copy (model swaps / re-localization).
 *  A create always takes the op's path (the INSERT). */
function upsertCollabNode(
  sceneId: string,
  dto: SceneNodeDto,
  forceFilePath = false,
  updatedAtMs?: number
): void {
  const link = getDb()
    .prepare('SELECT project_id FROM collab_scenes WHERE scene_id = ? LIMIT 1')
    .get(sceneId) as { project_id: string } | undefined;
  if (!link) return;
  // Reconcile passes the source edit time so both sides converge to the same
  // updated_at (a fresh datetime('now') would look newer and re-trigger the
  // origin to re-apply — a ping-pong). Live edits use NULL → datetime('now').
  const ua =
    updatedAtMs != null
      ? new Date(updatedAtMs).toISOString().slice(0, 19).replace('T', ' ')
      : null;
  getDb()
    .prepare(
      `INSERT INTO scene_nodes
         (id, project_id, root_scene_node_id, parent_id, bone_attachment,
          name, kind, file_path, components, properties, hidden, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
       ON CONFLICT(id) DO UPDATE SET
         parent_id = excluded.parent_id, name = excluded.name,
         kind = excluded.kind,${forceFilePath ? ' file_path = excluded.file_path,' : ''}
         components = excluded.components, properties = excluded.properties,
         hidden = excluded.hidden, updated_at = COALESCE(?, datetime('now'))`
    )
    .run(
      dto.id,
      link.project_id,
      sceneId,
      dto.parentId ?? null,
      dto.boneAttachment ?? null,
      dto.name,
      dto.kind,
      dto.filePath ?? null,
      JSON.stringify(dto.components ?? {}),
      JSON.stringify(dto.properties ?? {}),
      dto.hidden ? 1 : 0,
      ua,
      ua
    );
  sync.document.upsert('scene_node', dto.id);
}
