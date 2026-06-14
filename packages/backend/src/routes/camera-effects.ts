/**
 * Camera-effect routes — written THROUGH the mesh store (§10): the route
 * builds the canonical DTO and writes the collection; the onCommitted tap
 * persists + emits sync.document, and the write fans out with one stamp.
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { getMeshCollection } from '../mesh/index.js';
import { _ws } from './shared.js';

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
router.post('/scene-nodes/:nodeId/effects', async (req, res) => {
  const { id, kind, enabled, config } = req.body;
  if (!kind)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'kind is required' } });
  const col = getMeshCollection('camera_effect');
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  const effectId = id ?? randomUUID();
  const outcome = await col.set(effectId, '', {
    id: effectId,
    nodeId: req.params.nodeId,
    kind,
    enabled: enabled ?? true,
    config: config ?? {},
  }).ack;
  if (outcome.status === 'rejected')
    return res
      .status(500)
      .json({ ok: false, error: { message: outcome.reason } });
  res.status(201).json({
    ok: true,
    data: {
      id: effectId,
      node_id: req.params.nodeId,
      kind,
      enabled: enabled ?? true,
      config: config ?? {},
    },
  });
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
router.put('/camera-effects/:id', async (req, res) => {
  const { enabled, config } = req.body;
  const col = getMeshCollection('camera_effect');
  const cur = col?.get(req.params.id);
  if (!col || !cur)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'camera effect not found' } });
  const outcome = await col.set(req.params.id, '', {
    ...cur,
    ...(enabled != null ? { enabled: !!enabled } : {}),
    ...(config != null ? { config } : {}),
  }).ack;
  if (outcome.status === 'rejected')
    return res
      .status(500)
      .json({ ok: false, error: { message: outcome.reason } });
  // Local smoothing broadcast (the canonical doc re-sync rides the store tap).
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
router.delete('/camera-effects/:id', async (req, res) => {
  const col = getMeshCollection('camera_effect');
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  await col.remove(req.params.id).ack;
  res.json({ ok: true, data: {} });
});

export default router;
