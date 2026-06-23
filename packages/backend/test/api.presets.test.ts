import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Preset API tests. The presets table is direct-DB (no mesh collection), but
 * creating a preset via POST requires a real scene-node to serialize, so we
 * bootstrap the mesh store for the seed helpers.
 */

/** Seed a project + scene + group node and return ids. */
async function seedNode(app: Express) {
  const projectId = (
    await request(app).post('/api/projects').send({ name: 'P' })
  ).body.data.id as string;
  await request(app)
    .post(`/api/projects/${projectId}/scenes`)
    .send({ name: 'S', populate: false });
  const sceneId = (
    await request(app).get(`/api/projects/${projectId}/scenes`)
  ).body.data.scenes[0].id as string;
  const nodeId = (
    await request(app)
      .post(`/api/scenes/${sceneId}/nodes`)
      .send({ name: 'Root', kind: 'group' })
  ).body.data.id as string;
  return { projectId, sceneId, nodeId };
}

// ── PROJECT-SCOPED PRESET CRUD ────────────────────────────────────────────

describe('presets API – project-scoped CRUD', () => {
  let app: Express;
  let projectId: string;
  let nodeId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    ({ projectId, nodeId } = await seedNode(app));
  });

  it('lists presets for a project (empty initially)', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/presets`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('creates a preset from a scene node and reads it back', async () => {
    // CREATE
    const create = await request(app)
      .post(`/api/projects/${projectId}/presets`)
      .send({ name: 'My Preset', rootKind: 'scene_node', rootId: nodeId });
    expect(create.status).toBe(201);
    expect(create.body.ok).toBe(true);
    const preset = create.body.data;
    expect(typeof preset.id).toBe('string');
    expect(preset.name).toBe('My Preset');
    expect(preset.projectId).toBe(projectId);
    expect(preset.rootKind).toBe('scene_node');
    expect(preset.payload).toBeDefined();
    expect(preset.payload.format).toBe('vspark.preset.v2');

    // LIST shows it
    const list = await request(app).get(`/api/projects/${projectId}/presets`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(preset.id);
    expect(list.body.data[0].name).toBe('My Preset');
    // Summary omits payload
    expect(list.body.data[0].payload).toBeUndefined();

    // GET by id
    const get = await request(app).get(`/api/presets/${preset.id}`);
    expect(get.status).toBe(200);
    expect(get.body.data.id).toBe(preset.id);
    expect(get.body.data.payload).toBeDefined();

    // DELETE
    const del = await request(app).delete(`/api/presets/${preset.id}`);
    expect(del.status).toBe(200);
    expect(del.body.data.id).toBe(preset.id);

    // List is empty again
    const after = await request(app).get(`/api/projects/${projectId}/presets`);
    expect(after.body.data).toEqual([]);
  });

  it('returns 400 when name is missing on create', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/presets`)
      .send({ rootKind: 'scene_node', rootId: nodeId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when rootKind is missing on create', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/presets`)
      .send({ name: 'X', rootId: nodeId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when rootKind is invalid on create', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/presets`)
      .send({ name: 'X', rootKind: 'bad_kind', rootId: nodeId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('404s when getting a non-existent preset', async () => {
    const res = await request(app).get('/api/presets/no-such-id');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('delete is idempotent (returns 200 for unknown id)', async () => {
    // Route does not 404 on unknown id — it just runs DELETE WHERE id = ?
    const res = await request(app).delete('/api/presets/no-such-id');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── SERIALIZE ENDPOINT ────────────────────────────────────────────────────

describe('presets API – /presets/serialize', () => {
  let app: Express;
  let nodeId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    ({ nodeId } = await seedNode(app));
  });

  it('serializes a scene node subtree without saving to DB', async () => {
    const res = await request(app)
      .post('/api/presets/serialize')
      .send({ rootKind: 'scene_node', rootId: nodeId });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.format).toBe('vspark.preset.v2');
    expect(res.body.data.rootKind).toBe('scene_node');
    expect(Array.isArray(res.body.data.sceneNodes)).toBe(true);
  });

  it('returns 400 when rootKind is missing on serialize', async () => {
    const res = await request(app)
      .post('/api/presets/serialize')
      .send({ rootId: nodeId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when rootId is missing on serialize', async () => {
    const res = await request(app)
      .post('/api/presets/serialize')
      .send({ rootKind: 'scene_node' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid rootKind on serialize', async () => {
    const res = await request(app)
      .post('/api/presets/serialize')
      .send({ rootKind: 'bad_kind', rootId: nodeId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ── INSTANTIATE ENDPOINT ─────────────────────────────────────────────────

describe('presets API – /presets/instantiate', () => {
  let app: Express;
  let projectId: string;
  let sceneId: string;
  let nodeId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    ({ projectId, sceneId, nodeId } = await seedNode(app));
  });

  it('returns 400 when payload is missing', async () => {
    const res = await request(app)
      .post('/api/presets/instantiate')
      .send({ projectId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await request(app)
      .post('/api/presets/instantiate')
      .send({ payload: { format: 'vspark.preset.v2' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for unsupported preset format', async () => {
    const res = await request(app)
      .post('/api/presets/instantiate')
      .send({ payload: { format: 'unknown.format' }, projectId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/unsupported preset format/i);
  });

  it('instantiates a valid v2 scene_node preset', async () => {
    // First serialize the existing node to get a valid payload
    const ser = await request(app)
      .post('/api/presets/serialize')
      .send({ rootKind: 'scene_node', rootId: nodeId });
    expect(ser.status).toBe(200);
    const payload = ser.body.data;

    const res = await request(app)
      .post('/api/presets/instantiate')
      .send({ payload, projectId, rootSceneNodeId: sceneId });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.idMap).toBeDefined();
    expect(typeof res.body.data.idMap).toBe('object');
  });
});

// ── BUILTIN PRESETS ───────────────────────────────────────────────────────

describe('presets API – builtins', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
  });

  it('lists builtin presets', async () => {
    const res = await request(app).get('/api/presets/builtin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    const first = res.body.data[0];
    expect(first.id).toMatch(/^builtin:/);
    expect(first.builtin).toBe(true);
    expect(first.payload).toBeUndefined(); // summary, no payload
  });

  it('gets a specific builtin preset by id', async () => {
    const res = await request(app).get(
      '/api/presets/builtin/builtin:three-point-lighting'
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe('builtin:three-point-lighting');
    expect(res.body.data.builtin).toBe(true);
    expect(res.body.data.payload).toBeDefined();
    expect(res.body.data.payload.format).toBe('vspark.preset.v2');
  });

  it('returns 404 for an unknown builtin id', async () => {
    const res = await request(app).get('/api/presets/builtin/builtin:no-such');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
