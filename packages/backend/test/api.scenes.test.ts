import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * API integration for the scene + scene-node CRUD routes. Drives real handlers
 * against a fresh in-memory DB, asserting persistence via read-back plus the
 * validation / not-found error paths.
 */
describe('scenes + scene-nodes API', () => {
  let app: Express;
  beforeEach(async () => {
    ({ app } = await makeTestApp());
  });

  const newProject = async () => {
    const r = await request(app).post('/api/projects').send({ name: 'P' });
    return r.body.data.id as string;
  };
  // Scenes are created un-populated for predictable node counts; the id is read
  // back from the list endpoint to stay robust to the POST response shape.
  const newScene = async (projectId: string) => {
    const create = await request(app)
      .post(`/api/projects/${projectId}/scenes`)
      .send({ name: 'S', populate: false });
    expect(create.status).toBe(201);
    const list = await request(app).get(`/api/projects/${projectId}/scenes`);
    return list.body.data.scenes[0].id as string;
  };

  describe('scenes', () => {
    it('lists empty, then creates + reads back a scene', async () => {
      const projectId = await newProject();
      expect(
        (await request(app).get(`/api/projects/${projectId}/scenes`)).body.data.scenes
      ).toEqual([]);

      const sceneId = await newScene(projectId);
      const list = await request(app).get(`/api/projects/${projectId}/scenes`);
      expect(list.body.data.scenes).toHaveLength(1);
      expect(list.body.data.scenes[0].id).toBe(sceneId);
    });

    it('creates an EMPTY scene by default — no camera, no lights', async () => {
      // Creating a scene and furnishing it are separate acts. Seeding used to be
      // the default, which made an agent asked for "a scene with key and fill
      // lights" produce four lights: the seeded pair plus the requested pair.
      const projectId = await newProject();
      const sceneId = await newScene(projectId);

      const nodes = (await request(app).get(`/api/scenes/${sceneId}/nodes`)).body
        .data as { kind: string; name: string }[];
      expect(nodes).toEqual([]);
    });

    it('seeds a camera + key/fill lights when populate is explicitly true', async () => {
      const projectId = await newProject();
      const res = await request(app)
        .post(`/api/projects/${projectId}/scenes`)
        .send({ name: 'Seeded', populate: true });
      expect(res.status).toBe(201);

      const nodes = (
        await request(app).get(`/api/scenes/${res.body.data.id}/nodes`)
      ).body.data as { kind: string; name: string; components: string }[];

      expect(nodes.map((n) => n.name).sort()).toEqual([
        'Camera',
        'Fill Light',
        'Key Light',
      ]);
      // The seeded camera must agree with a manually created one
      // (createKinds.ts), which is orthographic. It previously carried no camera
      // component at all and so silently fell back to perspective.
      // NB this route returns `components` as a raw JSON string, not an object.
      const cam = nodes.find((n) => n.kind === 'camera')!;
      const camComponents = JSON.parse(cam.components) as {
        camera?: { projection?: string };
      };
      expect(camComponents.camera?.projection).toBe('orthographic');
    });

    it('rejects a scene without a name (400)', async () => {
      const projectId = await newProject();
      const res = await request(app).post(`/api/projects/${projectId}/scenes`).send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('404s when updating a non-existent scene', async () => {
      const res = await request(app).put('/api/scenes/does-not-exist').send({ name: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('scene-nodes', () => {
    // NOTE: node *writes* go through the mesh store (getMeshCollection), which the
    // bare createApp() harness doesn't bootstrap — covering create/update/delete
    // needs a mesh-initialised testApp (a dedicated follow-up increment). The
    // validation + not-found paths run before the mesh write, so they're covered here.

    it('lists nodes for a scene (empty when un-populated)', async () => {
      const projectId = await newProject();
      const sceneId = await newScene(projectId);
      const nodes = await request(app).get(`/api/scenes/${sceneId}/nodes`);
      expect(nodes.status).toBe(200);
      expect(Array.isArray(nodes.body.data)).toBe(true);
      expect(nodes.body.data).toEqual([]);
    });

    it('rejects a node without name/kind (400)', async () => {
      const projectId = await newProject();
      const sceneId = await newScene(projectId);
      const res = await request(app).post(`/api/scenes/${sceneId}/nodes`).send({ name: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('404s creating a node under a missing scene', async () => {
      const res = await request(app)
        .post('/api/scenes/nope/nodes')
        .send({ name: 'x', kind: 'group' });
      expect(res.status).toBe(404);
    });
  });
});
