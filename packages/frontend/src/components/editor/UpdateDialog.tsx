import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import type { UpdateChannel } from '@vspark/shared';
import { HelpButton } from '../../help/HelpButton';
import { useEscapeKey } from '../../hooks/useEscapeKey';

const CHANNELS: UpdateChannel[] = ['stable', 'recent', 'experimental'];

interface Props {
  onClose: () => void;
  /** Control that opened the dialog; the popover anchors under it. */
  anchorRef?: React.RefObject<HTMLElement>;
}

const DIALOG_WIDTH = 340;

export function UpdateDialog({ onClose, anchorRef }: Props) {
  const { t } = useTranslation('update');
  const { updateAvailable, updateInfo } = useEditorStore((s) => ({
    updateAvailable: s.updateAvailable,
    updateInfo: s.updateInfo,
  }));

  const [currentVersion, setCurrentVersion] = useState<string>('—');
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{
    downloaded: number;
    total: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Anchor the popover under the control that opened it (the anchor is already
  // mounted by the time this dialog renders on click), clamped to the viewport.
  // Falls back to the top-right corner when no anchor is supplied.
  const [pos] = useState(() => {
    const r = anchorRef?.current?.getBoundingClientRect();
    if (!r) return { top: 60, right: 16 };
    const right = window.innerWidth - r.right;
    const clamped = Math.min(
      Math.max(8, right),
      window.innerWidth - DIALOG_WIDTH - 8
    );
    return { top: r.bottom + 6, right: Math.max(8, clamped) };
  });

  // Close on Esc, but not mid-download so a stray keypress can't abandon it.
  useEscapeKey(onClose, !downloading);

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
      useEditorStore.getState().setUpdateAvailable(
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
      setError(t('error.channel'));
    }
  };

  const handleUpdate = async () => {
    setDownloading(true);
    setProgress({ downloaded: 0, total: null });
    setError(null);
    try {
      await api.startUpdateDownload();
      // Poll for progress until the download is ready, then apply.
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.getUpdateStatus();
          if (status.downloadedBytes !== null) {
            setProgress({
              downloaded: status.downloadedBytes,
              total: status.totalBytes,
            });
          }
          if (status.downloadReady) {
            clearInterval(pollRef.current!);
            await api.applyUpdate();
            // Server will exit — browser reloads on reconnect via useWsSync
          }
        } catch {
          clearInterval(pollRef.current!);
          setError(t('error.downloadFailed'));
          setDownloading(false);
        }
      }, 500);
    } catch {
      setError(t('error.startFailed'));
      setDownloading(false);
    }
  };

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;
  const fmtMB = (b: number) => `${(b / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div
      style={{
        position: 'fixed',
        top: pos.top,
        right: pos.right,
        width: DIALOG_WIDTH,
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
        <span
          style={{
            fontWeight: 600,
            fontSize: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {updateAvailable ? t('header.available') : t('header.updates')}
          <HelpButton
            topic="overview"
            anchor="updates"
            tip={t('help.updates')}
          />
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
            {t('version.current')}{' '}
            <strong style={{ color: '#e0e0e0' }}>{currentVersion}</strong>
          </span>
          {updateAvailable && updateInfo && (
            <>
              <span style={{ color: '#555' }}>→</span>
              <span>
                {t('version.latest')}{' '}
                <strong style={{ color: '#f59e0b' }}>
                  {updateInfo.latestVersion}
                </strong>
              </span>
            </>
          )}
          {!updateAvailable && (
            <span style={{ color: '#4ade80', marginLeft: 4 }}>
              {t('version.upToDate')}
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
            {t('channel.label')}
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
                {t(`channel.${c}`)}
              </option>
            ))}
          </select>
        </div>

        {error && <div style={{ color: '#f87171', fontSize: 12 }}>{error}</div>}

        {/* Download progress */}
        {downloading && progress && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div
              style={{
                height: 6,
                background: '#222',
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: pct !== null ? `${pct}%` : '100%',
                  background: '#4ade80',
                  borderRadius: 3,
                  transition: 'width 0.3s linear',
                  // Indeterminate look when total size is unknown.
                  opacity: pct !== null ? 1 : 0.4,
                }}
              />
            </div>
            <div style={{ fontSize: 11, color: '#888' }}>
              {pct !== null
                ? t('progress.withTotal', {
                    pct,
                    downloaded: fmtMB(progress.downloaded),
                    total: fmtMB(progress.total!),
                  })
                : t('progress.downloaded', {
                    downloaded: fmtMB(progress.downloaded),
                  })}
            </div>
          </div>
        )}

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
            {t('actions.later')}
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
              {downloading
                ? pct !== null
                  ? t('actions.downloadingPct', { pct })
                  : t('actions.downloading')
                : t('actions.updateNow')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
