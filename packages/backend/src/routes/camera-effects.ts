import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { _ws } from './shared.js';

const router: ReturnType<typeof Router> = Router();

router.get('/scene-nodes/:nodeId/effects', (req, res) => {
  const data = getDb().prepare('SELECT * FROM camera_effects WHERE node_id = ?').all(req.params.nodeId);
  res.json({ ok: true, data });
});

router.post('/scene-nodes/:nodeId/effects', (req, res) => {
  const { id, kind, enabled, config } = req.body;
  if (!kind) return res.status(400).json({ ok: false, error: { message: 'kind is required' } });
  const effectId = id ?? randomUUID();
  getDb().prepare('INSERT INTO camera_effects (id, node_id, kind, enabled, config) VALUES (?, ?, ?, ?, ?)')
    .run(effectId, req.params.nodeId, kind, enabled ? 1 : 0, JSON.stringify(config ?? {}));
  const data = { id: effectId, node_id: req.params.nodeId, kind, enabled: enabled ?? true, config: config ?? {} };
  _ws?.broadcast('camera_effect_added', data);
  res.status(201).json({ ok: true, data });
});

router.put('/camera-effects/:id', (req, res) => {
  const { enabled, config } = req.body;
  getDb().prepare(`UPDATE camera_effects SET
      enabled = COALESCE(?, enabled),
      config  = COALESCE(?, config),
      updated_at = datetime('now')
    WHERE id = ?`)
    .run(enabled != null ? (enabled ? 1 : 0) : null, config != null ? JSON.stringify(config) : null, req.params.id);
  _ws?.broadcast('camera_effect_updated', { id: req.params.id, enabled, config });
  res.json({ ok: true, data: { id: req.params.id } });
});

router.delete('/camera-effects/:id', (req, res) => {
  getDb().prepare('DELETE FROM camera_effects WHERE id = ?').run(req.params.id);
  _ws?.broadcast('camera_effect_removed', { id: req.params.id });
  res.json({ ok: true, data: {} });
});

export default router;
