/**
 * Behavior routes — the first rtype written THROUGH the mesh store (§10 of
 * dev-notes/plans/mesh-sync-refactor.md): the route validates + builds the
 * canonical DTO and writes the collection; the collection's onCommitted tap
 * persists (resource registry save/remove) and emits sync.document for
 * legacy tabs, and the write fans out to mesh subscribers with ONE stamp.
 * No direct SQL writes, no route-side sync emissions.
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { getMeshCollection } from '../mesh/index.js';
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
 *       200: { description: Array of behaviors rows ordered by sort_order }
 */
router.get('/scene-nodes/:nodeId/behaviors', (req, res) => {
  const data = getDb()
    .prepare('SELECT * FROM behaviors WHERE node_id = ? ORDER BY sort_order')
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
 *       201: { description: Behavior attached; all behavior managers re-synced }
 *       400: { description: Missing kind, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/scene-nodes/:nodeId/behaviors', async (req, res) => {
  const { id, kind, enabled, config, sortOrder } = req.body;
  if (!kind)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'kind is required' } });
  const col = getMeshCollection('behavior');
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  const compId = id ?? randomUUID();
  const outcome = await col.set(compId, '', {
    id: compId,
    nodeId: req.params.nodeId,
    kind,
    enabled: enabled ?? true,
    config: config ?? {},
    sortOrder: sortOrder ?? 0,
  }).ack;
  if (outcome.status === 'rejected')
    return res.status(500).json({ ok: false, error: { message: outcome.reason } });
  refreshAllBehaviorManagers();
  res.status(201).json({
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
 *       200: { description: Updated; all behavior managers re-synced }
 */
router.put('/behaviors/:id', async (req, res) => {
  const { enabled, config } = req.body;
  const col = getMeshCollection('behavior');
  const cur = col?.get(req.params.id);
  if (!col || !cur)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'behavior not found' } });
  const outcome = await col.set(req.params.id, '', {
    ...cur,
    ...(enabled != null ? { enabled: !!enabled } : {}),
    ...(config != null ? { config } : {}),
  }).ack;
  if (outcome.status === 'rejected')
    return res.status(500).json({ ok: false, error: { message: outcome.reason } });
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
router.delete('/behaviors/:id', async (req, res) => {
  const col = getMeshCollection('behavior');
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  await col.remove(req.params.id).ack;
  refreshAllBehaviorManagers();
  res.json({ ok: true, data: {} });
});

export default router;
