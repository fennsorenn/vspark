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

  it('scene DELETE tombstones the dependent docs, not just the nodes', async () => {
    // Regression: the dependent tables were cleared with raw SQL, which removes
    // the ROW but leaves the DOCUMENT alive in the replica with no tombstone.
    // A tab subscribing after the delete then received a snapshot describing
    // behaviors / effects / layers / clips whose rows no longer existed.
    const projectId = await newProject();
    const create = await request(app)
      .post(`/api/projects/${projectId}/scenes`)
      .send({ name: 'S', populate: true });
    const sceneId = create.body.data.id as string;

    const nodes = getMeshCollection('scene_node')!;
    const cameraId = nodes
      .all()
      .filter(
        (n) => (n as { rootSceneNodeId?: string }).rootSceneNodeId === sceneId
      )
      .find((n) => (n as { kind?: string }).kind === 'camera')!.id as string;

    const behaviorId = (
      await request(app)
        .post(`/api/scene-nodes/${cameraId}/behaviors`)
        .send({ kind: 'breathing' })
    ).body.data.id as string;
    const effectId = (
      await request(app)
        .post(`/api/scene-nodes/${cameraId}/effects`)
        .send({ kind: 'bloom' })
    ).body.data.id as string;
    const clipId = (
      await request(app)
        .post(`/api/scene-nodes/${cameraId}/track-clips`)
        .send({ name: 'C' })
    ).body.data.id as string;

    // populate:true creates a camera_view layer pointed at this scene's camera.
    const layers = getMeshCollection('compose_layer')!;
    const layerId = layers
      .all()
      .find((l) => (l as { cameraNodeId?: string }).cameraNodeId === cameraId)!
      .id as string;

    // All four are live in their replicas before the delete.
    expect(getMeshCollection('behavior')!.get(behaviorId)).toBeDefined();
    expect(getMeshCollection('camera_effect')!.get(effectId)).toBeDefined();
    expect(getMeshCollection('track_clip')!.get(clipId)).toBeDefined();
    expect(layers.get(layerId)).toBeDefined();

    expect((await request(app).delete(`/api/scenes/${sceneId}`)).status).toBe(
      200
    );

    // ...and gone from the replica afterwards, not just from SQLite.
    expect(getMeshCollection('behavior')!.get(behaviorId)).toBeUndefined();
    expect(getMeshCollection('camera_effect')!.get(effectId)).toBeUndefined();
    expect(getMeshCollection('track_clip')!.get(clipId)).toBeUndefined();
    expect(layers.get(layerId)).toBeUndefined();
  });
});

/**
 * The scene bundle after mounting stopped rewriting project ids (#27).
 *
 * A mounted scene keeps its author's `project_id`, so "everything with my
 * project id" no longer finds it. The share link is what says it belongs here —
 * which is the honest relationship: the receiver renders it, it does not own it.
 */
describe('scene bundle — mounted scenes', () => {
  let app: Express;
  let projectId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    projectId = (await request(app).post('/api/projects').send({ name: 'Mine' }))
      .body.data.id as string;
  });

  it('lists a mounted scene even though it carries the author project id', async () => {
    const { getDb } = await import('../src/db/index.js');
    const { mountSharedScene } = await import(
      '../src/multiplayer/collabScene.js'
    );
    mountSharedScene(
      {
        objectId: 'mounted-scene',
        rootName: 'Theirs',
        nodes: [
          {
            id: 'mounted-scene',
            projectId: 'author-project',
            rootSceneNodeId: 'mounted-scene',
            parentId: null,
            name: 'Theirs',
            kind: 'scene',
            components: {},
            properties: {},
          },
        ],
        behaviors: [],
        cameraEffects: [],
        assets: [],
      } as never,
      projectId,
      'PEER'
    );

    const res = await request(app).get(`/api/projects/${projectId}/scenes`);
    const names = (res.body.data.scenes as { id: string }[]).map((s) => s.id);
    expect(names).toContain('mounted-scene');
    // And the row itself still says the author's project — the bundle found it
    // through the link, not by rewriting anything.
    const row = getDb()
      .prepare('SELECT project_id FROM scene_nodes WHERE id = ?')
      .get('mounted-scene') as { project_id: string };
    expect(row.project_id).toBe('author-project');
  });

  it('does not list the peer-owned project we hold for it', async () => {
    const { ensurePeerProject } = await import(
      '../src/multiplayer/collabScene.js'
    );
    ensurePeerProject('author-project', 'PEER');

    const res = await request(app).get('/api/projects');
    const ids = (res.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(projectId);
    // We hold it so a mounted tree can be stored as written; nobody authors
    // into it, so it is not a project the user sees.
    expect(ids).not.toContain('author-project');
  });
});
