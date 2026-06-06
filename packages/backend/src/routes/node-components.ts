import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { refreshAllBehaviorManagers } from './shared.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/scene-nodes/{nodeId}/behaviors:
 *   get:
 *     tags: [behaviors]
 *     summary: List behavioural components attached to a node (vmc_receiver, breathing, lipsync, api_controller, ...)
 *     parameters:
 *       - { in: path, name: nodeId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of node_component rows ordered by sort_order }
 */
router.get('/scene-nodes/:nodeId/behaviors', (req, res) => {
  const data = getDb()
    .prepare(
      'SELECT * FROM behaviors WHERE node_id = ? ORDER BY sort_order'
    )
    .all(req.params.nodeId);
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/scene-nodes/{nodeId}/behaviors:
 *   post:
 *     tags: [behaviors]
 *     summary: Attach a new component to a node; triggers signal-graph manager refresh
 *     parameters:
 *       - { in: path, name: nodeId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateBehavior' }
 *     responses:
 *       201: { description: Component attached; all component managers re-synced }
 *       400: { description: Missing kind, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/scene-nodes/:nodeId/behaviors', (req, res) => {
  const { id, kind, enabled, config, sortOrder } = req.body;
  if (!kind)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'kind is required' } });
  const compId = id ?? randomUUID();
  getDb()
    .prepare(
      'INSERT INTO behaviors (id, node_id, kind, enabled, config, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      compId,
      req.params.nodeId,
      kind,
      enabled ? 1 : 0,
      JSON.stringify(config ?? {}),
      sortOrder ?? 0
    );
  refreshAllBehaviorManagers();
  res
    .status(201)
    .json({
      ok: true,
      data: {
        id: compId,
        node_id: req.params.nodeId,
        kind,
        enabled: enabled ?? true,
        config: config ?? {},
        sort_order: sortOrder ?? 0,
      },
    });
});

/**
 * @openapi
 * /api/behaviors/{id}:
 *   put:
 *     tags: [behaviors]
 *     summary: Update a component's enabled flag or config; triggers manager refresh
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateBehavior' }
 *     responses:
 *       200: { description: Updated; all component managers re-synced }
 */
router.put('/behaviors/:id', (req, res) => {
  const { enabled, config } = req.body;
  getDb()
    .prepare(
      `UPDATE behaviors SET
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
  refreshAllBehaviorManagers();
  res.json({ ok: true, data: { id: req.params.id } });
});

/**
 * @openapi
 * /api/behaviors/{id}:
 *   delete:
 *     tags: [behaviors]
 *     summary: Detach a component; triggers manager refresh which tears down its signal graph
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted; managers re-synced, content: { application/json: { schema: { $ref: '#/components/schemas/EmptyOk' } } } }
 */
router.delete('/behaviors/:id', (req, res) => {
  getDb()
    .prepare('DELETE FROM behaviors WHERE id = ?')
    .run(req.params.id);
  refreshAllBehaviorManagers();
  res.json({ ok: true, data: {} });
});

export default router;
