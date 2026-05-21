import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { refreshAllComponentManagers } from './shared.js';

const router: ReturnType<typeof Router> = Router();

router.get('/scene-nodes/:nodeId/components', (req, res) => {
  const data = getDb().prepare('SELECT * FROM node_components WHERE node_id = ? ORDER BY sort_order').all(req.params.nodeId);
  res.json({ ok: true, data });
});

router.post('/scene-nodes/:nodeId/components', (req, res) => {
  const { id, kind, enabled, config, sortOrder } = req.body;
  if (!kind) return res.status(400).json({ ok: false, error: { message: 'kind is required' } });
  const compId = id ?? randomUUID();
  getDb().prepare('INSERT INTO node_components (id, node_id, kind, enabled, config, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(compId, req.params.nodeId, kind, enabled ? 1 : 0, JSON.stringify(config ?? {}), sortOrder ?? 0);
  refreshAllComponentManagers();
  res.status(201).json({ ok: true, data: { id: compId, node_id: req.params.nodeId, kind, enabled: enabled ?? true, config: config ?? {}, sort_order: sortOrder ?? 0 } });
});

router.put('/node-components/:id', (req, res) => {
  const { enabled, config } = req.body;
  getDb().prepare(`UPDATE node_components SET
      enabled = COALESCE(?, enabled),
      config  = COALESCE(?, config),
      updated_at = datetime('now')
    WHERE id = ?`)
    .run(enabled != null ? (enabled ? 1 : 0) : null, config != null ? JSON.stringify(config) : null, req.params.id);
  refreshAllComponentManagers();
  res.json({ ok: true, data: { id: req.params.id } });
});

router.delete('/node-components/:id', (req, res) => {
  getDb().prepare('DELETE FROM node_components WHERE id = ?').run(req.params.id);
  refreshAllComponentManagers();
  res.json({ ok: true, data: {} });
});

export default router;
