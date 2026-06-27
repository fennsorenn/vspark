import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Compose-layers API (mesh-backed CRUD): creates, reads, updates, and deletes
 * compose-scenes and layers within them. The compose-scene parent must exist in
 * the containment index (mesh collection), so we seed a real compose-scene first.
 */
describe('compose-layers API (mesh-backed)', () => {
  let app: Express;
  let projectId: string;
  let composeSceneId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    // Seed a project
    const projectRes = await request(app).post('/api/projects').send({ name: 'TestProject' });
    projectId = projectRes.body.data.id as string;
  });

  const createComposeScene = async (name: string, config?: Record<string, unknown>) => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/compose-scenes`)
      .send({
        name,
        config: config ?? {},
        width: 1920,
        height: 1080,
        visible: true,
      });
    return res;
  };

  const listComposeScenesForProject = async () => {
    return await request(app).get(`/api/projects/${projectId}/compose-scenes`);
  };

  const listLayersInScene = async (sceneId: string) => {
    return await request(app).get(`/api/compose-scenes/${sceneId}/layers`);
  };

  const createLayerInScene = async (
    sceneId: string,
    body: Record<string, unknown>
  ) => {
    return await request(app)
      .post(`/api/compose-scenes/${sceneId}/layers`)
      .send(body);
  };

  const updateLayer = async (layerId: string, patch: Record<string, unknown>) => {
    return await request(app)
      .put(`/api/compose-layers/${layerId}`)
      .send(patch);
  };

  const deleteLayer = async (layerId: string) => {
    return await request(app).delete(`/api/compose-layers/${layerId}`);
  };

  describe('compose-scene CRUD', () => {
    it('creates a compose-scene and reads it back', async () => {
      const createRes = await createComposeScene('MyScene', { someConfig: 'value' });
      expect(createRes.status).toBe(201);
      expect(createRes.body.ok).toBe(true);
      expect(createRes.body.data).toMatchObject({
        name: 'MyScene',
        kind: 'compose_scene',
        width: 1920,
        height: 1080,
        visible: true,
      });
      composeSceneId = createRes.body.data.id as string;

      // Read back via list
      const listRes = await listComposeScenesForProject();
      expect(listRes.status).toBe(200);
      expect(listRes.body.ok).toBe(true);
      expect(listRes.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: composeSceneId,
            name: 'MyScene',
            kind: 'compose_scene',
          }),
        ])
      );
    });

    it('rejects a compose-scene without a name (400)', async () => {
      const res = await createComposeScene('');
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('name is required');
    });
  });

  describe('compose-layer lifecycle', () => {
    beforeEach(async () => {
      const createRes = await createComposeScene('TestScene');
      composeSceneId = createRes.body.data.id as string;
    });

    it('creates a layer in a compose-scene and reads it back', async () => {
      const createRes = await createLayerInScene(composeSceneId, {
        name: 'Layer1',
        kind: 'vrm_avatar',
        config: { modelUrl: 'test.vrm' },
        x: 100,
        y: 200,
        width: 320,
        height: 180,
        rotation: 45,
        anchorH: 'center',
        anchorV: 'middle',
        visible: true,
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body.ok).toBe(true);
      expect(createRes.body.data).toMatchObject({
        name: 'Layer1',
        kind: 'vrm_avatar',
        x: 100,
        y: 200,
        width: 320,
        height: 180,
        rotation: 45,
        anchorH: 'center',
        anchorV: 'middle',
        visible: true,
      });
      const layerId = createRes.body.data.id as string;

      // Read back via list
      const listRes = await listLayersInScene(composeSceneId);
      expect(listRes.status).toBe(200);
      expect(listRes.body.ok).toBe(true);
      expect(listRes.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: layerId,
            name: 'Layer1',
            kind: 'vrm_avatar',
          }),
        ])
      );
    });

    it('updates a layer via PUT /api/compose-layers/:id', async () => {
      const createRes = await createLayerInScene(composeSceneId, {
        name: 'OriginalName',
        kind: 'rect',
      });
      const layerId = createRes.body.data.id as string;

      const updateRes = await updateLayer(layerId, {
        name: 'UpdatedName',
        x: 500,
        visible: false,
      });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.ok).toBe(true);
      expect(updateRes.body.data).toMatchObject({
        id: layerId,
        name: 'UpdatedName',
        x: 500,
        visible: false,
      });

      // Verify persistence via list
      const listRes = await listLayersInScene(composeSceneId);
      expect(listRes.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: layerId,
            name: 'UpdatedName',
            x: 500,
            visible: false,
          }),
        ])
      );
    });

    it('persists cameraNodeId on PUT (camera_view reassignment)', async () => {
      // Regression: a camera_view layer's camera could be reassigned in the
      // editor (local store) but the PUT dropped cameraNodeId server-side, so
      // every viewer reverted to the creation default — making all compose
      // viewers show the first camera regardless of the link.
      const sceneRes = await request(app)
        .post(`/api/projects/${projectId}/scenes`)
        .send({ name: '3DScene' });
      const sceneId = sceneRes.body.data.id as string;
      const mkCam = async (name: string) => {
        const r = await request(app)
          .post(`/api/scenes/${sceneId}/nodes`)
          .send({ name, kind: 'camera' });
        return r.body.data.id as string;
      };
      const camA = await mkCam('CamA');
      const camB = await mkCam('CamB');

      const createRes = await createLayerInScene(composeSceneId, {
        name: 'CamView',
        kind: 'camera_view',
        cameraNodeId: camA,
      });
      const layerId = createRes.body.data.id as string;
      expect(createRes.body.data.cameraNodeId).toBe(camA);

      const updateRes = await updateLayer(layerId, { cameraNodeId: camB });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data).toMatchObject({
        id: layerId,
        cameraNodeId: camB,
      });

      // Read back fresh (what a viewer link loads) — must reflect the change.
      const listRes = await listLayersInScene(composeSceneId);
      expect(listRes.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: layerId, cameraNodeId: camB }),
        ])
      );

      // An explicit null clears the camera (the "None" option).
      const clearRes = await updateLayer(layerId, { cameraNodeId: null });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.data.cameraNodeId).toBeNull();
    });

    it('deletes a layer and removes it from the scene', async () => {
      const createRes = await createLayerInScene(composeSceneId, {
        name: 'ToDelete',
        kind: 'rect',
      });
      const layerId = createRes.body.data.id as string;

      // Verify it exists
      let listRes = await listLayersInScene(composeSceneId);
      expect(listRes.body.data).toHaveLength(1);

      // Delete it
      const deleteRes = await deleteLayer(layerId);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.ok).toBe(true);

      // Verify it's gone
      listRes = await listLayersInScene(composeSceneId);
      expect(listRes.body.data).toEqual([]);
    });
  });

  describe('compose-layer validation and error handling', () => {
    beforeEach(async () => {
      const createRes = await createComposeScene('TestScene');
      composeSceneId = createRes.body.data.id as string;
    });

    it('rejects a layer without kind and name (400)', async () => {
      const res = await createLayerInScene(composeSceneId, {
        config: {},
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('name and kind are required');
    });

    it('rejects a layer without kind (400)', async () => {
      const res = await createLayerInScene(composeSceneId, {
        name: 'NameOnly',
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a layer without name (400)', async () => {
      const res = await createLayerInScene(composeSceneId, {
        kind: 'rect',
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('404s when creating a layer under a non-existent compose-scene', async () => {
      const res = await createLayerInScene('nonexistent-scene-id', {
        name: 'Layer',
        kind: 'rect',
      });
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain('compose scene not found');
    });

    it('404s when updating a non-existent layer', async () => {
      const res = await updateLayer('nonexistent-layer-id', {
        name: 'UpdatedName',
      });
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain('compose layer not found');
    });

    it('rejects a feed layer with a syntactically broken template (400)', async () => {
      const res = await createLayerInScene(composeSceneId, {
        name: 'BadFeed',
        kind: 'feed',
        config: { template: '<div>`${chat.map((m) => <p>${m.text}</p>)}</div>' },
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/Template syntax error/);
    });

    it('rejects a feed layer with structurally broken CSS (400)', async () => {
      const res = await createLayerInScene(composeSceneId, {
        name: 'BadCss',
        kind: 'feed',
        config: { template: '<div></div>', css: '.chat { border-width: 20px;' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/unclosed "{"/);
    });

    it('accepts a feed layer with valid template + border-image CSS (201)', async () => {
      const res = await createLayerInScene(composeSceneId, {
        name: 'GoodFeed',
        kind: 'feed',
        config: {
          template: '<div>${chat.map((m) => html`<p>${m.text}</p>`)}</div>',
          css: '.chat { border-image: url(/u/border.png) 120 stretch; }',
        },
      });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    });

    it('rejects an update that introduces a broken template (400)', async () => {
      const created = await createLayerInScene(composeSceneId, {
        name: 'Feed',
        kind: 'feed',
        config: { template: '<div></div>' },
      });
      const layerId = created.body.data.id as string;
      const res = await updateLayer(layerId, {
        config: { template: '<div>${chat' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/Template syntax error/);
    });
  });

  describe('compose-layer defaults', () => {
    beforeEach(async () => {
      const createRes = await createComposeScene('TestScene');
      composeSceneId = createRes.body.data.id as string;
    });

    it('applies sensible defaults when creating a layer', async () => {
      const res = await createLayerInScene(composeSceneId, {
        name: 'SimpleLayer',
        kind: 'rect',
        // Omit optional fields to verify defaults
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        rotation: 0,
        anchorH: 'left',
        anchorV: 'top',
        visible: true,
        config: {},
      });
    });

    it('applies default scene_order when not specified', async () => {
      // Create first layer
      const first = await createLayerInScene(composeSceneId, {
        name: 'First',
        kind: 'rect',
      });
      const firstOrder = first.body.data.sceneOrder as number;

      // Create second layer
      const second = await createLayerInScene(composeSceneId, {
        name: 'Second',
        kind: 'rect',
      });
      const secondOrder = second.body.data.sceneOrder as number;

      // Second should have a higher order (append to back of stack)
      expect(secondOrder).toBeGreaterThan(firstOrder);
    });
  });
});
