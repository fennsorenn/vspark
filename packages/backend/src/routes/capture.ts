/**
 * Capture routes — server-side capture control and the A/B measurement surface.
 *
 * Deliberately minimal: while the two providers are being compared there is no
 * PropertiesPanel UI, i18n or help content for them (that would mean building it twice
 * for a provider that may be deleted). The provider switch and the metrics live here so
 * an A/B/A/B run can be driven inside a single game session, which is the only way to get
 * a trustworthy comparison — scheduling contention is not reproducible across sessions.
 */

import { Router } from 'express';
import { captureMetrics } from '../capture/metrics.js';
import { setReportedDevices } from '../capture/browser_agent/provider.js';
import {
  isCaptureProviderId,
  type CaptureDevice,
  type CaptureProviderId,
} from '../capture/types.js';
import { getCaptureManager, refreshCapture } from './shared.js';

const router: ReturnType<typeof Router> = Router();

/** Provider availability + what each currently has running. */
router.get('/capture/status', async (_req, res) => {
  const mgr = getCaptureManager();
  if (!mgr) {
    res.status(503).json({ ok: false, error: { message: 'capture manager not ready' } });
    return;
  }
  res.json({
    ok: true,
    data: {
      providers: await mgr.statuses(),
      override: mgr.getProviderOverride(),
      errors: mgr.getErrors(),
    },
  });
});

router.get('/capture/devices', async (req, res) => {
  const mgr = getCaptureManager();
  const id = req.query.provider;
  if (!mgr || !isCaptureProviderId(id)) {
    res.status(400).json({
      ok: false,
      error: { message: 'provider must be browser_agent or node_inference' },
    });
    return;
  }
  res.json({ ok: true, data: await mgr.listDevices(id) });
});

/**
 * A running browser agent posts its `enumerateDevices()` result here.
 *
 * This is why the browser-agent provider needs no per-OS device code: the agent page
 * already has a standing permission grant in its persistent profile, so its device list
 * comes back *labelled* without any prompt.
 */
router.post('/capture/devices-report', (req, res) => {
  const body = req.body as { devices?: unknown };
  if (!Array.isArray(body.devices)) {
    res.status(400).json({ ok: false, error: { message: 'devices must be an array' } });
    return;
  }
  const devices: CaptureDevice[] = body.devices
    .filter(
      (d): d is CaptureDevice =>
        !!d &&
        typeof d === 'object' &&
        typeof (d as CaptureDevice).id === 'string' &&
        typeof (d as CaptureDevice).kind === 'string'
    )
    .map((d) => ({ id: d.id, label: d.label ?? '', kind: d.kind }));
  setReportedDevices(devices);
  res.json({ ok: true, data: { count: devices.length } });
});

/**
 * Force every server-sourced behaviour onto one provider (or `null` to honour each
 * behaviour's own config). This is the A/B switch — it restarts capture through the other
 * provider without touching persisted state.
 */
router.put('/capture/provider', (req, res) => {
  const mgr = getCaptureManager();
  if (!mgr) {
    res.status(503).json({ ok: false, error: { message: 'capture manager not ready' } });
    return;
  }
  const { provider } = req.body as { provider?: unknown };
  let next: CaptureProviderId | null;
  if (provider === null || provider === undefined || provider === '') next = null;
  else if (isCaptureProviderId(provider)) next = provider;
  else {
    res.status(400).json({
      ok: false,
      error: { message: 'provider must be browser_agent, node_inference or null' },
    });
    return;
  }
  mgr.setProviderOverride(next);
  refreshCapture();
  res.json({ ok: true, data: { override: next } });
});

/**
 * Delivery metrics. p95/max gap and the stall count are the headline numbers — a mean
 * would hide the multi-hundred-millisecond freeze this whole experiment is about.
 */
router.get('/capture/metrics', (_req, res) => {
  res.json({
    ok: true,
    data: { streams: captureMetrics.snapshot(), csvPath: captureMetrics.getCsvPath() },
  });
});

/** Start/stop CSV logging, and append a labelled sample of the current numbers. */
router.post('/capture/metrics/sample', async (req, res) => {
  const { condition, csvPath, reset } = req.body as {
    condition?: string;
    csvPath?: string | null;
    reset?: boolean;
  };
  if (csvPath !== undefined) captureMetrics.setCsvPath(csvPath);
  const written = await captureMetrics.writeCsvSample(condition ?? 'unlabelled');
  if (reset) captureMetrics.reset();
  res.json({
    ok: true,
    data: { written, csvPath: captureMetrics.getCsvPath(), streams: captureMetrics.snapshot() },
  });
});

export default router;
