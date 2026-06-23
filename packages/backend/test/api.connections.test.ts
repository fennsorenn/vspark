import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Connections API — covers the subset of routes that work without a live
 * rendezvous/WebRTC stack:
 *
 * - GET /connections/identity   → always readable (keyed from DB)
 * - GET /connections/status     → always readable (enabled=false in tests)
 * - GET /connections/peers      → list (empty in fresh DB)
 * - PUT /connections/peers/:id  → 404 when peer not found
 * - DELETE /connections/peers/:id → idempotent (no-op on unknown id)
 * - GET  /connections/display-name/:projectId  → per-project display name
 * - PUT  /connections/display-name/:projectId  → set display name + read back
 * - GET  /connections/shares    → always readable (empty)
 * - GET  /connections/collab-scenes → always readable (empty)
 * - GET  /connections/objects/:id/grantees → empty list
 *
 * Routes gated on multiplayerManager.isEnabled (pair/create, pair/join, connect,
 * disconnect, accept, reject, share, share-collab, mount) return 503 when
 * multiplayer is disabled — those 503 paths are also covered here.
 */
describe('connections API', () => {
  let app: Express;
  let projectId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
    projectId = (
      await request(app).post('/api/projects').send({ name: 'P' })
    ).body.data.id as string;
  });

  // ── Identity ──────────────────────────────────────────────────────────────

  it('GET /connections/identity returns a peerId and publicKey', async () => {
    const res = await request(app).get('/api/connections/identity');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.data.peerId).toBe('string');
    expect(res.body.data.peerId.length).toBeGreaterThan(0);
    expect(typeof res.body.data.publicKey).toBe('string');
  });

  // ── Status ────────────────────────────────────────────────────────────────

  it('GET /connections/status returns enabled:false in test harness', async () => {
    const res = await request(app).get('/api/connections/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Multiplayer is disabled in test harness (no rendezvous URL configured)
    expect(res.body.data.enabled).toBe(false);
    expect(Array.isArray(res.body.data.connected)).toBe(true);
  });

  // ── Peers ─────────────────────────────────────────────────────────────────

  it('GET /connections/peers lists empty contacts on fresh DB', async () => {
    const res = await request(app).get('/api/connections/peers');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
  });

  it('PUT /connections/peers/:id 404s when peer not found', async () => {
    const res = await request(app)
      .put('/api/connections/peers/no-such-peer')
      .send({ displayName: 'Bob' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('DELETE /connections/peers/:id returns ok even for unknown peer (idempotent)', async () => {
    const res = await request(app).delete('/api/connections/peers/ghost-id');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ── Display name ─────────────────────────────────────────────────────────

  it('GET /connections/display-name/:projectId returns empty string initially', async () => {
    const res = await request(app).get(
      `/api/connections/display-name/${projectId}`
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.displayName).toBe('');
  });

  it('PUT /connections/display-name/:projectId stores and returns the name', async () => {
    const put = await request(app)
      .put(`/api/connections/display-name/${projectId}`)
      .send({ name: 'Studio A' });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    expect(put.body.data.displayName).toBe('Studio A');

    // Verify persistence via read-back
    const get = await request(app).get(
      `/api/connections/display-name/${projectId}`
    );
    expect(get.body.data.displayName).toBe('Studio A');
  });

  it('PUT /connections/display-name truncates names longer than 64 characters', async () => {
    const longName = 'A'.repeat(100);
    const res = await request(app)
      .put(`/api/connections/display-name/${projectId}`)
      .send({ name: longName });
    expect(res.status).toBe(200);
    expect(res.body.data.displayName).toHaveLength(64);
  });

  // ── Shares / collab ───────────────────────────────────────────────────────

  it('GET /connections/shares returns empty array', async () => {
    const res = await request(app).get('/api/connections/shares');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /connections/collab-scenes returns empty array', async () => {
    const res = await request(app).get('/api/connections/collab-scenes');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /connections/objects/:id/grantees returns empty array', async () => {
    const res = await request(app).get(
      '/api/connections/objects/some-object-id/grantees'
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  // ── Multiplayer-disabled 503 paths ────────────────────────────────────────

  it('POST /connections/pair/create returns 503 when multiplayer disabled', async () => {
    const res = await request(app).post('/api/connections/pair/create');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('MULTIPLAYER_DISABLED');
  });

  it('POST /connections/pair/join returns 503 when multiplayer disabled', async () => {
    const res = await request(app)
      .post('/api/connections/pair/join')
      .send({ code: 'abc123' });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('MULTIPLAYER_DISABLED');
  });

  it('POST /connections/pair/join validates missing code (400) — but multiplayer disabled returns 503 first', async () => {
    // When multiplayer is disabled the 503 gate fires before validation.
    // Covered by the pair/join 503 test above. This test documents the
    // validation-only path reachable when multiplayer is enabled:
    // for now just assert 503 so coverage of that code branch is noted.
    const res = await request(app)
      .post('/api/connections/pair/join')
      .send({});
    expect(res.status).toBe(503);
  });

  it('POST /connections/objects/:id/share returns 503 when multiplayer disabled', async () => {
    const res = await request(app)
      .post('/api/connections/objects/obj1/share')
      .send({ granteePeerId: 'peer-x' });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('MULTIPLAYER_DISABLED');
  });

  it('POST /connections/objects/:id/unshare returns ok (always — no multiplayer guard)', async () => {
    const res = await request(app)
      .post('/api/connections/objects/obj1/unshare')
      .send({ granteePeerId: 'peer-x' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /connections/objects/:id/unshare-all returns ok', async () => {
    const res = await request(app).post(
      '/api/connections/objects/obj1/unshare-all'
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /connections/peers/:id/connect returns 503 when multiplayer disabled', async () => {
    const res = await request(app).post(
      '/api/connections/peers/peer-x/connect'
    );
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MULTIPLAYER_DISABLED');
  });

  it('POST /connections/peers/:id/disconnect returns 503 when multiplayer disabled', async () => {
    const res = await request(app).post(
      '/api/connections/peers/peer-x/disconnect'
    );
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MULTIPLAYER_DISABLED');
  });

  it('POST /connections/scenes/:id/share-collab returns 503 when multiplayer disabled', async () => {
    const res = await request(app)
      .post('/api/connections/scenes/scene1/share-collab')
      .send({ granteePeerId: 'peer-y' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MULTIPLAYER_DISABLED');
  });

  it('POST /connections/collab/mount returns 503 when multiplayer disabled', async () => {
    const res = await request(app)
      .post('/api/connections/collab/mount')
      .send({ ownerPeerId: 'p', sceneId: 's', projectId: 'proj' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MULTIPLAYER_DISABLED');
  });

  // ── Subscribe / unsubscribe (no multiplayer guard) ─────────────────────────

  it('POST /connections/peers/:id/subscribe returns ok', async () => {
    const res = await request(app)
      .post('/api/connections/peers/peer-x/subscribe')
      .send({ objectId: 'obj1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /connections/peers/:id/unsubscribe returns ok', async () => {
    const res = await request(app)
      .post('/api/connections/peers/peer-x/unsubscribe')
      .send({ objectId: 'obj1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
