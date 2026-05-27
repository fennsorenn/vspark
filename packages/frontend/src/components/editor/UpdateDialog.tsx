import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import type { UpdateChannel } from '@vspark/shared';

const CHANNELS: UpdateChannel[] = ['stable', 'recent', 'experimental'];
const CHANNEL_LABELS: Record<UpdateChannel, string> = {
  stable: 'Stable',
  recent: 'Recent (beta)',
  experimental: 'Experimental (alpha)',
};

interface Props {
  onClose: () => void;
}

export function UpdateDialog({ onClose }: Props) {
  const { updateAvailable, updateInfo } = useEditorStore((s) => ({
    updateAvailable: s.updateAvailable,
    updateInfo: s.updateInfo,
  }));

  const [currentVersion, setCurrentVersion] = useState<string>('—');
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Load current version + channel on open
    void api.getUpdateStatus().then((s) => {
      setCurrentVersion(s.currentVersion);
      setChannel(s.channel);
    });
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleChannelChange = async (newChannel: UpdateChannel) => {
    setChannel(newChannel);
    try {
      await api.putConfig({ channel: newChannel });
      const status = await api.getUpdateStatus();
      useEditorStore
        .getState()
        .setUpdateAvailable(
          status.updateAvailable,
          status.updateAvailable && status.latestVersion
            ? {
                latestVersion: status.latestVersion,
                releaseNotes: status.releaseNotes,
                channel: status.channel,
              }
            : null
        );
    } catch (e) {
      setError('Failed to update channel');
    }
  };

  const handleUpdate = async () => {
    setDownloading(true);
    setError(null);
    try {
      await api.startUpdateDownload();
      // Poll until download is ready
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.getUpdateStatus();
          if (status.downloadReady) {
            clearInterval(pollRef.current!);
            await api.applyUpdate();
            // Server will exit — browser reloads on reconnect via useWsSync
          }
        } catch {
          clearInterval(pollRef.current!);
          setError('Download failed');
          setDownloading(false);
        }
      }, 2000);
    } catch {
      setError('Failed to start download');
      setDownloading(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 60,
        right: 16,
        width: 340,
        background: '#181818',
        border: '1px solid #333',
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,.6)',
        zIndex: 9000,
        fontFamily: 'system-ui, sans-serif',
        color: '#e0e0e0',
        fontSize: 13,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid #2a2a2a',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          {updateAvailable ? '↑ Update Available' : 'Updates'}
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#888',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            padding: '0 2px',
          }}
        >
          ×
        </button>
      </div>

      <div
        style={{
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {/* Version info */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            fontSize: 12,
            color: '#aaa',
          }}
        >
          <span>
            Current:{' '}
            <strong style={{ color: '#e0e0e0' }}>{currentVersion}</strong>
          </span>
          {updateAvailable && updateInfo && (
            <>
              <span style={{ color: '#555' }}>→</span>
              <span>
                Latest:{' '}
                <strong style={{ color: '#f59e0b' }}>
                  {updateInfo.latestVersion}
                </strong>
              </span>
            </>
          )}
          {!updateAvailable && (
            <span style={{ color: '#4ade80', marginLeft: 4 }}>
              ✓ Up to date
            </span>
          )}
        </div>

        {/* Release notes */}
        {updateAvailable && updateInfo?.releaseNotes && (
          <pre
            style={{
              margin: 0,
              padding: '8px 10px',
              background: '#111',
              border: '1px solid #2a2a2a',
              borderRadius: 4,
              fontSize: 11,
              color: '#bbb',
              whiteSpace: 'pre-wrap',
              overflowY: 'auto',
              maxHeight: 140,
            }}
          >
            {updateInfo.releaseNotes}
          </pre>
        )}

        {/* Channel selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label
            style={{
              fontSize: 11,
              color: '#888',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Release channel
          </label>
          <select
            value={channel}
            onChange={(e) =>
              void handleChannelChange(e.target.value as UpdateChannel)
            }
            style={{
              background: '#222',
              border: '1px solid #333',
              borderRadius: 4,
              color: '#e0e0e0',
              padding: '4px 8px',
              fontSize: 13,
            }}
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </div>

        {error && <div style={{ color: '#f87171', fontSize: 12 }}>{error}</div>}

        {/* Actions */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            marginTop: 2,
          }}
        >
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: '1px solid #333',
              borderRadius: 5,
              color: '#888',
              padding: '5px 14px',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Later
          </button>
          {updateAvailable && (
            <button
              onClick={() => void handleUpdate()}
              disabled={downloading}
              style={{
                background: downloading ? '#333' : '#1a3a1a',
                border: `1px solid ${downloading ? '#444' : '#4ade80'}`,
                borderRadius: 5,
                color: downloading ? '#666' : '#4ade80',
                padding: '5px 14px',
                cursor: downloading ? 'not-allowed' : 'pointer',
                fontSize: 13,
              }}
            >
              {downloading ? 'Downloading…' : 'Update Now'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
