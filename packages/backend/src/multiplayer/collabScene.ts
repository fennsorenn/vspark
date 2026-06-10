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
import { getDb } from '../db/index.js';
import { sync } from '../sync/index.js';
import { compareHLC, type HLC, type SyncEnvelope } from '@vspark/shared/sync';
import type { ObjectSnapshot } from './shares.js';
import { applySceneNodeRemove, type SceneNodeDto } from './sceneNodeWrite.js';

/** Control rtypes for collaborative scene sharing (over the mesh doc channel). */
export const COLLAB_OP_RTYPE = '_collab_op'; // one scene_node edit, peer→peer
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
}

/** A local scene_node op fired — mirror it to every collab peer of its scene.
 *  No-op for non-collab scenes or ops we're mid-applying from a peer (echo). */
export function forwardCollabOp(
  env: SyncEnvelope,
  send: (peerId: string, env: SyncEnvelope) => void
): void {
  if (env.rtype !== 'scene_node') return;
  if (applyingFromPeer.has(env.key)) return; // don't echo a peer's op back
  let sceneId: string | undefined;
  if (env.op === 'remove') {
    sceneId = nodeScene.get(env.key);
    nodeScene.delete(env.key);
  } else {
    sceneId = sceneOf(env.key);
    if (sceneId) nodeScene.set(env.key, sceneId);
  }
  if (!sceneId || !isCollabScene(sceneId)) return;
  if (env.v) lastVersion.set(env.key, env.v);
  for (const link of collabPeersForScene(sceneId))
    send(link.peerId, {
      rtype: COLLAB_OP_RTYPE,
      op: 'event',
      key: sceneId,
      data: { sceneId, env },
    });
}

/** Apply a peer's collab scene_node op to our own persisted copy, last-write-wins.
 *  Reuses the Phase-6 node-write primitives; structure stays owner-local (create
 *  derives project/root from the local parent). Guarded so the re-emit isn't
 *  forwarded back. Returns true if applied. */
export function applyCollabOp(sceneId: string, env: SyncEnvelope): boolean {
  if (env.rtype !== 'scene_node' || !isCollabScene(sceneId)) return false;
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
    } else if (env.op === 'upsert' && env.data) {
      nodeScene.set(env.key, sceneId);
      upsertCollabNode(sceneId, env.data as SceneNodeDto);
    }
    return true;
  } finally {
    applyingFromPeer.delete(env.key);
  }
}

/** Upsert a node into our local copy of a collab scene. Structure is set from the
 *  scene, not derived from a parent (a scene's top-level nodes have parent_id
 *  NULL, so the parent-derived object-write path can't create them): project_id
 *  comes from our collab link, root_scene_node_id is the scene, parent_id is taken
 *  verbatim (shared id space). Then emit so our own clients update. */
function upsertCollabNode(sceneId: string, dto: SceneNodeDto): void {
  const link = getDb()
    .prepare('SELECT project_id FROM collab_scenes WHERE scene_id = ? LIMIT 1')
    .get(sceneId) as { project_id: string } | undefined;
  if (!link) return;
  getDb()
    .prepare(
      `INSERT INTO scene_nodes
         (id, project_id, root_scene_node_id, parent_id, bone_attachment,
          name, kind, file_path, components, properties, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         parent_id = excluded.parent_id, name = excluded.name,
         kind = excluded.kind, file_path = excluded.file_path,
         components = excluded.components, properties = excluded.properties,
         hidden = excluded.hidden, updated_at = datetime('now')`
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
      dto.hidden ? 1 : 0
    );
  sync.document.upsert('scene_node', dto.id);
}
