import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import {
  projectGraphManager,
  type GraphRow,
} from '../project_graphs/manager.js';

const router: ReturnType<typeof Router> = Router();

function mapGraphRow(r: GraphRow) {
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

router.get('/projects/:projectId/graphs', (req, res) => {
  const rows = getDb()
    .prepare(
      "SELECT * FROM graphs WHERE owner_kind = 'project' AND owner_id = ? ORDER BY created_at"
    )
    .all(req.params.projectId) as unknown as GraphRow[];
  res.json({ ok: true, data: rows.map(mapGraphRow) });
});

router.post('/projects/:projectId/graphs', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'name is required' } });
  const id = randomUUID();
  // Route project graphs through the manager so the new graph starts
  // immediately (and gets validated/reconciled) rather than only on next boot.
  const row = projectGraphManager.create({
    id,
    projectId: req.params.projectId,
    name,
  });
  projectGraphManager.reconcile(id);
  res.status(201).json({ ok: true, data: mapGraphRow(row) });
});

/** All scene-node- and compose-layer-scoped graphs for a project, in one
 *  query, each tagged with its owner's display name. Powers the "Scoped
 *  Graphs" section of the Graphs panel — the per-owner GET routes below stay
 *  the source of truth for the inline scene-tree / compose-tree lists. */
router.get('/projects/:projectId/scoped-graphs', (req, res) => {
  const db = getDb();
  type ScopedRow = GraphRow & { owner_name: string; owner_node_kind: string };
  const nodeGraphs = db
    .prepare(
      `SELECT g.*, sn.name AS owner_name, sn.kind AS owner_node_kind
       FROM graphs g
       JOIN scene_nodes sn ON sn.id = g.owner_id
       WHERE g.owner_kind = 'scene_node' AND sn.project_id = ?
       ORDER BY g.created_at`
    )
    .all(req.params.projectId) as unknown as ScopedRow[];
  const layerGraphs = db
    .prepare(
      `SELECT g.*, cl.name AS owner_name, cl.kind AS owner_node_kind
       FROM graphs g
       JOIN compose_layers cl ON cl.id = g.owner_id
       WHERE g.owner_kind = 'compose_layer' AND cl.project_id = ?
       ORDER BY g.created_at`
    )
    .all(req.params.projectId) as unknown as ScopedRow[];
  const data = [...nodeGraphs, ...layerGraphs].map((r) => ({
    ...mapGraphRow(r),
    ownerName: r.owner_name,
    ownerNodeKind: r.owner_node_kind,
  }));
  res.json({ ok: true, data });
});

router.get('/scene-nodes/:nodeId/graphs', (req, res) => {
  const rows = getDb()
    .prepare(
      "SELECT * FROM graphs WHERE owner_kind = 'scene_node' AND owner_id = ? ORDER BY created_at"
    )
    .all(req.params.nodeId) as unknown as GraphRow[];
  res.json({ ok: true, data: rows.map(mapGraphRow) });
});

router.post('/scene-nodes/:nodeId/graphs', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'name is required' } });
  const id = randomUUID();
  getDb()
    .prepare(
      "INSERT INTO graphs (id, owner_kind, owner_id, name) VALUES (?, 'scene_node', ?, ?)"
    )
    .run(id, req.params.nodeId, name);
  // Route through the manager so the new graph starts immediately (it boots
  // empty-descriptor + enabled by default — nothing fires until the user
  // wires nodes via PUT, but having it `running` means subsequent PUTs
  // reconcile cleanly without a server restart).
  projectGraphManager.reconcile(id);
  const row = getDb()
    .prepare('SELECT * FROM graphs WHERE id = ?')
    .get(id) as unknown as GraphRow;
  res.status(201).json({ ok: true, data: mapGraphRow(row) });
});

router.get('/compose-layers/:layerId/graphs', (req, res) => {
  const rows = getDb()
    .prepare(
      "SELECT * FROM graphs WHERE owner_kind = 'compose_layer' AND owner_id = ? ORDER BY created_at"
    )
    .all(req.params.layerId) as unknown as GraphRow[];
  res.json({ ok: true, data: rows.map(mapGraphRow) });
});

router.post('/compose-layers/:layerId/graphs', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'name is required' } });
  const id = randomUUID();
  getDb()
    .prepare(
      "INSERT INTO graphs (id, owner_kind, owner_id, name) VALUES (?, 'compose_layer', ?, ?)"
    )
    .run(id, req.params.layerId, name);
  projectGraphManager.reconcile(id);
  const row = getDb()
    .prepare('SELECT * FROM graphs WHERE id = ?')
    .get(id) as unknown as GraphRow;
  res.status(201).json({ ok: true, data: mapGraphRow(row) });
});

router.put('/graphs/:id', (req, res) => {
  const { name, enabled, descriptor } = req.body as {
    name?: string;
    enabled?: boolean;
    descriptor?: unknown;
  };
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM graphs WHERE id = ?')
    .get(req.params.id) as unknown as GraphRow | undefined;
  if (!existing)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'graph not found' } });

  // All standalone graphs (project / scene_node / compose_layer) go through
  // the manager so the underlying SignalGraph is reconciled (validated,
  // restarted) after every edit. Component-owned graphs aren't reachable
  // via this route — they have no graphs row.
  try {
    const row = projectGraphManager.update(req.params.id, {
      ...(name !== undefined ? { name } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(descriptor !== undefined
        ? {
            descriptor: descriptor as Parameters<
              typeof projectGraphManager.update
            >[1]['descriptor'],
          }
        : {}),
    });
    if (!row)
      return res
        .status(404)
        .json({ ok: false, error: { message: 'graph not found' } });
    res.json({ ok: true, data: mapGraphRow(row) });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: { message: e instanceof Error ? e.message : String(e) },
    });
  }
});

/** Generic GET /graphs/:id for any owner kind. Used by the canvas to
 *  open a graph by id without first knowing whether it's project,
 *  scene_node, or compose_layer scoped. */
router.get('/graphs/:id', (req, res) => {
  const row = getDb()
    .prepare('SELECT * FROM graphs WHERE id = ?')
    .get(req.params.id) as unknown as GraphRow | undefined;
  if (!row)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'graph not found' } });
  res.json({ ok: true, data: mapGraphRow(row) });
});

router.delete('/graphs/:id', (req, res) => {
  // The manager stops the running instance (if any) and deletes the row.
  // Safe to call for any owner kind — non-running graphs become a no-op stop
  // before the DELETE runs.
  projectGraphManager.remove(req.params.id);
  res.json({ ok: true, data: {} });
});

export default router;
