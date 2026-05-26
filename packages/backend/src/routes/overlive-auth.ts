/**
 * Twitch OAuth start/callback for the Accounts modal.
 *
 * Flow:
 *   1. Frontend opens a popup at GET /api/auth/twitch/start?projectId=&appCredentialId=
 *      (optionally accountId= when reconnecting an existing row).
 *   2. We mint a CSRF state token, stash it (in-memory, TTL'd), and 302
 *      redirect the popup to Twitch's /oauth2/authorize.
 *   3. User logs in/consents. Twitch redirects back to the app's
 *      `redirect_uri` (which the user registered at dev.twitch.tv and
 *      stored on the app credential row) with `?code=&state=`.
 *   4. The redirect_uri lands at GET /api/auth/twitch/callback. We verify
 *      state, exchange the code for tokens, fetch the user's identity,
 *      upsert the overlive_accounts row, and return an HTML "you can
 *      close this window" page that posts a message to window.opener and
 *      auto-closes.
 *
 * Stage 3-4 split: the user-controlled redirect URI may differ from this
 * server's host (e.g. the user registered a Cloudflare tunnel domain).
 * That's fine — Twitch redirects there, the user's reverse proxy is
 * expected to terminate to this backend. The state map lives in this
 * process, so a multi-instance backend would need a shared store
 * (tracked in ARCHITECTURE.md → Future Features).
 */
import { Router } from 'express'
import { randomUUID } from 'crypto'
import { getDb } from '../db/index.js'
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchAuthorizedUser,
  DEFAULT_SCOPES,
  type TwitchScope,
} from '@overlive/twitch-oauth'

const router: ReturnType<typeof Router> = Router()

// ─── In-memory CSRF state store ───────────────────────────────────────────────

interface PendingState {
  projectId:       string
  appCredentialId: string
  accountId:       string | null   // present iff reconnecting
  createdAt:       number
}

const STATE_TTL_MS = 10 * 60 * 1000   // 10 minutes
const pendingStates = new Map<string, PendingState>()

function gcStates(): void {
  const now = Date.now()
  for (const [k, v] of pendingStates) {
    if (now - v.createdAt > STATE_TTL_MS) pendingStates.delete(k)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface AppCredentialRow {
  id:            string
  project_id:    string
  client_id:     string
  client_secret: string
  redirect_uri:  string
}

function getAppCredential(id: string): AppCredentialRow | undefined {
  return getDb().prepare('SELECT id, project_id, client_id, client_secret, redirect_uri FROM overlive_app_credentials WHERE id = ?')
    .get(id) as unknown as AppCredentialRow | undefined
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/auth/twitch/start:
 *   get:
 *     tags: [overlive]
 *     summary: Begin Twitch OAuth. Returns the authorize URL the popup should navigate to.
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: appCredentialId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: accountId
 *         required: false
 *         description: When present, the callback updates this existing account row (reconnect flow) instead of inserting a new one.
 *         schema: { type: string }
 */
router.get('/auth/twitch/start', (req, res) => {
  gcStates()
  const projectId = String(req.query.projectId ?? '')
  const appCredentialId = String(req.query.appCredentialId ?? '')
  const accountId = req.query.accountId ? String(req.query.accountId) : null
  if (!projectId || !appCredentialId) {
    return res.status(400).json({ ok: false, error: { message: 'projectId and appCredentialId are required' } })
  }
  const app = getAppCredential(appCredentialId)
  if (!app || app.project_id !== projectId) {
    return res.status(404).json({ ok: false, error: { message: 'app credential not found for project' } })
  }

  const state = randomUUID()
  pendingStates.set(state, { projectId, appCredentialId, accountId, createdAt: Date.now() })

  const url = buildAuthorizeUrl({
    clientId:    app.client_id,
    redirectUri: app.redirect_uri,
    scopes:      DEFAULT_SCOPES,
    state,
    // Force consent only on explicit reconnect, so a fresh OAuth doesn't
    // re-prompt a user who's already authorized this app.
    ...(accountId ? { forceVerify: true } : {}),
  })

  res.json({ ok: true, data: { authorizeUrl: url } })
})

/**
 * @openapi
 * /api/auth/twitch/callback:
 *   get:
 *     tags: [overlive]
 *     summary: Twitch OAuth redirect target. Exchanges code, upserts account, posts result to opener and closes.
 */
router.get('/auth/twitch/callback', async (req, res) => {
  gcStates()
  const code  = req.query.code  ? String(req.query.code)  : null
  const state = req.query.state ? String(req.query.state) : null
  const errParam = req.query.error ? String(req.query.error) : null
  const errDesc  = req.query.error_description ? String(req.query.error_description) : null

  if (errParam) {
    return res.send(renderCallbackPage({ ok: false, message: `Twitch returned ${errParam}: ${errDesc ?? ''}` }))
  }
  if (!code || !state) {
    return res.send(renderCallbackPage({ ok: false, message: 'Missing code or state from Twitch' }))
  }
  const pending = pendingStates.get(state)
  if (!pending) {
    return res.send(renderCallbackPage({ ok: false, message: 'Unknown or expired state — please retry from the Accounts modal' }))
  }
  pendingStates.delete(state)

  const app = getAppCredential(pending.appCredentialId)
  if (!app) {
    return res.send(renderCallbackPage({ ok: false, message: 'App credential disappeared between start and callback' }))
  }

  let tokens
  try {
    tokens = await exchangeCode({
      clientId:     app.client_id,
      clientSecret: app.client_secret,
      code,
      redirectUri:  app.redirect_uri,
    })
  } catch (e) {
    return res.send(renderCallbackPage({ ok: false, message: e instanceof Error ? e.message : String(e) }))
  }

  let user
  try {
    user = await fetchAuthorizedUser(tokens.accessToken, app.client_id)
  } catch (e) {
    return res.send(renderCallbackPage({ ok: false, message: `Failed to fetch user info: ${e instanceof Error ? e.message : String(e)}` }))
  }

  const credentials = {
    accessToken:  tokens.accessToken,
    refreshToken: tokens.refreshToken,
    scopes:       tokens.scope as TwitchScope[],
    expiresAt:    Date.now() + tokens.expiresIn * 1000,
  }

  const db = getDb()
  const accountId = pending.accountId ?? randomUUID()
  if (pending.accountId) {
    // Reconnect: refresh credentials + status, keep id stable so signal graphs
    // referencing the account continue to work.
    db.prepare(
      `UPDATE overlive_accounts SET
         credentials       = ?,
         broadcaster_id    = ?,
         broadcaster_login = ?,
         label             = COALESCE(label, ?),
         status            = 'disconnected',
         status_reason     = NULL,
         status_message    = NULL,
         updated_at        = datetime('now')
       WHERE id = ?`,
    ).run(JSON.stringify(credentials), user.id, user.login, user.displayName, accountId)
  } else {
    db.prepare(
      `INSERT INTO overlive_accounts
         (id, project_id, platform, label, app_credential_id, credentials,
          broadcaster_id, broadcaster_login, status)
       VALUES (?, ?, 'twitch', ?, ?, ?, ?, ?, 'disconnected')`,
    ).run(
      accountId,
      pending.projectId,
      user.displayName || user.login,
      pending.appCredentialId,
      JSON.stringify(credentials),
      user.id,
      user.login,
    )
  }

  res.send(renderCallbackPage({ ok: true, accountId, login: user.login, displayName: user.displayName }))
})

// ─── Callback HTML ────────────────────────────────────────────────────────────

interface CallbackResultOk {
  ok: true
  accountId: string
  login: string
  displayName: string
}
interface CallbackResultErr {
  ok: false
  message: string
}

/**
 * Tiny HTML page returned at the end of OAuth. Posts the result to
 * window.opener via postMessage and closes the popup. If postMessage
 * doesn't reach the opener (e.g. it was closed manually), the user sees
 * the success/error message inline.
 */
function renderCallbackPage(result: CallbackResultOk | CallbackResultErr): string {
  const json = JSON.stringify(result).replace(/</g, '\\u003c')
  const title = result.ok ? 'Account connected' : 'Connection failed'
  const body = result.ok
    ? `Connected Twitch account <strong>${escapeHtml(result.displayName)}</strong> (${escapeHtml(result.login)}). You can close this window.`
    : `<strong>Failed:</strong> ${escapeHtml(result.message)}`
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 14px system-ui, sans-serif; background: #1a1a1a; color: #e0e0e0; padding: 24px; }
  .box { max-width: 480px; margin: 60px auto; background: #222; border: 1px solid #333; border-radius: 8px; padding: 24px; }
  h1 { margin: 0 0 12px; font-size: 18px; color: ${result.ok ? '#4ade80' : '#f87171'}; }
</style>
</head><body>
<div class="box">
<h1>${title}</h1>
<p>${body}</p>
</div>
<script>
  (function () {
    var data = ${json};
    try {
      if (window.opener) {
        window.opener.postMessage({ source: 'overlive-oauth', payload: data }, '*');
      }
    } catch (e) {}
    if (data.ok) setTimeout(function () { try { window.close(); } catch (e) {} }, 500);
  })();
</script>
</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export default router
