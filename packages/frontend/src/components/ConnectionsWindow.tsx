/**
 * Connections window (Phase 5 multiplayer). Layout (top → bottom):
 *   - your display name (per project) + server ID
 *   - incoming connection prompts
 *   - currently-connected members, each with a collapsible "shared by them"
 *     section and a Disconnect (without unpairing) button
 *   - collapsed Pairing section (create/copy code, join)
 *   - collapsed Contacts section (connect; unpair with confirm)
 *
 * Live updates arrive via the mp_* WS messages → connectionsStore; this
 * component drives the REST actions. See dev-notes/plans/multiplayer-phase5.md.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConnectionsStore } from '../store/connectionsStore';
import { useEditorStore } from '../store/editorStore';
import { HelpButton } from '../help/HelpButton';
import {
  getConnectionIdentity,
  getConnectionStatus,
  getConnectionPeers,
  getConnectionDisplayName,
  setConnectionDisplayName,
  pairCreate,
  pairJoin,
  peerConnect,
  peerDisconnect,
  peerAccept,
  peerReject,
  peerRemove,
  peerUnsubscribe,
  createNode,
  deleteNode,
  type ConnectionPeer,
} from '../api/client';
import {
  removeProjection as removeSharedProjection,
  findContainer,
  REMOTE_OBJECT_KIND,
} from '../sync/sharedProjection';
import { unsubscribeDirect } from '../sync/shareDirect';
import type { SharedOffer } from '../store/connectionsStore';

const C = {
  bg: '#181818',
  panel: '#222',
  card: '#1e1e1e',
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
  collapseHeader: {
    fontSize: 10,
    fontWeight: 700,
    color: C.dim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    margin: '12px 0 4px',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    cursor: 'pointer',
    userSelect: 'none',
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
  dot: (on: boolean): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: on ? C.green : C.dim,
    flexShrink: 0,
  }),
};

function Collapsible({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div style={S.collapseHeader} onClick={() => setOpen((o) => !o)}>
        <span style={{ width: 8 }}>{open ? '▾' : '▸'}</span>
        {title}
      </div>
      {open && children}
    </div>
  );
}

/** A connected member with a collapsible "shared by them" sub-section listing
 *  the objects they offer; each can be placed into / removed from the scene. */
function ConnectedMember({
  peer,
  onDisconnect,
  busy,
}: {
  peer: ConnectionPeer;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation('connections');
  const [open, setOpen] = useState(false);
  const offers = useConnectionsStore((s) => s.offers[peer.peerId]) ?? EMPTY;
  const subscribed =
    useConnectionsStore((s) => s.subscribed[peer.peerId]) ?? EMPTY_IDS;
  const setSubscribed = useConnectionsStore((s) => s.setSubscribed);
  const activeSceneId = useEditorStore((s) => s.activeSceneId);
  const addNodeLocal = useEditorStore((s) => s.addNode);
  const [actBusy, setActBusy] = useState(false);

  const place = (offer: SharedOffer) =>
    void (async () => {
      if (!activeSceneId || findContainer(peer.peerId, offer.objectId)) return;
      setActBusy(true);
      try {
        // Place an opaque, editable container the receiver owns; the shared
        // subtree projects under it. The actual subscribe (snapshot fetch) is
        // driven by useSharedSubscriptions once the container exists.
        const node = await createNode(activeSceneId, {
          name: offer.name || t('shared.placedName'),
          kind: REMOTE_OBJECT_KIND,
          parentId: null,
          components: {
            remoteRef: {
              ownerPeerId: peer.peerId,
              remoteObjectId: offer.objectId,
              name: offer.name,
            },
          },
        });
        addNodeLocal(node);
      } catch {
        /* ignore */
      } finally {
        setActBusy(false);
      }
    })();
  const remove = (objectId: string) =>
    void (async () => {
      setActBusy(true);
      try {
        // Unsubscribe over both paths — the owner ignores an unsubscribe for a
        // subscription it doesn't hold, so this is safe regardless of which path
        // (direct edge or server relay) the subscription actually used.
        unsubscribeDirect(peer.peerId, objectId);
        await peerUnsubscribe(peer.peerId, objectId);
        removeSharedProjection(peer.peerId, objectId);
        const container = findContainer(peer.peerId, objectId);
        if (container) await deleteNode(container.id).catch(() => {});
        setSubscribed(peer.peerId, objectId, false);
      } catch {
        /* ignore */
      } finally {
        setActBusy(false);
      }
    })();

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: '6px 8px',
        marginBottom: 6,
      }}
    >
      <div style={S.row}>
        <span style={S.dot(true)} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {peer.displayName || peer.peerId.slice(0, 12)}
        </span>
        <button style={S.btn()} disabled={busy} onClick={onDisconnect}>
          {t('contacts.disconnect')}
        </button>
      </div>
      <div
        style={{
          ...S.row,
          marginTop: 4,
          cursor: 'pointer',
          color: C.dim,
          fontSize: 11,
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ width: 8 }}>{open ? '▾' : '▸'}</span>
        {t('shared.label')} {offers.length > 0 && `(${offers.length})`}
      </div>
      {open && (
        <div style={{ paddingLeft: 14, paddingTop: 2 }}>
          {offers.length === 0 && (
            <div style={{ color: C.dim, fontSize: 11, padding: '2px 0' }}>
              {t('shared.empty')}
            </div>
          )}
          {offers.map((o) => {
            const placed = subscribed.includes(o.objectId);
            return (
              <div
                key={o.objectId}
                style={{ ...S.row, marginBottom: 4, fontSize: 11 }}
              >
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {o.name || o.objectId.slice(0, 10)}
                </span>
                {placed ? (
                  <button
                    style={S.btn()}
                    disabled={actBusy}
                    onClick={() => remove(o.objectId)}
                  >
                    {t('shared.remove')}
                  </button>
                ) : (
                  <button
                    style={S.btn('primary')}
                    disabled={actBusy}
                    onClick={() => place(o)}
                  >
                    {t('shared.place')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const EMPTY: import('../store/connectionsStore').SharedOffer[] = [];
const EMPTY_IDS: string[] = [];

export function ConnectionsWindow({ visible }: { visible: boolean }) {
  const { t } = useTranslation('connections');
  const projectId = useEditorStore((s) => s.projectId);
  const [pos, setPos] = useState({ x: 80, y: 90 });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const {
    enabled,
    status,
    identityPeerId,
    peers,
    incoming,
    revision,
    meshConnected,
    setMeta,
    setPeers,
    removeIncoming,
  } = useConnectionsStore();

  const [name, setName] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Initial load: identity + status + my per-project display name.
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

  useEffect(() => {
    if (!projectId) return;
    void getConnectionDisplayName(projectId)
      .then((d) => setName(d.displayName))
      .catch(() => {});
  }, [projectId]);

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

  const saveName = () => {
    if (!projectId) return;
    void setConnectionDisplayName(projectId, name).catch(() => {});
  };

  if (!visible) return null;

  const statusColor =
    status === 'ready' ? C.green : status === 'connecting' ? '#fbbf24' : C.dim;
  const connected = peers.filter((p) => p.connected);
  const contacts = peers.filter((p) => !p.connected);

  return (
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: 340,
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
          style={{ ...S.dot(false), background: statusColor }}
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
            {/* Display name */}
            <div style={S.section}>{t('name.label')}</div>
            <input
              style={S.input}
              value={name}
              placeholder={t('name.placeholder')}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === 'Enter' && saveName()}
            />

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
                title={identityPeerId ?? ''}
              >
                {identityPeerId ? identityPeerId.slice(0, 18) + '…' : '—'}
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

            {/* Direct mesh status (live P2P data channels) */}
            <div style={{ ...S.row, marginTop: 6, color: C.dim }}>
              <span style={S.dot(meshConnected.length > 0)} />
              <span>{t('mesh.label', { count: meshConnected.length })}</span>
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

            {/* Connected members */}
            <div style={S.section}>
              {t('connected.label')}{' '}
              {connected.length > 0 && `(${connected.length})`}
            </div>
            {connected.length === 0 && (
              <div style={{ color: C.dim, padding: '2px 0' }}>
                {t('connected.empty')}
              </div>
            )}
            {connected.map((p) => (
              <ConnectedMember
                key={p.peerId}
                peer={p}
                busy={busy}
                onDisconnect={() => run(() => peerDisconnect(p.peerId))}
              />
            ))}

            {/* Pairing (collapsed) */}
            <Collapsible title={t('pairing.label')}>
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
                  <>
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
                    <button
                      style={S.btn()}
                      onClick={() => navigator.clipboard?.writeText(code)}
                      title={t('pairing.copyCode')}
                    >
                      {t('pairing.copyCode')}
                    </button>
                  </>
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
            </Collapsible>

            {/* Contacts (collapsed) */}
            <Collapsible title={`${t('contacts.label')} (${contacts.length})`}>
              {contacts.length === 0 && (
                <div style={{ color: C.dim, padding: '2px 0' }}>
                  {t('contacts.empty')}
                </div>
              )}
              {contacts.map((p) => (
                <div key={p.peerId} style={{ ...S.row, marginBottom: 4 }}>
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {p.displayName || p.peerId.slice(0, 12)}
                  </span>
                  <button
                    style={S.btn('primary')}
                    disabled={busy}
                    onClick={() => run(() => peerConnect(p.peerId))}
                  >
                    {t('contacts.connect')}
                  </button>
                  {confirmRemove === p.peerId ? (
                    <button
                      style={S.btn('danger')}
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await peerRemove(p.peerId);
                          setConfirmRemove(null);
                        })
                      }
                    >
                      {t('contacts.confirmRemove')}
                    </button>
                  ) : (
                    <button
                      style={S.btn('danger')}
                      disabled={busy}
                      onClick={() => setConfirmRemove(p.peerId)}
                      title={t('contacts.remove')}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </Collapsible>

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
