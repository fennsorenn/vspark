/**
 * Connections window (Phase 5 multiplayer) — pair with other servers, see
 * contacts + their online/connected state, and connect/disconnect. A draggable
 * floating window (sibling of the media window). Live updates arrive via the
 * mp_* WS messages → connectionsStore; this component drives the REST actions.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConnectionsStore } from '../store/connectionsStore';
import { HelpButton } from '../help/HelpButton';
import {
  getConnectionIdentity,
  getConnectionStatus,
  getConnectionPeers,
  pairCreate,
  pairJoin,
  peerConnect,
  peerDisconnect,
  peerAccept,
  peerReject,
  peerRemove,
} from '../api/client';

const C = {
  bg: '#181818',
  panel: '#222',
  border: '#333',
  text: '#ccc',
  dim: '#888',
  green: '#4ade80',
  red: '#ef4444',
  blue: '#60a5fa',
};

const S = {
  section: {
    fontSize: 10,
    fontWeight: 700,
    color: C.dim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    margin: '10px 0 4px',
  } as React.CSSProperties,
  btn: (
    kind: 'default' | 'primary' | 'danger' = 'default'
  ): React.CSSProperties => ({
    padding: '3px 9px',
    borderRadius: 4,
    border: `1px solid ${kind === 'primary' ? '#2563eb' : kind === 'danger' ? '#7f1d1d' : '#3a3a3a'}`,
    background:
      kind === 'primary'
        ? '#1e3a8a'
        : kind === 'danger'
          ? '#3a1414'
          : '#2a2a2a',
    color: kind === 'danger' ? '#fca5a5' : C.text,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
  }),
  input: {
    background: '#111',
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    color: C.text,
    padding: '4px 6px',
    fontSize: 12,
    width: '100%',
  } as React.CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 6 } as React.CSSProperties,
};

export function ConnectionsWindow({ visible }: { visible: boolean }) {
  const { t } = useTranslation('connections');
  const [pos, setPos] = useState({ x: 80, y: 90 });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const {
    enabled,
    status,
    identityPeerId,
    peers,
    incoming,
    revision,
    setMeta,
    setPeers,
    removeIncoming,
  } = useConnectionsStore();

  const [code, setCode] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Initial load: identity + status.
  useEffect(() => {
    void (async () => {
      try {
        const [st, id] = await Promise.all([
          getConnectionStatus(),
          getConnectionIdentity().catch(() => null),
        ]);
        setMeta({
          enabled: st.enabled,
          status: st.status,
          identityPeerId: id?.peerId ?? st.peerId,
        });
      } catch {
        /* not enabled / offline */
      }
    })();
  }, [setMeta]);

  // Refetch the peer list on mount and whenever a WS event bumps the revision.
  useEffect(() => {
    if (!enabled) return;
    void getConnectionPeers()
      .then(setPeers)
      .catch(() => {});
  }, [enabled, revision, setPeers]);

  const onDragDown = (e: React.MouseEvent) => {
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev: MouseEvent) => {
      if (dragRef.current)
        setPos({
          x: ev.clientX - dragRef.current.dx,
          y: ev.clientY - dragRef.current.dy,
        });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  const statusColor =
    status === 'ready' ? C.green : status === 'connecting' ? '#fbbf24' : C.dim;

  return (
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: 330,
        maxHeight: '80vh',
        overflowY: 'auto',
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,.6)',
        color: C.text,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 12,
        zIndex: 9000,
      }}
    >
      <div
        onMouseDown={onDragDown}
        style={{
          ...S.row,
          padding: '6px 10px',
          background: C.panel,
          borderRadius: '8px 8px 0 0',
          cursor: 'grab',
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <span style={{ fontWeight: 600, flex: 1 }}>🔗 {t('window.title')}</span>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: statusColor,
          }}
          title={t(`status.${status}`)}
        />
        <HelpButton topic="multiplayer" tip={t('help.tip')} size={12} />
      </div>

      <div style={{ padding: 10 }}>
        {!enabled && (
          <div style={{ color: C.dim, padding: '8px 0' }}>{t('disabled')}</div>
        )}

        {enabled && (
          <>
            {/* Identity */}
            <div style={S.section}>{t('identity.label')}</div>
            <div style={S.row}>
              <code
                style={{
                  flex: 1,
                  color: C.blue,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {identityPeerId ? identityPeerId.slice(0, 16) + '…' : '—'}
              </code>
              <button
                style={S.btn()}
                onClick={() =>
                  identityPeerId &&
                  navigator.clipboard?.writeText(identityPeerId)
                }
                title={t('identity.copy')}
              >
                {t('identity.copy')}
              </button>
            </div>

            {/* Pairing */}
            <div style={S.section}>{t('pairing.label')}</div>
            <div style={{ ...S.row, marginBottom: 6 }}>
              <button
                style={S.btn('primary')}
                disabled={busy}
                onClick={() =>
                  run(async () => setCode((await pairCreate()).code))
                }
              >
                {t('pairing.create')}
              </button>
              {code && (
                <code
                  style={{
                    flex: 1,
                    letterSpacing: 2,
                    color: C.green,
                    fontSize: 14,
                    textAlign: 'center',
                  }}
                >
                  {code}
                </code>
              )}
            </div>
            <div style={S.row}>
              <input
                style={S.input}
                placeholder={t('pairing.codePlaceholder')}
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              />
              <button
                style={S.btn()}
                disabled={busy || !joinCode.trim()}
                onClick={() =>
                  run(async () => {
                    await pairJoin(joinCode.trim());
                    setJoinCode('');
                  })
                }
              >
                {t('pairing.join')}
              </button>
            </div>

            {/* Incoming requests */}
            {incoming.length > 0 && (
              <>
                <div style={S.section}>{t('requests.label')}</div>
                {incoming.map((r) => (
                  <div key={r.peerId} style={{ ...S.row, marginBottom: 4 }}>
                    <span style={{ flex: 1 }}>
                      {r.displayName || r.peerId.slice(0, 10)}
                    </span>
                    <button
                      style={S.btn('primary')}
                      onClick={() =>
                        run(async () => {
                          await peerAccept(r.peerId);
                          removeIncoming(r.peerId);
                        })
                      }
                    >
                      {t('requests.accept')}
                    </button>
                    <button
                      style={S.btn('danger')}
                      onClick={() =>
                        run(async () => {
                          await peerReject(r.peerId);
                          removeIncoming(r.peerId);
                        })
                      }
                    >
                      {t('requests.reject')}
                    </button>
                  </div>
                ))}
              </>
            )}

            {/* Contacts */}
            <div style={S.section}>{t('contacts.label')}</div>
            {peers.length === 0 && (
              <div style={{ color: C.dim, padding: '4px 0' }}>
                {t('contacts.empty')}
              </div>
            )}
            {peers.map((p) => (
              <div key={p.peerId} style={{ ...S.row, marginBottom: 4 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: p.connected ? C.green : C.dim,
                  }}
                  title={
                    p.connected
                      ? t('contacts.connected')
                      : t('contacts.disconnected')
                  }
                />
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {p.displayName || p.peerId.slice(0, 12)}
                </span>
                {p.connected ? (
                  <button
                    style={S.btn()}
                    disabled={busy}
                    onClick={() => run(() => peerDisconnect(p.peerId))}
                  >
                    {t('contacts.disconnect')}
                  </button>
                ) : (
                  <button
                    style={S.btn('primary')}
                    disabled={busy}
                    onClick={() => run(() => peerConnect(p.peerId))}
                  >
                    {t('contacts.connect')}
                  </button>
                )}
                <button
                  style={S.btn('danger')}
                  disabled={busy}
                  onClick={() => run(() => peerRemove(p.peerId))}
                  title={t('contacts.remove')}
                >
                  ✕
                </button>
              </div>
            ))}

            {err && (
              <div style={{ color: C.red, marginTop: 8, fontSize: 11 }}>
                {err}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
