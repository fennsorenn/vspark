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
import { getMeshCollection, getMeshPeer } from '../mesh/index.js';
import { getIdentity } from './identity.js';
import type { IdMap } from '@vspark/shared/idMap';
import { type SyncEnvelope } from '@vspark/shared/sync';
import {
  type ObjectSnapshot,
  type SnapshotAsset,
} from './shares.js';

// COLLAB_STREAM_RTYPE ('_collab_stream') is gone: live frames for collab
// nodes ride the @vspark/mesh preview channel now (backend/src/mesh/streams.ts).

// COLLAB_PLAYBACK_RTYPE ('_collab_playback') and COLLAB_RUNTIME_RTYPE
// ('_collab_runtime') are gone too: clip playback + runtime events ride the
// mesh `control` channel (backend/src/mesh/streams.ts).

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
  projectId: string,
  /** ms epoch of the mount, for 'mounted' rows. See migration 038 and
   *  `MeshPeer.mount`: documents in a mounted scope reconcile against
   *  max(write stamp, mount stamp), so this peer's older tombstones cannot
   *  swallow the tree it just mounted (and then propagate that back to its
   *  author). Local metadata on the share — never written to the documents. */
  mountedAt?: number
): void {
  getDb()
    .prepare(
      `INSERT INTO collab_scenes (scene_id, peer_id, role, project_id, mounted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scene_id, peer_id)
       DO UPDATE SET role = excluded.role, project_id = excluded.project_id,
         mounted_at = COALESCE(excluded.mounted_at, collab_scenes.mounted_at)`
    )
    .run(sceneId, peerId, role, projectId, mountedAt ?? null);
  if (mountedAt !== undefined) applyMountStamp(sceneId, mountedAt);
}

/** Tell the mesh peer about a mount, so the scope reconciles against it. */
function applyMountStamp(sceneId: string, mountedAt: number): void {
  getMeshPeer()?.mount(sceneId, {
    t: mountedAt,
    c: 0,
    n: getIdentity().peerId,
  });
}

/** Re-apply every persisted mount stamp. Called at boot: the links persist, the
 *  peer's in-memory mount table does not, and a receiver that restarts must not
 *  quietly go back to reconciling a mounted scene as if it had always had it. */
export function restoreMountStamps(): void {
  const rows = getDb()
    .prepare(
      "SELECT scene_id, mounted_at FROM collab_scenes WHERE role = 'mounted' AND mounted_at IS NOT NULL"
    )
    .all() as { scene_id: string; mounted_at: number }[];
  for (const r of rows) applyMountStamp(r.scene_id, r.mounted_at);
}

export function removeCollabScene(sceneId: string, peerId: string): void {
  getDb()
    .prepare('DELETE FROM collab_scenes WHERE scene_id = ? AND peer_id = ?')
    .run(sceneId, peerId);
  // Nothing mounts this scene here any more, so it reconciles by ordinary LWW.
  if (!isCollabScene(sceneId)) getMeshPeer()?.unmount(sceneId);
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

/** Every distinct collab scene id this server holds — the publish targets for
 *  runtime events over the mesh (mesh/streams.ts keys one event per scene;
 *  runtime data like chat feeds and spawned clips is project-global, so it
 *  fans out to every shared scene, deduped per receiver by eventId). */
export function allCollabSceneIds(): string[] {
  return (
    getDb()
      .prepare('SELECT DISTINCT scene_id FROM collab_scenes')
      .all() as { scene_id: string }[]
  ).map((r) => r.scene_id);
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
  /** The AUTHOR's values. Kept verbatim on mount — see mountSharedScene. */
  projectId?: string;
  rootSceneNodeId?: string;
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
export function recordCollabAsset(
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

/** A project we hold but do not own, so a mounted tree can be stored exactly as
 *  its author wrote it (migration 039). Idempotent; never overwrites one of
 *  ours, so a peer claiming an id we already use cannot take it over. */
export function ensurePeerProject(projectId: string, peerId: string): void {
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, owner_peer_id, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO NOTHING`
    )
    .run(projectId, `Peer ${peerId.slice(0, 8)}`, peerId);
}

/** Mount a received scene snapshot as a real, persisted scene, keeping the
 *  author's documents EXACTLY as they wrote them — their node ids, their
 *  `project_id`, their parent links. `projectId` is the local project the mount
 *  is recorded against on the share link; it is not written into the documents.
 *  Idempotent: an existing node is upserted, so a re-mount (resubscribe)
 *  refreshes rather than duplicates. Nodes arrive BFS-ordered (root first) so
 *  parent rows exist before children. */
export function mountSharedScene(
  snapshot: ObjectSnapshot,
  projectId: string,
  peerId: string
): void {
  const db = getDb();
  const sceneId = snapshot.objectId; // the scene root node id
  // The author's project has to exist here for the FK to hold. Taken from the
  // documents themselves rather than passed in, because it is THEIR value —
  // that is the whole point of not rewriting it.
  const authorProjectId = (snapshot.nodes as unknown as SnapshotNode[]).find(
    (n) => typeof n.projectId === 'string'
  )?.projectId;
  if (authorProjectId) ensurePeerProject(authorProjectId, peerId);
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
      n.projectId ?? projectId,
      n.rootSceneNodeId ?? sceneId,
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
  // Stamp the mount BEFORE the documents land, so the scope is already in force
  // when they reconcile against this peer's history.
  registerCollabScene(sceneId, peerId, 'mounted', projectId, Date.now());
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

/** The collab scene a node belongs to, if any — the sender gate + receiver
 *  bridge filter for live streams over the mesh (mesh/streams.ts). HOT PATH
 *  (per pose frame, per avatar): in-memory index only — a node not in the
 *  index isn't collaborative, so this returns in O(1) without touching the
 *  DB for the common (non-shared) avatar. */
export function collabSceneForNode(nodeId: string): string | undefined {
  return nodeScene.get(nodeId);
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
  keyframes: IdMap<ClipKeyframeDto>;
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
  // Id-keyed, matching the document the sender loaded (@vspark/shared/idMap).
  lanes: IdMap<ClipLaneDto>;
  events: IdMap<ClipEventDto>;
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

/** Write a full clip from its DTO through the mesh store: the onCommitted tap's
 *  `save` does the same delete-then-reinsert of clip/lanes/keyframes/events (so
 *  a re-mount/re-apply is idempotent) and emits the canonical `sync.document`
 *  upsert; the store write also applies to the replica and fans out to mesh
 *  subscribers with one stamp. started_at is dropped (playback anchors are
 *  peer-local, synced separately). */
function applyClipDto(dto: ClipDto): void {
  getMeshCollection('track_clip')?.set(dto.id, '', dto);
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

/** The collab scene a clip belongs to (undefined if its scene isn't shared) —
 *  the sender gate + receiver filter for playback control over the mesh
 *  (mesh/streams.ts). Cache-first; falls back to a DB walk. */
export function clipCollabScene(clipId: string): string | undefined {
  const sceneId = resolveClipScene(clipId);
  return sceneId && isCollabScene(sceneId) ? sceneId : undefined;
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
  // Through the mesh store: the tap's `save` is the same idempotent upsert and
  // emits the canonical sync.document upsert; the write also lands in the
  // replica + fans out to mesh subscribers.
  getMeshCollection('camera_effect')?.set(dto.id, '', dto);
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
