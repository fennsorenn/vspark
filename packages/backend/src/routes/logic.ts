/**
 * Logic (signal-graph) routes — written THROUGH the mesh store: the route
 * builds the canonical DTO and writes the `logic` collection, and the
 * onCommitted tap persists it and reconciles the running instance. The routes
 * stay available to outside services; they just no longer own the write.
 *
 * Writing SQLite directly here would leave every connected tab showing stale
 * graphs until its next reload — the replica is what tabs read now.
 *
 * Descriptor validation moved to the collection's `validate` hook, so a graph
 * authored by a tab is checked on exactly the same terms as one PUT over REST.
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { getMeshCollection } from '../mesh/index.js';
import { type LogicRow } from '../logic/manager.js';

/** The collection, or null when the mesh isn't up (tests that skip it). */
const logicCol = () => getMeshCollection('logic');

/** Commit a whole logic doc, answering 500/400 on refusal. Returns false when
 *  the response has already been sent. */
async function commit(
  res: import('express').Response,
  id: string,
  doc: Record<string, unknown>
): Promise<boolean> {
  const col = logicCol();
  if (!col) {
    res.status(500).json({ ok: false, error: { message: 'store not ready' } });
    return false;
  }
  const outcome = await col.set(id, '', doc).ack;
  if (outcome.status === 'rejected') {
    // A refusal here is a rejected descriptor far more often than a broken
    // store, and that is a 400 — same status the manager's throw produced.
    res.status(400).json({ ok: false, error: { message: outcome.reason } });
    return false;
  }
  return true;
}

/** Read a row back for the response body. The DTO the route just wrote lacks
 *  the DB-generated timestamps, so the row is the honest answer. */
const rowOf = (id: string) =>
  getDb().prepare('SELECT * FROM logic WHERE id = ?').get(id) as unknown as
    | LogicRow
    | undefined;

const router: ReturnType<typeof Router> = Router();

function mapLogicRow(r: LogicRow) {
  return {
    id: r.id,
    ownerKind: r.owner_kind,
    ownerId: r.owner_id,
    name: r.name,
    enabled: r.enabled === 1,
    descriptor: JSON.parse(r.descriptor),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Create one graph on any owner and answer 201 with the stored row. New
 *  graphs boot enabled with an empty descriptor: nothing fires until the user
 *  wires nodes, but the instance is running, so later edits reconcile without
 *  a restart. */
async function created(
  res: import('express').Response,
  id: string,
  ownerKind: string,
  ownerId: string,
  name: string
): Promise<boolean> {
  if (
    !(await commit(res, id, {
      id,
      ownerKind,
      ownerId,
      name,
      enabled: true,
      descriptor: { nodes: [], edges: [] },
    }))
  )
    return false;
  const row = rowOf(id);
  if (!row) {
    res
      .status(500)
      .json({ ok: false, error: { message: 'graph was not persisted' } });
    return false;
  }
  res.status(201).json({ ok: true, data: mapLogicRow(row) });
  return true;
}

router.get('/projects/:projectId/logic', (req, res) => {
  const rows = getDb()
    .prepare(
      "SELECT * FROM logic WHERE owner_kind = 'project' AND owner_id = ? ORDER BY created_at"
    )
    .all(req.params.projectId) as unknown as LogicRow[];
  res.json({ ok: true, data: rows.map(mapLogicRow) });
});

router.post('/projects/:projectId/logic', async (req, res) => {
  const { id: clientId, name } = req.body as { id?: string; name?: string };
  if (!name)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'name is required' } });
  const id = clientId ?? randomUUID();
  if (!(await created(res, id, 'project', req.params.projectId, name))) return;
});

/** All scene-node- and compose-layer-scoped graphs for a project, in one
 *  query, each tagged with its owner's display name. Powers the "Scoped
 *  Graphs" section of the Graphs panel — the per-owner GET routes below stay
 *  the source of truth for the inline scene-tree / compose-tree lists. */
router.get('/projects/:projectId/scoped-logic', (req, res) => {
  const db = getDb();
  type ScopedRow = LogicRow & { owner_name: string; owner_node_kind: string };
  const nodeLogic = db
    .prepare(
      `SELECT g.*, sn.name AS owner_name, sn.kind AS owner_node_kind
       FROM logic g
       JOIN scene_nodes sn ON sn.id = g.owner_id
       WHERE g.owner_kind = 'scene_node' AND sn.project_id = ?
       ORDER BY g.created_at`
    )
    .all(req.params.projectId) as unknown as ScopedRow[];
  const layerLogic = db
    .prepare(
      `SELECT g.*, cl.name AS owner_name, cl.kind AS owner_node_kind
       FROM logic g
       JOIN compose_layers cl ON cl.id = g.owner_id
       WHERE g.owner_kind = 'compose_layer' AND cl.project_id = ?
       ORDER BY g.created_at`
    )
    .all(req.params.projectId) as unknown as ScopedRow[];
  const data = [...nodeLogic, ...layerLogic].map((r) => ({
    ...mapLogicRow(r),
    ownerName: r.owner_name,
    ownerNodeKind: r.owner_node_kind,
  }));
  res.json({ ok: true, data });
});

router.get('/scene-nodes/:nodeId/logic', (req, res) => {
  const rows = getDb()
    .prepare(
      "SELECT * FROM logic WHERE owner_kind = 'scene_node' AND owner_id = ? ORDER BY created_at"
    )
    .all(req.params.nodeId) as unknown as LogicRow[];
  res.json({ ok: true, data: rows.map(mapLogicRow) });
});

router.post('/scene-nodes/:nodeId/logic', async (req, res) => {
  const { id: clientId, name } = req.body as { id?: string; name?: string };
  if (!name)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'name is required' } });
  const id = clientId ?? randomUUID();
  if (!(await created(res, id, 'scene_node', req.params.nodeId, name))) return;
});

router.get('/compose-layers/:layerId/logic', (req, res) => {
  const rows = getDb()
    .prepare(
      "SELECT * FROM logic WHERE owner_kind = 'compose_layer' AND owner_id = ? ORDER BY created_at"
    )
    .all(req.params.layerId) as unknown as LogicRow[];
  res.json({ ok: true, data: rows.map(mapLogicRow) });
});

router.post('/compose-layers/:layerId/logic', async (req, res) => {
  const { id: clientId, name } = req.body as { id?: string; name?: string };
  if (!name)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'name is required' } });
  const id = clientId ?? randomUUID();
  if (!(await created(res, id, 'compose_layer', req.params.layerId, name)))
    return;
});

router.put('/logic/:id', async (req, res) => {
  const { name, enabled, descriptor } = req.body as {
    name?: string;
    enabled?: boolean;
    descriptor?: unknown;
  };
  const col = logicCol();
  const cur = col?.get(req.params.id) as Record<string, unknown> | undefined;
  if (!col || !cur)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'graph not found' } });

  // The reconcile that used to live in logicManager.update now rides the
  // onCommitted tap, so it fires for a tab's write as well as this one.
  const doc = {
    ...cur,
    ...(name !== undefined ? { name } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(descriptor !== undefined ? { descriptor } : {}),
  };
  if (!(await commit(res, req.params.id, doc))) return;
  const row = rowOf(req.params.id);
  if (!row)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'graph not found' } });
  res.json({ ok: true, data: mapLogicRow(row) });
});

/** Generic GET /graphs/:id for any owner kind. Used by the canvas to
 *  open a graph by id without first knowing whether it's project,
 *  scene_node, or compose_layer scoped. */
router.get('/logic/:id', (req, res) => {
  const row = getDb()
    .prepare('SELECT * FROM logic WHERE id = ?')
    .get(req.params.id) as unknown as LogicRow | undefined;
  if (!row)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'graph not found' } });
  res.json({ ok: true, data: mapLogicRow(row) });
});

router.delete('/logic/:id', async (req, res) => {
  const col = logicCol();
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  // The tap stops the running instance and deletes the row. A remove of an
  // unknown id is a no-op, matching the old manager call.
  await col.remove(req.params.id).ack;
  res.json({ ok: true, data: {} });
});

export default router;
