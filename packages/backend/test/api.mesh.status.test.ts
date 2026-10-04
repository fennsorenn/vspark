import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/** GET /api/mesh/status: this server's links and its tabs' direct paths. */
describe('GET /api/mesh/status', () => {
  let app: Express;
  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
  });

  it('reports no links and no direct paths when nothing is connected', async () => {
    const r = await request(app).get('/api/mesh/status');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ peers: [], direct: {} });
  });
});
