import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Exemplar API integration test. Drives the real route handlers + Express app
 * (via `createApp`) against a fresh in-memory SQLite DB, exercising the full
 * REST → DB → REST round-trip without binding any sockets or starting managers.
 */
describe('projects API', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
  });

  it('starts with no projects', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [] });
  });

  it('creates a project and reads it back', async () => {
    const create = await request(app)
      .post('/api/projects')
      .send({ name: 'My Project', description: 'a test' });

    expect(create.status).toBe(201);
    expect(create.body.ok).toBe(true);
    expect(create.body.data).toMatchObject({ name: 'My Project', description: 'a test' });
    const id = create.body.data.id as string;
    expect(id).toBeTruthy();

    // Read-back proves the row was actually persisted, not just echoed.
    const list = await request(app).get('/api/projects');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id, name: 'My Project' });
  });

  it('rejects a project without a name', async () => {
    const res = await request(app).post('/api/projects').send({ description: 'no name' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('isolates state between tests (in-memory DB reset)', async () => {
    // If the beforeEach reset didn't work, the project from the previous test
    // would leak in here.
    const res = await request(app).get('/api/projects');
    expect(res.body.data).toEqual([]);
  });
});
