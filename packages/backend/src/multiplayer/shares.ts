/**
 * Owner-side share grants (`shares`) + the snapshot gatherer for a shared
 * object's scene-node subtree. A grant says "peer X (or '*') may subscribe to my
 * object O". See dev-notes/plans/multiplayer-phase5.md.
 */
import { getDb } from '../db/index.js';
import { extOf } from './blobs.js';
import { loadClip } from '../routes/track-clips.js';
import { containmentIndex } from '../sync/containmentIndex.js';
import {
  addGrant,
  removeGrant,
  canAccess,
  grantsForRequester,
  grantsForEntity,
} from '../sync/grants.js';

export type ShareKind = 'object' | 'scene';

export interface ShareGrant {
  id: string;
  shareKind: ShareKind;
  objectId: string;
  granteePeerId: string;
  /** Whether this grantee may also edit (update/create/delete) the subtree. */
  canWrite: boolean;
  createdAt: string;
}

// Object sharing is now expressed as grants (entity = the shared scene_node +
// its subtree, read). These wrappers keep the existing call sites + the
// shareKind concept while delegating to the generalized grant store. See
// dev-notes/plans/permissioned-sync-mesh.md.

/** A scene/object share = a read grant on the scene_node entity + its subtree.
 *  `canWrite` additionally grants update/create/delete (the Phase 6 write tier) —
 *  a single "can edit" toggle covers all three structural rights. */
export function addShare(
  _shareKind: ShareKind,
  objectId: string,
  granteePeerId: string,
  canWrite = false
): void {
  addGrant({
    grantee: granteePeerId,
    entityRtype: 'scene_node',
    entityId: objectId,
    includeDescendants: true,
    pathPrefix: '',
    rights: {
      read: true,
      update: canWrite,
      create: canWrite,
      delete: canWrite,
    },
  });
}

export function removeShare(objectId: string, granteePeerId: string): void {
  removeGrant(granteePeerId, 'scene_node', objectId);
}

/** Grantees for an object (for the "Share with" UI checkmarks). */
export function listObjectGrantees(objectId: string): string[] {
  return grantsForEntity('scene_node', objectId)
    .filter((g) => g.rights.read)
    .map((g) => g.grantee);
}

/** Everything granted to a peer (peer-specific + '*'), for advertise. */
export function listSharesForPeer(peerId: string): ShareGrant[] {
  const db = getDb();
  const isScene = db.prepare(
    "SELECT 1 FROM scene_nodes WHERE id = ? AND kind = 'scene'"
  );
  return grantsForRequester(peerId)
    .filter((g) => g.rights.read && g.entityRtype === 'scene_node')
    .map((g) => ({
      id: `${g.grantee}:${g.entityId}`,
      // A grant on a scene root is a collaborative-scene offer (mount), not an
      // object projection (place) — the receiver UI branches on this.
      shareKind: (isScene.get(g.entityId) ? 'scene' : 'object') as ShareKind,
      objectId: g.entityId,
      granteePeerId: g.grantee,
      canWrite: !!g.rights.update,
      createdAt: '',
    }));
}

export function isSharedWith(objectId: string, peerId: string): boolean {
  // Exact-entity read grant on the object root (covers peer-specific + '*').
  return canAccess(
    peerId,
    `scene_node:${objectId}`,
    'read',
    containmentIndex.isDescendant
  );
}

// --- subtree snapshot -------------------------------------------------------

interface StageObjectRow {
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
export interface SnapshotAsset {
  /** the owner's file path as it appears on the subtree's nodes */
  filePath: string;
  hash: string;
  ext: string;
  mime: string;
  size: number;
}

export interface ObjectSnapshot {
  objectId: string;
  rootName: string;
  nodes: Record<string, unknown>[];
  behaviors: Record<string, unknown>[];
  cameraEffects: Record<string, unknown>[];
  /** Timeline clips owned by the scene's nodes (collab scenes only) — synced as
   *  data so each peer evaluates them locally. */
  clips?: Record<string, unknown>[];
  /** Assets referenced by the subtree, content-addressed for transfer; the
   *  receiver fetches each by hash and rewrites node file paths to its cache. */
  assets: SnapshotAsset[];
}

function rowToNode(r: StageObjectRow): Record<string, unknown> {
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
    .get(objectId) as unknown as StageObjectRow | undefined;
  if (!root) return null;

  // BFS over parent_id within the same root scene.
  const all = db
    .prepare('SELECT * FROM scene_nodes WHERE root_scene_node_id = ?')
    .all(root.root_scene_node_id) as unknown as StageObjectRow[];
  const byParent = new Map<string | null, StageObjectRow[]>();
  for (const n of all) {
    const arr = byParent.get(n.parent_id) ?? [];
    arr.push(n);
    byParent.set(n.parent_id, arr);
  }
  const subtree: StageObjectRow[] = [];
  const queue: StageObjectRow[] = [root];
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
  const paths = subtree.map((n) => n.file_path ?? '').filter(Boolean);
  const assets = (
    paths.length > 0
      ? (db
          .prepare(
            `SELECT stored_path, hash, mime_type, size FROM asset_files
             WHERE stored_path IN (${paths.map(() => '?').join(',')})`
          )
          .all(...paths) as {
          stored_path: string;
          hash: string;
          mime_type: string;
          size: number;
        }[])
      : []
  )
    .filter((r) => r.hash)
    .map((r) => ({
      filePath: r.stored_path,
      hash: r.hash,
      ext: extOf(r.stored_path),
      mime: r.mime_type,
      size: r.size,
    }));

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
    assets,
  };
}

/** Snapshot a WHOLE scene (collaborative scene sharing) rather than a parent_id
 *  subtree: a scene's top-level nodes have `parent_id = NULL` and are linked by
 *  `root_scene_node_id`, so the object snapshot's parent-walk misses them. This
 *  gathers the scene node + every node whose `root_scene_node_id` is the scene,
 *  ordered root-first then parent-before-child so a receiver can INSERT in order.
 *  Behaviours/effects/assets are gathered exactly as gatherObjectSnapshot. */
export function gatherSceneSnapshot(sceneId: string): ObjectSnapshot | null {
  const db = getDb();
  const root = db
    .prepare('SELECT * FROM scene_nodes WHERE id = ?')
    .get(sceneId) as unknown as StageObjectRow | undefined;
  if (!root) return null;
  const members = db
    .prepare(
      'SELECT * FROM scene_nodes WHERE root_scene_node_id = ? AND id != ?'
    )
    .all(sceneId, sceneId) as unknown as StageObjectRow[];

  const byParent = new Map<string | null, StageObjectRow[]>();
  for (const n of members) {
    const arr = byParent.get(n.parent_id) ?? [];
    arr.push(n);
    byParent.set(n.parent_id, arr);
  }
  // Root first; its "children" are the scene's top-level nodes (parent_id NULL
  // or pointing at the scene). Then BFS by parent_id so parents precede children.
  const subtree: StageObjectRow[] = [root];
  const queue: StageObjectRow[] = [
    ...(byParent.get(null) ?? []),
    ...(byParent.get(sceneId) ?? []),
  ];
  const seen = new Set<string>([sceneId]);
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
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
  const paths = subtree.map((n) => n.file_path ?? '').filter(Boolean);
  const assets = (
    paths.length > 0
      ? (db
          .prepare(
            `SELECT stored_path, hash, mime_type, size FROM asset_files
             WHERE stored_path IN (${paths.map(() => '?').join(',')})`
          )
          .all(...paths) as {
          stored_path: string;
          hash: string;
          mime_type: string;
          size: number;
        }[])
      : []
  )
    .filter((r) => r.hash)
    .map((r) => ({
      filePath: r.stored_path,
      hash: r.hash,
      ext: extOf(r.stored_path),
      mime: r.mime_type,
      size: r.size,
    }));

  // Timeline clips owned by the scene's nodes (full DTOs for collab sync).
  const clipIds =
    ids.length > 0
      ? (db
          .prepare(
            `SELECT id FROM track_clips WHERE owner_node_id IN (${placeholders})`
          )
          .all(...ids) as { id: string }[])
      : [];
  const clips = clipIds
    .map((c) => loadClip(c.id))
    .filter((c): c is NonNullable<typeof c> => !!c);

  return {
    objectId: sceneId,
    rootName: root.name,
    nodes: subtree.map(rowToNode),
    clips,
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
    assets,
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
  // Prefer the in-memory containment index (parent walk, no per-step DB query).
  // Returns the nearest ancestor that is a candidate root — same semantics as
  // the DB walk below.
  if (containmentIndex.has(nodeId)) {
    let cur = containmentIndex.parentOf(nodeId) ?? null;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (candidateRoots.has(cur)) return cur;
      cur = containmentIndex.parentOf(cur) ?? null;
    }
    return null;
  }
  // Fallback for ids the index hasn't seen (e.g. tmp/spawn nodes that don't flow
  // through sync.document): walk parent_id in SQLite.
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
