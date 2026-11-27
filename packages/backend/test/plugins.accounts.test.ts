import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp } from './helpers/testApp.js';
import { buildFixturePlugin } from './helpers/plugins.js';
import { getDb } from '../src/db/index.js';
import { getMeshCollection, getMeshPeer } from '../src/mesh/index.js';
import { PluginHost, setPluginHost } from '../src/plugins/loader.js';
import { createAccountsApi, ReauthRequired } from '../src/plugins/accounts/store.js';
import { guardPluginAccount, guardPluginApp } from '../src/plugins/accounts/guards.js';
import { oauthRedirectUri, pkcePair } from '../src/plugins/accounts/oauth.js';
import { pluginCollection, publishPlugins } from '../src/mesh/plugins.js';
import { statusCollection } from '../src/mesh/status.js';

/**
 * Plugin-system phase 3: provider accounts. The fixture plugin "hello"
 * defines provider `hello:svc` (token endpoint https://example.test/token);
 * fetch is stubbed for the provider's endpoints only.
 */

let app: Express;
let host: PluginHost;
let projectId: string;
const realFetch = globalThis.fetch;
let tokenResponses: Array<{ status: number; body?: unknown }>;
let tokenRequests: URLSearchParams[];

const accounts = () => getMeshCollection('plugin_account')!;
const status = (id: string) =>
  statusCollection()!.get(`plugin_account:${id}`) as { status?: string } | undefined;

beforeEach(async () => {
  process.env.VSPARK_PLUGINS_DIR = mkdtempSync(join(tmpdir(), 'vspark-plugins-'));
  ({ app } = await makeTestApp({ mesh: true }));
  host = new PluginHost('0.13.0');
  setPluginHost(host);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await host.load(await buildFixturePlugin('hello'), 'dev');
  projectId = (await request(app).post('/api/projects').send({ name: 'P' })).body.data.id;
  tokenResponses = [];
  tokenRequests = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url) === 'https://example.test/token') {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      const r = tokenResponses.shift() ?? { status: 500 };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }
    return realFetch(url, init);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await host.closeAll();
  setPluginHost(undefined);
  delete process.env.VSPARK_PLUGINS_DIR;
  vi.restoreAllMocks();
});

async function setClientId(clientId: string) {
  await getMeshCollection('plugin_app')!.set(`${projectId}:hello:svc`, '', {
    id: `${projectId}:hello:svc`,
    projectId,
    provider: 'hello:svc',
    fields: { clientId, junk: 'dropped' },
  } as never).ack;
}

async function connect(accountId?: string): Promise<string> {
  const start = await request(app)
    .get('/api/plugin-auth/start')
    .query({ provider: 'hello:svc', projectId, ...(accountId ? { accountId } : {}) });
  expect(start.status).toBe(302);
  const url = new URL(start.headers.location);
  tokenResponses.push({ status: 200, body: { access_token: 'tok1', refresh_token: 'ref1', expires_in: 3600 } });
  const cb = await request(app).get('/api/plugin-auth/callback').query({ code: 'c0de', state: url.searchParams.get('state') });
  expect(cb.status).toBe(200);
  expect(cb.text).toContain('vspark-plugin-oauth');
  return /"accountId":"([^"]+)"/.exec(cb.text)![1]!;
}

describe('connecting an account', () => {
  it('needs the app client id, then runs PKCE and stores the account without its tokens', async () => {
    const early = await request(app).get('/api/plugin-auth/start').query({ provider: 'hello:svc', projectId });
    expect(early.status).toBe(400);
    expect(early.text).toContain('client id');

    await setClientId('client-123');
    expect(getMeshCollection('plugin_app')!.get(`${projectId}:hello:svc`)).toMatchObject({ fields: { clientId: 'client-123' } });

    const start = await request(app).get('/api/plugin-auth/start').query({ provider: 'hello:svc', projectId });
    const url = new URL(start.headers.location);
    expect(url.origin + url.pathname).toBe('https://example.test/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(oauthRedirectUri());
    expect(oauthRedirectUri()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/plugin-auth\/callback$/);

    tokenResponses.push({ status: 200, body: { access_token: 'tok1', refresh_token: 'ref1', expires_in: 3600 } });
    const cb = await request(app).get('/api/plugin-auth/callback').query({ code: 'c0de', state: url.searchParams.get('state') });
    expect(cb.status).toBe(200);
    expect(tokenRequests[0]!.get('code_verifier')).toBeTruthy();
    expect(tokenRequests[0]!.get('client_id')).toBe('client-123');

    const doc = accounts().all()[0] as Record<string, unknown>;
    expect(doc).toMatchObject({ projectId, provider: 'hello:svc', label: 'user-tok1', isDefault: true, identity: { token: 'tok1' } });
    expect(JSON.stringify(doc)).not.toContain('ref1'); // tokens never in the document
    const row = getDb().prepare('SELECT credentials FROM plugin_accounts WHERE id = ?').get(doc.id as string) as { credentials: string };
    expect(JSON.parse(row.credentials)).toMatchObject({ accessToken: 'tok1', refreshToken: 'ref1' });
    expect(status(doc.id as string)?.status).toBe('connected');

    // A replayed state is refused.
    const again = await request(app).get('/api/plugin-auth/callback').query({ code: 'x', state: url.searchParams.get('state') });
    expect(again.status).toBe(400);
  });

  it('reconnects in place (stable id) and keeps one default per provider', async () => {
    await setClientId('c');
    const a = await connect();
    const b = await connect();
    expect(accounts().get(a)).toMatchObject({ isDefault: true });
    expect(accounts().get(b)).toMatchObject({ isDefault: false });
    expect(await connect(a)).toBe(a);
    await accounts().set(b, 'isDefault', true).ack;
    expect(accounts().get(a)).toMatchObject({ isDefault: false });
    const api = createAccountsApi('hello', () => {});
    expect(api.defaultFor(projectId, 'hello:svc')?.id).toBe(b);
    expect(api.list(projectId, 'hello:svc')).toHaveLength(2);
    // Another plugin cannot see these accounts.
    expect(createAccountsApi('other', () => {}).list(projectId, 'hello:svc')).toEqual([]);
  });
});

describe('tokens', () => {
  it('withToken refreshes an expired token, keeps the refresh token when none is rotated', async () => {
    await setClientId('c');
    const id = await connect();
    const api = createAccountsApi('hello', () => {});
    expect(await api.withToken(id, async (t) => t)).toBe('tok1');
    api.invalidate(id);
    tokenResponses.push({ status: 200, body: { access_token: 'tok2', expires_in: 3600 } });
    expect(await api.withToken(id, async (t) => t)).toBe('tok2');
    expect(tokenRequests.at(-1)!.get('refresh_token')).toBe('ref1');
    const row = getDb().prepare('SELECT credentials FROM plugin_accounts WHERE id = ?').get(id) as { credentials: string };
    expect(JSON.parse(row.credentials)).toMatchObject({ accessToken: 'tok2', refreshToken: 'ref1' });
  });

  it('a refused refresh marks the account needs_reauth', async () => {
    await setClientId('c');
    const id = await connect();
    const api = createAccountsApi('hello', () => {});
    api.invalidate(id);
    tokenResponses.push({ status: 400, body: { error: 'invalid_grant' } });
    await expect(api.withToken(id, async (t) => t)).rejects.toBeInstanceOf(ReauthRequired);
    expect(status(id)?.status).toBe('needs_reauth');
  });

  it('onChanged fires for the plugin when its accounts change', async () => {
    await setClientId('c');
    const seen: string[] = [];
    createAccountsApi('hello', () => {}).onChanged((p) => seen.push(p));
    const id = await connect();
    expect(seen).toContain(projectId);
    seen.length = 0;
    await accounts().remove(id).ack;
    await new Promise((r) => setImmediate(r));
    expect(seen).toContain(projectId);
    expect(getDb().prepare('SELECT 1 FROM plugin_accounts WHERE id = ?').get(id)).toBeUndefined();
  });
});

describe('provider info and guards', () => {
  it("the plugin's document lists its providers with the redirect URI", () => {
    publishPlugins(host.list());
    const doc = pluginCollection()!.get(`${getMeshPeer()!.id}:hello`)!;
    expect(doc.providers).toEqual([
      {
        id: 'hello:svc',
        label: 'account.provider',
        appFields: [{ path: 'clientId', label: 'account.clientId' }],
        redirectUri: oauthRedirectUri(),
      },
    ]);
  });

  it('tabs cannot change what the server established; app fields are limited to the declared ones', () => {
    const prev = { id: 'a', projectId: 'p', provider: 'x:y', identity: { u: 1 }, label: 'old' };
    const out = guardPluginAccount({ ...prev, provider: 'x:z', identity: {}, label: 'new' }, prev, true);
    expect(out).toMatchObject({ provider: 'x:y', identity: { u: 1 }, label: 'new' });
    expect(() => guardPluginAccount({ id: 'a', projectId: 'p', provider: 'bad' }, undefined, false)).toThrow();
    expect(guardPluginApp({ id: 'p:x:y', projectId: 'p', provider: 'x:y', fields: { clientId: ' c ', other: 'o' } }, ['clientId']).fields).toEqual({ clientId: 'c' });
    expect(() => guardPluginApp({ id: 'wrong', projectId: 'p', provider: 'x:y' })).toThrow();
  });

  it('PKCE challenge is the S256 of the verifier', async () => {
    const { verifier, challenge } = pkcePair();
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
  });
});
