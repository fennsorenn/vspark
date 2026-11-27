/**
 * Plugin-system phase 3, editor side: the Accounts window shows a block per
 * provider of an active plugin of our server; app fields, rename, default and
 * delete are mesh writes; Connect opens the server's OAuth start page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginDoc } from '@vspark/shared/types';
import { renderWithProviders, userEvent, waitFor } from './helpers/render';
import { testPeer } from './helpers/mesh';
import { DialogProvider } from '../src/components/DialogProvider';
import { PluginAccountsSection, pluginAuthStartUrl } from '../src/components/editor/PluginAccountsSection';

const P = 'proj-acc';
const v = (n: number) => ({ v: { t: n, c: 0, n: 'seed' } });
const col = (rtype: string) => testPeer().collection<Record<string, unknown>>(rtype);

const pluginDoc = (over: Partial<PluginDoc> = {}): PluginDoc =>
  ({
    id: 'test-server:demo',
    name: { en: 'Demo' },
    pluginId: 'demo',
    server: 'test-server',
    version: '1.0.0',
    status: 'active',
    locales: {},
    help: {},
    providers: [
      {
        id: 'demo:svc',
        label: 'account.provider',
        appFields: [{ path: 'clientId', label: 'account.clientId' }],
        redirectUri: 'http://127.0.0.1:3001/api/plugin-auth/callback',
      },
    ],
    ...over,
  }) as PluginDoc;

const account = (id: string, isDefault: boolean, n: number) =>
  col('plugin_account').put(
    { id, projectId: P, provider: 'demo:svc', label: `acc ${id}`, identity: {}, isDefault },
    v(n)
  );

const render = () =>
  renderWithProviders(
    <DialogProvider>
      <PluginAccountsSection projectId={P} />
    </DialogProvider>
  );

beforeEach(() => {
  col('plugin').put(pluginDoc() as never, v(1));
});
afterEach(() => vi.restoreAllMocks());

describe('plugin accounts section', () => {
  it('shows only providers of active plugins of our own server', () => {
    col('plugin').put(pluginDoc({ id: 'peer:other', server: 'peer', pluginId: 'other' }) as never, v(2));
    col('plugin').put(pluginDoc({ id: 'test-server:off', pluginId: 'off', status: 'failed' }) as never, v(3));
    const { container } = render();
    expect(container.querySelectorAll('.vs-plugin-accounts')).toHaveLength(1);
    expect(container.querySelector('.vs-plugin-accounts-demo-svc')).not.toBeNull();
    expect(container.textContent).toContain('http://127.0.0.1:3001/api/plugin-auth/callback');
  });

  it('Connect needs the app fields; entering them writes the plugin_app document', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { container } = render();
    const connect = container.querySelector('.vs-plugin-account-connect') as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    const input = container.querySelector('.vs-plugin-app-field-clientId') as HTMLInputElement;
    await user.type(input, 'client-1{Enter}');
    await waitFor(() =>
      expect(col('plugin_app').get(`${P}:demo:svc`)).toMatchObject({ fields: { clientId: 'client-1' } })
    );
    await waitFor(() => expect(connect.disabled).toBe(false));
    await user.click(connect);
    expect(open.mock.calls[0]![0]).toBe(pluginAuthStartUrl('demo:svc', P));
  });

  it('lists accounts with status; rename, default and delete are mesh writes', async () => {
    account('a1', true, 2);
    account('a2', false, 3);
    col('server_status').put(
      { id: 'plugin_account:a2', kind: 'plugin_account', key: 'a2', status: 'needs_reauth', message: 'expired' },
      v(4)
    );
    const user = userEvent.setup();
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { container, getByRole } = render();
    const rows = container.querySelectorAll('.vs-plugin-account-row');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.textContent).toContain('expired');
    expect(rows[1]!.querySelector('.vs-plugin-account-reconnect')).not.toBeNull();

    await user.click(rows[1]!.querySelector('.vs-plugin-account-default')!);
    await waitFor(() => expect(col('plugin_account').get('a2')).toMatchObject({ isDefault: true }));

    const label = rows[0]!.querySelector('.vs-plugin-account-label') as HTMLInputElement;
    await user.clear(label);
    await user.type(label, 'Main{Enter}');
    await waitFor(() => expect(col('plugin_account').get('a1')).toMatchObject({ label: 'Main' }));

    await user.click(rows[0]!.querySelector('.vs-plugin-account-remove')!);
    await user.click(getByRole('button', { name: /ok|confirm|yes|delete|remove|bestätigen/i }));
    await waitFor(() => expect(col('plugin_account').get('a1')).toBeUndefined());
  });

  it('builds the OAuth start URL (reconnect carries the account id)', () => {
    expect(pluginAuthStartUrl('demo:svc', 'p1', 'a1')).toBe('/api/plugin-auth/start?provider=demo%3Asvc&projectId=p1&accountId=a1');
  });
});
