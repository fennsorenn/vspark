import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { getMeshCollection } from '../src/mesh/index.js';

/**
 * A2 (retire the legacy sync envelope): template/bulk scene creation, scene
 * settings PUT, and scene DELETE now write through the mesh store instead of
 * emitting `sync.document` directly. These assert the store is the source of
 * truth for the created/updated/removed rows (mesh replica read-back), which is
 * what fans out to tabs + collab/share subscribers.
 */
describe('scenes API → mesh store write-through', () => {
  let app: Express;
  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
  });

  const newProject = async () => {
    const r = await request(app).post('/api/projects').send({ name: 'P' });
    return r.body.data.id as string;
  };

  it('template creation mirrors every node + layer into the mesh store', async () => {
    const projectId = await newProject();
    const create = await request(app)
      .post(`/api/projects/${projectId}/scenes`)
      .send({ name: 'S', populate: true });
    expect(create.status).toBe(201);
    const sceneId = create.body.data.id as string;

    const nodes = getMeshCollection('scene_node')!;
    const layers = getMeshCollection('compose_layer')!;

    // Scene root + camera + key light + fill light all live in the replica.
    const sceneRoot = nodes.get(sceneId) as { kind?: string } | undefined;
    expect(sceneRoot?.kind).toBe('scene');
    const nodeKinds = nodes
      .all()
      .filter((n) => (n as { rootSceneNodeId?: string }).rootSceneNodeId === sceneId)
      .map((n) => (n as { kind?: string }).kind)
      .sort();
    expect(nodeKinds).toEqual(['camera', 'light', 'light', 'scene']);

    // Default compose scene + camera_view layer are in the replica too.
    const layerKinds = layers
      .all()
      .filter((l) => (l as { projectId?: string }).projectId === projectId)
      .map((l) => (l as { kind?: string }).kind)
      .sort();
    expect(layerKinds).toEqual(['camera_view', 'compose_scene']);
  });

  it('scene settings PUT re-syncs the scene node through the store', async () => {
    const projectId = await newProject();
    const create = await request(app)
      .post(`/api/projects/${projectId}/scenes`)
      .send({ name: 'S', populate: false });
    const sceneId = create.body.data.id as string;

    const put = await request(app)
      .put(`/api/scenes/${sceneId}`)
      .send({ name: 'Renamed', runtimeSettings: { tickRate: 30 } });
    expect(put.status).toBe(200);

    const doc = getMeshCollection('scene_node')!.get(sceneId) as
      | { name?: string; properties?: { tickRate?: number } }
      | undefined;
    expect(doc?.name).toBe('Renamed');
    expect(doc?.properties?.tickRate).toBe(30);
  });

  it('scene DELETE removes every node from the mesh store (tombstoned)', async () => {
    const projectId = await newProject();
    const create = await request(app)
      .post(`/api/projects/${projectId}/scenes`)
      .send({ name: 'S', populate: true });
    const sceneId = create.body.data.id as string;

    const nodes = getMeshCollection('scene_node')!;
    const before = nodes
      .all()
      .filter((n) => (n as { rootSceneNodeId?: string }).rootSceneNodeId === sceneId);
    expect(before.length).toBeGreaterThan(0);

    const del = await request(app).delete(`/api/scenes/${sceneId}`);
    expect(del.status).toBe(200);

    // Nothing for this scene remains in the replica, and the DB is empty too.
    expect(nodes.get(sceneId)).toBeUndefined();
    const after = nodes
      .all()
      .filter((n) => (n as { rootSceneNodeId?: string }).rootSceneNodeId === sceneId);
    expect(after).toEqual([]);
    const list = await request(app).get(`/api/projects/${projectId}/scenes`);
    expect(list.body.data.scenes).toEqual([]);
  });
});
