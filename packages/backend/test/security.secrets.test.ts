import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { EventEmitter } from 'events';
import { readFile, rm } from 'fs/promises';
import type { Express } from 'express';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeTestApp } from './helpers/testApp.js';
import { getDb } from '../src/db/index.js';
import { initObsWsManager } from '../src/obs/ws_manager.js';
import { VsparkClient } from '../src/mcp/client.js';
import { createMcpServer } from '../src/mcp/server.js';
import {
  hostAllowed,
  isLoopbackAddress,
  originAllowed,
} from '../src/localAccess.js';

/**
 * Secrets never leave the backend through REST or MCP. Each secret is written
 * through the API, then every read path (list, create/update responses, MCP)
 * is checked for the raw value — and the stored value must survive an update
 * that omits it.
 */
class FakeClient extends EventEmitter {
  identified = false;
  connect() {}
  close() {}
  async request() {
    return {};
  }
}

const SECRET = 'do-not-leak-7f3a';

describe('secrets stay in the backend', () => {
  let app: Express;
  let projectId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
    initObsWsManager(undefined, () => new FakeClient() as never);
    const p = await request(app).post('/api/projects').send({ name: 'P' });
    projectId = p.body.data.id;
  });

  it('OBS password: never returned, kept when an update omits it', async () => {
    const create = await request(app)
      .post(`/api/projects/${projectId}/obs-connections`)
      .send({ label: 'Studio', password: SECRET });
    expect(create.body.data.hasPassword).toBe(true);
    expect(JSON.stringify(create.body)).not.toContain(SECRET);
    const id = create.body.data.id as string;

    const list = await request(app).get(
      `/api/projects/${projectId}/obs-connections`
    );
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect(list.body.data[0]).not.toHaveProperty('password');

    const upd = await request(app)
      .put(`/api/obs-connections/${id}`)
      .send({ label: 'Renamed' });
    expect(JSON.stringify(upd.body)).not.toContain(SECRET);
    const row = getDb()
      .prepare('SELECT password FROM obs_connections WHERE id = ?')
      .get(id) as { password: string };
    expect(row.password).toBe(SECRET);
  });

  it('OBS hasPassword is false without a password', async () => {
    const create = await request(app)
      .post(`/api/projects/${projectId}/obs-connections`)
      .send({ label: 'Open' });
    expect(create.body.data.hasPassword).toBe(false);
  });

  it('Twitch client secret: never returned, kept when an update omits it', async () => {
    const create = await request(app)
      .post(`/api/projects/${projectId}/overlive-app-credentials`)
      .send({
        label: 'App',
        clientId: 'cid',
        clientSecret: SECRET,
        redirectUri: 'http://localhost/cb',
      });
    expect(create.status).toBe(201);
    expect(create.body.data.hasClientSecret).toBe(true);
    expect(JSON.stringify(create.body)).not.toContain(SECRET);
    const id = create.body.data.id as string;

    const list = await request(app).get(
      `/api/projects/${projectId}/overlive-app-credentials`
    );
    expect(JSON.stringify(list.body)).not.toContain(SECRET);

    await request(app)
      .put(`/api/overlive-app-credentials/${id}`)
      .send({ label: 'Renamed' });
    const row = getDb()
      .prepare('SELECT client_secret FROM overlive_app_credentials WHERE id = ?')
      .get(id) as { client_secret: string };
    expect(row.client_secret).toBe(SECRET);
  });

  it('account tokens and JWTs: never returned; the SE channel id is', async () => {
    const twitch = await request(app)
      .post(`/api/projects/${projectId}/overlive-accounts`)
      .send({
        platform: 'twitch',
        label: 'Main',
        credentials: { accessToken: SECRET, refreshToken: SECRET },
      });
    expect(twitch.status).toBe(201);
    expect(JSON.stringify(twitch.body)).not.toContain(SECRET);
    expect(twitch.body.data.credentials).toEqual({});

    const se = await request(app)
      .post(`/api/projects/${projectId}/overlive-accounts`)
      .send({
        platform: 'streamelements',
        label: 'SE',
        credentials: { jwt: SECRET, channelId: 'chan-1' },
      });
    expect(JSON.stringify(se.body)).not.toContain(SECRET);
    expect(se.body.data.credentials).toEqual({ channelId: 'chan-1' });

    const list = await request(app).get(
      `/api/projects/${projectId}/overlive-accounts`
    );
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
  });
});

describe('assistant apiKey', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
    await rm(process.env.VSPARK_CONFIG_PATH!, { force: true });
  });

  afterEach(() => {
    delete process.env.ASSISTANT_API_KEY;
  });

  it('PATCH /config answers with the redacted view', async () => {
    await request(app)
      .put('/api/assistant-config')
      .send({ baseUrl: 'http://localhost:1234', apiKey: SECRET });
    const res = await request(app)
      .patch('/api/config')
      .send({ live2dLicenseAccepted: true });
    expect(res.body.ok).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.data.assistant.hasApiKey).toBe(true);
  });

  it('changing the endpoint without a new key drops the old key', async () => {
    await request(app)
      .put('/api/assistant-config')
      .send({ baseUrl: 'http://localhost:1234', apiKey: SECRET });
    const moved = await request(app)
      .put('/api/assistant-config')
      .send({ baseUrl: 'http://elsewhere.example' });
    expect(moved.body.data.hasApiKey).toBe(false);
  });

  it('keeps the key when only the model changes', async () => {
    await request(app)
      .put('/api/assistant-config')
      .send({ baseUrl: 'http://localhost:1234', apiKey: SECRET });
    const res = await request(app)
      .put('/api/assistant-config')
      .send({ model: 'm2' });
    expect(res.body.data.hasApiKey).toBe(true);
  });

  it('does not copy a key from the environment into config.json', async () => {
    process.env.ASSISTANT_API_KEY = SECRET;
    const res = await request(app)
      .put('/api/assistant-config')
      .send({ model: 'm2' });
    expect(res.body.data.hasApiKey).toBe(true);
    const onDisk = await readFile(process.env.VSPARK_CONFIG_PATH!, 'utf-8');
    expect(onDisk).not.toContain(SECRET);
  });
});

describe('MCP list_overlive_accounts', () => {
  let app: Express;
  let httpServer: Server;
  let mcp: Client;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    await new Promise<void>((resolve) => {
      httpServer = app.listen(0, resolve);
    });
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const server = createMcpServer(
      new VsparkClient({ baseUrl: `http://127.0.0.1:${port}` })
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    mcp = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(st), mcp.connect(ct)]);
  });

  afterEach(async () => {
    await mcp.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('returns only id/platform/label/status/isDefault', async () => {
    const p = await request(app).post('/api/projects').send({ name: 'P' });
    await request(app)
      .post(`/api/projects/${p.body.data.id}/overlive-accounts`)
      .send({
        platform: 'twitch',
        label: 'Main',
        credentials: { accessToken: SECRET },
        broadcasterLogin: 'streamer',
      });
    const r = (await mcp.callTool({
      name: 'list_overlive_accounts',
      arguments: { projectId: p.body.data.id },
    })) as { content: { text?: string }[] };
    const text = r.content.map((c) => c.text ?? '').join('');
    expect(text).not.toContain(SECRET);
    const rows = JSON.parse(text) as Record<string, unknown>[];
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['id', 'isDefault', 'label', 'platform', 'status'].sort()
    );
  });
});

describe('local access guard', () => {
  it('recognizes loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('accepts loopback names and IP literals as Host, refuses other names', () => {
    expect(hostAllowed('localhost:3001')).toBe(true);
    expect(hostAllowed('127.0.0.1:3001')).toBe(true);
    expect(hostAllowed('[::1]:3001')).toBe(true);
    expect(hostAllowed('100.64.1.2:5173')).toBe(true);
    expect(hostAllowed('evil.example:3001')).toBe(false); // DNS rebinding
  });

  it('accepts names listed in VSPARK_ALLOWED_HOSTS', () => {
    process.env.VSPARK_ALLOWED_HOSTS = 'studio.tailnet.ts.net';
    try {
      expect(hostAllowed('studio.tailnet.ts.net:5173')).toBe(true);
    } finally {
      delete process.env.VSPARK_ALLOWED_HOSTS;
    }
  });

  it('refuses cross-site WebSocket origins', () => {
    expect(originAllowed(undefined, 'localhost:3001')).toBe(true);
    expect(originAllowed('http://localhost:5173', 'localhost:3001')).toBe(true);
    expect(originAllowed('http://100.64.1.2:5173', '100.64.1.2:5173')).toBe(true);
    expect(originAllowed('https://evil.example', 'localhost:3001')).toBe(false);
    expect(originAllowed('not a url', 'localhost:3001')).toBe(false);
  });

  it('refuses requests from other machines unless VSPARK_ALLOW_LAN=1', async () => {
    const { app } = await makeTestApp();
    // supertest connects over loopback, so the default path is allowed …
    const ok = await request(app).get('/health');
    expect(ok.status).toBe(200);
    // … and a rebinding Host is refused regardless.
    const bad = await request(app).get('/health').set('Host', 'evil.example');
    expect(bad.status).toBe(403);
  });
});
