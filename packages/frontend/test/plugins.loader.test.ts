/**
 * Plugin-system phase 2, editor side: the loader reads `plugin` mesh
 * documents of its own server and registers each active plugin's shared
 * contributions, i18n namespace and help topics; documents of other servers
 * (name only) feed the "plugin missing" note.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/i18n';
import { actionKind, responseTypeIds, unregisterActionContributions } from '@vspark/shared/actions';
import { COMPOSITE_TYPES, unregisterCompositeContributions } from '@vspark/shared/composites';
import type { PluginDoc } from '@vspark/shared/types';
import { docExists, getDocMarkdown } from '../src/help/docs';
import { COMPOSITE_DEFS, unregisterCompositeDefs } from '../src/components/editor/composites/compositeModel';
import {
  editorPluginStatus,
  loadPlugins,
  pluginForKind,
  pluginHelpTopic,
  type PluginSource,
} from '../src/plugins/loader';

const doc = (over: Partial<PluginDoc>): PluginDoc => ({
  id: 'srv:hello',
  name: { en: 'Hello', de: 'Hallo' },
  pluginId: 'hello',
  server: 'srv',
  version: '1.0.0',
  description: { en: '' },
  author: 'tests',
  homepage: null,
  network: [],
  source: 'dev',
  status: 'active',
  error: null,
  contributes: { nodes: [], actionKinds: [], responseTypes: [], composites: [] },
  baseUrl: '/plugin-files/hello',
  entries: { shared: 'shared.mjs', ui: null },
  locales: { en: { field: { name: 'Name' }, composite: { banner: { name: 'Hello banner' } } } },
  help: { en: { index: '# Hello {#overview}', setup: '# Setup {#setup}' } },
  ...over,
});

const sharedFactory = (sdk: { actions: { Tpl: new () => { out(): unknown } } }) => ({
  responseTypes: { hello_greet: { nodeKind: 'hello_greet', entryPort: 'fire', fields: [] } },
  actionKinds: [
    {
      kind: 'hello_wave',
      label: 'Wave',
      icon: '👋',
      fields: [],
      defaults: () => ({}),
      normalize: () => ({}),
      build: () => new sdk.actions.Tpl().out(),
      preview: () => ({ headline: [], lines: [] }),
    },
  ],
  compositeTypes: [{ type: 'hello_banner', rootRtype: 'compose_layer', parts: { panel: 'compose_layer' }, settings: [] }],
  compositePresets: [{ type: 'hello_banner', name: 'composite.banner.name' }],
});

const importModule = async (url: string) =>
  url.startsWith('/plugin-files/hello/shared.mjs') ? { default: sharedFactory } : { default: 'not a factory' };

function source(docs: PluginDoc[]): PluginSource & { emit(): void; docs: PluginDoc[] } {
  const listeners = new Set<() => void>();
  return {
    docs,
    serverPeerId: 'srv',
    ready: () => Promise.resolve(),
    all() {
      return this.docs;
    },
    observe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: () => listeners.forEach((l) => l()),
  };
}

afterEach(() => {
  unregisterActionContributions('hello');
  unregisterCompositeContributions('hello');
  unregisterCompositeDefs('hello');
  editorPluginStatus.clear();
  vi.restoreAllMocks();
});

describe('editor plugin loader', () => {
  it("loads our server's active plugins from their documents", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const src = source([
      doc({}),
      doc({ id: 'srv:bad', pluginId: 'bad', baseUrl: '/plugin-files/bad' }),
      doc({ id: 'srv:off', pluginId: 'off', status: 'failed' }),
      // A peer's document (name only) is never loaded.
      { id: 'other:remote', name: { en: 'Remote' } } as PluginDoc,
    ]);
    await loadPlugins(src, { importModule });
    expect(responseTypeIds()).toContain('hello_greet');
    expect(actionKind('hello_wave')?.plugin).toBe('hello');
    expect(COMPOSITE_TYPES.hello_banner?.plugin).toBe('hello');
    expect(COMPOSITE_DEFS.find((d) => d.type === 'hello_banner')).toMatchObject({
      presetId: 'plugin:hello:hello_banner',
      label: 'Hello banner',
    });
    expect(i18n.t('plugin-hello:field.name')).toBe('Name');
    expect(docExists('plugin-hello')).toBe(true);
    expect(getDocMarkdown('plugin-hello-setup', 'en')).toContain('Setup');
    expect(editorPluginStatus.get('hello')?.ok).toBe(true);
    expect(editorPluginStatus.get('bad')?.ok).toBe(false);
    expect(editorPluginStatus.has('off')).toBe(false);
    expect(editorPluginStatus.has('remote')).toBe(false);
  });

  it('loads a plugin that becomes active later, once', async () => {
    const src = source([]);
    await loadPlugins(src, { importModule });
    expect(actionKind('hello_wave')).toBeUndefined();
    src.docs = [doc({})];
    src.emit();
    await vi.waitFor(() => expect(actionKind('hello_wave')).toBeDefined());
    src.emit();
    await new Promise((r) => setTimeout(r, 0));
    expect(COMPOSITE_DEFS.filter((d) => d.type === 'hello_banner')).toHaveLength(1);
  });

  it('does not wait forever for the subscription', async () => {
    const src = { ...source([]), ready: () => new Promise<void>(() => {}) };
    await expect(loadPlugins(src, { importModule, timeoutMs: 10 })).resolves.toBeTypeOf('function');
  });
});

describe('plugin names for missing kinds', () => {
  it('finds the plugin a kind belongs to, also from name-only documents of peers', () => {
    const docs = [
      doc({}),
      { id: 'peer-2:spotify', name: { en: 'Spotify', de: 'Spotify' } } as PluginDoc,
      { id: 'peer-2:spotify_extra', name: { en: 'Spotify Extra' } } as PluginDoc,
    ];
    expect(pluginForKind(docs, 'spotify_now_playing')).toBe('Spotify');
    expect(pluginForKind(docs, 'spotify_extra_thing')).toBe('Spotify Extra');
    expect(pluginForKind(docs, 'hello_greet', 'de')).toBe('Hallo');
    expect(pluginForKind(docs, 'log')).toBeUndefined();
  });

  it('names help topics after the plugin', () => {
    expect(pluginHelpTopic('spotify', 'index.md')).toBe('plugin-spotify');
    expect(pluginHelpTopic('spotify', 'requests')).toBe('plugin-spotify-requests');
  });
});
