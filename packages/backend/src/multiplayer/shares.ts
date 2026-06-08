/**
 * Owner-side share grants (`shares`) + the snapshot gatherer for a shared
 * object's scene-node subtree. A grant says "peer X (or '*') may subscribe to my
 * object O". See dev-notes/plans/multiplayer-phase5.md.
 */
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';

export type ShareKind = 'object' | 'scene';

export interface ShareGrant {
  id: string;
  shareKind: ShareKind;
  objectId: string;
  granteePeerId: string;
  createdAt: string;
}

interface ShareRow {
  id: string;
  share_kind: ShareKind;
  object_id: string;
  grantee_peer_id: string;
  created_at: string;
}

const map = (r: ShareRow): ShareGrant => ({
  id: r.id,
  shareKind: r.share_kind,
  objectId: r.object_id,
  granteePeerId: r.grantee_peer_id,
  createdAt: r.created_at,
});

export function addShare(
  shareKind: ShareKind,
  objectId: string,
  granteePeerId: string
): void {
  getDb()
    .prepare(
      `INSERT INTO shares (id, share_kind, object_id, grantee_peer_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (share_kind, object_id, grantee_peer_id) DO NOTHING`
    )
    .run(randomUUID(), shareKind, objectId, granteePeerId);
}

export function removeShare(objectId: string, granteePeerId: string): void {
  getDb()
    .prepare('DELETE FROM shares WHERE object_id = ? AND grantee_peer_id = ?')
    .run(objectId, granteePeerId);
}

/** Grantees for an object (for the "Share with" UI checkmarks). */
export function listObjectGrantees(objectId: string): string[] {
  return (
    getDb()
      .prepare('SELECT grantee_peer_id FROM shares WHERE object_id = ?')
      .all(objectId) as { grantee_peer_id: string }[]
  ).map((r) => r.grantee_peer_id);
}

/** Everything granted to a peer (peer-specific + '*'), for advertise. */
export function listSharesForPeer(peerId: string): ShareGrant[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM shares WHERE grantee_peer_id = ? OR grantee_peer_id = '*'"
      )
      .all(peerId) as unknown as ShareRow[]
  ).map(map);
}

export function isSharedWith(objectId: string, peerId: string): boolean {
  const r = getDb()
    .prepare(
      "SELECT 1 FROM shares WHERE object_id = ? AND (grantee_peer_id = ? OR grantee_peer_id = '*') LIMIT 1"
    )
    .get(objectId, peerId);
  return !!r;
}

// --- subtree snapshot -------------------------------------------------------

interface SceneNodeRow {
  id: string;
  project_id: string;
  root_scene_node_id: string;
  parent_id: string | null;
  bone_attachment: string | null;
  name: string;
  kind: string;
  file_path: string | null;
  components: string;
  properties: string;
  hidden: number;
}

/** A shared object snapshot: the node subtree + attached behaviours/effects,
 *  as the canonical camelCase DTOs the frontend renders. Parent ids are kept so
 *  the receiver can rebuild the tree under its wrapper (the root's parent is
 *  rewritten to the wrapper locally). */
export interface ObjectSnapshot {
  objectId: string;
  rootName: string;
  nodes: Record<string, unknown>[];
  behaviors: Record<string, unknown>[];
  cameraEffects: Record<string, unknown>[];
  /** sha256 → file_path for assets referenced by the subtree (transfer later). */
  assetHashes: string[];
}

function rowToNode(r: SceneNodeRow): Record<string, unknown> {
  return {
    id: r.id,
    rootSceneNodeId: r.root_scene_node_id,
    projectId: r.project_id,
    parentId: r.parent_id,
    boneAttachment: r.bone_attachment,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    components: JSON.parse(r.components || '{}'),
    properties: JSON.parse(r.properties || '{}'),
    hidden: r.hidden === 1,
  };
}

/** Gather the node + all descendants (by parent_id) plus their behaviors and
 *  camera effects. Returns null if the object node no longer exists. */
export function gatherObjectSnapshot(objectId: string): ObjectSnapshot | null {
  const db = getDb();
  const root = db
    .prepare('SELECT * FROM scene_nodes WHERE id = ?')
    .get(objectId) as unknown as SceneNodeRow | undefined;
  if (!root) return null;

  // BFS over parent_id within the same root scene.
  const all = db
    .prepare('SELECT * FROM scene_nodes WHERE root_scene_node_id = ?')
    .all(root.root_scene_node_id) as unknown as SceneNodeRow[];
  const byParent = new Map<string | null, SceneNodeRow[]>();
  for (const n of all) {
    const arr = byParent.get(n.parent_id) ?? [];
    arr.push(n);
    byParent.set(n.parent_id, arr);
  }
  const subtree: SceneNodeRow[] = [];
  const queue: SceneNodeRow[] = [root];
  while (queue.length) {
    const n = queue.shift()!;
    subtree.push(n);
    for (const c of byParent.get(n.id) ?? []) queue.push(c);
  }

  const ids = subtree.map((n) => n.id);
  const placeholders = ids.map(() => '?').join(',');
  const behaviors =
    ids.length > 0
      ? (db
          .prepare(`SELECT * FROM behaviors WHERE node_id IN (${placeholders})`)
          .all(...ids) as Record<string, unknown>[])
      : [];
  const cameraEffects =
    ids.length > 0
      ? (db
          .prepare(
            `SELECT * FROM camera_effects WHERE node_id IN (${placeholders})`
          )
          .all(...ids) as Record<string, unknown>[])
      : [];
  const assetHashes = (
    db
      .prepare(
        `SELECT DISTINCT hash FROM asset_files WHERE stored_path IN (${subtree
          .map(() => '?')
          .join(',')})`
      )
      .all(...subtree.map((n) => n.file_path ?? '')) as { hash: string }[]
  )
    .map((r) => r.hash)
    .filter(Boolean);

  return {
    objectId,
    rootName: root.name,
    nodes: subtree.map(rowToNode),
    behaviors: behaviors.map((b) => ({
      id: b.id,
      nodeId: b.node_id,
      kind: b.kind,
      enabled: (b.enabled as number) === 1,
      config: JSON.parse((b.config as string) || '{}'),
    })),
    cameraEffects: cameraEffects.map((e) => ({
      id: e.id,
      nodeId: e.node_id,
      kind: e.kind,
      enabled: (e.enabled as number) === 1,
      config: JSON.parse((e.config as string) || '{}'),
    })),
    assetHashes,
  };
}

/** Which subtree-root objectId (if any) a given node belongs to, given the set
 *  of candidate roots. Walks up parent_id. Used to route live updates to the
 *  right subscribed object. */
export function findOwningRoot(
  nodeId: string,
  candidateRoots: Set<string>
): string | null {
  if (candidateRoots.has(nodeId)) return nodeId;
  const db = getDb();
  let cur: string | null = nodeId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const r = db
      .prepare('SELECT parent_id FROM scene_nodes WHERE id = ?')
      .get(cur) as { parent_id: string | null } | undefined;
    if (!r) return null;
    if (r.parent_id && candidateRoots.has(r.parent_id)) return r.parent_id;
    cur = r.parent_id;
  }
  return null;
}
