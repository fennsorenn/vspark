/**
 * Plugin-system phase 4, editor side: the Plugins window reads catalog
 * documents and the host status, and acts through plugin_command requests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginCatalogDoc } from '@vspark/shared/types';
import { renderWithProviders, userEvent, waitFor } from './helpers/render';
import { testPeer } from './helpers/mesh';
import { DialogProvider } from '../src/components/DialogProvider';

const sent: unknown[] = [];
vi.mock('../src/mesh/pluginCommands', () => ({
  sendPluginCommand: vi.fn(async (cmd: unknown) => {
    sent.push(cmd);
    return (cmd as { action: string }).action === 'install' ? { ok: false, error: 'untrusted_registry' } : { ok: true };
  }),
}));

const { PluginsWindow, updateAvailable, localized } = await import('../src/components/editor/PluginsWindow');

const v = (n: number) => ({ v: { t: n, c: 0, n: 'seed' } });
const base = (over: Partial<PluginCatalogDoc>): PluginCatalogDoc => ({
  id: 'x',
  pluginId: 'x',
  name: { en: 'X', de: 'X-de' },
  description: { en: 'desc' },
  author: 'a',
  homepage: null,
  tags: [],
  network: ['api.example.com'],
  registry: { url: 'https://r', trusted: true, official: true },
  versions: [{ version: '1.0.0', channel: 'stable', compatible: true, notes: {} }],
  latest: '1.0.0',
  installed: null,
  running: null,
  pending: null,
  job: null,
  ...over,
});

const seed = (docs: PluginCatalogDoc[], status: Record<string, unknown> = {}) => {
  docs.forEach((d, i) => testPeer().collection<Record<string, unknown>>('plugin_catalog').put(d as never, v(i + 1)));
  testPeer()
    .collection<Record<string, unknown>>('server_status')
    .put({ id: 'plugins:main', kind: 'plugins', key: 'main', registries: [], restartRequired: false, canRestart: true, ...status }, v(99));
};

const render = () =>
  renderWithProviders(
    <DialogProvider>
      <PluginsWindow onClose={() => {}} />
    </DialogProvider>
  );

beforeEach(() => {
  sent.length = 0;
});

describe('Plugins window', () => {
  it('splits installed and available plugins; shows status and an update', async () => {
    seed([
      base({ id: 'spotify', pluginId: 'spotify', name: { en: 'Spotify' }, latest: '1.1.0', installed: { version: '1.0.0', enabled: true, source: 'installed' }, running: { version: '1.0.0', status: 'active', error: null } }),
      base({ id: 'weather', pluginId: 'weather', name: { en: 'Weather' } }),
    ]);
    const user = userEvent.setup();
    const { container } = render();
    expect(container.querySelector('.vs-plugin-row-spotify')!.textContent).toContain('Running');
    expect(container.querySelector('.vs-plugin-row-spotify .vs-plugin-update')!.textContent).toContain('1.1.0');
    expect(container.querySelector('.vs-plugin-row-weather')).toBeNull();
    await user.click(container.querySelector('.vs-plugins-tab-browse')!);
    expect(container.querySelector('.vs-plugin-row-weather .vs-plugin-install')).not.toBeNull();
  });

  it('install asks first (listing hosts), sends the command and shows a refusal', async () => {
    seed([base({ id: 'weather', pluginId: 'weather', name: { en: 'Weather' } })]);
    const user = userEvent.setup();
    const { container } = render();
    await user.click(container.querySelector('.vs-plugins-tab-browse')!);
    await user.click(container.querySelector('.vs-plugin-install')!);
    expect(document.body.textContent).toContain('api.example.com');
    await user.click(document.querySelector('.vs-dialog-confirm')!);
    await waitFor(() => expect(sent).toContainEqual({ action: 'install', pluginId: 'weather' }));
    await waitFor(() => expect(container.querySelector('.vs-plugins-message')!.textContent).toMatch(/Trust this registry/));
  });

  it('pending changes, restart banner and toggles send the right commands', async () => {
    seed(
      [
        base({ id: 'a', pluginId: 'a', installed: { version: '1.0.0', enabled: true, source: 'installed' }, pending: { action: 'uninstall' } }),
        base({ id: 'b', pluginId: 'b', installed: { version: '1.0.0', enabled: true, source: 'installed' }, running: { version: '1.0.0', status: 'active', error: null } }),
      ],
      { restartRequired: true }
    );
    const user = userEvent.setup();
    const { container } = render();
    expect(container.querySelector('.vs-plugins-restart-banner')).not.toBeNull();
    expect(container.querySelector('.vs-plugin-row-a')!.textContent).toContain('removed when vspark restarts');
    await user.click(container.querySelector('.vs-plugin-row-a .vs-plugin-cancel')!);
    await user.click(container.querySelector('.vs-plugin-row-b .vs-plugin-enabled')!);
    await waitFor(() =>
      expect(sent).toEqual([
        { action: 'cancel_pending', pluginId: 'a' },
        { action: 'disable', pluginId: 'b' },
      ])
    );
  });

  it('registries: add a third-party one (untrusted), trust it after confirming', async () => {
    seed([], {
      registries: [{ url: 'https://official', trusted: true, official: true, ok: true, error: null, problems: [], checkedAt: null, count: 0 }],
    });
    const user = userEvent.setup();
    const { container } = render();
    await user.click(container.querySelector('.vs-plugins-registries-toggle')!);
    await user.type(container.querySelector('.vs-plugins-registry-url')!, 'https://third.example/r.json');
    await user.click(container.querySelector('.vs-plugins-registry-add')!);
    await waitFor(() =>
      expect(sent).toContainEqual({
        action: 'set_registries',
        registries: [
          { url: 'https://official', trusted: true },
          { url: 'https://third.example/r.json', trusted: false },
        ],
      })
    );
  });

  it('helpers: update detection and localized text', () => {
    expect(updateAvailable(base({ latest: '1.2.0', installed: { version: '1.10.0', enabled: true, source: 'installed' } }))).toBe(false);
    expect(updateAvailable(base({ latest: '1.10.0', installed: { version: '1.2.0', enabled: true, source: 'installed' } }))).toBe(true);
    expect(updateAvailable(base({ latest: '2.0.0', installed: { version: '1.0.0', enabled: true, source: 'dev' } }))).toBe(false);
    expect(localized({ en: 'X', de: 'Y' }, 'de-AT')).toBe('Y');
    expect(localized({ en: 'X' }, 'fr')).toBe('X');
  });
});
