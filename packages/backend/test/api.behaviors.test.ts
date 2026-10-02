import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Behavior CRUD — writes go through the mesh store (getMeshCollection), so the
 * harness must be initialized with `{ mesh: true }`. The test seeds a real
 * scene-node to provide a valid nodeId for the behaviors collection.
 */
describe('behaviors API (mesh-backed)', () => {
  let app: Express;
  let nodeId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    const projectId = (
      await request(app).post('/api/projects').send({ name: 'P' })
    ).body.data.id as string;
    await request(app)
      .post(`/api/projects/${projectId}/scenes`)
      .send({ name: 'S', populate: false });
    const sceneId = (
      await request(app).get(`/api/projects/${projectId}/scenes`)
    ).body.data.scenes[0].id as string;
    nodeId = (
      await request(app)
        .post(`/api/scenes/${sceneId}/nodes`)
        .send({ name: 'Avatar', kind: 'group' })
    ).body.data.id as string;
  });

  const listBehaviors = async (nid: string) =>
    (await request(app).get(`/api/scene-nodes/${nid}/behaviors`)).body
      .data as Array<{ id: string; kind: string }>;

  it('lists behaviors (empty initially)', async () => {
    const behaviors = await listBehaviors(nodeId);
    expect(Array.isArray(behaviors)).toBe(true);
    expect(behaviors).toEqual([]);
  });

  it('creates, reads back, updates, and deletes a behavior', async () => {
    // Create
    const createRes = await request(app)
      .post(`/api/scene-nodes/${nodeId}/behaviors`)
      .send({ kind: 'breathing' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.ok).toBe(true);
    const id = createRes.body.data.id as string;
    expect(id).toBeTruthy();
    expect(createRes.body.data.node_id).toBe(nodeId);
    expect(createRes.body.data.kind).toBe('breathing');
    expect(createRes.body.data.enabled).toBe(true);

    // Read back via list
    const after = await listBehaviors(nodeId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id, kind: 'breathing' });

    // Update enabled flag
    const updRes = await request(app)
      .put(`/api/behaviors/${id}`)
      .send({ enabled: false });
    expect(updRes.status).toBe(200);
    expect(updRes.body.ok).toBe(true);

    // Update config
    const updConf = await request(app)
      .put(`/api/behaviors/${id}`)
      .send({ config: { intensity: 0.5 } });
    expect(updConf.status).toBe(200);

    // Delete
    const delRes = await request(app).delete(`/api/behaviors/${id}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    expect(await listBehaviors(nodeId)).toEqual([]);
  });

  it('accepts optional fields (config, sortOrder, enabled) on create', async () => {
    const res = await request(app)
      .post(`/api/scene-nodes/${nodeId}/behaviors`)
      .send({ kind: 'breathing', enabled: false, config: { x: 1 }, sortOrder: 5 });
    expect(res.status).toBe(201);
    expect(res.body.data.enabled).toBe(false);
    expect(res.body.data.sort_order).toBe(5);
  });

  it('seeds the kind default config when create omits one', async () => {
    // The editor's add-menu seeds `defaultConfig` client-side; the REST path
    // fills it in too, so a behavior created over the API is not inert.
    const res = await request(app)
      .post(`/api/scene-nodes/${nodeId}/behaviors`)
      .send({ kind: 'blendshape_limiter' });
    expect(res.status).toBe(201);
    const limits = res.body.data.config.limits as {
      groups: unknown[];
      clamps: unknown[];
    };
    expect(limits.groups).toHaveLength(1);
    expect(limits.clamps).toHaveLength(2);

    // And it round-trips through the store, not just the response body. The
    // list route returns raw rows, so `config` comes back as a JSON string.
    const stored = (await listBehaviors(nodeId)).find(
      (b) => b.kind === 'blendshape_limiter'
    ) as unknown as { config: string };
    const parsed = JSON.parse(stored.config) as {
      limits: { clamps: unknown[] };
    };
    expect(parsed.limits.clamps).toHaveLength(2);
  });

  it('honours an explicitly supplied empty config over the kind default', async () => {
    const res = await request(app)
      .post(`/api/scene-nodes/${nodeId}/behaviors`)
      .send({ kind: 'blendshape_limiter', config: {} });
    expect(res.status).toBe(201);
    expect(res.body.data.config).toEqual({});
  });

  it('rejects a behavior without kind (400)', async () => {
    const res = await request(app)
      .post(`/api/scene-nodes/${nodeId}/behaviors`)
      .send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).toMatch(/kind/i);
  });

  it('404s when updating a non-existent behavior', async () => {
    const res = await request(app)
      .put('/api/behaviors/no-such-id')
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
