import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * API integration tests for assets and logic routes.
 * Both routes are tested with list, create, read-back, update, delete,
 * validation (400), and not-found (404) paths where supported.
 *
 * The mesh is booted because the logic routes write through its collection —
 * they answer 500 "store not ready" without it, which is the honest answer:
 * persisting behind the replica's back would leave every connected tab stale.
 */
describe('assets + logic API', () => {
  let app: Express;
  let projectId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    // Seed a project for all tests
    const res = await request(app).post('/api/projects').send({ name: 'TestProject' });
    projectId = res.body.data.id as string;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ASSETS ROUTE TESTS
  // ──────────────────────────────────────────────────────────────────────────

  describe('assets API', () => {
    const listAssets = async () =>
      (
        await request(app).get(`/api/projects/${projectId}/assets`)
      ).body.data as Array<{
        id: string;
        project_id: string;
        original_name: string;
        stored_path: string;
      }>;

    it('lists assets (empty initially)', async () => {
      const assets = await listAssets();
      expect(Array.isArray(assets)).toBe(true);
      expect(assets).toEqual([]);
    });

    it('creates and reads back an asset', async () => {
      // Upload a test asset
      const createRes = await request(app)
        .post(`/api/projects/${projectId}/assets`)
        .send({
          name: 'test.vrm',
          mimeType: 'application/octet-stream',
          data: Buffer.from('binary data').toString('base64'),
        });
      expect(createRes.status).toBe(201);
      expect(createRes.body.ok).toBe(true);
      const assetId = createRes.body.data.id as string;
      expect(assetId).toBeTruthy();
      expect(createRes.body.data.original_name).toBe('test.vrm');
      expect(createRes.body.data.size).toBeGreaterThan(0);

      // List to verify it appears
      const assets = await listAssets();
      expect(assets).toHaveLength(1);
      expect(assets[0].id).toBe(assetId);
      expect(assets[0].original_name).toBe('test.vrm');
    });

    it('rejects an asset without name (400)', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/assets`)
        .send({
          mimeType: 'application/octet-stream',
          data: Buffer.from('binary data').toString('base64'),
        });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('name');
    });

    it('rejects an asset without data (400)', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/assets`)
        .send({
          name: 'test.vrm',
          mimeType: 'application/octet-stream',
        });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('stores and serves a thumbnail', async () => {
      // Create an asset first
      const createRes = await request(app)
        .post(`/api/projects/${projectId}/assets`)
        .send({
          name: 'test.vrm',
          mimeType: 'application/octet-stream',
          data: Buffer.from('binary data').toString('base64'),
        });
      const assetId = createRes.body.data.id as string;

      // Upload a thumbnail
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const thumbRes = await request(app)
        .put(`/api/assets/${assetId}/thumbnail`)
        .send({
          data: pngData.toString('base64'),
        });
      expect(thumbRes.status).toBe(200);
      expect(thumbRes.body.ok).toBe(true);
      expect(thumbRes.body.data.url).toContain('/uploads/');
      expect(thumbRes.body.data.url).toContain('thumbnails');
    });

    it('rejects a thumbnail without data (400)', async () => {
      const createRes = await request(app)
        .post(`/api/projects/${projectId}/assets`)
        .send({
          name: 'test.vrm',
          mimeType: 'application/octet-stream',
          data: Buffer.from('binary data').toString('base64'),
        });
      const assetId = createRes.body.data.id as string;

      const res = await request(app)
        .put(`/api/assets/${assetId}/thumbnail`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('404s when uploading thumbnail for non-existent asset', async () => {
      const res = await request(app)
        .put(`/api/assets/nonexistent-id/thumbnail`)
        .send({
          data: Buffer.from('png').toString('base64'),
        });
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('deletes an asset', async () => {
      // Create
      const createRes = await request(app)
        .post(`/api/projects/${projectId}/assets`)
        .send({
          name: 'test.vrm',
          mimeType: 'application/octet-stream',
          data: Buffer.from('binary data').toString('base64'),
        });
      const assetId = createRes.body.data.id as string;
      expect(await listAssets()).toHaveLength(1);

      // Delete
      const delRes = await request(app).delete(`/api/assets/${assetId}`);
      expect(delRes.status).toBe(200);
      expect(delRes.body.ok).toBe(true);

      // Verify deleted
      expect(await listAssets()).toHaveLength(0);
    });

    it('deletes an asset that never existed (idempotent)', async () => {
      const res = await request(app).delete('/api/assets/nonexistent-id');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // LOGIC ROUTE TESTS (project-scoped)
  // ──────────────────────────────────────────────────────────────────────────

  describe('logic API (project-scoped)', () => {
    const listLogic = async () =>
      (
        await request(app).get(`/api/projects/${projectId}/logic`)
      ).body.data as Array<{
        id: string;
        ownerKind: string;
        ownerId: string;
        name: string;
        enabled: boolean;
        descriptor: Record<string, unknown>;
      }>;

    it('lists logic (empty initially)', async () => {
      const logic = await listLogic();
      expect(Array.isArray(logic)).toBe(true);
      expect(logic).toEqual([]);
    });

    it('creates and reads back a project logic graph', async () => {
      const createRes = await request(app)
        .post(`/api/projects/${projectId}/logic`)
        .send({ name: 'TestGraph' });
      expect(createRes.status).toBe(201);
      expect(createRes.body.ok).toBe(true);
      const logicId = createRes.body.data.id as string;
      expect(createRes.body.data.name).toBe('TestGraph');
      expect(createRes.body.data.ownerKind).toBe('project');
      expect(createRes.body.data.ownerId).toBe(projectId);
      expect(createRes.body.data.enabled).toBe(true);
      expect(createRes.body.data.descriptor).toBeDefined();

      // List to verify it appears
      const logic = await listLogic();
      expect(logic).toHaveLength(1);
      expect(logic[0].id).toBe(logicId);
      expect(logic[0].name).toBe('TestGraph');

      // GET by id
      const getRes = await request(app).get(`/api/logic/${logicId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.ok).toBe(true);
      expect(getRes.body.data.id).toBe(logicId);
    });

    it('rejects logic creation without name (400)', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/logic`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.message).toContain('name');
    });

    it('updates a logic graph (name, enabled, descriptor)', async () => {
      const createRes = await request(app)
        .post(`/api/projects/${projectId}/logic`)
        .send({ name: 'Original' });
      const logicId = createRes.body.data.id as string;

      const updateRes = await request(app)
        .put(`/api/logic/${logicId}`)
        .send({
          name: 'Updated',
          enabled: false,
          descriptor: { nodes: [], edges: [] },
        });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.ok).toBe(true);
      expect(updateRes.body.data.name).toBe('Updated');
      expect(updateRes.body.data.enabled).toBe(false);

      // Verify via read
      const getRes = await request(app).get(`/api/logic/${logicId}`);
      expect(getRes.body.data.name).toBe('Updated');
      expect(getRes.body.data.enabled).toBe(false);
    });

    it('404s when updating a non-existent logic', async () => {
      const res = await request(app)
        .put('/api/logic/nonexistent')
        .send({ name: 'Test' });
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.message).toContain('not found');
    });

    it('404s when reading a non-existent logic', async () => {
      const res = await request(app).get('/api/logic/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });

    it('deletes a logic graph', async () => {
      const createRes = await request(app)
        .post(`/api/projects/${projectId}/logic`)
        .send({ name: 'ToDelete' });
      const logicId = createRes.body.data.id as string;
      expect(await listLogic()).toHaveLength(1);

      const delRes = await request(app).delete(`/api/logic/${logicId}`);
      expect(delRes.status).toBe(200);
      expect(delRes.body.ok).toBe(true);

      // Verify deleted
      expect(await listLogic()).toHaveLength(0);
    });

    it('deletes a logic graph that never existed (idempotent)', async () => {
      const res = await request(app).delete('/api/logic/nonexistent');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // LOGIC ROUTE TESTS (scene-node-scoped)
  // ──────────────────────────────────────────────────────────────────────────

  describe('logic API (scene-node-scoped)', () => {
    let sceneId: string;
    let nodeId: string;

    beforeEach(async () => {
      // Seed a scene and node for node-scoped logic
      const sceneRes = await request(app)
        .post(`/api/projects/${projectId}/scenes`)
        .send({ name: 'TestScene', populate: false });
      const scenes = (await request(app).get(`/api/projects/${projectId}/scenes`))
        .body.data.scenes as Array<{ id: string }>;
      sceneId = scenes[0].id as string;

      // For node creation, we need the mesh store initialized
      // Since this test doesn't use mesh, we just verify the endpoint exists
      // but we cannot fully test node-scoped logic creation here.
      // We will test the list and get endpoints instead.
    });

    it('lists node logic (empty for non-existent node)', async () => {
      // This will query an empty list for a node that doesn't exist in the mesh
      // The endpoint doesn't 404; it just returns empty
      const res = await request(app).get('/api/scene-nodes/nonexistent/logic');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // LOGIC ROUTE TESTS (compose-layer-scoped)
  // ──────────────────────────────────────────────────────────────────────────

  describe('logic API (compose-layer-scoped)', () => {
    it('lists compose layer logic (empty for non-existent layer)', async () => {
      const res = await request(app).get('/api/compose-layers/nonexistent/logic');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // LOGIC ROUTE TESTS (scoped-logic endpoint)
  // ──────────────────────────────────────────────────────────────────────────

  describe('logic API (scoped-logic aggregate endpoint)', () => {
    it('lists all scoped logic for a project (empty initially)', async () => {
      const res = await request(app).get(
        `/api/projects/${projectId}/scoped-logic`
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });
});
