import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginCatalogDoc, PluginHostStatus } from '@vspark/shared/types';
import { makeTestApp } from './helpers/testApp.js';
import { buildFixturePlugin, zipPlugin } from './helpers/plugins.js';
import { NODE_REGISTRY } from '../src/signal/registry.js';
import { PluginHost, setPluginHost } from '../src/plugins/loader.js';
import { PluginManager, applyPendingChanges } from '../src/plugins/manager.js';
import { readState, writeState } from '../src/plugins/state.js';
import { pluginVersionDir } from '../src/plugins/paths.js';
import { OFFICIAL_REGISTRY, parseRegistry, pickVersion } from '../src/plugins/registry.js';

/**
 * Plugin-system phase 4: registries, install / update / enable / disable /
 * uninstall and pending changes. Registry and zip downloads are served by a
 * stubbed fetch; the zip is a real build of the fixture plugin.
 */

const OTHER = 'https://example.test/third-party.json';
let host: PluginHost;
let published: { docs: PluginCatalogDoc[]; status: PluginHostStatus };
let files: Record<string, { status: number; body: unknown }>;

const fakeFetch = (async (url: string | URL) => {
  const f = files[String(url)];
  if (!f) return new Response(null, { status: 404 });
  const body = f.body instanceof Uint8Array ? f.body : JSON.stringify(f.body);
  return new Response(body as BodyInit, { status: f.status, headers: f.body instanceof Uint8Array ? { 'content-length': String(f.body.byteLength) } : {} });
}) as typeof fetch;

function registry(entries: unknown[]) {
  return { status: 200, body: { schema: 1, plugins: entries } };
}

async function helloRelease(version = '1.0.0') {
  const dir = await buildFixturePlugin('hello');
  if (version !== '1.0.0') {
    const m = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'plugin.json'), 'utf8'));
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...m, version }));
  }
  const { zip, sha256 } = await zipPlugin(dir);
  const url = `https://example.test/hello-${version}.zip`;
  files[url] = { status: 200, body: zip };
  return { version, apiVersion: 1, vspark: '>=0.1.0', channel: 'stable', url, sha256 };
}

function manager() {
  return new PluginManager({
    host,
    fetch: fakeFetch,
    hostVersion: '0.13.0',
    publish: (docs, status) => (published = { docs, status }),
  });
}

const doc = (id: string) => published.docs.find((d) => d.id === id);

beforeEach(async () => {
  process.env.VSPARK_PLUGINS_DIR = mkdtempSync(join(tmpdir(), 'vspark-plugins-'));
  process.env.VSPARK_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'vspark-cfg-')), 'config.json');
  await makeTestApp({ mesh: true });
  host = new PluginHost('0.13.0');
  setPluginHost(host);
  files = {};
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await host.closeAll();
  setPluginHost(undefined);
  delete process.env.VSPARK_PLUGINS_DIR;
  delete process.env.VSPARK_CONFIG_PATH;
  vi.restoreAllMocks();
});

const helloEntry = (versions: unknown[]) => ({
  id: 'hello',
  name: { en: 'Hello' },
  description: { en: 'fixture' },
  author: 'tests',
  network: ['example.test'],
  versions,
});

describe('registries', () => {
  it('lists the official registry by default and reports a failing one', async () => {
    files[OFFICIAL_REGISTRY] = registry([helloEntry([await helloRelease()])]);
    const m = manager();
    await m.refresh();
    expect(published.status.registries).toEqual([
      expect.objectContaining({ url: OFFICIAL_REGISTRY, official: true, trusted: true, ok: true, count: 1 }),
    ]);
    expect(doc('hello')).toMatchObject({ latest: '1.0.0', installed: null, network: ['example.test'], registry: { official: true } });

    await m.handle({ action: 'set_registries', registries: [{ url: OTHER, trusted: false }] });
    expect(published.status.registries[0]).toMatchObject({ url: OTHER, ok: false, error: expect.stringContaining('404') });
  });

  it('validates entries and picks the newest compatible version on the channel', () => {
    const { registry, problems } = parseRegistry({
      schema: 1,
      plugins: [
        {
          id: 'x',
          versions: [
            { version: '2.0.0', apiVersion: 2, vspark: '*', url: 'https://a', sha256: 'a'.repeat(64) },
            { version: '1.5.0', apiVersion: 1, vspark: '*', channel: 'experimental', url: 'https://a', sha256: 'a'.repeat(64) },
            { version: '1.4.0', apiVersion: 1, vspark: '>=0.13.0', url: 'https://a', sha256: 'a'.repeat(64) },
            { version: '1.3.0', apiVersion: 1, vspark: '*', url: 'http://insecure', sha256: 'a'.repeat(64) },
          ],
        },
        { id: 'Bad Id' },
      ],
    });
    expect(problems).toHaveLength(2);
    const p = registry.plugins[0]!;
    expect(pickVersion(p, '0.13.0', 'stable')?.version).toBe('1.4.0');
    expect(pickVersion(p, '0.13.0', 'experimental')?.version).toBe('1.5.0');
    expect(pickVersion(p, '0.12.0', 'stable')).toBeUndefined();
  });
});

describe('installing', () => {
  it('installs live: verifies, unpacks, records state and activates the plugin', async () => {
    files[OFFICIAL_REGISTRY] = registry([helloEntry([await helloRelease()])]);
    const m = manager();
    await m.refresh();
    expect(await m.handle({ action: 'install', pluginId: 'hello' })).toEqual({ ok: true });
    expect(existsSync(join(pluginVersionDir('hello', '1.0.0'), 'plugin.json'))).toBe(true);
    expect(readState().installed.hello).toMatchObject({ version: '1.0.0', enabled: true, registry: OFFICIAL_REGISTRY });
    expect(NODE_REGISTRY.has('hello_greet')).toBe(true);
    expect(doc('hello')).toMatchObject({
      installed: { version: '1.0.0', enabled: true },
      running: { status: 'active' },
      job: { state: 'done' },
    });
    expect(published.status.restartRequired).toBe(false);
    expect(await m.handle({ action: 'install', pluginId: 'hello' })).toEqual({ ok: false, error: 'already_installed' });
  });

  it('refuses a checksum mismatch and untrusted registries', async () => {
    const rel = await helloRelease();
    files[OFFICIAL_REGISTRY] = registry([helloEntry([{ ...rel, sha256: 'b'.repeat(64) }])]);
    const m = manager();
    await m.refresh();
    const r = await m.handle({ action: 'install', pluginId: 'hello' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/checksum mismatch/);
    expect(existsSync(pluginVersionDir('hello', '1.0.0'))).toBe(false);
    expect(doc('hello')?.job).toMatchObject({ state: 'failed' });

    files[OTHER] = registry([helloEntry([rel])]);
    await m.handle({ action: 'set_registries', registries: [{ url: OTHER, trusted: false }] });
    expect(await m.handle({ action: 'install', pluginId: 'hello' })).toEqual({ ok: false, error: 'untrusted_registry' });
    await m.handle({ action: 'set_registries', registries: [{ url: OTHER, trusted: true }] });
    expect(await m.handle({ action: 'install', pluginId: 'hello' })).toEqual({ ok: true });
  });

  it('updating a running plugin downloads now and swaps at the next start', async () => {
    files[OFFICIAL_REGISTRY] = registry([helloEntry([await helloRelease()])]);
    const m = manager();
    await m.refresh();
    await m.handle({ action: 'install', pluginId: 'hello' });
    files[OFFICIAL_REGISTRY] = registry([helloEntry([await helloRelease('1.1.0'), await helloRelease()])]);
    await m.refresh();
    expect(doc('hello')?.latest).toBe('1.1.0');
    expect(await m.handle({ action: 'update', pluginId: 'hello' })).toEqual({ ok: true });
    expect(readState().installed.hello).toMatchObject({ version: '1.0.0', pending: { action: 'update', version: '1.1.0' } });
    expect(published.status.restartRequired).toBe(true);
    applyPendingChanges(); // what the next start does first
    expect(readState().installed.hello).toEqual(expect.objectContaining({ version: '1.1.0' }));
    expect(readState().installed.hello!.pending).toBeUndefined();
    expect(existsSync(pluginVersionDir('hello', '1.0.0'))).toBe(false);
  });
});

describe('enable / disable / uninstall', () => {
  it('a running plugin is disabled or uninstalled at the next start; cancel undoes the schedule', async () => {
    files[OFFICIAL_REGISTRY] = registry([helloEntry([await helloRelease()])]);
    const m = manager();
    await m.refresh();
    await m.handle({ action: 'install', pluginId: 'hello' });
    await m.handle({ action: 'disable', pluginId: 'hello' });
    expect(doc('hello')?.pending).toEqual({ action: 'disable' });
    await m.handle({ action: 'cancel_pending', pluginId: 'hello' });
    expect(doc('hello')?.pending).toBeNull();
    await m.handle({ action: 'uninstall', pluginId: 'hello' });
    applyPendingChanges();
    expect(readState().installed.hello).toBeUndefined();
    expect(existsSync(join(process.env.VSPARK_PLUGINS_DIR!, 'hello'))).toBe(false);
  });

  it('a plugin that is not running is disabled now and enabled live', async () => {
    await buildFixturePlugin('hello', pluginVersionDir('hello', '1.0.0'));
    writeState({ installed: { hello: { version: '1.0.0', enabled: false } } });
    const m = manager();
    await m.refresh();
    expect(await m.handle({ action: 'enable', pluginId: 'hello' })).toEqual({ ok: true });
    expect(host.get('hello')?.status).toBe('active');
    expect(readState().installed.hello?.enabled).toBe(true);
    await host.closeAll();
    expect(await m.handle({ action: 'disable', pluginId: 'hello' })).toEqual({ ok: true });
    expect(readState().installed.hello?.enabled).toBe(false);
    expect(doc('hello')?.pending).toBeNull();
  });

  it('restart is refused on a dev server; unknown commands are refused', async () => {
    const exit = vi.fn();
    const m = new PluginManager({ host, fetch: fakeFetch, exit, publish: () => {} });
    expect(await m.handle({ action: 'restart' })).toEqual({ ok: false, error: 'not_packaged' });
    expect(await m.handle({ action: 'nope' } as never)).toEqual({ ok: false, error: 'unknown_action' });
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('over the mesh', () => {
  it('a tab sends a command and gets the reply; the catalog reaches it as documents', async () => {
    const { createLoopbackPair, createMeshPeer } = await import('@vspark/mesh');
    const { makeClientParticipantId } = await import('@vspark/shared/sync');
    const { MODELS } = await import('@vspark/shared/models');
    const { getMeshPeer } = await import('../src/mesh/index.js');
    const { publishCatalog, setPluginCommandHandler } = await import('../src/mesh/pluginCatalog.js');

    files[OFFICIAL_REGISTRY] = registry([helloEntry([await helloRelease()])]);
    const m = new PluginManager({ host, fetch: fakeFetch, hostVersion: '0.13.0', publish: publishCatalog });
    setPluginCommandHandler((cmd) => m.handle(cmd));

    const server = getMeshPeer()!;
    const tabId = makeClientParticipantId(server.id, 'tab1');
    const lb = createLoopbackPair(server.id, tabId);
    server.addTransport(lb.a);
    const tab = createMeshPeer({ identity: { peerId: tabId }, transports: [lb.b], models: MODELS });
    const catalog = tab.collection<PluginCatalogDoc>('plugin_catalog');
    const commands = tab.collection<{ id: string }>('plugin_command');
    await lb.flush();
    await tab.subscribe({ entityRtype: 'plugin_catalog', entityId: '*', includeDescendants: false, pathPrefix: '' });
    await lb.flush();

    const pending = commands.request('c1', { id: 'c1', action: 'refresh' }, { to: server.id, timeoutMs: 5000 });
    for (let i = 0; i < 20; i++) {
      await lb.flush();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await pending).toEqual({ status: 'replied', data: { id: 'c1', ok: true } });
    await lb.flush();
    expect(catalog.get('hello')).toMatchObject({ latest: '1.0.0' });
    setPluginCommandHandler(null);
    tab.close();
  });
});
