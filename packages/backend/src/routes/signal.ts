import { Router } from 'express';
import { getAllNodeKindMeta } from '../signal/registry.js';
import { _vmc, _breathing, _lipsync, _tracking } from './shared.js';
import { logicManager } from '../logic/manager.js';

const router: ReturnType<typeof Router> = Router();

function _allGraphDescriptors() {
  return [
    ...(_vmc?.getAllGraphDescriptors() ?? []),
    ...(_breathing?.getAllGraphDescriptors() ?? []),
    ...(_lipsync?.getAllGraphDescriptors() ?? []),
    ...(_tracking?.getAllGraphDescriptors() ?? []),
  ];
}

function _stripPrefix(graphId: string): string {
  const prefixes = [
    'vmc-pipeline:',
    'breathing:',
    'lipsync:',
    'mediapipe_tracker:',
  ];
  for (const p of prefixes)
    if (graphId.startsWith(p)) return graphId.slice(p.length);
  return graphId;
}

/**
 * @openapi
 * /api/signal/graphs:
 *   get:
 *     tags: [signal]
 *     summary: List all active signal-graph descriptors across every behavior manager
 *     responses:
 *       200: { description: Array of GraphDescriptor objects }
 */
router.get('/signal/graphs', (_req, res) => {
  res.json({ ok: true, data: _allGraphDescriptors() });
});

/**
 * @openapi
 * /api/signal/graphs/{id}:
 *   get:
 *     tags: [signal]
 *     summary: Fetch a single signal-graph descriptor by id
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 'Graph id with manager prefix (e.g. "vmc-pipeline:<behaviorId>")' }
 *     responses:
 *       200: { description: GraphDescriptor object }
 *       404: { description: Not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/signal/graphs/:id', (req, res) => {
  const graph = _allGraphDescriptors().find((g) => g.id === req.params.id);
  if (!graph)
    return res
      .status(404)
      .json({
        ok: false,
        error: { status: 404, message: 'not found', code: 'NOT_FOUND' },
      });
  res.json({ ok: true, data: graph });
});

/**
 * @openapi
 * /api/signal/graphs/{id}/node-states:
 *   get:
 *     tags: [signal]
 *     summary: Read the live node-state snapshot for an active graph
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Map of nodeId → current state }
 *       404: { description: Graph not active, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/signal/graphs/:id/node-states', (req, res) => {
  const graphId = req.params.id;
  // Standalone project graphs use bare UUIDs (no prefix). Try those first.
  if (!graphId.includes(':')) {
    const pgStates = logicManager.getStates(graphId);
    if (pgStates) return res.json({ ok: true, data: pgStates });
  }
  const behaviorId = _stripPrefix(graphId);
  const states = graphId.startsWith('breathing:')
    ? _breathing?.getStates(behaviorId)
    : graphId.startsWith('lipsync:')
      ? _lipsync?.getStates(behaviorId)
      : graphId.startsWith('mediapipe_tracker:')
        ? _tracking?.getStates(behaviorId)
        : _vmc?.getStates(behaviorId);
  if (!states)
    return res
      .status(404)
      .json({
        ok: false,
        error: { status: 404, message: 'not found', code: 'NOT_FOUND' },
      });
  res.json({ ok: true, data: states });
});

/**
 * @openapi
 * /api/signal/graphs/{id}/fire:
 *   post:
 *     tags: [signal]
 *     summary: Fire a trigger event into a specific node port on a running graph
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/FireGraphEvent' }
 *     responses:
 *       200: { description: Event dispatched }
 *       400: { description: Missing nodeId/port, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       503: { description: Target manager not ready, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/signal/graphs/:id/fire', (req, res) => {
  const graphId = req.params.id;
  const { nodeId, port } = req.body as { nodeId?: string; port?: string };
  if (!nodeId || !port) {
    return res
      .status(400)
      .json({
        ok: false,
        error: {
          status: 400,
          message: 'nodeId and port are required',
          code: 'VALIDATION_ERROR',
        },
      });
  }
  // Standalone project graphs fire through the LogicManager.
  if (!graphId.includes(':')) {
    logicManager.fire(graphId, nodeId, port, undefined);
    return res.json({ ok: true });
  }
  const behaviorId = _stripPrefix(graphId);
  if (graphId.startsWith('mediapipe_tracker:')) {
    if (!_tracking)
      return res
        .status(503)
        .json({
          ok: false,
          error: {
            status: 503,
            message: 'Tracking manager not ready',
            code: 'NOT_READY',
          },
        });
    _tracking.fireGraphEvent(behaviorId, nodeId, port);
    return res.json({ ok: true });
  }
  if (!_vmc)
    return res
      .status(503)
      .json({
        ok: false,
        error: {
          status: 503,
          message: 'VMC manager not ready',
          code: 'NOT_READY',
        },
      });
  _vmc.fireGraphEvent(behaviorId, nodeId, port);
  res.json({ ok: true });
});

/**
 * @openapi
 * /api/signal/node-kinds:
 *   get:
 *     tags: [signal]
 *     summary: List all registered signal-node kinds with display metadata (drives the node palette UI)
 *     responses:
 *       200: { description: Array of node-kind metadata objects }
 */
router.get('/signal/node-kinds', (_req, res) => {
  res.json({ ok: true, data: getAllNodeKindMeta() });
});

export default router;
