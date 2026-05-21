import { Router } from 'express';
import { getAllNodeKindMeta } from '../signal/registry.js';
import { _vmc, _breathing, _lipsync, _tracking } from './shared.js';

const router: ReturnType<typeof Router> = Router();

function _allGraphDescriptors() {
  return [
    ...(_vmc?.getAllGraphDescriptors()       ?? []),
    ...(_breathing?.getAllGraphDescriptors() ?? []),
    ...(_lipsync?.getAllGraphDescriptors()   ?? []),
    ...(_tracking?.getAllGraphDescriptors()  ?? []),
  ];
}

function _stripPrefix(graphId: string): string {
  const prefixes = ['vmc-pipeline:', 'breathing:', 'lipsync:', 'mediapipe_tracker:'];
  for (const p of prefixes) if (graphId.startsWith(p)) return graphId.slice(p.length);
  return graphId;
}

// All active graph descriptors (implicit + future explicit).
router.get('/signal/graphs', (_req, res) => {
  res.json({ ok: true, data: _allGraphDescriptors() });
});

// Single graph descriptor by id.
router.get('/signal/graphs/:id', (req, res) => {
  const graph = _allGraphDescriptors().find((g) => g.id === req.params.id);
  if (!graph) return res.status(404).json({ ok: false, error: { status: 404, message: 'not found', code: 'NOT_FOUND' } });
  res.json({ ok: true, data: graph });
});

// Live node states for a graph.
router.get('/signal/graphs/:id/node-states', (req, res) => {
  const graphId     = req.params.id;
  const componentId = _stripPrefix(graphId);
  const states =
    graphId.startsWith('breathing:')         ? _breathing?.getStates(componentId) :
    graphId.startsWith('lipsync:')           ? _lipsync?.getStates(componentId) :
    graphId.startsWith('mediapipe_tracker:') ? _tracking?.getStates(componentId) :
    _vmc?.getStates(componentId);
  if (!states) return res.status(404).json({ ok: false, error: { status: 404, message: 'not found', code: 'NOT_FOUND' } });
  res.json({ ok: true, data: states });
});

// Fire a trigger event into a specific node port.
// Body: { nodeId: string, port: string }
router.post('/signal/graphs/:id/fire', (req, res) => {
  const graphId     = req.params.id;
  const componentId = _stripPrefix(graphId);
  const { nodeId, port } = req.body as { nodeId?: string; port?: string };
  if (!nodeId || !port) {
    return res.status(400).json({ ok: false, error: { status: 400, message: 'nodeId and port are required', code: 'VALIDATION_ERROR' } });
  }
  if (graphId.startsWith('mediapipe_tracker:')) {
    if (!_tracking) return res.status(503).json({ ok: false, error: { status: 503, message: 'Tracking manager not ready', code: 'NOT_READY' } });
    _tracking.fireGraphEvent(componentId, nodeId, port);
    return res.json({ ok: true });
  }
  if (!_vmc) return res.status(503).json({ ok: false, error: { status: 503, message: 'VMC manager not ready', code: 'NOT_READY' } });
  _vmc.fireGraphEvent(componentId, nodeId, port);
  res.json({ ok: true });
});

// All registered node kinds with display metadata (drives the node palette).
router.get('/signal/node-kinds', (_req, res) => {
  res.json({ ok: true, data: getAllNodeKindMeta() });
});

export default router;
