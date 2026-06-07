import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { _ws } from './shared.js';
import { sync } from '../sync/index.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/scene-nodes/{nodeId}/effects:
 *   get:
 *     tags: [camera_effects]
 *     summary: List post-processing effects bound to a camera node
 *     parameters:
 *       - { in: path, name: nodeId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of camera_effect rows }
 */
router.get('/scene-nodes/:nodeId/effects', (req, res) => {
  const data = getDb()
    .prepare('SELECT * FROM camera_effects WHERE node_id = ?')
    .all(req.params.nodeId);
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/scene-nodes/{nodeId}/effects:
 *   post:
 *     tags: [camera_effects]
 *     summary: Add a new camera effect to a node
 *     parameters:
 *       - { in: path, name: nodeId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateCameraEffect' }
 *     responses:
 *       201: { description: Effect created; broadcast as camera_effect_added over WebSocket }
 *       400: { description: Missing kind, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/scene-nodes/:nodeId/effects', (req, res) => {
  const { id, kind, enabled, config } = req.body;
  if (!kind)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'kind is required' } });
  const effectId = id ?? randomUUID();
  getDb()
    .prepare(
      'INSERT INTO camera_effects (id, node_id, kind, enabled, config) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      effectId,
      req.params.nodeId,
      kind,
      enabled ? 1 : 0,
      JSON.stringify(config ?? {})
    );
  const data = {
    id: effectId,
    node_id: req.params.nodeId,
    kind,
    enabled: enabled ?? true,
    config: config ?? {},
  };
  sync.document.upsert('camera_effect', effectId);
  res.status(201).json({ ok: true, data });
});

/**
 * @openapi
 * /api/camera-effects/{id}:
 *   put:
 *     tags: [camera_effects]
 *     summary: Update a camera effect's enabled flag or config
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateCameraEffect' }
 *     responses:
 *       200: { description: Updated; broadcast as camera_effect_updated over WebSocket }
 */
router.put('/camera-effects/:id', (req, res) => {
  const { enabled, config } = req.body;
  getDb()
    .prepare(
      `UPDATE camera_effects SET
      enabled = COALESCE(?, enabled),
      config  = COALESCE(?, config),
      updated_at = datetime('now')
    WHERE id = ?`
    )
    .run(
      enabled != null ? (enabled ? 1 : 0) : null,
      config != null ? JSON.stringify(config) : null,
      req.params.id
    );
  _ws?.broadcast('camera_effect_updated', {
    id: req.params.id,
    enabled,
    config,
  });
  res.json({ ok: true, data: { id: req.params.id } });
});

/**
 * @openapi
 * /api/camera-effects/{id}:
 *   delete:
 *     tags: [camera_effects]
 *     summary: Remove a camera effect
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted; broadcast as camera_effect_removed over WebSocket }
 */
router.delete('/camera-effects/:id', (req, res) => {
  getDb().prepare('DELETE FROM camera_effects WHERE id = ?').run(req.params.id);
  sync.document.remove('camera_effect', req.params.id);
  res.json({ ok: true, data: {} });
});

export default router;
