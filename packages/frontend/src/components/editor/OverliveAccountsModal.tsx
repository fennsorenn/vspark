/**
 * OverliveAccountsModal — per-project Twitch + StreamElements account management.
 *
 * Sections:
 *   1. Twitch Apps — register dev.twitch.tv apps (with walkthrough). One project may
 *      hold multiple. App rows hold {clientId, clientSecret, redirectUri}.
 *   2. Login Accounts — list of connected Twitch + SE accounts with status pills.
 *      Twitch accounts are created via OAuth popup; SE accounts via JWT form.
 *      Each row has a "Reconnect" button when the account is in error/needs_reauth.
 *
 * Storage caveat: credentials are stored plaintext today. See ARCHITECTURE.md →
 * Future Features → Multi-user usage.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useEditorStore } from '../../store/editorStore';
import type {
  OverliveAppCredentialRecord,
  OverliveAccountRecord,
  OverliveAccountStatus,
  Project,
} from '../../api/client';

interface Props {
  onClose: () => void;
}

const STATUS_LABEL: Record<
  OverliveAccountStatus,
  { text: string; color: string }
> = {
  connected: { text: 'Connected', color: '#4ade80' },
  connecting: { text: 'Connecting…', color: '#facc15' },
  reconnecting: { text: 'Reconnecting…', color: '#facc15' },
  disconnected: { text: 'Disconnected', color: '#888' },
  error: { text: 'Error', color: '#f87171' },
  needs_reauth: { text: 'Needs Reauth', color: '#f87171' },
};

export function OverliveAccountsModal({ onClose }: Props) {
  const { projectId } = useParams<{ projectId: string }>();
  const setStoreAccounts = useEditorStore((s) => s.setOverliveAccounts);
  const [apps, setApps] = useState<OverliveAppCredentialRecord[]>([]);
  const [accounts, _setAccounts] = useState<OverliveAccountRecord[]>([]);
  // Mirror modal-local accounts into the editor store so Account port dropdowns
  // update without waiting for the next Editor mount.
  const setAccounts = (
    next:
      | OverliveAccountRecord[]
      | ((prev: OverliveAccountRecord[]) => OverliveAccountRecord[])
  ) => {
    _setAccounts((prev) => {
      const resolved =
        typeof next === 'function'
          ? (next as (p: OverliveAccountRecord[]) => OverliveAccountRecord[])(
              prev
            )
          : next;
      setStoreAccounts(resolved);
      return resolved;
    });
  };
  const [busy, setBusy] = useState(false);
  const [showAppWalkthrough, setShowAppWalkthrough] = useState(false);
  const [showSeForm, setShowSeForm] = useState(false);
  const [pendingTwitchAppPick, setPendingTwitchAppPick] = useState(false);
  const [otherProjects, setOtherProjects] = useState<Project[]>([]);

  const refresh = async () => {
    if (!projectId) return;
    try {
      const [a, b] = await Promise.all([
        api.getOverliveAppCredentials(projectId),
        api.getOverliveAccounts(projectId),
      ]);
      setApps(a);
      setAccounts(b);
    } catch {
      /* non-fatal */
    }
  };

  useEffect(() => {
    refresh();
    // Listen for the OAuth popup's success message so we can refresh
    // immediately rather than waiting for the next poll.
    const handler = (e: MessageEvent) => {
      const d = e.data as
        | { source?: string; payload?: { ok?: boolean } }
        | undefined;
      if (d?.source !== 'overlive-oauth') return;
      if (d.payload?.ok) refresh();
      else
        alert(
          `Twitch sign-in failed: ${(d.payload as { message?: string } | undefined)?.message ?? 'unknown error'}`
        );
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Load other projects on demand for the copy-from picker
  useEffect(() => {
    if (!showAppWalkthrough) return;
    api
      .getProjects()
      .then((all) => setOtherProjects(all.filter((p) => p.id !== projectId)))
      .catch(() => {});
  }, [showAppWalkthrough, projectId]);

  if (!projectId) return null;

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const startTwitchOAuthFor = async (
    appCredentialId: string,
    accountId?: string
  ) => {
    if (!projectId) return;
    setPendingTwitchAppPick(false);
    setBusy(true);
    try {
      const { authorizeUrl } = await api.startTwitchOAuth({
        projectId,
        appCredentialId,
        ...(accountId ? { accountId } : {}),
      });
      const popup = window.open(
        authorizeUrl,
        'overlive-twitch-oauth',
        'width=600,height=720,popup=yes'
      );
      if (!popup)
        alert(
          'Could not open OAuth popup — please disable your popup blocker for this site.'
        );
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to start OAuth');
    } finally {
      setBusy(false);
    }
  };

  const handleAddTwitchAccount = async () => {
    if (apps.length === 0) {
      setShowAppWalkthrough(true);
      return;
    }
    if (apps.length === 1) {
      await startTwitchOAuthFor(apps[0]!.id);
      return;
    }
    setPendingTwitchAppPick(true);
  };

  const handleReconnect = async (acc: OverliveAccountRecord) => {
    if (acc.platform !== 'twitch') return;
    if (!acc.appCredentialId) {
      alert('This account has no app credential — recreate it from scratch.');
      return;
    }
    await startTwitchOAuthFor(acc.appCredentialId, acc.id);
  };

  const handleDeleteAccount = async (acc: OverliveAccountRecord) => {
    if (!window.confirm(`Remove ${acc.label}?`)) return;
    try {
      await api.deleteOverliveAccount(acc.id);
      setAccounts((prev) => prev.filter((x) => x.id !== acc.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete account');
    }
  };

  const handleDeleteApp = async (app: OverliveAppCredentialRecord) => {
    const usingCount = accounts.filter(
      (a) => a.appCredentialId === app.id
    ).length;
    const extra =
      usingCount > 0
        ? `\n\n${usingCount} account(s) reference this app — they'll keep working until tokens expire, then will need a new app to reconnect.`
        : '';
    if (!window.confirm(`Remove app "${app.label}"?${extra}`)) return;
    try {
      await api.deleteOverliveAppCredential(app.id);
      setApps((prev) => prev.filter((x) => x.id !== app.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete app');
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={modalStyle}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: 16, color: '#fff' }}>
            Stream Accounts
          </h2>
          <button style={closeBtnStyle} onClick={onClose} title="Close">
            ×
          </button>
        </div>

        {/* Twitch Apps section */}
        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <span>Twitch Apps</span>
            <button
              style={primaryBtnStyle}
              onClick={() => setShowAppWalkthrough(true)}
              disabled={busy}
            >
              + Register App
            </button>
          </div>
          {apps.length === 0 ? (
            <div style={emptyStateStyle}>
              No Twitch apps registered. Click <strong>Register App</strong> to
              walk through setup at dev.twitch.tv.
            </div>
          ) : (
            apps.map((app) => (
              <div key={app.id} style={rowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={rowTitleStyle}>{app.label}</div>
                  <div style={rowSubStyle}>
                    <code
                      style={{
                        background: '#0a0a0a',
                        padding: '1px 4px',
                        borderRadius: 3,
                        color: '#9a9a9a',
                      }}
                    >
                      {app.clientId}
                    </code>{' '}
                    ·{' '}
                    {
                      accounts.filter((a) => a.appCredentialId === app.id)
                        .length
                    }{' '}
                    account(s)
                  </div>
                </div>
                <button
                  style={dangerBtnStyle}
                  onClick={() => handleDeleteApp(app)}
                  title="Delete app"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </section>

        {/* Login Accounts section */}
        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <span>Accounts</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                style={primaryBtnStyle}
                onClick={handleAddTwitchAccount}
                disabled={busy}
              >
                + Twitch
              </button>
              <button
                style={primaryBtnStyle}
                onClick={() => setShowSeForm(true)}
                disabled={busy}
              >
                + StreamElements
              </button>
            </div>
          </div>
          {accounts.length === 0 ? (
            <div style={emptyStateStyle}>
              No accounts connected yet.{' '}
              {apps.length === 0
                ? 'Register a Twitch app first, then click + Twitch.'
                : 'Click + Twitch to authenticate, or + StreamElements to paste a JWT.'}
            </div>
          ) : (
            accounts.map((acc) => {
              const status = STATUS_LABEL[acc.status];
              const needsReauth =
                acc.status === 'error' || acc.status === 'needs_reauth';
              return (
                <div key={acc.id} style={rowStyle}>
                  <span style={{ fontSize: 16, marginRight: 8 }}>
                    {acc.platform === 'twitch' ? '🟣' : '🟢'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={rowTitleStyle}>
                      {acc.label}
                      {acc.broadcasterLogin &&
                        acc.broadcasterLogin !== acc.label && (
                          <span
                            style={{
                              color: '#666',
                              fontWeight: 400,
                              marginLeft: 6,
                            }}
                          >
                            ({acc.broadcasterLogin})
                          </span>
                        )}
                    </div>
                    <div style={rowSubStyle}>
                      <span style={{ color: status.color }}>
                        ● {status.text}
                      </span>
                      {acc.statusReason && (
                        <span style={{ color: '#888', marginLeft: 6 }}>
                          · {acc.statusReason}
                        </span>
                      )}
                    </div>
                    {acc.statusMessage && (
                      <div
                        style={{
                          fontSize: 10,
                          color: '#888',
                          marginTop: 2,
                          fontStyle: 'italic',
                        }}
                      >
                        {acc.statusMessage}
                      </div>
                    )}
                  </div>
                  {needsReauth && acc.platform === 'twitch' && (
                    <button
                      style={primaryBtnStyle}
                      onClick={() => handleReconnect(acc)}
                      disabled={busy}
                    >
                      Reconnect
                    </button>
                  )}
                  <button
                    style={dangerBtnStyle}
                    onClick={() => handleDeleteAccount(acc)}
                    title="Remove account"
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </section>

        {/* Footer note */}
        <div
          style={{
            fontSize: 11,
            color: '#555',
            textAlign: 'center',
            padding: '8px 16px 14px',
          }}
        >
          Credentials are stored locally in your project database.
        </div>

        {/* Sub-dialogs */}
        {showAppWalkthrough && (
          <RegisterAppDialog
            projectId={projectId}
            otherProjects={otherProjects}
            onCancel={() => setShowAppWalkthrough(false)}
            onCreated={(app) => {
              setApps((prev) => [...prev, app]);
              setShowAppWalkthrough(false);
            }}
            onCopied={(rows) => {
              setApps((prev) => [...prev, ...rows]);
              setShowAppWalkthrough(false);
            }}
          />
        )}
        {showSeForm && (
          <RegisterSeAccountDialog
            projectId={projectId}
            onCancel={() => setShowSeForm(false)}
            onCreated={(acc) => {
              setAccounts((prev) => [...prev, acc]);
              setShowSeForm(false);
            }}
          />
        )}
        {pendingTwitchAppPick && (
          <PickAppDialog
            apps={apps}
            onCancel={() => setPendingTwitchAppPick(false)}
            onPick={(id) => startTwitchOAuthFor(id)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Register App dialog ─────────────────────────────────────────────────────

function RegisterAppDialog({
  projectId,
  otherProjects,
  onCancel,
  onCreated,
  onCopied,
}: {
  projectId: string;
  otherProjects: Project[];
  onCancel: () => void;
  onCreated: (app: OverliveAppCredentialRecord) => void;
  onCopied: (rows: OverliveAppCredentialRecord[]) => void;
}) {
  const [label, setLabel] = useState('My Twitch App');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(
    () => `${window.location.origin}/api/auth/twitch/callback`
  );
  const [busy, setBusy] = useState(false);
  const [copySource, setCopySource] = useState<string>('');

  const handleCreate = async () => {
    if (
      !label.trim() ||
      !clientId.trim() ||
      !clientSecret.trim() ||
      !redirectUri.trim()
    ) {
      alert('All fields are required.');
      return;
    }
    setBusy(true);
    try {
      const app = await api.createOverliveAppCredential(projectId, {
        label: label.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        redirectUri: redirectUri.trim(),
      });
      onCreated(app);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create app credential');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!copySource) return;
    setBusy(true);
    try {
      const rows = await api.copyOverliveAppCredentialsFromProject(
        projectId,
        copySource
      );
      if (rows.length === 0) alert('That project has no Twitch apps to copy.');
      else onCopied(rows);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Copy failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={subOverlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={{ ...subModalStyle, maxWidth: 580 }}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0, fontSize: 15, color: '#fff' }}>
            Register Twitch App
          </h3>
          <button style={closeBtnStyle} onClick={onCancel}>
            ×
          </button>
        </div>

        {otherProjects.length > 0 && (
          <div
            style={{ padding: '10px 16px', borderBottom: '1px solid #2a2a2a' }}
          >
            <label
              style={{
                fontSize: 11,
                color: '#888',
                display: 'block',
                marginBottom: 4,
              }}
            >
              Copy from another project
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                value={copySource}
                onChange={(e) => setCopySource(e.target.value)}
                style={inputStyle}
              >
                <option value="">— select —</option>
                {otherProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                style={primaryBtnStyle}
                onClick={handleCopy}
                disabled={!copySource || busy}
              >
                Copy
              </button>
            </div>
          </div>
        )}

        <ol
          style={{
            padding: '12px 18px 4px 32px',
            margin: 0,
            color: '#bbb',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          <li>
            Open{' '}
            <a
              href="https://dev.twitch.tv/console/apps"
              target="_blank"
              rel="noreferrer"
              style={linkStyle}
            >
              dev.twitch.tv/console/apps
            </a>{' '}
            and click <strong>Register Your Application</strong>.
          </li>
          <li>
            Set <strong>OAuth Redirect URLs</strong> to exactly:{' '}
            <code style={codeStyle}>{redirectUri}</code>
          </li>
          <li>
            Choose <strong>Category</strong>: <em>Application Integration</em>{' '}
            (or whichever fits — Twitch uses this for analytics, not scopes).
          </li>
          <li>
            Save the app, then click <strong>Manage</strong>. Copy the{' '}
            <strong>Client ID</strong> below; click <strong>New Secret</strong>{' '}
            for the <strong>Client Secret</strong>.
          </li>
        </ol>

        <div
          style={{
            padding: '8px 16px 12px',
            display: 'grid',
            gridTemplateColumns: '110px 1fr',
            gap: '8px 10px',
            alignItems: 'center',
          }}
        >
          <label style={labelStyle}>Label</label>
          <input
            style={inputStyle}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="My Twitch App"
          />
          <label style={labelStyle}>Client ID</label>
          <input
            style={inputStyle}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="abc123…"
            autoComplete="off"
          />
          <label style={labelStyle}>Client Secret</label>
          <input
            style={inputStyle}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="••••••••"
            type="password"
            autoComplete="off"
          />
          <label style={labelStyle}>Redirect URI</label>
          <input
            style={inputStyle}
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
          />
        </div>

        <div
          style={{
            padding: '4px 16px 16px',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button style={secondaryBtnStyle} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            style={primaryBtnStyle}
            onClick={handleCreate}
            disabled={busy}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SE Account dialog ──────────────────────────────────────────────────────

function RegisterSeAccountDialog({
  projectId,
  onCancel,
  onCreated,
}: {
  projectId: string;
  onCancel: () => void;
  onCreated: (acc: OverliveAccountRecord) => void;
}) {
  const [label, setLabel] = useState('StreamElements');
  const [jwt, setJwt] = useState('');
  const [channelId, setChannelId] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    if (!label.trim() || !jwt.trim() || !channelId.trim()) {
      alert('All fields are required.');
      return;
    }
    setBusy(true);
    try {
      const acc = await api.createOverliveAccount(projectId, {
        platform: 'streamelements',
        label: label.trim(),
        credentials: { jwt: jwt.trim(), channelId: channelId.trim() },
        broadcasterId: channelId.trim(),
      });
      onCreated(acc);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to add account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={subOverlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={subModalStyle}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0, fontSize: 15, color: '#fff' }}>
            Add StreamElements Account
          </h3>
          <button style={closeBtnStyle} onClick={onCancel}>
            ×
          </button>
        </div>
        <div
          style={{
            padding: '12px 16px',
            color: '#bbb',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          Get your JWT and channel ID from{' '}
          <a
            href="https://streamelements.com/dashboard/account/channels"
            target="_blank"
            rel="noreferrer"
            style={linkStyle}
          >
            streamelements.com/dashboard/account/channels
          </a>
          .
        </div>
        <div
          style={{
            padding: '4px 16px 12px',
            display: 'grid',
            gridTemplateColumns: '110px 1fr',
            gap: '8px 10px',
            alignItems: 'center',
          }}
        >
          <label style={labelStyle}>Label</label>
          <input
            style={inputStyle}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <label style={labelStyle}>JWT</label>
          <input
            style={inputStyle}
            value={jwt}
            onChange={(e) => setJwt(e.target.value)}
            type="password"
            autoComplete="off"
          />
          <label style={labelStyle}>Channel ID</label>
          <input
            style={inputStyle}
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div
          style={{
            padding: '4px 16px 16px',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button style={secondaryBtnStyle} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button style={primaryBtnStyle} onClick={handleSave} disabled={busy}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── App picker (when multiple Twitch apps exist) ────────────────────────────

function PickAppDialog({
  apps,
  onCancel,
  onPick,
}: {
  apps: OverliveAppCredentialRecord[];
  onCancel: () => void;
  onPick: (id: string) => void;
}) {
  return (
    <div
      style={subOverlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={{ ...subModalStyle, maxWidth: 420 }}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0, fontSize: 15, color: '#fff' }}>
            Which Twitch app?
          </h3>
          <button style={closeBtnStyle} onClick={onCancel}>
            ×
          </button>
        </div>
        <div style={{ padding: '8px 0' }}>
          {apps.map((app) => (
            <div
              key={app.id}
              style={{ ...rowStyle, cursor: 'pointer' }}
              onClick={() => onPick(app.id)}
            >
              <div style={{ flex: 1 }}>
                <div style={rowTitleStyle}>{app.label}</div>
                <div style={rowSubStyle}>
                  <code style={{ color: '#9a9a9a' }}>{app.clientId}</code>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  zIndex: 1000,
  paddingTop: 60,
};
const modalStyle: React.CSSProperties = {
  background: '#181818',
  border: '1px solid #2a2a2a',
  borderRadius: 8,
  width: '90%',
  maxWidth: 640,
  maxHeight: '80vh',
  overflow: 'auto',
  fontFamily: 'system-ui, sans-serif',
};
const subOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1100,
};
const subModalStyle: React.CSSProperties = {
  background: '#1c1c1c',
  border: '1px solid #333',
  borderRadius: 8,
  width: '90%',
  maxWidth: 480,
  fontFamily: 'system-ui, sans-serif',
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid #2a2a2a',
};
const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#777',
  cursor: 'pointer',
  fontSize: 20,
  padding: 0,
  lineHeight: 1,
};
const sectionStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid #2a2a2a',
};
const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: 11,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
};
const emptyStateStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#666',
  fontStyle: 'italic',
  padding: '8px 0',
};
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 4,
  margin: '2px 0',
  background: '#202020',
};
const rowTitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#e0e0e0',
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const rowSubStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#777',
  marginTop: 2,
};
const primaryBtnStyle: React.CSSProperties = {
  background: '#2563eb',
  border: 'none',
  color: '#fff',
  borderRadius: 4,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
};
const secondaryBtnStyle: React.CSSProperties = {
  background: '#2a2a2a',
  border: '1px solid #3a3a3a',
  color: '#ccc',
  borderRadius: 4,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
};
const dangerBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#666',
  cursor: 'pointer',
  fontSize: 14,
  padding: '2px 6px',
  lineHeight: 1,
};
const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
  textAlign: 'right',
};
const inputStyle: React.CSSProperties = {
  background: '#0e0e0e',
  border: '1px solid #2a2a2a',
  color: '#e0e0e0',
  borderRadius: 3,
  padding: '5px 8px',
  fontSize: 12,
  fontFamily: 'inherit',
};
const linkStyle: React.CSSProperties = {
  color: '#4a90d9',
  textDecoration: 'none',
};
const codeStyle: React.CSSProperties = {
  background: '#0a0a0a',
  padding: '1px 4px',
  borderRadius: 3,
  color: '#9a9a9a',
  fontSize: 11,
};
