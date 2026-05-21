import { Router } from 'express';
import { networkInterfaces } from 'os';
import { getAllComponentKindMeta } from '../node_components/registry.js';
import { _vmc } from './shared.js';

const router: ReturnType<typeof Router> = Router();

// Returns the uncalibrated NormalizedPose currently at the body_calibration
// node's input for this VMC receiver component. The client uses this to
// populate bodyOffsets without needing to read raw VMC data itself.
router.get('/node-components/:id/body-calib-state', (req, res) => {
  if (!_vmc) return res.status(503).json({ ok: false, error: { status: 503, message: 'VMC manager not ready', code: 'NOT_READY' } });
  const pose = _vmc.peekBodyCalibInput(req.params.id);
  if (!pose) return res.status(404).json({ ok: false, error: { status: 404, message: 'No active receiver or no data yet', code: 'NOT_FOUND' } });
  res.json({ ok: true, data: { bones: pose.toRecord() } });
});

router.get('/component-kinds', (_req, res) => {
  res.json({ ok: true, data: getAllComponentKindMeta() });
});

router.get('/system/local-ips', (_req, res) => {
  const ifaces = networkInterfaces();
  const ips: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' || (addr.family as unknown) === 4) ips.push(addr.address);
    }
  }
  res.json({ ok: true, data: { ips } });
});

export default router;
