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
import { type SyncEnvelope } from '@vspark/shared/sync';
import {
  type ObjectSnapshot,
  type SnapshotAsset,
} from './shares.js';

/** Lossy stream frame (pose / blendshapes / IK / drag preview) for a collab node.
 *  Rides the mesh stream channel, not the doc channel. */
export const COLLAB_STREAM_RTYPE = '_collab_stream';

/** Control rtypes for collaborative scene sharing (over the mesh doc channel). */
export const COLLAB_PLAYBACK_RTYPE = '_collab_playback'; // clip play/pause/seek control
export const COLLAB_RUNTIME_RTYPE = '_collab_runtime'; // runtime data (Set Data, spawn, …)

export type ClipPlaybackAction = 'trigger' | 'stop' | 'pause' | 'resume' | 'seek';
export const COLLAB_SUBSCRIBE_RTYPE = '_collab_subscribe'; // grantee→owner: "send it"
export const COLLAB_SNAPSHOT_RTYPE = '_collab_snapshot'; // owner→grantee: the scene

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

/** Unique peers we collaborate with on any scene — runtime data (chat feeds,
 *  spawned clips, …) is project-global, so it fans out to all of them. */
export function allCollabPeers(): string[] {
  return (
    getDb()
      .prepare('SELECT DISTINCT peer_id FROM collab_scenes')
      .all() as { peer_id: string }[]
  ).map((r) => r.peer_id);
}

/** Mirror one runtime WS broadcast (kind + payload) to every collab peer, who
 *  re-applies it locally. */
export function forwardCollabRuntime(
  kind: string,
  payload: Record<string, unknown>,
  send: (peerId: string, env: SyncEnvelope) => void
): void {
  const peers = allCollabPeers();
  if (peers.length === 0) return;
  for (const peerId of peers)
    send(peerId, {
      rtype: COLLAB_RUNTIME_RTYPE,
      op: 'event',
      key: kind,
      data: { kind, payload },
    });
}

/** Every collab-scene link this server holds (for the scene-graph chain badge). */
export function listAllCollabScenes(): CollabLink[] {
  return (
    getDb()
      .prepare(
        'SELECT scene_id, peer_id, role, project_id FROM collab_scenes'
      )
      .all() as {
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
  applyCollabCameraEffects(
    sceneId,
    (snapshot.cameraEffects ?? []) as unknown as CameraEffectDto[]
  );
  registerCollabScene(sceneId, peerId, 'mounted', projectId);
}

/** nodeId → sceneId, so a `remove` (whose row is already gone) still resolves
 *  its scene for fan-out. Filled on mount + index.
 *  NOTE: forwardCollabOp (removed — migrated to @vspark/mesh) was the live-edit
 *  writer that kept this current for new nodes beyond mount/index time. It is now
 *  seeded only at indexCollabScene / mountSharedScene. New nodes added after mount
 *  won't appear until the next index (reconnect or restart). */
const nodeScene = new Map<string, string>();

/** Seed the node→scene map for an already-mounted/known scene so removes resolve. */
/** Keep the stream-routing map current for a single node (called from the
 *  manager's sync.onDocument hook — the deleted legacy forwardCollabOp used
 *  to do this as a side effect). No-op unless the root is a collab scene. */
export function indexCollabNode(nodeId: string, rootSceneNodeId: string): void {
  if (isCollabScene(rootSceneNodeId)) nodeScene.set(nodeId, rootSceneNodeId);
}

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

/** clipId → sceneId. Used by forwardClipPlayback to resolve which scene a clip
 *  belongs to so it can fan-out to the right peers.
 *  NOTE: forwardCollabClipOp (removed — migrated to @vspark/mesh) was the live-edit
 *  writer that kept this current for newly created/removed clips beyond mount/index
 *  time. It is now seeded only at applyCollabClips (mount) and indexCollabSceneClips
 *  (indexCollabScene / boot). Clips created after mount won't be in the map until
 *  the next index. resolveClipScene falls back to a DB query on cache miss. */
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

/** Write a full clip from its DTO (delete + reinsert clip/lanes/keyframes/events).
 *  Children are cleared EXPLICITLY rather than via FK cascade — migrations toggle
 *  `foreign_keys`, and a re-mount/re-apply must be idempotent regardless. Without
 *  this, re-applying a clip hits a UNIQUE constraint on the stale lane ids.
 *  started_at is dropped (playback anchors are peer-local, synced separately) and
 *  the re-emit updates our own clients. */
function applyClipDto(dto: ClipDto): void {
  const db = getDb();
  const oldLanes = db
    .prepare('SELECT id FROM track_clip_lanes WHERE clip_id = ?')
    .all(dto.id) as { id: string }[];
  for (const l of oldLanes)
    db.prepare('DELETE FROM track_clip_keyframes WHERE lane_id = ?').run(l.id);
  db.prepare('DELETE FROM track_clip_lanes WHERE clip_id = ?').run(dto.id);
  db.prepare('DELETE FROM track_clip_events WHERE clip_id = ?').run(dto.id);
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

/** Write a collab scene's clips at mount/reconcile time, indexing them. A bad
 *  clip is logged and skipped rather than aborting the whole scene mount. */
export function applyCollabClips(sceneId: string, clips: ClipDto[]): void {
  for (const c of clips) {
    try {
      applyClipDto(c);
      clipScene.set(c.id, sceneId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[collab] failed to apply clip ${c.id}:`, e);
    }
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

// --- camera effects (node-scoped) -------------------------------------------

interface CameraEffectDto {
  id: string;
  nodeId: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

function applyCameraEffectDto(dto: CameraEffectDto): void {
  getDb()
    .prepare(
      `INSERT INTO camera_effects (id, node_id, kind, enabled, config)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, enabled = excluded.enabled, config = excluded.config`
    )
    .run(
      dto.id,
      dto.nodeId,
      dto.kind,
      dto.enabled ? 1 : 0,
      JSON.stringify(dto.config ?? {})
    );
  sync.document.upsert('camera_effect', dto.id);
}

/** Write a collab scene's camera effects at mount time (in the snapshot). */
export function applyCollabCameraEffects(
  sceneId: string,
  effects: CameraEffectDto[]
): void {
  for (const e of effects) {
    try {
      applyCameraEffectDto(e);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[collab] failed to apply camera effect ${e.id}:`, err);
    }
  }
}
