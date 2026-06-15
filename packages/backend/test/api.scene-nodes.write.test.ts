import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Scene-node WRITE routes — these persist through the mesh store, so the app is
 * built with the mesh peer bootstrapped (`{ mesh: true }`). Covers the full
 * create → update → delete lifecycle with REST read-back.
 */
describe('scene-node writes (mesh-backed)', () => {
  let app: Express;
  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
  });

  const seedScene = async () => {
    const projectId = (await request(app).post('/api/projects').send({ name: 'P' })).body
      .data.id as string;
    await request(app)
      .post(`/api/projects/${projectId}/scenes`)
      .send({ name: 'S', populate: false });
    const scenes = await request(app).get(`/api/projects/${projectId}/scenes`);
    return scenes.body.data.scenes[0].id as string;
  };

  it('creates a node and reads it back', async () => {
    const sceneId = await seedScene();
    const create = await request(app)
      .post(`/api/scenes/${sceneId}/nodes`)
      .send({ name: 'Group A', kind: 'group' });
    expect(create.status).toBe(201);
    const nodeId = create.body.data.id as string;
    expect(nodeId).toBeTruthy();

    const nodes = await request(app).get(`/api/scenes/${sceneId}/nodes`);
    const found = nodes.body.data.find((n: { id: string }) => n.id === nodeId);
    expect(found).toBeTruthy();
    expect(found.name).toBe('Group A');
  });

  it('updates a node, reflected in read-back', async () => {
    const sceneId = await seedScene();
    const nodeId = (
      await request(app)
        .post(`/api/scenes/${sceneId}/nodes`)
        .send({ name: 'N', kind: 'group' })
    ).body.data.id as string;

    const upd = await request(app)
      .put(`/api/scene-nodes/${nodeId}`)
      .send({ name: 'Renamed' });
    expect(upd.status).toBe(200);

    const nodes = await request(app).get(`/api/scenes/${sceneId}/nodes`);
    expect(nodes.body.data.find((n: { id: string }) => n.id === nodeId)?.name).toBe(
      'Renamed'
    );
  });

  it('deletes a node, reflected in read-back', async () => {
    const sceneId = await seedScene();
    const nodeId = (
      await request(app)
        .post(`/api/scenes/${sceneId}/nodes`)
        .send({ name: 'Doomed', kind: 'group' })
    ).body.data.id as string;

    const del = await request(app).delete(`/api/scene-nodes/${nodeId}`);
    expect(del.status).toBe(200);

    const nodes = await request(app).get(`/api/scenes/${sceneId}/nodes`);
    expect(nodes.body.data.some((n: { id: string }) => n.id === nodeId)).toBe(false);
  });
});
