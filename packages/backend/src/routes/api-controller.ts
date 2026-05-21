import { Router } from 'express';
import {
  apiControllerAnimationSchema,
  apiControllerAnimationQueueSchema,
  apiControllerBlendshapesSchema,
} from '@vspark/shared/schema';
import { _apiController, _resolveApiController } from './shared.js';

const router: ReturnType<typeof Router> = Router();

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

router.put('/projects/:projectId/nodes/:nodeId/api-controller/animation', (req, res) => {
  const resolved = _resolveApiController(req.params.projectId, req.params.nodeId);
  if ('error' in resolved) return res.status(resolved.error.status).json({ ok: false, error: resolved.error });
  const parsed = apiControllerAnimationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: { status: 400, message: parsed.error.message, code: 'VALIDATION_ERROR' } });
  try {
    _apiController!.setAnimationQueue(resolved.componentId, [{ animation: parsed.data.animation }], 'last');
    res.json({ ok: true, data: {} });
  } catch (e) {
    res.status(400).json({ ok: false, error: { status: 400, message: (e as Error).message, code: 'CLIP_NOT_FOUND' } });
  }
});

router.put('/projects/:projectId/nodes/:nodeId/api-controller/animation-queue', (req, res) => {
  const resolved = _resolveApiController(req.params.projectId, req.params.nodeId);
  if ('error' in resolved) return res.status(resolved.error.status).json({ ok: false, error: resolved.error });
  const parsed = apiControllerAnimationQueueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: { status: 400, message: parsed.error.message, code: 'VALIDATION_ERROR' } });
  try {
    _apiController!.setAnimationQueue(resolved.componentId, parsed.data.queue, parsed.data.loopMode ?? 'none');
    res.json({ ok: true, data: {} });
  } catch (e) {
    res.status(400).json({ ok: false, error: { status: 400, message: (e as Error).message, code: 'CLIP_NOT_FOUND' } });
  }
});

router.put('/projects/:projectId/nodes/:nodeId/api-controller/blendshapes', (req, res) => {
  const resolved = _resolveApiController(req.params.projectId, req.params.nodeId);
  if ('error' in resolved) return res.status(resolved.error.status).json({ ok: false, error: resolved.error });
  const parsed = apiControllerBlendshapesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: { status: 400, message: parsed.error.message, code: 'VALIDATION_ERROR' } });
  const weights = 'preset' in parsed.data
    ? { [parsed.data.preset]: 1.0 }
    : parsed.data.blendshapes;
  _apiController!.setBlendshapes(resolved.componentId, weights);
  res.json({ ok: true, data: {} });
});

router.delete('/projects/:projectId/nodes/:nodeId/api-controller/blendshapes', (req, res) => {
  const resolved = _resolveApiController(req.params.projectId, req.params.nodeId);
  if ('error' in resolved) return res.status(resolved.error.status).json({ ok: false, error: resolved.error });
  _apiController!.clearBlendshapes(resolved.componentId);
  res.json({ ok: true, data: {} });
});

export default router;
