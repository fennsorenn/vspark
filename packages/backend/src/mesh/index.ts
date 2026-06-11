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
}

const childOfNode = (d: Dto) =>
  typeof d.nodeId === 'string' ? { rtype: 'scene_node', id: d.nodeId } : null;

const BINDINGS: RtypeBinding[] = [
  {
    rtype: 'scene_node',
    table: 'scene_nodes',
    parent: (d) =>
      typeof d.parentId === 'string'
        ? { rtype: 'scene_node', id: d.parentId }
        : null,
  },
  { rtype: 'behavior', table: 'behaviors', parent: childOfNode },
  { rtype: 'camera_effect', table: 'camera_effects', parent: childOfNode },
  {
    rtype: 'compose_layer',
    table: 'compose_layers',
    parent: (d) =>
      typeof d.parentId === 'string'
        ? { rtype: 'compose_layer', id: d.parentId }
        : null,
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
  },
];

/** Echo guard for the legacy bridge: ids currently being persisted from a
 *  mesh apply — the sync.onDocument mirror skips them so the tap's own
 *  legacy upsert can't loop back into the mesh. */
const applyingFromMesh = new Set<string>();

let _peer: MeshPeer | null = null;
let _transport: WsServerTransport | null = null;

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
    authority: 'self',
  });
  if (!r?.load) return col;

  // Persistence tap: committed mesh state → SQLite, generically — then echo
  // through the legacy sync hub so this backend's own (legacy) tabs see the
  // change live. The guard keeps the bridge mirror from looping it back.
  // Removes also persist their HLC tombstone so a restart can't resurrect
  // entities deleted while a peer was offline.
  col.onCommitted((c) => {
    const key = `${b.rtype}:${c.id}`;
    applyingFromMesh.add(key);
    try {
      if (c.op === 'remove') {
        r.remove?.(c.id);
        if (c.v) saveTombstone(b.rtype, c.id, c.v);
        sync.document.remove(b.rtype, c.id);
      } else if (c.doc) {
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
