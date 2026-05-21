import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { refreshAllComponentManagers } from './shared.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/scene-nodes/{nodeId}/components:
 *   get:
 *     tags: [node_components]
 *     summary: List behavioural components attached to a node (vmc_receiver, breathing, lipsync, api_controller, ...)
 *     parameters:
 *       - { in: path, name: nodeId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of node_component rows ordered by sort_order }
 */
router.get('/scene-nodes/:nodeId/components', (req, res) => {
  const data = getDb().prepare('SELECT * FROM node_components WHERE node_id = ? ORDER BY sort_order').all(req.params.nodeId);
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/scene-nodes/{nodeId}/components:
 *   post:
 *     tags: [node_components]
 *     summary: Attach a new component to a node; triggers signal-graph manager refresh
 *     parameters:
 *       - { in: path, name: nodeId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateNodeComponent' }
 *     responses:
 *       201: { description: Component attached; all component managers re-synced }
 *       400: { description: Missing kind, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/scene-nodes/:nodeId/components', (req, res) => {
  const { id, kind, enabled, config, sortOrder } = req.body;
  if (!kind) return res.status(400).json({ ok: false, error: { message: 'kind is required' } });
  const compId = id ?? randomUUID();
  getDb().prepare('INSERT INTO node_components (id, node_id, kind, enabled, config, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(compId, req.params.nodeId, kind, enabled ? 1 : 0, JSON.stringify(config ?? {}), sortOrder ?? 0);
  refreshAllComponentManagers();
  res.status(201).json({ ok: true, data: { id: compId, node_id: req.params.nodeId, kind, enabled: enabled ?? true, config: config ?? {}, sort_order: sortOrder ?? 0 } });
});

/**
 * @openapi
 * /api/node-components/{id}:
 *   put:
 *     tags: [node_components]
 *     summary: Update a component's enabled flag or config; triggers manager refresh
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateNodeComponent' }
 *     responses:
 *       200: { description: Updated; all component managers re-synced }
 */
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

/**
 * @openapi
 * /api/node-components/{id}:
 *   delete:
 *     tags: [node_components]
 *     summary: Detach a component; triggers manager refresh which tears down its signal graph
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted; managers re-synced, content: { application/json: { schema: { $ref: '#/components/schemas/EmptyOk' } } } }
 */
router.delete('/node-components/:id', (req, res) => {
  getDb().prepare('DELETE FROM node_components WHERE id = ?').run(req.params.id);
  refreshAllComponentManagers();
  res.json({ ok: true, data: {} });
});

export default router;
