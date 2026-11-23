/** POST /api/learned-tracker/:behaviorId/restart (routes/learned-tracker.ts) against a stand-in manager. */
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setVmcManager } from '../src/behaviors/refresh.js';
import { makeTestApp } from './helpers/testApp.js';

describe('Learned Tracking restart route', () => {
  afterEach(() => setVmcManager(null as never));

  it('restarts the behavior runtime, 404 when it has none', async () => {
    const { app } = await makeTestApp();
    const asked: string[] = [];
    setVmcManager({
      restartLearnedRuntime: (id: string) => {
        asked.push(id);
        return id === 'b1';
      },
    } as never);
    const ok = await request(app).post('/api/learned-tracker/b1/restart');
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ restarting: true });
    const missing = await request(app).post(
      '/api/learned-tracker/nope/restart'
    );
    expect(missing.status).toBe(404);
    expect(asked).toEqual(['b1', 'nope']);
  });

  it('503 before the manager exists', async () => {
    const { app } = await makeTestApp();
    setVmcManager(null as never);
    const res = await request(app).post('/api/learned-tracker/b1/restart');
    expect(res.status).toBe(503);
  });
});
