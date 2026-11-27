/**
 * Plugin-system phase 2, editor side: the loader registers a plugin's shared
 * contributions, i18n namespace and help topics from the server's list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '../src/i18n';
import { actionKind, responseTypeIds, unregisterActionContributions } from '@vspark/shared/actions';
import { COMPOSITE_TYPES, unregisterCompositeContributions } from '@vspark/shared/composites';
import { docExists, getDocMarkdown } from '../src/help/docs';
import { COMPOSITE_DEFS, unregisterCompositeDefs } from '../src/components/editor/composites/compositeModel';
import { editorPluginStatus, loadPlugins, pluginHelpTopic, type LoaderDeps } from '../src/plugins/loader';

const active = [
  {
    id: 'hello',
    version: '1.0.0',
    name: { en: 'Hello' },
    baseUrl: '/plugin-files/hello',
    entries: { shared: 'shared.mjs', ui: null },
    locales: { en: ['a.json', 'b.json'] },
    help: { en: ['index.md', 'setup.md'] },
  },
  { id: 'bad', version: '0.1.0', name: { en: 'Bad' }, baseUrl: '/plugin-files/bad', entries: { shared: 'shared.mjs', ui: null }, locales: {}, help: {} },
];

const files: Record<string, unknown> = {
  '/api/plugins/active': { ok: true, data: active },
  '/plugin-files/hello/locales/en/a.json': { field: { name: 'Name' }, composite: { banner: { name: 'Hello banner' } } },
  '/plugin-files/hello/locales/en/b.json': { field: { other: 'Other' } },
  '/plugin-files/hello/help/en/index.md': '# Hello {#overview}',
  '/plugin-files/hello/help/en/setup.md': '# Setup {#setup}',
};

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

const deps: LoaderDeps = {
  fetchJson: async (url) => files[url],
  fetchText: async (url) => files[url] as string,
  importModule: async (url) => {
    if (url.startsWith('/plugin-files/hello/shared.mjs')) return { default: sharedFactory };
    return { default: 'not a factory' };
  },
};

afterEach(() => {
  unregisterActionContributions('hello');
  unregisterCompositeContributions('hello');
  unregisterCompositeDefs('hello');
  editorPluginStatus.clear();
});

describe('editor plugin loader', () => {
  it('registers contributions, merges locale files into the plugin namespace and adds help topics', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadPlugins(deps);
    expect(responseTypeIds()).toContain('hello_greet');
    expect(actionKind('hello_wave')?.plugin).toBe('hello');
    expect(COMPOSITE_TYPES.hello_banner?.plugin).toBe('hello');
    const def = COMPOSITE_DEFS.find((d) => d.type === 'hello_banner')!;
    expect(def).toMatchObject({ presetId: 'plugin:hello:hello_banner', label: 'Hello banner', plugin: 'hello' });
    expect(i18n.t('plugin-hello:field.name')).toBe('Name');
    expect(i18n.t('plugin-hello:field.other')).toBe('Other');
    expect(docExists('plugin-hello')).toBe(true);
    expect(getDocMarkdown('plugin-hello-setup', 'en')).toContain('Setup');
    expect(editorPluginStatus.get('hello')).toEqual({ ok: true });
    // A broken plugin is recorded and skipped.
    expect(editorPluginStatus.get('bad')?.ok).toBe(false);
  });

  it('is idempotent and survives an unreachable server', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadPlugins(deps);
    await loadPlugins(deps);
    expect(COMPOSITE_DEFS.filter((d) => d.type === 'hello_banner')).toHaveLength(1);
    await expect(loadPlugins({ ...deps, fetchJson: () => Promise.reject(new Error('down')) })).resolves.toBeUndefined();
  });

  it('names help topics after the plugin', () => {
    expect(pluginHelpTopic('spotify', 'index.md')).toBe('plugin-spotify');
    expect(pluginHelpTopic('spotify', 'requests.md')).toBe('plugin-spotify-requests');
  });
});
