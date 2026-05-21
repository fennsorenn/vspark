import { Router } from 'express';
import { z } from 'zod';
import {
  apiControllerAnimationSchema,
  apiControllerAnimationQueueSchema,
  apiControllerBlendshapesSchema,
} from '@vspark/shared/schema';
import { _apiController, _resolveApiController } from './shared.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/projects/{projectId}/nodes/{nodeId}/api-controller/state:
 *   get:
 *     tags: [api_controller]
 *     summary: Read the current animation queue, loop mode, start time, and active blendshapes
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: nodeId,    required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Live state of the api_controller component on this node
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:   { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     queue:       { type: array, items: { type: object } }
 *                     loopMode:    { type: string, enum: [none, last, queue] }
 *                     startedAt:   { type: number }
 *                     blendshapes: { type: object, additionalProperties: { type: number } }
 *       404: { description: Node or component not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       503: { description: Manager not ready,           content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/projects/:projectId/nodes/:nodeId/api-controller/state', (req, res) => {
  const resolved = _resolveApiController(req.params.projectId, req.params.nodeId);
  if ('error' in resolved) return res.status(resolved.error.status).json({ ok: false, error: resolved.error });
  const state = _apiController!.getState(resolved.componentId);
  if (!state) return res.status(404).json({ ok: false, error: { status: 404, message: 'state not found', code: 'NOT_FOUND' } });
  res.json({
    ok: true,
    data: {
      queue:       state.queue,
      loopMode:    state.loopMode,
      startedAt:   state.startedAt,
      blendshapes: state.blendshapes.toRecord(),
    },
  });
});

/**
 * @openapi
 * /api/projects/{projectId}/nodes/{nodeId}/api-controller/animation:
 *   put:
 *     tags: [api_controller]
 *     summary: Trigger a single animation (replaces the queue with one entry; loopMode = "last")
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: nodeId,    required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ApiControllerAnimation' }
 *     responses:
 *       200: { description: Animation queued }
 *       400: { description: Invalid body or unknown clip, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       404: { description: Node or component not found,  content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.put('/projects/:projectId/nodes/:nodeId/api-controller/animation', (req, res) => {
  const resolved = _resolveApiController(req.params.projectId, req.params.nodeId);
  if ('error' in resolved) return res.status(resolved.error.status).json({ ok: false, error: resolved.error });
  const parsed = apiControllerAnimationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: { status: 400, message: z.prettifyError(parsed.error), code: 'VALIDATION_ERROR' } });
  try {
    _apiController!.setAnimationQueue(resolved.componentId, [{ animation: parsed.data.animation }], 'last');
    res.json({ ok: true, data: {} });
  } catch (e) {
    res.status(400).json({ ok: false, error: { status: 400, message: (e as Error).message, code: 'CLIP_NOT_FOUND' } });
  }
});

/**
 * @openapi
 * /api/projects/{projectId}/nodes/{nodeId}/api-controller/animation-queue:
 *   put:
 *     tags: [api_controller]
 *     summary: Replace the animation queue with an ordered list and set the loop mode
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: nodeId,    required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ApiControllerAnimationQueue' }
 *     responses:
 *       200: { description: Queue accepted }
 *       400: { description: Invalid body or unknown clip, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       404: { description: Node or component not found,  content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.put('/projects/:projectId/nodes/:nodeId/api-controller/animation-queue', (req, res) => {
  const resolved = _resolveApiController(req.params.projectId, req.params.nodeId);
  if ('error' in resolved) return res.status(resolved.error.status).json({ ok: false, error: resolved.error });
  const parsed = apiControllerAnimationQueueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: { status: 400, message: z.prettifyError(parsed.error), code: 'VALIDATION_ERROR' } });
  try {
    _apiController!.setAnimationQueue(resolved.componentId, parsed.data.queue, parsed.data.loopMode ?? 'none');
    res.json({ ok: true, data: {} });
  } catch (e) {
    res.status(400).json({ ok: false, error: { status: 400, message: (e as Error).message, code: 'CLIP_NOT_FOUND' } });
  }
});

/**
 * @openapi
 * /api/projects/{projectId}/nodes/{nodeId}/api-controller/blendshapes:
 *   put:
 *     tags: [api_controller]
 *     summary: Apply a blendshape preset (single name @ weight 1.0) or an explicit weights map
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: nodeId,    required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ApiControllerBlendshapes' }
 *     responses:
 *       200: { description: Blendshapes applied }
 *       400: { description: Invalid body, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.put('/projects/:projectId/nodes/:nodeId/api-controller/blendshapes', (req, res) => {
  const resolved = _resolveApiController(req.params.projectId, req.params.nodeId);
  if ('error' in resolved) return res.status(resolved.error.status).json({ ok: false, error: resolved.error });
  const parsed = apiControllerBlendshapesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: { status: 400, message: z.prettifyError(parsed.error), code: 'VALIDATION_ERROR' } });
  const weights = 'preset' in parsed.data
    ? { [parsed.data.preset]: 1.0 }
    : parsed.data.blendshapes;
  _apiController!.setBlendshapes(resolved.componentId, weights);
  res.json({ ok: true, data: {} });
});

/**
 * @openapi
 * /api/projects/{projectId}/nodes/{nodeId}/api-controller/blendshapes:
 *   delete:
 *     tags: [api_controller]
 *     summary: Clear all active blendshape weights for this api_controller component
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: nodeId,    required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Cleared, content: { application/json: { schema: { $ref: '#/components/schemas/EmptyOk' } } } }
 */
router.delete('/projects/:projectId/nodes/:nodeId/api-controller/blendshapes', (req, res) => {
  const resolved = _resolveApiController(req.params.projectId, req.params.nodeId);
  if ('error' in resolved) return res.status(resolved.error.status).json({ ok: false, error: resolved.error });
  _apiController!.clearBlendshapes(resolved.componentId);
  res.json({ ok: true, data: {} });
});

export default router;
