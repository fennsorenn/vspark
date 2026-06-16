import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Update-checker REST surface. The in-process module-level state (`_status`,
 * `_downloadPath`) persists between test runs because Node caches the module.
 * We only cover the read-only status path and the gated "no update available"
 * + "download not ready" 400 paths — the actual file-download and process.exit
 * paths are not exercised in unit tests.
 */
describe('update API', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
  });

  it('GET /update-status returns a valid UpdateStatus envelope', async () => {
    const res = await request(app).get('/api/update-status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const d = res.body.data as {
      updateAvailable: boolean;
      downloadReady: boolean;
      currentVersion: string;
      channel: string;
    };
    expect(typeof d.updateAvailable).toBe('boolean');
    expect(typeof d.downloadReady).toBe('boolean');
    expect(typeof d.currentVersion).toBe('string');
    expect(typeof d.channel).toBe('string');
  });

  it('POST /update/download returns 400 when no update is available', async () => {
    // Module state: updateAvailable defaults to false in tests (no version.json
    // + no network call succeeds). The route guards on this flag.
    const res = await request(app).post('/api/update/download');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).toMatch(/no update available/i);
  });

  it('POST /update/apply returns 400 when download is not ready', async () => {
    // _downloadPath is null and _status.downloadReady is false (initial state).
    const res = await request(app).post('/api/update/apply');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).toMatch(/download not ready/i);
  });
});
