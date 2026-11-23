import { Router } from 'express';
import { execFile } from 'child_process';
import { join } from 'path';
import {
  learnedRuntimeDir,
  learnedRuntimeLocation,
} from '../behaviors/learned_tracker/runtime.js';
import {
  MOTIONTRACKER_RUNTIME,
  downloadStatus,
  isDownloaded,
  startRuntimeDownload,
} from '../behaviors/learned_tracker/download.js';
import { _vmc } from './shared.js';

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

function runtimeInfo() {
  const { dir, source } = learnedRuntimeLocation();
  return {
    version: MOTIONTRACKER_RUNTIME.version,
    bytes: MOTIONTRACKER_RUNTIME.bytes,
    source,
    dir,
    downloaded: isDownloaded(),
    download: downloadStatus(),
  };
}

/**
 * @openapi
 * /api/learned-tracker/runtime:
 *   get:
 *     tags: [behaviors]
 *     summary: Where the Learned Tracking runtime comes from, and the state of its download
 *     description: >
 *       `source`: env (VSPARK_MOTIONTRACKER_PATH), config (config.json learnedTracker.runtimePath),
 *       download (the pinned motiontracker release, downloaded into the install's runtime/ folder),
 *       checkout (a motiontracker folder beside the install) or missing. `version` is the pinned release.
 *     responses:
 *       200:
 *         description: Runtime info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:   { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     version:    { type: string }
 *                     bytes:      { type: integer, description: download size }
 *                     source:     { type: string, enum: [env, config, download, checkout, missing] }
 *                     dir:        { type: string }
 *                     downloaded: { type: boolean }
 *                     download:
 *                       type: object
 *                       properties:
 *                         state:    { type: string, enum: [idle, downloading, error] }
 *                         progress: { type: number, description: 0..1 while downloading }
 *                         message:  { type: string }
 */
router.get('/learned-tracker/runtime', (_req, res) => {
  res.json({ ok: true, data: runtimeInfo() });
});

/**
 * @openapi
 * /api/learned-tracker/runtime/download:
 *   post:
 *     tags: [behaviors]
 *     summary: Download the pinned Learned Tracking runtime from GitHub (background)
 *     description: >
 *       Downloads the motiontracker release asset this vspark version pins, verifies its SHA-256
 *       and unpacks it into the install's runtime/ folder; running Learned Tracking behaviors then
 *       restart on it. Returns at once; poll GET /api/learned-tracker/runtime for progress.
 *     responses:
 *       200:
 *         description: Download started (or already running / done); same body as GET /api/learned-tracker/runtime
 */
router.post('/learned-tracker/runtime/download', (_req, res) => {
  if (!isDownloaded())
    startRuntimeDownload().catch((e: unknown) =>
      console.error('[LearnedTracker] runtime download failed:', e)
    );
  res.json({ ok: true, data: runtimeInfo() });
});

/**
 * @openapi
 * /api/learned-tracker/{behaviorId}/restart:
 *   post:
 *     tags: [behaviors]
 *     summary: Restart a Learned Tracking behavior's runtime process
 *     description: >
 *       Stops the runtime and starts it again (also skipping a pending retry after a crash), e.g.
 *       when the camera stopped sending frames. The new process reports its state through the
 *       behavior's tracking status as usual.
 *     parameters:
 *       - { in: path, name: behaviorId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Restart started }
 *       404: { description: No running Learned Tracking runtime for this behavior }
 *       503: { description: VMC manager not ready }
 */
router.post('/learned-tracker/:behaviorId/restart', (req, res) => {
  if (!_vmc)
    return res.status(503).json({
      ok: false,
      error: {
        status: 503,
        message: 'VMC manager not ready',
        code: 'NOT_READY',
      },
    });
  if (!_vmc.restartLearnedRuntime(req.params.behaviorId))
    return res.status(404).json({
      ok: false,
      error: {
        status: 404,
        message: 'no Learned Tracking runtime for this behavior',
        code: 'NOT_FOUND',
      },
    });
  res.json({ ok: true, data: { restarting: true } });
});

export default router;
