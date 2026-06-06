import { Router } from 'express';
import { networkInterfaces } from 'os';
import { getAllBehaviorKindMeta } from '../node_components/registry.js';
import { _vmc } from './shared.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/behaviors/{id}/body-calib-state:
 *   get:
 *     tags: [meta]
 *     summary: Peek the uncalibrated NormalizedPose at this VMC receiver's body_calibration input
 *     description: Used by the client to seed bodyOffsets without re-implementing VMC parsing.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Current bone rotations as a flat record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:   { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     bones: { type: object, additionalProperties: true }
 *       404: { description: No active receiver or no data yet, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       503: { description: VMC manager not ready,             content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/behaviors/:id/body-calib-state', (req, res) => {
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
  const pose = _vmc.peekBodyCalibInput(req.params.id);
  if (!pose)
    return res
      .status(404)
      .json({
        ok: false,
        error: {
          status: 404,
          message: 'No active receiver or no data yet',
          code: 'NOT_FOUND',
        },
      });
  res.json({ ok: true, data: { bones: pose.toRecord() } });
});

/**
 * @openapi
 * /api/behavior-kinds:
 *   get:
 *     tags: [meta]
 *     summary: List all registered node_component kinds with display metadata
 *     responses:
 *       200: { description: Array of component-kind metadata objects }
 */
router.get('/behavior-kinds', (_req, res) => {
  res.json({ ok: true, data: getAllBehaviorKindMeta() });
});

/**
 * @openapi
 * /api/system/local-ips:
 *   get:
 *     tags: [meta]
 *     summary: List the host's IPv4 addresses (useful for showing the user where to point VMC clients)
 *     responses:
 *       200:
 *         description: IPv4 address list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:   { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     ips: { type: array, items: { type: string } }
 */
router.get('/system/local-ips', (_req, res) => {
  const ifaces = networkInterfaces();
  const ips: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' || (addr.family as unknown) === 4)
        ips.push(addr.address);
    }
  }
  res.json({ ok: true, data: { ips } });
});

export default router;
