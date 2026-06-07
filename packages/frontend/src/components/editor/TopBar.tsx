import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import { useTranslation } from 'react-i18next';
import { MediaInputWindow } from '../MediaInputWindow';
import { ConnectionsWindow } from '../ConnectionsWindow';
import { UpdateDialog } from './UpdateDialog';
import { OverliveAccountsModal } from './OverliveAccountsModal';
import { LanguageSwitcher } from '../LanguageSwitcher';
import { HelpButton } from '../../help/HelpButton';

export function TopBar() {
  const navigate = useNavigate();
  const { t } = useTranslation('topbar');
  const { projectId, projectName, updateAvailable, setUpdateAvailable } =
    useEditorStore();
  const [connected, setConnected] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaMounted, setMediaMounted] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connectionsMounted, setConnectionsMounted] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
    );
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    return () => ws.close();
  }, []);

  useEffect(() => {
    void api
      .getUpdateStatus()
      .then((s) => {
        if (s.updateAvailable && s.latestVersion) {
          setUpdateAvailable(true, {
            latestVersion: s.latestVersion,
            releaseNotes: s.releaseNotes,
            channel: s.channel,
          });
        }
      })
      .catch(() => {});
  }, []);

  const barStyle: React.CSSProperties = {
    height: 48,
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    gap: 16,
    flexShrink: 0,
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
    color: '#ccc',
  };

  return (
    <>
      <div style={barStyle}>
        {/* Left */}
        <button
          style={{
            background: 'none',
            border: 'none',
            color: '#ccc',
            cursor: 'pointer',
            fontSize: 13,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
          onClick={() => navigate('/')}
        >
          ← vspark
        </button>
        <span style={{ color: '#444' }}>|</span>
        <span style={{ color: '#e0e0e0', fontWeight: 500 }}>
          {projectName || t('loading')}
        </span>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Right - Media input + WS status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            style={{
              background: mediaOpen ? '#1a3a2a' : '#2a2a2a',
              border: `1px solid ${mediaOpen ? '#4ade80' : '#3a3a3a'}`,
              color: mediaOpen ? '#4ade80' : '#ccc',
              borderRadius: 5,
              padding: '3px 10px',
              cursor: 'pointer',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
            onClick={() => {
              setMediaOpen((v) => !v);
              setMediaMounted(true);
            }}
            title={t('media.title')}
          >
            🎤 {t('media.label')}
          </button>
          <button
            style={{
              background: connectionsOpen ? '#1a2a3a' : '#2a2a2a',
              border: `1px solid ${connectionsOpen ? '#60a5fa' : '#3a3a3a'}`,
              color: connectionsOpen ? '#60a5fa' : '#ccc',
              borderRadius: 5,
              padding: '3px 10px',
              cursor: 'pointer',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
            onClick={() => {
              setConnectionsOpen((v) => !v);
              setConnectionsMounted(true);
            }}
            title={t('connections.title')}
          >
            🔗 {t('connections.label')}
          </button>
          <button
            style={{
              background: 'none',
              border: 'none',
              color: '#555',
              cursor: 'pointer',
              fontSize: 11,
              padding: 0,
            }}
            onClick={() =>
              projectId && window.open(`/media-input/${projectId}`, '_blank')
            }
            title={t('media.openNewTab')}
          >
            ↗
          </button>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: connected ? '#4ade80' : '#f87171',
            }}
          >
            <span style={{ fontSize: 10 }}>{connected ? '●' : '○'}</span>
            {connected ? t('status.connected') : t('status.disconnected')}
          </div>
          <button
            style={{
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              color: '#ccc',
              borderRadius: 5,
              padding: '3px 10px',
              cursor: 'pointer',
              fontSize: 12,
            }}
            onClick={() => setAccountsOpen(true)}
            title={t('accounts.title')}
          >
            🟣 {t('accounts.label')}
          </button>
          {updateAvailable && (
            <button
              onClick={() => setUpdateOpen(true)}
              style={{
                background: '#2a1a00',
                border: '1px solid #f59e0b',
                color: '#f59e0b',
                borderRadius: 5,
                padding: '3px 10px',
                cursor: 'pointer',
                fontSize: 12,
              }}
              title={t('update.availableTitle')}
            >
              ↑ {t('update.label')}
            </button>
          )}
          <button
            onClick={() => setUpdateOpen(true)}
            style={{
              background: 'none',
              border: 'none',
              color: '#555',
              cursor: 'pointer',
              fontSize: 11,
              padding: '0 2px',
            }}
            title={t('update.settingsTitle')}
          >
            ⚙ {t('update.versionLabel')}
          </button>
          <LanguageSwitcher compact />
          <HelpButton topic="overview" tip={t('help.tip')} size={18} />
        </div>
      </div>
      {mediaMounted && <MediaInputWindow visible={mediaOpen} />}
      {connectionsMounted && <ConnectionsWindow visible={connectionsOpen} />}
      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
      {accountsOpen && (
        <OverliveAccountsModal onClose={() => setAccountsOpen(false)} />
      )}
    </>
  );
}
