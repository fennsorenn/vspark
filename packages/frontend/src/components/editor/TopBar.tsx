import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import { MediaInputWindow } from '../MediaInputWindow';
import { UpdateDialog } from './UpdateDialog';
import { OverliveAccountsModal } from './OverliveAccountsModal';

export function TopBar() {
  const navigate = useNavigate();
  const {
    projectId,
    projectName,
    scenes,
    activeSceneId,
    setScenes,
    setActiveScene,
    setNodes,
    updateAvailable,
    setUpdateAvailable,
  } = useEditorStore();
  const [connected, setConnected] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaMounted, setMediaMounted] = useState(false);
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

  const handleSceneChange = async (sceneId: string) => {
    setActiveScene(sceneId);
    try {
      const nodes = await api.getNodes(sceneId);
      setNodes(nodes);
    } catch {
      // ignore
    }
  };

  const handleNewScene = async () => {
    if (!projectId) return;
    const name = window.prompt('Scene name:');
    if (!name?.trim()) return;
    try {
      const scene = await api.createScene(projectId, name.trim());
      const updated = [
        ...scenes,
        {
          id: scene.id,
          name: scene.name,
          runtimeSettings: scene.runtimeSettings,
        },
      ];
      setScenes(updated);
      setActiveScene(scene.id);
      setNodes([]);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to create scene');
    }
  };

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

  const selectStyle: React.CSSProperties = {
    background: '#2a2a2a',
    border: '1px solid #3a3a3a',
    color: '#e0e0e0',
    borderRadius: 5,
    padding: '3px 8px',
    fontSize: 13,
    cursor: 'pointer',
    outline: 'none',
  };

  const iconBtnStyle: React.CSSProperties = {
    background: '#2a2a2a',
    border: '1px solid #3a3a3a',
    color: '#e0e0e0',
    borderRadius: 5,
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1,
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
          {projectName || 'Loading…'}
        </span>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Center - scenes */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#888' }}>Scene:</span>
          <select
            style={selectStyle}
            value={activeSceneId ?? ''}
            onChange={(e) => handleSceneChange(e.target.value)}
          >
            {scenes.length === 0 && <option value="">No scenes</option>}
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            style={iconBtnStyle}
            onClick={handleNewScene}
            title="New scene"
          >
            +
          </button>
        </div>

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
            title="Media Inputs (mic / camera)"
          >
            🎤 Media
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
            title="Open Media Input in new tab"
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
            {connected ? 'Connected' : 'Disconnected'}
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
            title="Stream accounts (Twitch / StreamElements)"
          >
            🟣 Accounts
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
              title="An update is available"
            >
              ↑ Update
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
            title="Updates & release channel"
          >
            ⚙ ver
          </button>
        </div>
      </div>
      {mediaMounted && <MediaInputWindow visible={mediaOpen} />}
      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
      {accountsOpen && (
        <OverliveAccountsModal onClose={() => setAccountsOpen(false)} />
      )}
    </>
  );
}
