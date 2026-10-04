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
import { verifyClientToken } from '../auth/clients.js';
import { getDb } from '../db/index.js';
import { getIdentity } from '../multiplayer/identity.js';
import { getResource } from '../sync/registry.js';
import { sync } from '../sync/index.js';
import {
  queueCollabAssetFollowUp,
  queueAnimationAssetFollowUp,
  setAnimationClipCollection,
} from './assets.js';
import {
  guardClientSceneNode,
  guardClientComposeLayer,
  guardClientNodeChild,
} from './docGuards.js';
import { runtimeOverrideManager } from '../runtime_overrides/manager.js';
import { initMeshRuntime, resetMeshRuntime } from './runtime.js';
import { initPeerGrants } from './peerGrants.js';
import {
  clearStatusOf,
  initServerStatus,
  resetServerStatus,
} from './status.js';
import { refreshAllBehaviorManagers } from '../behaviors/refresh.js';
import { logicLifecycle } from '../logic/lifecycle.js';
import {
  ensurePeerProject,
  isCollabScene,
} from '../multiplayer/collabScene.js';
import { validateDescriptor } from '../logic/manager.js';
import {
  toGraphDescriptor,
  type GraphDescriptorDoc,
} from '@vspark/shared/signal';
import { validateFeedConfig } from '@vspark/shared/feedValidation';
import { broadcastBus } from '../broadcast/bus.js';
import { isClientParticipant } from '@vspark/shared/sync';
import { MODELS } from '@vspark/shared/models';
import '../sync/resources.js'; // side effect: register the descriptors

type Dto = Record<string, unknown>;

/** What only this server adds to a document type declared in
 *  `@vspark/shared/models` (parent, channels and clock fields come from there). */
interface RtypeBinding {
  rtype: string;
  table: string;
  /** Checks that need this server's data, run after the shared declaration's
   *  on the composed document of every committed write, whatever its shape (a
   *  tab's field edit, a REST patch, a collab peer's upsert). Throw to refuse:
   *  the write is nacked and rolled back on its author. Return a different
   *  document to correct it. `origin` is the participant the write came from
   *  (our own id for local writes). */
  validate?: (data: unknown, ctx: { origin: string }) => Dto;
  /** Whether a committed doc belongs to THIS server's data (persist it) or is
   *  a remote projection riding a placed-object subscription (replica-only:
   *  fans out to our tabs, never touches SQLite). §9 step D. */
  persists?: (dto: Dto) => boolean;
  /** What this server's own tabs may do on the collection. Grants are a
   *  whitelist: tabs get exactly these rights and nothing else. */
  clients: TabRights;
  /** Side effects of a committed document, whoever authored it (a REST
   *  route, a tab, an undo, a collab peer) — they run in the persistence tap,
   *  never in a route, or a write that bypasses the route would skip them.
   *  `onRemoving` runs before the row is deleted, the others after. */
  onSaved?: (dto: Dto) => void;
  onRemoving?: (id: string) => void;
  onRemoved?: (id: string) => void;
}

/** camera_view layers show a camera by id — a reference, not containment, so
 *  removeTree can't see them. They go with their camera, through their
 *  collection while the rows still exist (each gets its tombstone; the
 *  database would otherwise cascade-delete the row and leave the document). */
function removeCameraViewsOf(nodeId: string): void {
  const layers = COLLECTIONS.get('compose_layer');
  if (!layers) return;
  for (const { id } of getDb()
    .prepare('SELECT id FROM compose_layers WHERE camera_node_id = ?')
    .all(nodeId) as { id: string }[])
    if (layers.get(id)) layers.remove(id);
}

/** Runtime overrides target a doc by id and outlive its row, so they go
 *  with it. Only scene nodes and compose layers can carry overrides
 *  (ParamTargetKind). */
const clearOverridesOf =
  (rtype: 'scene_node' | 'compose_layer') =>
  (id: string): void =>
    runtimeOverrideManager.clearAllForTarget(rtype, id);

type TabRights = {
  read?: boolean;
  update?: boolean;
  create?: boolean;
  delete?: boolean;
};
/** Tabs author these documents (mesh write helpers in frontend/src/mesh/). */
const TAB_AUTHORED: TabRights = {
  read: true,
  update: true,
  create: true,
  delete: true,
};
/** Servers write these; tabs display them and remove them only together with
 *  the node they belong to. */
const TAB_READ_DELETE: TabRights = { read: true, delete: true };

const rowExists = (table: string, id: unknown): boolean =>
  !!getDb()
    .prepare(`SELECT 1 FROM ${table} WHERE id = ?`)
    .get(id as string);

/** A project of OURS — not one we merely hold for a peer (migration 039). */
const ownProject = (id: unknown): boolean =>
  !!getDb()
    .prepare('SELECT 1 FROM projects WHERE id = ? AND owner_peer_id IS NULL')
    .get(id as string);

const BINDINGS: RtypeBinding[] = [
  {
    rtype: 'scene_node',
    clients: TAB_AUTHORED,
    onRemoving: (id) => {
      clearOverridesOf('scene_node')(id);
      removeCameraViewsOf(id);
    },
    // A scene root's properties are its runtime settings: the running bus
    // re-reads them whoever wrote them.
    onSaved: (d) => {
      if (d.kind === 'scene') broadcastBus.reloadSceneSettings(d.id as string);
    },
    table: 'scene_nodes',
    // Incoming collab docs carry the AUTHOR's project id, and they KEEP it: a
    // document has exactly one truth, so re-scoping it here would give one id
    // different content on two peers (mesh.md principle 2). What used to force
    // the rewrite was the foreign key — we hold a row for the author's project
    // now instead (migration 039).
    //
    // The file path is a different matter and is still localized: it names a
    // file on the SENDER's disk, which is not a fact about the document so much
    // as a pointer into a store we do not share. The follow-up
    // (mesh/assets.ts) fetches the content over the blob protocol and re-points
    // the row at our /uploads/_shared URL once it lands; we keep our existing
    // local path in the interim (so a converged _shared URL isn't clobbered),
    // and a node with no prior path takes the owner path verbatim until the
    // follow-up corrects it.
    validate: (data, { origin: originId }) => {
      let d = { ...(data as Dto) };
      // Writes from a browser tab bypass the REST route, so its
      // server-authoritative checks run here instead, on the document the
      // write would leave behind — a throw nacks the write and the client
      // rolls its optimistic copy back. Collab peers are servers, not
      // clients, and their docs are re-scoped below rather than validated
      // against our data.
      if (isClientParticipant(originId)) d = guardClientSceneNode(d);
      const rootId =
        typeof d.rootSceneNodeId === 'string' ? d.rootSceneNodeId : undefined;
      if (!rootId) return d;
      const link = getDb()
        .prepare(
          'SELECT project_id FROM collab_scenes WHERE scene_id = ? LIMIT 1'
        )
        .get(rootId) as { project_id: string } | undefined;
      if (!link || d.projectId === link.project_id) return d;
      // A collab doc from the author's project: hold a row for that project so
      // the FK holds, and leave the document alone.
      if (typeof d.projectId === 'string')
        ensurePeerProject(d.projectId, originId);
      const incoming = typeof d.filePath === 'string' ? d.filePath : null;
      if (incoming) {
        // queueCollabAssetFollowUp skips when we already hold the content
        // (managed asset at this path, or a _shared/<hash> we already have),
        // so this is safe to call unconditionally.
        queueCollabAssetFollowUp(d.id as string, incoming, rootId);
        const cur = getDb()
          .prepare('SELECT file_path FROM scene_nodes WHERE id = ?')
          .get(d.id as string) as { file_path: string | null } | undefined;
        if (cur?.file_path && cur.file_path !== incoming)
          d.filePath = cur.file_path;
      }
      return d;
    },
    // What we persist is our own data, plus the collab scenes we deliberately
    // keep (authored or mounted — a mount is stored so it survives the author
    // going offline). Everything else is a projection: replica-only, fanned out
    // to tabs, never touching SQLite.
    //
    // This cannot be "does a projects row exist" any more. Peer-owned project
    // rows exist now (migration 039), and a placed-share projection from a peer
    // whose scene we also mount would have one — it must still not persist.
    persists: (d) =>
      ownProject(d.projectId) ||
      (typeof d.rootSceneNodeId === 'string' &&
        isCollabScene(d.rootSceneNodeId)),
  },
  {
    rtype: 'behavior',
    clients: TAB_AUTHORED,
    // Attaching, reconfiguring or detaching a behavior starts, restarts or
    // tears down its signal graph. Each manager re-reads the full row set, so
    // the refresh is idempotent; on remove it runs after the row is gone.
    onSaved: () => refreshAllBehaviorManagers(),
    onRemoved: () => refreshAllBehaviorManagers(),
    // Tabs author behaviors directly now, so the route's owner check runs here
    // — and it matters more than for effects, because a committed behavior doc
    // makes the onCommitted tap instantiate its signal graph.
    validate: (data, { origin }) =>
      isClientParticipant(origin)
        ? guardClientNodeChild(data as Dto, 'behavior')
        : (data as Dto),
    table: 'behaviors',
    persists: (d) => rowExists('scene_nodes', d.nodeId),
  },
  {
    rtype: 'camera_effect',
    clients: TAB_AUTHORED,
    // Tabs author effects directly now, so the route's owner check has to run
    // here too — see guardClientNodeChild. Collab peers are servers, not
    // clients, and their docs are gated by `persists` instead.
    validate: (data, { origin }) =>
      isClientParticipant(origin)
        ? guardClientNodeChild(data as Dto, 'camera_effect')
        : (data as Dto),
    table: 'camera_effects',
    persists: (d) => rowExists('scene_nodes', d.nodeId),
  },
  {
    rtype: 'compose_layer',
    clients: TAB_AUTHORED,
    onRemoving: clearOverridesOf('compose_layer'),
    table: 'compose_layers',
    // Tabs author layers directly (so they land on the authoring tab's undo
    // stack), bypassing the REST route — so its server-owned fields are
    // re-derived here instead. Collab peers are servers, not clients. A feed
    // layer's template/css must compile whoever wrote it: refusing it nacks
    // the write instead of storing markup that renders nothing.
    validate: (data, { origin }) => {
      const d = isClientParticipant(origin)
        ? guardClientComposeLayer({ ...(data as Dto) })
        : (data as Dto);
      const err = validateFeedConfig(d.config);
      if (err) throw new Error(err);
      return d;
    },
    persists: (d) => rowExists('projects', d.projectId),
  },
  {
    rtype: 'track_clip',
    clients: TAB_AUTHORED,
    table: 'track_clips',
    persists: (d) =>
      typeof d.ownerNodeId === 'string'
        ? rowExists('scene_nodes', d.ownerNodeId)
        : typeof d.ownerLayerId === 'string'
          ? rowExists('compose_layers', d.ownerLayerId)
          : false,
  },
  {
    rtype: 'animation_clip',
    // Tabs don't author clips, but deleting a node removes the clips imported
    // from it (removeTree), and that delete is the tab's own action.
    clients: TAB_READ_DELETE,
    table: 'animation_clips',
    persists: (d) => rowExists('scene_nodes', d.sourceNodeId),
    // Path localization. animation_clips has no project column, so foreignness
    // is discriminated by CONTENT resolvability instead (scene_node uses its
    // collab-link projectId):
    //  - incoming path is one of OUR managed asset paths (exact stored_path
    //    row — covers legit local edits AND a receiver's own /_shared cache
    //    entry, which recordCollabAsset registers) → accept it;
    //  - otherwise, an existing row keeps ITS local path: the incoming value
    //    is either a peer's name for content we already hold (their /_shared
    //    URL) or content we lack — in which case the asset follow-up fetches
    //    it and re-points the row once the blob lands.
    validate: (data) => {
      const d = { ...(data as Dto) };
      const incoming =
        typeof d.sourceFilePath === 'string' ? d.sourceFilePath : null;
      if (!incoming) return d;
      // Our own managed path (an exact asset_files stored_path — covers legit
      // local edits AND a receiver's /_shared cache entry, which the
      // follow-up registers) → accept as-is, nothing to fetch.
      if (
        getDb()
          .prepare('SELECT 1 FROM asset_files WHERE stored_path = ? LIMIT 1')
          .get(incoming)
      )
        return d;
      // Foreign path — queue the content fetch in EVERY case, including a
      // clip that's new to this server (the mount-snapshot / live-import
      // case: there's no local row yet, the doc takes the foreign path
      // verbatim until the follow-up re-points it). The follow-up dedupes
      // per (id, path) and skips content we already hold, so repeated
      // arrivals of the same path are no-ops.
      const node = getDb()
        .prepare('SELECT root_scene_node_id FROM scene_nodes WHERE id = ?')
        .get(d.sourceNodeId as string) as
        | { root_scene_node_id: string }
        | undefined;
      if (node)
        queueAnimationAssetFollowUp(
          d.id as string,
          incoming,
          node.root_scene_node_id
        );
      // An existing row keeps ITS local path (the incoming value is a peer's
      // name for the content — ours arrives/exists via the follow-up).
      const cur = getDb()
        .prepare('SELECT source_file_path FROM animation_clips WHERE id = ?')
        .get(d.id as string) as { source_file_path: string } | undefined;
      if (cur && cur.source_file_path !== incoming)
        d.sourceFilePath = cur.source_file_path;
      return d;
    },
  },
  {
    rtype: 'scheduled_animation',
    clients: TAB_READ_DELETE,
    table: 'scheduled_animations',
    // startEpoch is anchored on the writer's clock: the shared declaration
    // lists it as a clock field, and the mesh translates it onto ours as it
    // arrives, so our tabs read it against their clocks like a locally
    // authored timeline.
    persists: (d) => rowExists('scene_nodes', d.avatarNodeId),
  },
  {
    rtype: 'logic',
    clients: TAB_AUTHORED,
    // A graph's descriptor IS its program: committing one starts, restarts or
    // stops the running instance.
    onSaved: (d) => logicLifecycle.onCommitted(d.id as string),
    onRemoved: (id) => logicLifecycle.onRemoved(id),
    table: 'logic',
    // A project-owned graph has no parent (no `project` rtype), so project
    // graphs cannot be subtree-scoped (shared or collab-scoped) until one
    // exists. The descriptor IS the program, so an unrunnable one is refused
    // rather than persisted and left to fail at reconcile. This is the mesh
    // equivalent of the 400 the PUT route used to return, and the only place
    // the check lives, since REST and tabs both write through here. The canvas
    // commits `set(id, 'descriptor', …)`; the check sees the whole document.
    validate: (data) => {
      const d = data as Dto;
      if (d.descriptor)
        validateDescriptor(
          toGraphDescriptor(d.descriptor as GraphDescriptorDoc),
          String(d.ownerKind)
        );
      return d;
    },
    persists: (d) =>
      d.ownerKind === 'project'
        ? rowExists('projects', d.ownerId)
        : d.ownerKind === 'scene_node'
          ? rowExists('scene_nodes', d.ownerId)
          : rowExists('compose_layers', d.ownerId),
  },
  {
    rtype: 'clip_playback',
    clients: TAB_AUTHORED,
    table: 'clip_playback',
    // Parented by clipId (shared declaration); startEpoch is a declared clock
    // field, translated onto our clock by the mesh.
    persists: (d) => rowExists('track_clips', d.clipId),
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

/** Persist a tombstone with where the entity sat (`ancestors`, nearest first):
 *  subtree-scoped grants can only be checked against the old position, which
 *  the containment index forgets on removal (migration 042). */
function saveTombstone(
  rtype: string,
  id: string,
  v: HLC,
  ancestors?: string[]
): void {
  getDb()
    .prepare(
      `INSERT INTO mesh_tombstones (rtype, id, v_t, v_c, v_n, ancestors)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(rtype, id) DO UPDATE SET
         v_t = excluded.v_t, v_c = excluded.v_c, v_n = excluded.v_n,
         ancestors = excluded.ancestors,
         deleted_at = datetime('now')`
    )
    .run(
      rtype,
      id,
      v.t,
      v.c,
      v.n,
      ancestors?.length ? JSON.stringify(ancestors) : null
    );
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
  _transport = new WsServerTransport(peerId, {
    // Only enrolled browsers join (principle 9; see auth/clients.ts).
    authenticate: ({ token }) => verifyClientToken(token) !== null,
  });
  const peer = createMeshPeer({
    identity: { peerId },
    models: MODELS,
    transports: [_transport],
  });

  for (const b of BINDINGS) bindCollection(peer, peerId, b);
  // Runtime state (graph-driven param overrides) lives on its own retained
  // channel rather than in BINDINGS: it never touches SQLite, so it has no
  // table, no resource and no persistence tap. Registered here rather than at
  // the call site so a mesh peer cannot exist without it — a missing runtime
  // collection is silent, and the overrides simply stop arriving.
  initMeshRuntime(peer);
  initServerStatus(peer);
  initPeerGrants(peer);
  // The animation-clip asset follow-up re-points sourceFilePath through the
  // store once a fetched blob lands.
  const animCol = COLLECTIONS.get('animation_clip');
  if (animCol) setAnimationClipCollection(animCol);

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

/** Tear down the backend mesh peer + bound collections so a fresh
 *  `initBackendMesh()` rebuilds from a clean slate. Used by the test harness to
 *  isolate per-test state (the peer is otherwise memoised for the process). */
export function resetBackendMesh(): void {
  _peer?.close();
  _peer = null;
  _transport = null;
  COLLECTIONS.clear();
  resetMeshRuntime();
  resetServerStatus();
}

/** Epoch reset: forget deletion markers for the given ids — replica AND the
 *  persisted mesh_tombstones rows (so a restart can't resurrect them either).
 *  Used when a collab scene is (re-)mounted: the author's snapshot is the
 *  accepted baseline, so any deletions this server made to a detached copy of
 *  those ids must stop competing in LWW (they'd otherwise out-stamp the
 *  author's docs and delete the author's scene through the mutual sync). */
export function purgeMeshTombstones(rtype: string, ids: string[]): void {
  const col = COLLECTIONS.get(rtype);
  for (const id of ids) {
    col?.clearTombstone(id);
    clearTombstone(rtype, id);
  }
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
    validate: b.validate,
    authority: 'self',
    clients: b.clients,
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
        b.onRemoving?.(c.id);
        // Dependents first, while their rows still exist: a node's behaviors,
        // effects, clips and graphs go through their collections (each with a
        // tombstone) instead of being cascade-deleted by the database, which
        // would leave their documents alive in every replica. A tab's delete
        // usually removed them already in the same undo action — then this is
        // a no-op.
        peer.removeTree(c.id);
        clearStatusOf(c.id);
        if (b.persists && !rowExists(b.table, c.id)) return; // never persisted
        r.remove?.(c.id);
        if (c.v) saveTombstone(b.rtype, c.id, c.v, c.ancestors);
        sync.document.remove(b.rtype, c.id);
        b.onRemoved?.(c.id);
      } else if (c.doc) {
        if (b.persists && !b.persists(c.doc)) return;
        // Before persisting: a throw here nacks the write and restores the
        // pre-write state on the author.
        r.save?.(c.doc);
        clearTombstone(b.rtype, c.id);
        sync.document.upsert(b.rtype, c.id);
        b.onSaved?.(c.doc);
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
    .prepare(
      'SELECT id, v_t, v_c, v_n, ancestors FROM mesh_tombstones WHERE rtype = ?'
    )
    .all(b.rtype) as {
    id: string;
    v_t: number;
    v_c: number;
    v_n: string;
    ancestors: string | null;
  }[])
    col.putTombstone(
      t.id,
      { t: t.v_t, c: t.v_c, n: t.v_n },
      t.ancestors ? (JSON.parse(t.ancestors) as string[]) : undefined
    );
  return col;
}
