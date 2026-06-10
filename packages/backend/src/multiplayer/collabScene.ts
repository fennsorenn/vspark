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
import type { ObjectSnapshot } from './shares.js';

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
  const upsert = db.prepare(
    `INSERT INTO scene_nodes
       (id, project_id, root_scene_node_id, parent_id, bone_attachment,
        name, kind, file_path, components, properties, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, file_path = excluded.file_path,
       components = excluded.components, properties = excluded.properties,
       hidden = excluded.hidden, updated_at = datetime('now')`
  );
  const nodes = snapshot.nodes as unknown as SnapshotNode[];
  db.exec('BEGIN');
  try {
    for (const n of nodes) {
      upsert.run(
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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  registerCollabScene(sceneId, peerId, 'mounted', projectId);
}
