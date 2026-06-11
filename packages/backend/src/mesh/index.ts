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
import { createMeshPeer, type Collection, type MeshPeer } from '@vspark/mesh';
import { WsServerTransport } from '@vspark/mesh-transports/wsServer';
import { getDb } from '../db/index.js';
import { getIdentity } from '../multiplayer/identity.js';
import { getResource } from '../sync/registry.js';
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
  { rtype: 'track_clip', table: 'track_clips' },
];

let _peer: MeshPeer | null = null;
let _transport: WsServerTransport | null = null;

/** Create + hydrate the backend mesh peer. Idempotent. */
export function initBackendMesh(): MeshPeer {
  if (_peer) return _peer;
  const { peerId } = getIdentity();
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

  // Persistence tap: committed mesh state → SQLite, generically.
  col.onCommitted((c) => {
    if (c.op === 'remove') r.remove?.(c.id);
    else if (c.doc) r.save?.(c.doc);
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
  return col;
}
