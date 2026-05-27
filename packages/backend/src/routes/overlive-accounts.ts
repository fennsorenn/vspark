/**
 * REST surface for overlive app credentials and login accounts.
 * OAuth start/callback live in a separate `overlive-auth.ts` route file
 * (Phase D) — this file only owns CRUD over the two persisted tables.
 *
 * Account scope is per-project. Twitch login accounts reference an
 * `app_credential_id`; SE login accounts leave it NULL.
 * See dev-notes/modules/overlive.md.
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { getOverliveManager } from '../overlive/manager.js';

const router: ReturnType<typeof Router> = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

interface AppCredentialRow {
  id: string;
  project_id: string;
  label: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  created_at: string;
  updated_at: string;
}

interface AccountRow {
  id: string;
  project_id: string;
  platform: string;
  label: string;
  app_credential_id: string | null;
  credentials: string;
  broadcaster_id: string | null;
  broadcaster_login: string | null;
  status: string;
  status_reason: string | null;
  status_message: string | null;
  created_at: string;
  updated_at: string;
}

// ─── App credentials ──────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/projects/{projectId}/overlive-app-credentials:
 *   get:
 *     tags: [overlive]
 *     summary: List Twitch app credentials registered for a project
 */
router.get('/projects/:projectId/overlive-app-credentials', (req, res) => {
  const rows = getDb()
    .prepare(
      'SELECT * FROM overlive_app_credentials WHERE project_id = ? ORDER BY created_at'
    )
    .all(req.params.projectId) as unknown as AppCredentialRow[];
  res.json({ ok: true, data: rows.map(mapAppCredential) });
});

/**
 * @openapi
 * /api/projects/{projectId}/overlive-app-credentials:
 *   post:
 *     tags: [overlive]
 *     summary: Register a Twitch app credential (client_id + client_secret + redirect_uri)
 */
router.post('/projects/:projectId/overlive-app-credentials', (req, res) => {
  const { label, clientId, clientSecret, redirectUri } = req.body as {
    label?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
  if (!label || !clientId || !clientSecret || !redirectUri) {
    return res.status(400).json({
      ok: false,
      error: {
        message: 'label, clientId, clientSecret, and redirectUri are required',
      },
    });
  }
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO overlive_app_credentials (id, project_id, label, client_id, client_secret, redirect_uri)
     VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, req.params.projectId, label, clientId, clientSecret, redirectUri);
  res.status(201).json({ ok: true, data: getAppCredential(id) });
});

/**
 * @openapi
 * /api/overlive-app-credentials/{id}:
 *   put:
 *     tags: [overlive]
 *     summary: Update label / clientId / clientSecret / redirectUri (all optional)
 */
router.put('/overlive-app-credentials/:id', (req, res) => {
  const { label, clientId, clientSecret, redirectUri } = req.body as {
    label?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
  const db = getDb();
  db.prepare(
    `UPDATE overlive_app_credentials SET
       label         = COALESCE(?, label),
       client_id     = COALESCE(?, client_id),
       client_secret = COALESCE(?, client_secret),
       redirect_uri  = COALESCE(?, redirect_uri),
       updated_at    = datetime('now')
     WHERE id = ?`
  ).run(
    label ?? null,
    clientId ?? null,
    clientSecret ?? null,
    redirectUri ?? null,
    req.params.id
  );
  const row = getAppCredential(req.params.id);
  if (!row)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'app credential not found' } });
  res.json({ ok: true, data: row });
});

/**
 * @openapi
 * /api/overlive-app-credentials/{id}:
 *   delete:
 *     tags: [overlive]
 *     summary: Delete a Twitch app credential. Login accounts referencing it have app_credential_id nulled.
 */
router.delete('/overlive-app-credentials/:id', (req, res) => {
  getDb()
    .prepare('DELETE FROM overlive_app_credentials WHERE id = ?')
    .run(req.params.id);
  res.json({ ok: true, data: {} });
});

/**
 * @openapi
 * /api/projects/{projectId}/overlive-app-credentials/copy-from/{sourceProjectId}:
 *   post:
 *     tags: [overlive]
 *     summary: Copy all Twitch app credentials from another project into this one
 *     description: |
 *       Shortcut so users don't have to re-enter the same dev.twitch.tv app
 *       across projects. Each source row is inserted as a new row in the
 *       destination project (new ids, original labels preserved).
 */
router.post(
  '/projects/:projectId/overlive-app-credentials/copy-from/:sourceProjectId',
  (req, res) => {
    const db = getDb();
    const sources = db
      .prepare(
        'SELECT * FROM overlive_app_credentials WHERE project_id = ? ORDER BY created_at'
      )
      .all(req.params.sourceProjectId) as unknown as AppCredentialRow[];
    const inserted: ReturnType<typeof mapAppCredential>[] = [];
    const stmt = db.prepare(
      `INSERT INTO overlive_app_credentials (id, project_id, label, client_id, client_secret, redirect_uri)
     VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const src of sources) {
      const newId = randomUUID();
      stmt.run(
        newId,
        req.params.projectId,
        src.label,
        src.client_id,
        src.client_secret,
        src.redirect_uri
      );
      const row = getAppCredential(newId);
      if (row) inserted.push(row);
    }
    res.json({ ok: true, data: inserted });
  }
);

// ─── Login accounts ───────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/projects/{projectId}/overlive-accounts:
 *   get:
 *     tags: [overlive]
 *     summary: List login accounts (Twitch + StreamElements) for a project
 */
router.get('/projects/:projectId/overlive-accounts', (req, res) => {
  const rows = getDb()
    .prepare(
      'SELECT * FROM overlive_accounts WHERE project_id = ? ORDER BY created_at'
    )
    .all(req.params.projectId) as unknown as AccountRow[];
  res.json({ ok: true, data: rows.map(mapAccount) });
});

/**
 * @openapi
 * /api/projects/{projectId}/overlive-accounts:
 *   post:
 *     tags: [overlive]
 *     summary: |
 *       Manually create a login account. For Twitch this is rarely used —
 *       prefer the OAuth flow (POST /auth/twitch/start) which inserts a row
 *       on callback. For StreamElements this is the only way: the body
 *       must contain { platform: "streamelements", label, credentials: { jwt, channelId } }.
 */
router.post('/projects/:projectId/overlive-accounts', (req, res) => {
  const {
    platform,
    label,
    appCredentialId,
    credentials,
    broadcasterId,
    broadcasterLogin,
  } = req.body as {
    platform?: string;
    label?: string;
    appCredentialId?: string | null;
    credentials?: Record<string, unknown>;
    broadcasterId?: string;
    broadcasterLogin?: string;
  };
  if (!platform || !label) {
    return res
      .status(400)
      .json({
        ok: false,
        error: { message: 'platform and label are required' },
      });
  }
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO overlive_accounts
       (id, project_id, platform, label, app_credential_id, credentials, broadcaster_id, broadcaster_login)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      req.params.projectId,
      platform,
      label,
      appCredentialId ?? null,
      JSON.stringify(credentials ?? {}),
      broadcasterId ?? null,
      broadcasterLogin ?? null
    );
  res.status(201).json({ ok: true, data: getAccount(id) });
  void getOverliveManager()
    .refreshProject(req.params.projectId)
    .catch(() => {});
});

/**
 * @openapi
 * /api/overlive-accounts/{id}:
 *   put:
 *     tags: [overlive]
 *     summary: Update a login account's label, credentials, status, etc.
 */
router.put('/overlive-accounts/:id', (req, res) => {
  const {
    label,
    credentials,
    broadcasterId,
    broadcasterLogin,
    status,
    statusReason,
    statusMessage,
  } = req.body as {
    label?: string;
    credentials?: Record<string, unknown>;
    broadcasterId?: string | null;
    broadcasterLogin?: string | null;
    status?: string;
    statusReason?: string | null;
    statusMessage?: string | null;
  };
  getDb()
    .prepare(
      `UPDATE overlive_accounts SET
       label             = COALESCE(?, label),
       credentials       = COALESCE(?, credentials),
       broadcaster_id    = COALESCE(?, broadcaster_id),
       broadcaster_login = COALESCE(?, broadcaster_login),
       status            = COALESCE(?, status),
       status_reason     = COALESCE(?, status_reason),
       status_message    = COALESCE(?, status_message),
       updated_at        = datetime('now')
     WHERE id = ?`
    )
    .run(
      label ?? null,
      credentials != null ? JSON.stringify(credentials) : null,
      broadcasterId ?? null,
      broadcasterLogin ?? null,
      status ?? null,
      statusReason ?? null,
      statusMessage ?? null,
      req.params.id
    );
  const row = getAccount(req.params.id);
  if (!row)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'account not found' } });
  res.json({ ok: true, data: row });
  void getOverliveManager()
    .refreshProject(row.projectId)
    .catch(() => {});
});

/**
 * @openapi
 * /api/overlive-accounts/{id}:
 *   delete:
 *     tags: [overlive]
 *     summary: Delete a login account.
 *     description: |
 *       For Twitch accounts, the caller should first revoke the access token
 *       via the OAuth helper so no dangling authorization remains on Twitch.
 *       The OverliveManager handles that — this endpoint only deletes the row.
 */
router.delete('/overlive-accounts/:id', async (req, res) => {
  // Capture projectId before delete so we can reconcile its kit afterwards.
  const before = getDb()
    .prepare('SELECT project_id FROM overlive_accounts WHERE id = ?')
    .get(req.params.id) as { project_id: string } | undefined;
  // Revoke Twitch tokens + remove from kit before dropping the row.
  try {
    await getOverliveManager().beforeAccountDelete(req.params.id);
  } catch {
    /* best effort */
  }
  getDb()
    .prepare('DELETE FROM overlive_accounts WHERE id = ?')
    .run(req.params.id);
  res.json({ ok: true, data: {} });
  if (before)
    void getOverliveManager()
      .refreshProject(before.project_id)
      .catch(() => {});
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAppCredential(id: string) {
  const row = getDb()
    .prepare('SELECT * FROM overlive_app_credentials WHERE id = ?')
    .get(id) as unknown as AppCredentialRow | undefined;
  return row ? mapAppCredential(row) : null;
}

function mapAppCredential(r: AppCredentialRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    clientId: r.client_id,
    clientSecret: r.client_secret,
    redirectUri: r.redirect_uri,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getAccount(id: string) {
  const row = getDb()
    .prepare('SELECT * FROM overlive_accounts WHERE id = ?')
    .get(id) as unknown as AccountRow | undefined;
  return row ? mapAccount(row) : null;
}

function mapAccount(r: AccountRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    platform: r.platform,
    label: r.label,
    appCredentialId: r.app_credential_id,
    credentials: safeJson(r.credentials),
    broadcasterId: r.broadcaster_id,
    broadcasterLogin: r.broadcaster_login,
    status: r.status,
    statusReason: r.status_reason,
    statusMessage: r.status_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default router;
