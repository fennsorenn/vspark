import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Camera-effect CRUD — mesh-backed writes (no manager side effects). The effect's
 * parent node must exist in the containment index, so we seed a real scene-node.
 */
describe('camera-effects API (mesh-backed)', () => {
  let app: Express;
  let NODE: string;
  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    const projectId = (await request(app).post('/api/projects').send({ name: 'P' })).body
      .data.id as string;
    await request(app)
      .post(`/api/projects/${projectId}/scenes`)
      .send({ name: 'S', populate: false });
    const sceneId = (await request(app).get(`/api/projects/${projectId}/scenes`)).body.data
      .scenes[0].id as string;
    NODE = (
      await request(app).post(`/api/scenes/${sceneId}/nodes`).send({ name: 'Cam', kind: 'camera' })
    ).body.data.id as string;
  });

  const list = async () =>
    (await request(app).get(`/api/scene-nodes/${NODE}/effects`)).body.data as {
      id: string;
      kind: string;
    }[];

  it('creates, reads back, updates, and deletes an effect', async () => {
    expect(await list()).toEqual([]);

    const create = await request(app)
      .post(`/api/scene-nodes/${NODE}/effects`)
      .send({ kind: 'bloom', config: { intensity: 0.5 } });
    expect(create.status).toBe(201);
    const id = create.body.data.id as string;

    const after = await list();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id, kind: 'bloom' });

    const upd = await request(app)
      .put(`/api/camera-effects/${id}`)
      .send({ enabled: false });
    expect(upd.status).toBe(200);

    const del = await request(app).delete(`/api/camera-effects/${id}`);
    expect(del.status).toBe(200);
    expect(await list()).toEqual([]);
  });

  it('rejects an effect without a kind (400)', async () => {
    const res = await request(app)
      .post(`/api/scene-nodes/${NODE}/effects`)
      .send({ config: {} });
    expect(res.status).toBe(400);
  });

  it('404s when updating a non-existent effect', async () => {
    const res = await request(app)
      .put('/api/camera-effects/missing')
      .send({ enabled: true });
    expect(res.status).toBe(404);
  });
});
