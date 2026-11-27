import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionKind, responseTypeIds } from '@vspark/shared/actions';
import { COMPOSITE_TYPES } from '@vspark/shared/composites';
import { NODE_REGISTRY } from '../src/signal/registry.js';
import { getBuiltinPreset } from '../src/presets/builtins.js';
import { PluginHost, setPluginHost } from '../src/plugins/loader.js';
import { parseManifest, satisfies, compareVersions } from '../src/plugins/manifest.js';
import { writeState } from '../src/plugins/state.js';
import { PROVIDERS } from '../src/plugins/accounts/store.js';
import { dataChannelManager } from '../src/data_channels/manager.js';
import { makeTestApp } from './helpers/testApp.js';
import { buildFixturePlugin } from './helpers/plugins.js';
import { pullValue } from './helpers/nodeHarness.js';

/** Plugin-system phase 2: loading built plugins with the injected SDK. */

let host: PluginHost;
let pluginsDir: string;

beforeEach(() => {
  pluginsDir = mkdtempSync(join(tmpdir(), 'vspark-plugins-'));
  process.env.VSPARK_PLUGINS_DIR = pluginsDir;
  host = new PluginHost('0.13.0');
  setPluginHost(host);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await host.closeAll();
  setPluginHost(undefined);
  delete process.env.VSPARK_PLUGINS_DIR;
  vi.restoreAllMocks();
});

describe('loading a plugin', () => {
  it('registers its nodes, response types, Action kinds and composites; rolls back on close', async () => {
    const dir = await buildFixturePlugin('hello');
    const p = (await host.load(dir, 'dev'))!;
    expect(p.status).toBe('active');
    expect(p.summary).toEqual({
      nodes: ['hello_greet'],
      actionKinds: ['hello_wave'],
      responseTypes: ['hello_greet'],
      composites: ['hello_banner'],
    });
    expect(NODE_REGISTRY.has('hello_greet')).toBe(true);
    expect(pullValue('hello_greet', 'text', { name: 'Ada' })).toBe('Hello, Ada!');
    expect(responseTypeIds()).toContain('hello_greet');
    expect(actionKind('hello_wave')?.form?.[0]?.label).toBe('plugin-hello:field.name');
    expect(COMPOSITE_TYPES.hello_banner?.plugin).toBe('hello');
    // The preset's name is resolved from the plugin's English strings.
    expect(getBuiltinPreset('plugin:hello:hello_banner')?.name).toBe('Hello banner');
    expect(PROVIDERS.has('hello:svc')).toBe(true);
    expect(p.locales).toEqual({ de: ['plugin.json'], en: ['plugin.json'] });
    expect(p.help).toEqual({ en: ['index.md'] });

    await host.closeAll();
    expect(NODE_REGISTRY.has('hello_greet')).toBe(false);
    expect(responseTypeIds()).not.toContain('hello_greet');
    expect(actionKind('hello_wave')).toBeUndefined();
    expect(COMPOSITE_TYPES.hello_banner).toBeUndefined();
    expect(getBuiltinPreset('plugin:hello:hello_banner')).toBeUndefined();
    expect(PROVIDERS.has('hello:svc')).toBe(false);
    expect((globalThis as Record<string, unknown>).__helloDisposed).toBe(true);
  });

  it('a throwing activate rolls back what it registered and marks the plugin failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = (await host.load(await buildFixturePlugin('broken'), 'dev'))!;
    expect(p.status).toBe('failed');
    expect(p.error).toBe('boom');
    expect(NODE_REGISTRY.has('broken_x')).toBe(false);
    expect(responseTypeIds()).not.toContain('broken_x');
    expect((globalThis as Record<string, unknown>).__brokenDisposed).toBe(true);
  });

  it('refuses an incompatible plugin without importing it', async () => {
    const dir = await buildFixturePlugin('hello');
    const m = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...m, vspark: '>=2.0.0' }));
    const p = (await host.load(dir, 'dev'))!;
    expect(p.status).toBe('incompatible');
    expect(p.error).toMatch(/needs vspark >=2.0.0/);
    expect(NODE_REGISTRY.has('hello_greet')).toBe(false);
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...m, apiVersion: 99 }));
    expect((await host.load(dir, 'dev'))!.status).toBe('incompatible');
  });

  it('loadAll loads enabled installed plugins from the plugins dir and dev folders', async () => {
    await buildFixturePlugin('hello', join(pluginsDir, 'hello', '1.0.0'));
    writeState({ installed: { hello: { version: '1.0.0', enabled: true } } });
    await host.loadAll();
    expect(host.get('hello')?.status).toBe('active');
    expect(host.get('hello')?.source).toBe('installed');
    await host.closeAll();
    writeState({ installed: { hello: { version: '1.0.0', enabled: false } } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await host.loadAll({ dev: [await buildFixturePlugin('broken')] });
    expect(host.get('hello')).toBeUndefined();
    expect(host.get('broken')?.status).toBe('failed');
  });
});

describe('plugin context', () => {
  it('serves the plugin router, its browser files (not the backend entry) and the plugin lists', async () => {
    await host.load(await buildFixturePlugin('hello'), 'dev', { hello: { greeting: 'hi' } });
    const { app } = await makeTestApp();
    const ping = await request(app).get('/api/plugin/hello/ping');
    expect(ping.body).toEqual({ pong: true, config: { greeting: 'hi' } });
    expect((await request(app).get('/api/plugin/nope/ping')).status).toBe(404);

    const shared = await request(app).get('/plugin-files/hello/shared.mjs');
    expect(shared.status).toBe(200);
    expect((await request(app).get('/plugin-files/hello/backend.mjs')).status).toBe(404);
    expect(host.browserFile('hello', '../../etc/passwd')).toBeUndefined();
    expect(host.browserFile('hello', 'plugin.json')).toBeDefined();
    expect((await request(app).get('/plugin-files/hello/locales/en/plugin.json')).status).toBe(200);

    const list = await request(app).get('/api/plugins');
    expect(list.body.data[0]).toMatchObject({ id: 'hello', status: 'active', source: 'dev' });
    const active = await request(app).get('/api/plugins/active');
    expect(active.body.data[0]).toMatchObject({
      id: 'hello',
      baseUrl: '/plugin-files/hello',
      entries: { shared: 'shared.mjs', ui: null },
      help: { en: ['index.md'] },
    });
  });

  it('nodes publish data and use storage persisted in the plugin data folder', async () => {
    const set = vi.spyOn(dataChannelManager, 'set');
    await host.load(await buildFixturePlugin('hello'), 'dev');
    const { buildGraph } = await import('./helpers/nodeHarness.js');
    const { graph } = buildGraph(
      [{ id: 'g', kind: 'hello_greet' }],
      [],
      { g: { name: 'Bo', _projectId: 'p1' } }
    );
    graph.deliverExternal('g', 'fire', { payload: undefined, timestamp: 0 });
    expect(set).toHaveBeenCalledWith('', { helloGreeting: 'Hello, Bo!' });
    const stored = JSON.parse(readFileSync(join(pluginsDir, 'hello', 'data', 'storage.json'), 'utf8'));
    expect(stored.greetings).toBe(1);
  });
});

describe('manifest', () => {
  it('validates plugin.json', () => {
    expect(() => parseManifest({})).toThrow(/id must be/);
    expect(() =>
      parseManifest({ id: 'x', version: '1.0.0', apiVersion: 1, vspark: '*', name: { en: 'X' }, description: {}, author: 'a', entries: { backend: '../evil.js' } })
    ).toThrow(/entries.backend/);
  });

  it('compares versions and ranges', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(satisfies('0.13.2', '>=0.13.0 <1.0.0')).toBe(true);
    expect(satisfies('1.0.0', '>=0.13.0 <1.0.0')).toBe(false);
    expect(satisfies('0.13.5', '^0.13.0')).toBe(true);
    expect(satisfies('0.14.0', '^0.13.0')).toBe(false);
    expect(satisfies('2.3.0', '^2.1.0')).toBe(true);
    expect(satisfies('0.13.0-beta.2', '>=0.13.0')).toBe(true);
    expect(satisfies('5.0.0', '*')).toBe(true);
  });
});

