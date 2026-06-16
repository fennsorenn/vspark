import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Overlive-accounts + overlive-app-credentials REST surface.
 * Both resources are backed by direct SQLite writes (no mesh store), so the
 * plain makeTestApp() harness (no mesh) is sufficient.
 *
 * Note: `getOverliveManager().refreshProject()` is called on mutation paths but
 * the manager is a no-op stub in the test harness — the async promise it
 * returns is swallowed (`catch(() => {})`), so tests complete synchronously.
 */
describe('overlive-accounts API', () => {
  let app: Express;
  let projectId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
    projectId = (
      await request(app).post('/api/projects').send({ name: 'P' })
    ).body.data.id as string;
  });

  // ── App credentials ────────────────────────────────────────────────────────

  describe('overlive-app-credentials', () => {
    const listCreds = async () =>
      (
        await request(app).get(
          `/api/projects/${projectId}/overlive-app-credentials`
        )
      ).body.data as Array<{ id: string; label: string }>;

    it('lists credentials (empty initially)', async () => {
      expect(await listCreds()).toEqual([]);
    });

    it('creates, reads back, updates, and deletes a credential', async () => {
      // Create
      const createRes = await request(app)
        .post(`/api/projects/${projectId}/overlive-app-credentials`)
        .send({
          label: 'My App',
          clientId: 'cid-001',
          clientSecret: 'sec-001',
          redirectUri: 'http://localhost/callback',
        });
      expect(createRes.status).toBe(201);
      expect(createRes.body.ok).toBe(true);
      const id = createRes.body.data.id as string;
      expect(id).toBeTruthy();
      expect(createRes.body.data.label).toBe('My App');
      expect(createRes.body.data.clientId).toBe('cid-001');
      expect(createRes.body.data.projectId).toBe(projectId);

      // Read back via list
      const creds = await listCreds();
      expect(creds).toHaveLength(1);
      expect(creds[0].id).toBe(id);

      // Update
      const updRes = await request(app)
        .put(`/api/overlive-app-credentials/${id}`)
        .send({ label: 'Updated App' });
      expect(updRes.status).toBe(200);
      expect(updRes.body.ok).toBe(true);
      expect(updRes.body.data.label).toBe('Updated App');

      // Delete
      const delRes = await request(app).delete(
        `/api/overlive-app-credentials/${id}`
      );
      expect(delRes.status).toBe(200);
      expect(delRes.body.ok).toBe(true);

      expect(await listCreds()).toHaveLength(0);
    });

    it('rejects a credential missing required fields (400)', async () => {
      // Missing clientSecret and redirectUri
      const res = await request(app)
        .post(`/api/projects/${projectId}/overlive-app-credentials`)
        .send({ label: 'x', clientId: 'y' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.message).toMatch(/required/i);
    });

    it('PUT returns 404 for non-existent credential id', async () => {
      const res = await request(app)
        .put('/api/overlive-app-credentials/no-such-id')
        .send({ label: 'Ghost' });
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });

    it('copy-from copies credentials between projects', async () => {
      // Seed a credential in the source project
      await request(app)
        .post(`/api/projects/${projectId}/overlive-app-credentials`)
        .send({
          label: 'Source Cred',
          clientId: 'src-cid',
          clientSecret: 'src-sec',
          redirectUri: 'http://localhost/cb',
        });

      // Create a target project
      const targetId = (
        await request(app).post('/api/projects').send({ name: 'Q' })
      ).body.data.id as string;

      const copyRes = await request(app).post(
        `/api/projects/${targetId}/overlive-app-credentials/copy-from/${projectId}`
      );
      expect(copyRes.status).toBe(200);
      expect(copyRes.body.ok).toBe(true);
      expect(Array.isArray(copyRes.body.data)).toBe(true);
      expect(copyRes.body.data).toHaveLength(1);
      expect(copyRes.body.data[0].label).toBe('Source Cred');
      // Must have a new id (not the original)
      const sourceCreds = await listCreds();
      expect(copyRes.body.data[0].id).not.toBe(sourceCreds[0].id);
    });

    it('copy-from with empty source returns empty array (no error)', async () => {
      const targetId = (
        await request(app).post('/api/projects').send({ name: 'Q' })
      ).body.data.id as string;
      const res = await request(app).post(
        `/api/projects/${targetId}/overlive-app-credentials/copy-from/${projectId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ── Login accounts ────────────────────────────────────────────────────────

  describe('overlive-accounts', () => {
    const listAccounts = async () =>
      (
        await request(app).get(`/api/projects/${projectId}/overlive-accounts`)
      ).body.data as Array<{ id: string; platform: string; isDefault: boolean }>;

    it('lists accounts (empty initially)', async () => {
      expect(await listAccounts()).toEqual([]);
    });

    it('creates, reads back, updates, and set-default an account', async () => {
      // Create
      const createRes = await request(app)
        .post(`/api/projects/${projectId}/overlive-accounts`)
        .send({ platform: 'streamelements', label: 'SE Account' });
      expect(createRes.status).toBe(201);
      expect(createRes.body.ok).toBe(true);
      const id = createRes.body.data.id as string;
      expect(id).toBeTruthy();
      expect(createRes.body.data.platform).toBe('streamelements');
      expect(createRes.body.data.label).toBe('SE Account');
      expect(createRes.body.data.isDefault).toBe(false);
      expect(createRes.body.data.projectId).toBe(projectId);

      // Read back via list
      const accounts = await listAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe(id);

      // Update label
      const updRes = await request(app)
        .put(`/api/overlive-accounts/${id}`)
        .send({ label: 'SE Account Updated' });
      expect(updRes.status).toBe(200);
      expect(updRes.body.ok).toBe(true);
      expect(updRes.body.data.label).toBe('SE Account Updated');

      // Set default
      const defRes = await request(app).post(
        `/api/overlive-accounts/${id}/set-default`
      );
      expect(defRes.status).toBe(200);
      expect(defRes.body.ok).toBe(true);
      expect(defRes.body.data.isDefault).toBe(true);
    });

    it('deletes a non-existent account (idempotent — no OverliveManager call)', async () => {
      // Deleting a non-existent id skips the `if (before)` refreshProject call
      // that would throw "OverliveManager not initialised" in the test harness.
      const delRes = await request(app).delete(
        '/api/overlive-accounts/non-existent-id'
      );
      expect(delRes.status).toBe(200);
      expect(delRes.body.ok).toBe(true);
    });

    it('rejects an account missing platform and label (400)', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/overlive-accounts`)
        .send({ credentials: { jwt: 'x' } });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.message).toMatch(/required/i);
    });

    it('rejects an account missing label (400)', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/overlive-accounts`)
        .send({ platform: 'streamelements' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('PUT /overlive-accounts/:id returns 404 for missing account', async () => {
      const res = await request(app)
        .put('/api/overlive-accounts/no-such-id')
        .send({ label: 'Ghost' });
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });

    it('POST /overlive-accounts/:id/set-default returns 404 for missing account', async () => {
      const res = await request(app).post(
        '/api/overlive-accounts/no-such-id/set-default'
      );
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });

    it('set-default clears other accounts in the same project', async () => {
      const a1 = (
        await request(app)
          .post(`/api/projects/${projectId}/overlive-accounts`)
          .send({ platform: 'streamelements', label: 'SE-1' })
      ).body.data.id as string;
      const a2 = (
        await request(app)
          .post(`/api/projects/${projectId}/overlive-accounts`)
          .send({ platform: 'streamelements', label: 'SE-2' })
      ).body.data.id as string;

      // Set a1 as default
      await request(app).post(`/api/overlive-accounts/${a1}/set-default`);

      // Now set a2 as default — a1 should be demoted
      const setRes = await request(app).post(
        `/api/overlive-accounts/${a2}/set-default`
      );
      expect(setRes.body.data.isDefault).toBe(true);

      const accounts = await listAccounts();
      const row1 = accounts.find((a) => a.id === a1);
      const row2 = accounts.find((a) => a.id === a2);
      expect(row1?.isDefault).toBe(false);
      expect(row2?.isDefault).toBe(true);
    });

    it('creates an account with optional credentials and broadcasterId', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/overlive-accounts`)
        .send({
          platform: 'twitch',
          label: 'Twitch Main',
          credentials: { accessToken: 'tok', refreshToken: 'ref' },
          broadcasterId: 'user123',
          broadcasterLogin: 'streamer',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.broadcasterId).toBe('user123');
      expect(res.body.data.broadcasterLogin).toBe('streamer');
      expect(res.body.data.credentials).toMatchObject({ accessToken: 'tok' });
    });
  });
});
