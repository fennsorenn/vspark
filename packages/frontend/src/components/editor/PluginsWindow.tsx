/**
 * The Plugins window (TopBar → Plugins): browse what the registries offer,
 * install / update / enable / disable / uninstall, see what each plugin adds,
 * restart when a change needs it, and manage the registry list. Everything is
 * mesh: `plugin_catalog` documents and the `server_status` document
 * (`plugins:main`) to read, `plugin_command` requests to act (mesh principle
 * 7). See dev-notes/modules/plugins.md#managing.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCollection, useMeshAll } from '@vspark/mesh-react';
import type { PluginCatalogDoc, PluginDoc, PluginHostStatus } from '@vspark/shared/types';
import { HelpButton } from '../../help/HelpButton';
import { useConfirm } from '../DialogProvider';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { getMeshHandles } from '../../mesh/peer';
import { useServerStatus } from '../../mesh/runtime';
import { sendPluginCommand, type CommandReply } from '../../mesh/pluginCommands';
import type { PluginCommand } from '@vspark/shared/types';
import {
  codeStyle,
  dangerBtnStyle,
  emptyStateStyle,
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  rowStyle,
  rowSubStyle,
  rowTitleStyle,
  secondaryBtnStyle,
  sectionHeaderStyle,
  sectionStyle,
} from './OverliveAccountsModal';

type Tab = 'installed' | 'browse';

/** The text of a localized map in the UI language (English fallback). */
export function localized(map: Record<string, string> | undefined, lng: string): string {
  if (!map) return '';
  return map[lng] ?? map[lng.split('-')[0]!] ?? map.en ?? Object.values(map)[0] ?? '';
}

const newer = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/** Is an update offered for this plugin? */
export const updateAvailable = (d: PluginCatalogDoc) =>
  !!d.installed && d.installed.source === 'installed' && !!d.latest && newer(d.latest, d.installed.version) && d.pending?.action !== 'update';

export function PluginsWindow({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation('plugins');
  const confirm = useConfirm();
  useEscapeKey(onClose);
  const lng = i18n.resolvedLanguage ?? 'en';
  const catalog = useMeshAll(useCollection<PluginCatalogDoc>('plugin_catalog'));
  const server = getMeshHandles()?.serverPeerId;
  const loaded = useMeshAll(useCollection<PluginDoc>('plugin')).filter((p) => p.server === server);
  const host = useServerStatus('plugins', 'main') as unknown as PluginHostStatus | undefined;
  const [tab, setTab] = useState<Tab>('installed');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const installed = catalog.filter((d) => d.installed);
  const available = catalog.filter((d) => !d.installed && d.registry);
  const rows = tab === 'installed' ? installed : available;
  const detail = useMemo(() => catalog.find((d) => d.id === selected) ?? null, [catalog, selected]);

  const errorText = (r: CommandReply) => t(`error.${r.error}`, { defaultValue: r.error ?? t('error.unknown') });

  const run = async (cmd: PluginCommand, key: string, done?: string) => {
    setBusy(key);
    setMessage(null);
    const r = await sendPluginCommand(cmd);
    setBusy(null);
    setMessage(r.ok ? (done ? { ok: true, text: done } : null) : { ok: false, text: errorText(r) });
    return r;
  };

  const install = async (d: PluginCatalogDoc, action: 'install' | 'update') => {
    const hosts = d.network.length ? d.network.join(', ') : t('install.noHosts');
    const ok = await confirm({
      message: t('install.confirm', { name: localized(d.name, lng), version: d.latest, hosts }),
      confirmLabel: t(action === 'install' ? 'action.install' : 'action.update'),
    });
    if (ok) await run({ action, pluginId: d.pluginId }, `${action}:${d.id}`, t(action === 'install' ? 'install.done' : 'install.updateDone'));
  };

  const statusLine = (d: PluginCatalogDoc) => {
    if (d.job?.state === 'running')
      return t('state.downloading', { progress: Math.round((d.job.progress ?? 0) * 100) });
    if (d.job?.state === 'failed') return t('state.failed', { error: d.job.error ?? '' });
    if (d.pending) return t(`pending.${d.pending.action}`, { version: d.pending.version ?? '' });
    if (d.running?.status === 'active') return t('state.active');
    if (d.running?.status === 'failed') return t('state.error', { error: d.running.error ?? '' });
    if (d.running?.status === 'incompatible') return t('state.incompatible', { error: d.running.error ?? '' });
    if (d.installed && !d.installed.enabled) return t('state.disabled');
    if (d.installed) return t('state.notRunning');
    return d.latest ? t('state.available', { version: d.latest }) : t('state.noCompatible');
  };

  return (
    <div className="vs-plugins-window" style={overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={modal} role="dialog" aria-label={t('title')}>
        <div style={header}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            {t('title')}
            <HelpButton topic="plugins" anchor="manage" tip={t('help.manage')} />
          </span>
          <div style={{ flex: 1 }} />
          <button
            className="vs-plugins-refresh"
            style={secondaryBtnStyle}
            disabled={busy === 'refresh'}
            onClick={() => void run({ action: 'refresh' }, 'refresh')}
          >
            {t('action.refresh')}
          </button>
          <button className="vs-plugins-close" style={secondaryBtnStyle} onClick={onClose} aria-label={t('close')}>
            ×
          </button>
        </div>

        <div style={{ ...rowSubStyle, marginBottom: 8 }}>{t('trustNote')}</div>

        {host?.restartRequired && (
          <div className="vs-plugins-restart-banner" style={banner}>
            <span style={{ flex: 1 }}>{host.canRestart ? t('restart.needed') : t('restart.neededDev')}</span>
            {host.canRestart && (
              <button
                className="vs-plugins-restart"
                style={primaryBtnStyle}
                disabled={busy === 'restart'}
                onClick={async () => {
                  if (await confirm({ message: t('restart.confirm'), confirmLabel: t('action.restart') }))
                    await run({ action: 'restart' }, 'restart', t('restart.restarting'));
                }}
              >
                {t('action.restart')}
              </button>
            )}
          </div>
        )}
        {message && (
          <div className="vs-plugins-message" style={{ ...rowSubStyle, color: message.ok ? '#4ade80' : '#f87171', marginBottom: 8 }}>
            {message.text}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {(['installed', 'browse'] as Tab[]).map((k) => (
            <button
              key={k}
              className={`vs-plugins-tab vs-plugins-tab-${k}`}
              style={{ ...secondaryBtnStyle, ...(tab === k ? { borderColor: '#60a5fa', color: '#60a5fa' } : {}) }}
              onClick={() => setTab(k)}
            >
              {t(`tab.${k}`, { count: k === 'installed' ? installed.length : available.length })}
            </button>
          ))}
        </div>

        <section style={sectionStyle}>
          {rows.length === 0 ? (
            <div style={emptyStateStyle}>{t(tab === 'installed' ? 'empty.installed' : 'empty.browse')}</div>
          ) : (
            rows.map((d) => (
              <div key={d.id} style={rowStyle} className={`vs-plugin-row vs-plugin-row-${d.id}`}>
                <button className="vs-plugin-details" style={{ ...linkBtn, flex: 1, minWidth: 0, textAlign: 'left' }} onClick={() => setSelected(d.id === selected ? null : d.id)}>
                  <div style={rowTitleStyle}>
                    {localized(d.name, lng)}{' '}
                    <span style={{ color: '#666', fontWeight: 400 }}>
                      {d.installed ? d.installed.version : d.latest ?? ''}
                      {d.installed?.source === 'dev' ? ` · ${t('source.dev')}` : ''}
                      {d.registry && !d.registry.official ? ` · ${t('source.thirdParty')}` : ''}
                    </span>
                  </div>
                  <div style={rowSubStyle}>{statusLine(d)}</div>
                </button>
                {!d.installed && d.registry && (
                  <button
                    className="vs-plugin-install"
                    style={primaryBtnStyle}
                    disabled={!d.latest || !d.registry.trusted || busy !== null || d.job?.state === 'running'}
                    title={!d.registry.trusted ? t('error.untrusted_registry') : undefined}
                    onClick={() => void install(d, 'install')}
                  >
                    {t('action.install')}
                  </button>
                )}
                {updateAvailable(d) && (
                  <button className="vs-plugin-update" style={primaryBtnStyle} disabled={busy !== null} onClick={() => void install(d, 'update')}>
                    {t('action.updateTo', { version: d.latest })}
                  </button>
                )}
                {d.installed?.source === 'installed' && d.pending && (
                  <button
                    className="vs-plugin-cancel"
                    style={secondaryBtnStyle}
                    disabled={busy !== null}
                    onClick={() => void run({ action: 'cancel_pending', pluginId: d.pluginId }, `cancel:${d.id}`)}
                  >
                    {t('action.cancel')}
                  </button>
                )}
                {d.installed?.source === 'installed' && !d.pending && (
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }} title={t('action.enabledTip')}>
                    <input
                      type="checkbox"
                      className="vs-plugin-enabled"
                      checked={d.installed.enabled}
                      disabled={busy !== null}
                      onChange={(e) =>
                        void run({ action: e.target.checked ? 'enable' : 'disable', pluginId: d.pluginId }, `toggle:${d.id}`)
                      }
                    />
                    {t('action.enabled')}
                  </label>
                )}
                {d.installed?.source === 'installed' && d.pending?.action !== 'uninstall' && (
                  <button
                    className="vs-plugin-uninstall"
                    style={dangerBtnStyle}
                    disabled={busy !== null}
                    onClick={async () => {
                      if (await confirm({ message: t('uninstall.confirm', { name: localized(d.name, lng) }), danger: true }))
                        await run({ action: 'uninstall', pluginId: d.pluginId }, `uninstall:${d.id}`);
                    }}
                  >
                    {t('action.uninstall')}
                  </button>
                )}
              </div>
            ))
          )}
        </section>

        {detail && <Details d={detail} loaded={loaded.find((p) => p.pluginId === detail.pluginId)} lng={lng} />}

        <Registries host={host} run={run} busy={busy} />
      </div>
    </div>
  );
}

function Details({ d, loaded, lng }: { d: PluginCatalogDoc; loaded?: PluginDoc; lng: string }) {
  const { t } = useTranslation('plugins');
  const c = loaded?.contributes;
  const latestNotes = d.versions.find((v) => v.version === d.latest)?.notes;
  return (
    <section style={sectionStyle} className="vs-plugin-detail">
      <div style={sectionHeaderStyle}>
        <span>{localized(d.name, lng)}</span>
        {d.homepage && (
          <a href={d.homepage} target="_blank" rel="noreferrer" style={{ color: '#60a5fa', fontSize: 12 }}>
            {t('detail.homepage')}
          </a>
        )}
      </div>
      <div style={rowSubStyle}>{localized(d.description, lng)}</div>
      {d.author && <div style={rowSubStyle}>{t('detail.author', { author: d.author })}</div>}
      <div style={rowSubStyle}>
        {t('detail.network')}{' '}
        {d.network.length ? d.network.map((h) => <code key={h} style={{ ...codeStyle, marginRight: 4 }}>{h}</code>) : t('install.noHosts')}
      </div>
      {d.registry && <div style={rowSubStyle}>{t('detail.registry')} <code style={codeStyle}>{d.registry.url}</code></div>}
      {latestNotes && localized(latestNotes, lng) && (
        <div style={{ ...rowSubStyle, whiteSpace: 'pre-wrap' }}>{t('detail.notes')} {localized(latestNotes, lng)}</div>
      )}
      {c && (
        <div style={rowSubStyle}>
          {t('detail.contributes', {
            nodes: c.nodes.length,
            actions: c.actionKinds.length,
            responses: c.responseTypes.length,
            layers: c.composites.length,
          })}
        </div>
      )}
      {d.versions.length > 0 && (
        <div style={rowSubStyle}>
          {t('detail.versions')}{' '}
          {d.versions.map((v) => `${v.version}${v.compatible ? '' : ` (${t('detail.incompatible')})`}`).join(', ')}
        </div>
      )}
    </section>
  );
}

function Registries({
  host,
  run,
  busy,
}: {
  host: PluginHostStatus | undefined;
  run: (cmd: PluginCommand, key: string, done?: string) => Promise<CommandReply>;
  busy: string | null;
}) {
  const { t } = useTranslation('plugins');
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const list = host?.registries ?? [];
  const save = (next: { url: string; trusted: boolean }[]) => run({ action: 'set_registries', registries: next }, 'registries');

  return (
    <section style={sectionStyle} className="vs-plugins-registries">
      <div style={sectionHeaderStyle}>
        <button className="vs-plugins-registries-toggle" style={linkBtn} onClick={() => setOpen((v) => !v)}>
          {open ? '▾' : '▸'} {t('registries.heading')}
        </button>
        <HelpButton topic="plugins" anchor="registries" tip={t('help.registries')} />
      </div>
      {open && (
        <>
          {list.map((r) => (
            <div key={r.url} style={rowStyle} className="vs-plugins-registry">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitleStyle}>
                  <code style={codeStyle}>{r.url}</code> {r.official && <span style={{ color: '#4ade80' }}>{t('registries.official')}</span>}
                </div>
                <div style={rowSubStyle}>
                  {r.ok ? t('registries.ok', { count: r.count }) : r.error ? t('registries.failed', { error: r.error }) : t('registries.loading')}
                  {r.problems.length > 0 && ` · ${t('registries.problems', { count: r.problems.length })}`}
                </div>
              </div>
              {!r.official && (
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="checkbox"
                    className="vs-plugins-registry-trusted"
                    checked={r.trusted}
                    disabled={busy !== null}
                    onChange={async (e) => {
                      const trusted = e.target.checked;
                      if (trusted && !(await confirm({ message: t('registries.trustConfirm', { url: r.url }), danger: true }))) return;
                      await save(list.map((x) => ({ url: x.url, trusted: x.url === r.url ? trusted : x.trusted })));
                    }}
                  />
                  {t('registries.trusted')}
                </label>
              )}
              <button
                className="vs-plugins-registry-remove"
                style={dangerBtnStyle}
                disabled={busy !== null}
                onClick={() => void save(list.filter((x) => x.url !== r.url).map((x) => ({ url: x.url, trusted: x.trusted })))}
              >
                ×
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input
              className="vs-plugins-registry-url"
              style={{ ...inputStyle, flex: 1 }}
              value={url}
              placeholder="https://raw.githubusercontent.com/…/registry.json"
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              className="vs-plugins-registry-add"
              style={secondaryBtnStyle}
              disabled={!/^https:\/\/\S+$/.test(url) || busy !== null}
              onClick={async () => {
                const r = await save([...list.map((x) => ({ url: x.url, trusted: x.trusted })), { url, trusted: false }]);
                if (r.ok) setUrl('');
              }}
            >
              {t('registries.add')}
            </button>
            <button className="vs-plugins-registry-reset" style={secondaryBtnStyle} disabled={busy !== null} onClick={() => void save([])}>
              {t('registries.reset')}
            </button>
          </div>
          <div style={rowSubStyle}>{t('registries.untrustedNote')}</div>
        </>
      )}
    </section>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};
const modal: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #333',
  borderRadius: 8,
  padding: 16,
  width: 'min(720px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 64px)',
  overflow: 'auto',
  color: '#ddd',
  fontSize: 13,
};
const header: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 };
const banner: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: 8,
  marginBottom: 8,
  borderRadius: 6,
  background: '#2a2410',
  border: '1px solid #6b5a1a',
};
const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'inherit',
  padding: 0,
  cursor: 'pointer',
  font: 'inherit',
};
