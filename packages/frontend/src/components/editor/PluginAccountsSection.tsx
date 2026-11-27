/**
 * Accounts of plugin account providers, inside the Accounts window — one
 * block per provider of an active plugin of our server (plugin-system
 * phase 3). Everything here is mesh: the provider list comes from `plugin`
 * documents, accounts are `plugin_account` documents (rename, default and
 * delete are tab writes), app credentials a `plugin_app` document, status a
 * `server_status` document. Connecting opens the server's OAuth start page
 * in a popup (a browser redirect to the provider, not an editor data call);
 * the new account arrives through the subscription.
 * See dev-notes/modules/plugins.md#accounts.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCollection, useMeshAll } from '@vspark/mesh-react';
import type {
  PluginAccountDoc,
  PluginAppDoc,
  PluginDoc,
  PluginProviderInfo,
} from '@vspark/shared/types';
import { HelpButton } from '../../help/HelpButton';
import { useConfirm } from '../DialogProvider';
import { getMeshHandles } from '../../mesh/peer';
import { createDoc, removeDoc, setField } from '../../mesh/docs';
import { useServerStatuses } from '../../mesh/runtime';
import { DraftText } from './actions/draftInputs';
import {
  codeStyle,
  dangerBtnStyle,
  emptyStateStyle,
  labelStyle,
  primaryBtnStyle,
  rowStyle,
  rowSubStyle,
  rowTitleStyle,
  secondaryBtnStyle,
  sectionHeaderStyle,
  sectionStyle,
} from './OverliveAccountsModal';

const STATUS_COLOR: Record<string, string> = {
  connected: '#4ade80',
  connecting: '#facc15',
  reconnecting: '#facc15',
  disconnected: '#888',
  error: '#f87171',
  needs_reauth: '#f87171',
};

const handleOf = (provider: string) => provider.replace(/[^a-z0-9]+/g, '-');

/** The OAuth start page of a provider, opened in a popup. */
export function pluginAuthStartUrl(provider: string, projectId: string, accountId?: string): string {
  const q = new URLSearchParams({ provider, projectId, ...(accountId ? { accountId } : {}) });
  return `/api/plugin-auth/start?${q}`;
}

function ProviderBlock({
  plugin,
  provider,
  projectId,
}: {
  plugin: PluginDoc;
  provider: PluginProviderInfo;
  projectId: string;
}) {
  const { t } = useTranslation('accounts');
  const confirm = useConfirm();
  const ns = `plugin-${plugin.pluginId}`;
  const accounts = useMeshAll(useCollection<PluginAccountDoc>('plugin_account')).filter(
    (a) => a.projectId === projectId && a.provider === provider.id
  );
  const appId = `${projectId}:${provider.id}`;
  const app = useMeshAll(useCollection<PluginAppDoc>('plugin_app')).find((a) => a.id === appId);
  const statuses = useServerStatuses('plugin_account');
  const [showSetup, setShowSetup] = useState(false);
  const h = handleOf(provider.id);
  const ready = provider.appFields.every((f) => (app?.fields?.[f.path] ?? '').trim() !== '');

  // A finished popup posts back; the account itself arrives via the mesh.
  const [popupError, setPopupError] = useState<string | null>(null);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { source?: string; payload?: { ok: boolean; message?: string } };
      if (d?.source !== 'vspark-plugin-oauth') return;
      setPopupError(d.payload?.ok ? null : (d.payload?.message ?? t('plugins.connectFailed')));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [t]);

  const setAppField = async (path: string, value: string) => {
    if (app) setField('plugin_app', appId, `fields.${path}`, value);
    else
      await createDoc<PluginAppDoc>('plugin_app', {
        id: appId,
        projectId,
        provider: provider.id,
        fields: { [path]: value },
      });
  };
  const open = (accountId?: string) =>
    window.open(pluginAuthStartUrl(provider.id, projectId, accountId), 'vspark-plugin-oauth', 'width=520,height=720');

  const setup = provider.setupHelp
    ? t(`${ns}:${provider.setupHelp}`, { redirectUri: provider.redirectUri })
    : '';

  return (
    <section style={sectionStyle} className={`vs-plugin-accounts vs-plugin-accounts-${h}`}>
      <div style={sectionHeaderStyle}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {t(`${ns}:${provider.label}`, { defaultValue: provider.id })}
          <HelpButton topic="plugins" anchor="accounts" tip={t('plugins.help')} />
        </span>
        <button
          className="vs-plugin-account-connect"
          style={primaryBtnStyle}
          disabled={!ready}
          title={ready ? undefined : t('plugins.needsApp')}
          onClick={() => open()}
        >
          {t('plugins.connect')}
        </button>
      </div>

      {provider.appFields.map((f) => (
        <label key={f.path} style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ minWidth: 80 }}>{t(`${ns}:${f.label}`, { defaultValue: f.path })}</span>
          <DraftText
            className={`vs-plugin-app-field vs-plugin-app-field-${f.path}`}
            value={app?.fields?.[f.path] ?? ''}
            onCommit={(v) => void setAppField(f.path, v)}
          />
        </label>
      ))}
      <div style={{ ...rowSubStyle, marginBottom: 6 }}>
        {t('plugins.redirectUri')} <code style={codeStyle}>{provider.redirectUri}</code>{' '}
        {setup && (
          <button className="vs-plugin-account-setup" style={secondaryBtnStyle} onClick={() => setShowSetup((v) => !v)}>
            {showSetup ? t('plugins.hideSetup') : t('plugins.showSetup')}
          </button>
        )}
      </div>
      {showSetup && setup && (
        <div style={{ ...rowSubStyle, whiteSpace: 'pre-wrap', marginBottom: 8 }}>{setup}</div>
      )}
      {popupError && <div style={{ ...rowSubStyle, color: '#f87171' }}>{popupError}</div>}

      {accounts.length === 0 ? (
        <div style={emptyStateStyle}>{t('plugins.empty')}</div>
      ) : (
        accounts.map((a) => {
          const st = statuses[a.id];
          const status = (st?.status as string | undefined) ?? 'disconnected';
          return (
            <div key={a.id} style={rowStyle} className="vs-plugin-account-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitleStyle}>
                  <DraftText
                    className="vs-plugin-account-label"
                    value={a.label}
                    onCommit={(v) => setField('plugin_account', a.id, 'label', v)}
                  />
                </div>
                <div style={rowSubStyle}>
                  <span style={{ color: STATUS_COLOR[status] ?? '#888' }}>● {t(`status.${status}`)}</span>
                  {st?.message ? <span style={{ marginLeft: 6 }}>{String(st.message)}</span> : null}
                </div>
              </div>
              {(status === 'needs_reauth' || status === 'error') && (
                <button className="vs-plugin-account-reconnect" style={secondaryBtnStyle} onClick={() => open(a.id)}>
                  {t('accounts.reconnect')}
                </button>
              )}
              <label title={t('accounts.defaultTitle')} style={{ ...labelStyle, display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  type="radio"
                  className="vs-plugin-account-default"
                  checked={a.isDefault}
                  onChange={() => setField('plugin_account', a.id, 'isDefault', true)}
                />
                {t('accounts.default')}
              </label>
              <button
                className="vs-plugin-account-remove"
                style={dangerBtnStyle}
                onClick={async () => {
                  if (await confirm({ message: t('plugins.removeConfirm', { label: a.label }), danger: true }))
                    await removeDoc('plugin_account', a.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })
      )}
    </section>
  );
}

export function PluginAccountsSection({ projectId }: { projectId: string }) {
  const server = getMeshHandles()?.serverPeerId;
  const plugins = useMeshAll(useCollection<PluginDoc>('plugin')).filter(
    (p) => p.server === server && p.status === 'active' && (p.providers?.length ?? 0) > 0
  );
  return (
    <>
      {plugins.flatMap((p) =>
        p.providers.map((pr) => <ProviderBlock key={pr.id} plugin={p} provider={pr} projectId={projectId} />)
      )}
    </>
  );
}
