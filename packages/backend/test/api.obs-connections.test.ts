import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { EventEmitter } from 'events';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { initObsWsManager } from '../src/obs/ws_manager.js';

/**
 * obs_connections REST CRUD. A fake obs-websocket client is injected into the
 * manager singleton so route mutations (which call refreshProject) never open a
 * real socket.
 */
class FakeClient extends EventEmitter {
  identified = false;
  connect() {}
  close() {}
  async request() {
    return {};
  }
}

describe('obs-connections API', () => {
  let app: Express;
  let projectId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
    // Idempotent — first call wins; supplies the fake factory for the file.
    initObsWsManager(undefined, () => new FakeClient() as never);
    const p = await request(app)
      .post('/api/projects')
      .send({ name: 'P', description: '' });
    projectId = p.body.data.id;
  });

  it('lists empty, then creates and reads back', async () => {
    const empty = await request(app).get(
      `/api/projects/${projectId}/obs-connections`
    );
    expect(empty.body).toEqual({ ok: true, data: [] });

    const create = await request(app)
      .post(`/api/projects/${projectId}/obs-connections`)
      .send({ label: 'Studio', host: 'localhost', port: 4455, password: 'pw' });
    expect(create.body.ok).toBe(true);
    expect(create.body.data).toMatchObject({
      label: 'Studio',
      host: 'localhost',
      port: 4455,
      enabled: true,
      status: expect.any(String),
    });

    const list = await request(app).get(
      `/api/projects/${projectId}/obs-connections`
    );
    expect(list.body.data).toHaveLength(1);
  });

  it('updates and deletes a connection', async () => {
    const create = await request(app)
      .post(`/api/projects/${projectId}/obs-connections`)
      .send({});
    const id = create.body.data.id as string;

    const upd = await request(app)
      .put(`/api/obs-connections/${id}`)
      .send({ port: 4456, enabled: false });
    expect(upd.body.data).toMatchObject({ port: 4456, enabled: false });

    const del = await request(app).delete(`/api/obs-connections/${id}`);
    expect(del.body).toEqual({ ok: true });

    const list = await request(app).get(
      `/api/projects/${projectId}/obs-connections`
    );
    expect(list.body.data).toHaveLength(0);
  });

  it('404s updating a missing connection', async () => {
    const res = await request(app).put('/api/obs-connections/nope').send({});
    expect(res.status).toBe(404);
  });

  it('returns empty inputs when disconnected', async () => {
    const res = await request(app).get(
      `/api/projects/${projectId}/obs/inputs`
    );
    expect(res.body).toEqual({ ok: true, data: [] });
  });
});
