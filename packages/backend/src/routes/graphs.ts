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

  if (existing.owner_kind === 'project') {
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
          .json({ ok: false, error: { message: 'project graph not found' } });
      res.json({ ok: true, data: mapGraphRow(row) });
    } catch (e) {
      res
        .status(400)
        .json({
          ok: false,
          error: { message: e instanceof Error ? e.message : String(e) },
        });
    }
    return;
  }

  const cols: string[] = [];
  const vals: unknown[] = [];
  if (name !== undefined) {
    cols.push('name = ?');
    vals.push(name);
  }
  if (enabled !== undefined) {
    cols.push('enabled = ?');
    vals.push(enabled ? 1 : 0);
  }
  if (descriptor !== undefined) {
    cols.push('descriptor = ?');
    vals.push(JSON.stringify(descriptor));
  }
  if (cols.length > 0) {
    cols.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    db.prepare(`UPDATE graphs SET ${cols.join(', ')} WHERE id = ?`).run(
      ...vals
    );
  }
  const row = db
    .prepare('SELECT * FROM graphs WHERE id = ?')
    .get(req.params.id) as unknown as GraphRow;
  res.json({ ok: true, data: mapGraphRow(row) });
});

router.delete('/graphs/:id', (req, res) => {
  const db = getDb();
  const existing = db
    .prepare('SELECT owner_kind FROM graphs WHERE id = ?')
    .get(req.params.id) as { owner_kind: string } | undefined;
  if (existing?.owner_kind === 'project') {
    projectGraphManager.remove(req.params.id);
  } else {
    db.prepare('DELETE FROM graphs WHERE id = ?').run(req.params.id);
  }
  res.json({ ok: true, data: {} });
});

export default router;
