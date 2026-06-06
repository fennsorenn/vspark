import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import {
  logicManager,
  type LogicRow,
} from '../logic/manager.js';

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

router.get('/projects/:projectId/logic', (req, res) => {
  const rows = getDb()
    .prepare(
      "SELECT * FROM logic WHERE owner_kind = 'project' AND owner_id = ? ORDER BY created_at"
    )
    .all(req.params.projectId) as unknown as LogicRow[];
  res.json({ ok: true, data: rows.map(mapLogicRow) });
});

router.post('/projects/:projectId/logic', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'name is required' } });
  const id = randomUUID();
  // Route project graphs through the manager so the new graph starts
  // immediately (and gets validated/reconciled) rather than only on next boot.
  const row = logicManager.create({
    id,
    projectId: req.params.projectId,
    name,
  });
  logicManager.reconcile(id);
  res.status(201).json({ ok: true, data: mapLogicRow(row) });
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

router.post('/scene-nodes/:nodeId/logic', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'name is required' } });
  const id = randomUUID();
  getDb()
    .prepare(
      "INSERT INTO logic (id, owner_kind, owner_id, name) VALUES (?, 'scene_node', ?, ?)"
    )
    .run(id, req.params.nodeId, name);
  // Route through the manager so the new graph starts immediately (it boots
  // empty-descriptor + enabled by default — nothing fires until the user
  // wires nodes via PUT, but having it `running` means subsequent PUTs
  // reconcile cleanly without a server restart).
  logicManager.reconcile(id);
  const row = getDb()
    .prepare('SELECT * FROM logic WHERE id = ?')
    .get(id) as unknown as LogicRow;
  res.status(201).json({ ok: true, data: mapLogicRow(row) });
});

router.get('/compose-layers/:layerId/logic', (req, res) => {
  const rows = getDb()
    .prepare(
      "SELECT * FROM logic WHERE owner_kind = 'compose_layer' AND owner_id = ? ORDER BY created_at"
    )
    .all(req.params.layerId) as unknown as LogicRow[];
  res.json({ ok: true, data: rows.map(mapLogicRow) });
});

router.post('/compose-layers/:layerId/logic', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'name is required' } });
  const id = randomUUID();
  getDb()
    .prepare(
      "INSERT INTO logic (id, owner_kind, owner_id, name) VALUES (?, 'compose_layer', ?, ?)"
    )
    .run(id, req.params.layerId, name);
  logicManager.reconcile(id);
  const row = getDb()
    .prepare('SELECT * FROM logic WHERE id = ?')
    .get(id) as unknown as LogicRow;
  res.status(201).json({ ok: true, data: mapLogicRow(row) });
});

router.put('/logic/:id', (req, res) => {
  const { name, enabled, descriptor } = req.body as {
    name?: string;
    enabled?: boolean;
    descriptor?: unknown;
  };
  const db = getDb();
  const existing = db
    .prepare('SELECT * FROM logic WHERE id = ?')
    .get(req.params.id) as unknown as LogicRow | undefined;
  if (!existing)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'graph not found' } });

  // All logic (project / scene_node / compose_layer) go through
  // the manager so the underlying SignalGraph is reconciled (validated,
  // restarted) after every edit. Behavior-owned graphs aren't reachable
  // via this route — they have no logic row.
  try {
    const row = logicManager.update(req.params.id, {
      ...(name !== undefined ? { name } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(descriptor !== undefined
        ? {
            descriptor: descriptor as Parameters<
              typeof logicManager.update
            >[1]['descriptor'],
          }
        : {}),
    });
    if (!row)
      return res
        .status(404)
        .json({ ok: false, error: { message: 'graph not found' } });
    res.json({ ok: true, data: mapLogicRow(row) });
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

router.delete('/logic/:id', (req, res) => {
  // The manager stops the running instance (if any) and deletes the row.
  // Safe to call for any owner kind — non-running graphs become a no-op stop
  // before the DELETE runs.
  logicManager.remove(req.params.id);
  res.json({ ok: true, data: {} });
});

export default router;
