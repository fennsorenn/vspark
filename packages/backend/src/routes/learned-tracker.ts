import { Router } from 'express';
import { execFile } from 'child_process';
import { join } from 'path';
import { learnedRuntimeDir } from '../behaviors/learned_tracker/runtime.js';

const router = Router();

/**
 * @openapi
 * /api/learned-tracker/cameras:
 *   get:
 *     tags: [behaviors]
 *     summary: List the cameras the Learned Tracking runtime can open (index = the runtime's camera setting)
 *     description: >
 *       Asks the motiontracker runtime (`mtservice --list-cameras`, started with uv from the
 *       configured checkout). The first call can take minutes while uv installs the runtime.
 *     responses:
 *       200:
 *         description: Camera list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:   { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     cameras:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           index: { type: integer }
 *                           name:  { type: string }
 *       502:
 *         description: The runtime could not be run (not found, uv missing, install failed)
 */
router.get('/learned-tracker/cameras', (_req, res) => {
  const dir = learnedRuntimeDir();
  execFile(
    'uv',
    ['run', '--project', join(dir, 'service'), 'mtservice', '--list-cameras'],
    { timeout: 300000, maxBuffer: 1 << 20 },
    (err, stdout, stderr) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        res.status(502).json({
          ok: false,
          error: {
            status: 502,
            code: 'RUNTIME_UNAVAILABLE',
            message: missing
              ? 'uv not found: install uv to use Learned Tracking'
              : `runtime at ${dir} failed: ${String(stderr).trim().split('\n').slice(-2).join(' ') || err.message}`,
          },
        });
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        const cameras = JSON.parse(lines[lines.length - 1]) as Array<{
          index: number;
          name: string;
        }>;
        res.json({ ok: true, data: { cameras } });
      } catch {
        res.status(502).json({
          ok: false,
          error: {
            status: 502,
            code: 'RUNTIME_UNAVAILABLE',
            message: 'unexpected output from the runtime',
          },
        });
      }
    }
  );
});

export default router;
