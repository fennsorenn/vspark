import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Signal-graph REST surface.
 *
 * The manager singletons (_vmc, _breathing, _lipsync, _tracking) are null in
 * the test harness (set only by the real entry-point), so:
 *   - GET /signal/graphs          → ok:true, data:[] (no active graphs)
 *   - GET /signal/graphs/:id      → 404 (not in the empty list)
 *   - GET /signal/graphs/:id/node-states → 404 (manager null)
 *   - POST /signal/graphs/:id/fire → 400 (missing nodeId/port) / 404 (unknown)
 *   - GET /signal/node-kinds      → ok:true, data: array of kind meta objects
 */
describe('signal API', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
  });

  it('GET /signal/graphs returns empty list when no managers are active', async () => {
    const res = await request(app).get('/api/signal/graphs');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
  });

  it('GET /signal/graphs/:id returns 404 for unknown graph id', async () => {
    const res = await request(app).get('/api/signal/graphs/vmc-pipeline:missing');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /signal/graphs/:id/node-states returns 404 for unknown graph', async () => {
    const res = await request(app).get(
      '/api/signal/graphs/vmc-pipeline:missing/node-states'
    );
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('POST /signal/graphs/:id/fire returns 400 when nodeId and port are missing', async () => {
    const res = await request(app)
      .post('/api/signal/graphs/vmc-pipeline:any/fire')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/nodeId and port/i);
  });

  it('POST /signal/graphs/:id/fire returns 400 when only nodeId is provided', async () => {
    const res = await request(app)
      .post('/api/signal/graphs/vmc-pipeline:any/fire')
      .send({ nodeId: 'n1' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /signal/graphs/:id/fire returns 400 when only port is provided', async () => {
    const res = await request(app)
      .post('/api/signal/graphs/vmc-pipeline:any/fire')
      .send({ port: 'trigger' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /signal/graphs/:id/fire with bare-uuid graphId fires through logicManager (ok:true) for unknown graph', async () => {
    // When the graphId has no prefix (bare UUID), the route tries logicManager.fire
    // which is a no-op for an unknown graph — still returns ok:true.
    const res = await request(app)
      .post('/api/signal/graphs/00000000-0000-0000-0000-000000000001/fire')
      .send({ nodeId: 'n1', port: 'trigger' });
    // The logicManager silently ignores unknown graphs; no 404 is produced.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /signal/graphs/:id/fire returns 503 when VMC manager is not ready', async () => {
    // Prefix is "vmc-pipeline:" → route checks _vmc (null in test harness)
    const res = await request(app)
      .post('/api/signal/graphs/vmc-pipeline:some-behavior/fire')
      .send({ nodeId: 'n1', port: 'trigger' });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_READY');
  });

  it('POST /signal/graphs/:id/fire returns 503 for mediapipe_tracker prefix', async () => {
    const res = await request(app)
      .post('/api/signal/graphs/mediapipe_tracker:some-id/fire')
      .send({ nodeId: 'n1', port: 'trigger' });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_READY');
  });

  it('GET /signal/node-kinds returns an array of kind metadata objects', async () => {
    const res = await request(app).get('/api/signal/node-kinds');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    // Each entry should have at minimum a `kind` string field
    for (const entry of res.body.data as Array<{ kind: string }>) {
      expect(typeof entry.kind).toBe('string');
    }
  });
});
