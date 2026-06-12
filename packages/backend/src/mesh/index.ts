/**
 * Backend mesh peer — parallel-run scaffold.
 *
 * Creates this server's @vspark/mesh peer: collections for the five document
 * rtypes (persisted through the resource registry's generic save/remove via
 * the onCommitted tap), hydration from SQLite, a WS transport on /mesh for
 * the server's own browser tabs, and a standing full-rights grant for those
 * tabs (grantee = this server's peer id covers every `${peerId}#tab` via
 * granteeCandidates).
 *
 * Runs ALONGSIDE the legacy multiplayer/sync system — nothing is unplugged
 * yet. Migration plan: dev-notes/plans/mesh-sync-refactor.md §8.
 *
 * Bootstrap stamps: rows hydrate with HLC stamps derived from their
 * updated_at (second granularity, c=0, n=serverPeerId), falling back to
 * created_at / 0 where a table has no timestamp. Real end-to-end HLC
 * persistence (a sync_v column) lands with the reconcile step; until then a
 * restart re-derives the same deterministic ordering.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import {
  createMeshPeer,
  type Collection,
  type HLC,
  type MeshPeer,
} from '@vspark/mesh';
import { WsServerTransport } from '@vspark/mesh-transports/wsServer';
import { getDb } from '../db/index.js';
import { getIdentity } from '../multiplayer/identity.js';
import { getResource } from '../sync/registry.js';
import { sync } from '../sync/index.js';
import '../sync/resources.js'; // side effect: register the descriptors

type Dto = Record<string, unknown>;

interface RtypeBinding {
  rtype: string;
  table: string;
  parent?: (dto: Dto) => { rtype: string; id: string } | null;
  /** Incoming-doc transform/gate (localize project scope, keep local paths). */
  validate?: (data: unknown) => Dto;
  /** Whether a committed doc belongs to THIS server's data (persist it) or is
   *  a remote projection riding a placed-object subscription (replica-only:
   *  fans out to our tabs, never touches SQLite). §9 step D. */
  persists?: (dto: Dto) => boolean;
}

const rowExists = (table: string, id: unknown): boolean =>
  !!getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id as string);

const childOfNode = (d: Dto) =>
  typeof d.nodeId === 'string' ? { rtype: 'scene_node', id: d.nodeId } : null;

const BINDINGS: RtypeBinding[] = [
  {
    rtype: 'scene_node',
    table: 'scene_nodes',
    // Top-level nodes have parent_id NULL and hang off the scene root via
    // root_scene_node_id (the scene root itself is its own root → null).
    parent: (d) =>
      typeof d.parentId === 'string'
        ? { rtype: 'scene_node', id: d.parentId }
        : typeof d.rootSceneNodeId === 'string' && d.rootSceneNodeId !== d.id
          ? { rtype: 'scene_node', id: d.rootSceneNodeId }
          : null,
    // Bug-5 fix: incoming collab docs carry the SENDER's project id (FK fail
    // here) and the sender's local file path. Re-scope to our collab_scenes
    // link and keep our local file path (model-swap assets don't ride the
    // mesh yet — §9 known gap). Both adjustments fire ONLY for foreign docs
    // (projectId ≠ our link's project): local writes also pass through this
    // validate now that REST routes write through the store (§10 hazard e),
    // and a local model swap must not be reverted.
    validate: (data) => {
      const d = { ...(data as Dto) };
      const rootId =
        typeof d.rootSceneNodeId === 'string' ? d.rootSceneNodeId : undefined;
      if (!rootId) return d;
      const link = getDb()
        .prepare(
          'SELECT project_id FROM collab_scenes WHERE scene_id = ? LIMIT 1'
        )
        .get(rootId) as { project_id: string } | undefined;
      if (!link || d.projectId === link.project_id) return d;
      d.projectId = link.project_id;
      const cur = getDb()
        .prepare('SELECT file_path FROM scene_nodes WHERE id = ?')
        .get(d.id as string) as { file_path: string | null } | undefined;
      if (cur?.file_path && cur.file_path !== d.filePath)
        d.filePath = cur.file_path;
      return d;
    },
    // Placed-share projections keep the OWNER's projectId (no collab link to
    // re-scope it) — that marks them foreign, so they stay replica-only.
    persists: (d) => rowExists('projects', d.projectId),
  },
  {
    rtype: 'behavior',
    table: 'behaviors',
    parent: childOfNode,
    persists: (d) => rowExists('scene_nodes', d.nodeId),
  },
  {
    rtype: 'camera_effect',
    table: 'camera_effects',
    parent: childOfNode,
    persists: (d) => rowExists('scene_nodes', d.nodeId),
  },
  {
    rtype: 'compose_layer',
    table: 'compose_layers',
    // Top-level layers have parent_id NULL and hang off their compose scene
    // via root_compose_scene_id (the compose scene root itself → null) — the
    // same fallback shape as scene_node, giving compose content a real
    // containment scope for subtree grants/subscriptions.
    parent: (d) =>
      typeof d.parentId === 'string'
        ? { rtype: 'compose_layer', id: d.parentId }
        : typeof d.rootComposeSceneId === 'string' &&
            d.rootComposeSceneId !== d.id
          ? { rtype: 'compose_layer', id: d.rootComposeSceneId }
          : null,
    persists: (d) => rowExists('projects', d.projectId),
  },
  {
    rtype: 'track_clip',
    table: 'track_clips',
    // Clip → its owning node/layer, so scene-subtree grants and subscriptions
    // cover clips cross-type (the §9 cutover relies on this).
    parent: (d) =>
      typeof d.ownerNodeId === 'string'
        ? { rtype: 'scene_node', id: d.ownerNodeId }
        : typeof d.ownerLayerId === 'string'
          ? { rtype: 'compose_layer', id: d.ownerLayerId }
          : null,
    persists: (d) =>
      typeof d.ownerNodeId === 'string'
        ? rowExists('scene_nodes', d.ownerNodeId)
        : typeof d.ownerLayerId === 'string'
          ? rowExists('compose_layers', d.ownerLayerId)
          : false,
  },
];

/** Echo guard for the legacy bridge: ids currently being persisted from a
 *  mesh apply — the sync.onDocument mirror skips them so the tap's own
 *  legacy upsert can't loop back into the mesh. */
const applyingFromMesh = new Set<string>();

let _peer: MeshPeer | null = null;
let _transport: WsServerTransport | null = null;
const COLLECTIONS = new Map<string, Collection<Dto>>();
/** rtype → timestamp column used for bootstrap stamps (cached at bind time). */
const TS_COLS = new Map<string, string | undefined>();

/** Mirror one persisted row into the mesh replica with its row-derived
 *  (old) stamp — used after a legacy mount so the mirrored content can't
 *  out-stamp the author's live state and echo-clobber it. */
export function mirrorIntoMesh(rtype: string, id: string): void {
  const col = COLLECTIONS.get(rtype);
  const b = BINDINGS.find((x) => x.rtype === rtype);
  const r = getResource(rtype);
  if (!col || !b || !r?.load) return;
  const dto = r.load(id);
  if (!dto) return;
  const tsCol = TS_COLS.get(rtype);
  const row = tsCol
    ? (getDb()
        .prepare(
          `SELECT strftime('%s', ${tsCol}) AS ts FROM ${b.table} WHERE id = ?`
        )
        .get(id) as { ts: string | number | null } | undefined)
    : undefined;
  const t = row?.ts ? Number(row.ts) * 1000 : 0;
  col.put(dto, { v: { t, c: 0, n: getIdentity().peerId } });
}

/** Resurrect window: tombstones older than this are pruned — a peer offline
 *  longer may resurrect a deletion on reconnect (accepted trade-off, §8.7). */
const TOMBSTONE_MAX_AGE_DAYS = 30;

function saveTombstone(rtype: string, id: string, v: HLC): void {
  getDb()
    .prepare(
      `INSERT INTO mesh_tombstones (rtype, id, v_t, v_c, v_n)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(rtype, id) DO UPDATE SET
         v_t = excluded.v_t, v_c = excluded.v_c, v_n = excluded.v_n,
         deleted_at = datetime('now')`
    )
    .run(rtype, id, v.t, v.c, v.n);
}

function clearTombstone(rtype: string, id: string): void {
  getDb()
    .prepare('DELETE FROM mesh_tombstones WHERE rtype = ? AND id = ?')
    .run(rtype, id);
}

/** Create + hydrate the backend mesh peer. Idempotent. */
export function initBackendMesh(): MeshPeer {
  if (_peer) return _peer;
  const { peerId } = getIdentity();
  getDb()
    .prepare(
      `DELETE FROM mesh_tombstones
       WHERE deleted_at < datetime('now', '-${TOMBSTONE_MAX_AGE_DAYS} days')`
    )
    .run();
  _transport = new WsServerTransport(peerId);
  const peer = createMeshPeer({
    identity: { peerId },
    transports: [_transport],
  });

  for (const b of BINDINGS) bindCollection(peer, peerId, b);

  // This server's own tabs hold full rights on everything it serves.
  peer.grants.grant({
    grantee: peerId,
    entityRtype: '*',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true, update: true, create: true, delete: true },
  });

  _peer = peer;
  return peer;
}

export function getMeshPeer(): MeshPeer | null {
  return _peer;
}

/** A bound document collection (for REST routes writing through the store). */
export function getMeshCollection(rtype: string): Collection<Dto> | undefined {
  return COLLECTIONS.get(rtype);
}

/** HTTP 'upgrade' branch for the /mesh path. */
export function meshUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  _transport?.upgrade(req, socket, head);
}

function bindCollection(
  peer: MeshPeer,
  peerId: string,
  b: RtypeBinding
): Collection<Dto> {
  const r = getResource(b.rtype);
  const col = peer.collection<Dto>(b.rtype, {
    parent: b.parent,
    validate: b.validate,
    authority: 'self',
  });
  COLLECTIONS.set(b.rtype, col);
  if (!r?.load) return col;

  // Persistence tap: committed mesh state → SQLite, generically — then echo
  // through the legacy sync hub so this backend's own (legacy) tabs see the
  // change live. The guard keeps the bridge mirror from looping it back.
  // Removes also persist their HLC tombstone so a restart can't resurrect
  // entities deleted while a peer was offline.
  // Foreign docs (a placed object's projection — §9 step D) skip all of it:
  // they live in the replica only, fanned out to tabs over the mesh.
  col.onCommitted((c) => {
    const key = `${b.rtype}:${c.id}`;
    applyingFromMesh.add(key);
    try {
      if (c.op === 'remove') {
        if (b.persists && !rowExists(b.table, c.id)) return; // never persisted
        r.remove?.(c.id);
        if (c.v) saveTombstone(b.rtype, c.id, c.v);
        sync.document.remove(b.rtype, c.id);
      } else if (c.doc) {
        if (b.persists && !b.persists(c.doc)) return;
        r.save?.(c.doc);
        clearTombstone(b.rtype, c.id);
        sync.document.upsert(b.rtype, c.id);
      }
    } finally {
      applyingFromMesh.delete(key);
    }
  });

  // Legacy bridge (parallel-run keystone, §9.3): every legacy mutation
  // (REST routes persist + emit sync.document) is mirrored into the mesh
  // replica so it stays current and fans out to mesh subscribers. `put`
  // skips the persistence tap — the row is already in SQLite. Legacy removes
  // persist their tombstone too (the legacy reconcile path is being cut).
  sync.onDocument((env) => {
    if (env.rtype !== b.rtype) return;
    if (applyingFromMesh.has(`${b.rtype}:${env.key}`)) return;
    const v = env.v ?? { t: Date.now(), c: 0, n: peerId };
    if (env.op === 'remove') {
      col.putTombstone(env.key, v);
      saveTombstone(b.rtype, env.key, v);
    } else if (env.data) col.put(env.data as Dto, { v });
  });

  // Hydrate with stamps derived from the row's timestamp column.
  const db = getDb();
  const columns = db.prepare(`PRAGMA table_info(${b.table})`).all() as {
    name: string;
  }[];
  const tsCol = ['updated_at', 'created_at'].find((name) =>
    columns.some((c) => c.name === name)
  );
  TS_COLS.set(b.rtype, tsCol);
  const rows = db
    .prepare(
      tsCol
        ? `SELECT id, strftime('%s', ${tsCol}) AS ts FROM ${b.table}`
        : `SELECT id, 0 AS ts FROM ${b.table}`
    )
    .all() as { id: string; ts: string | number | null }[];
  let hydrated = 0;
  for (const row of rows) {
    const dto = r.load(row.id);
    if (!dto) continue;
    const t = row.ts ? Number(row.ts) * 1000 : 0;
    col.put(dto, { v: { t, c: 0, n: peerId } });
    hydrated++;
  }
  if (hydrated) console.log(`[mesh] hydrated ${hydrated} ${b.rtype} row(s)`);

  // Re-hydrate persisted tombstones (order vs docs is irrelevant — LWW).
  for (const t of db
    .prepare('SELECT id, v_t, v_c, v_n FROM mesh_tombstones WHERE rtype = ?')
    .all(b.rtype) as { id: string; v_t: number; v_c: number; v_n: string }[])
    col.putTombstone(t.id, { t: t.v_t, c: t.v_c, n: t.v_n });
  return col;
}
