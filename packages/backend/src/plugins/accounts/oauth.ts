/**
 * OAuth (Authorization Code + PKCE) for plugin account providers.
 *
 * Browser navigation, not an editor data call: the editor opens a popup on
 * `/api/plugin-auth/start`, which redirects to the provider; the provider
 * redirects back to `/api/plugin-auth/callback`, which stores the account
 * (a `plugin_account` mesh document — the editor sees it arrive through its
 * subscription) and closes the popup. Like overlive-auth.ts, the CSRF state
 * map is in memory with a 10-minute TTL.
 * See dev-notes/modules/plugins.md#accounts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Router, type Response } from 'express';
import { getDb } from '../../db/index.js';
import { getMeshCollection } from '../../mesh/index.js';
import { PROVIDERS, emitAccountsChanged, upsertAccount } from './store.js';

const TTL_MS = 10 * 60_000;

interface Pending {
  provider: string;
  projectId: string;
  accountId?: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  at: number;
}

const pendingStates = new Map<string, Pending>();

/** The redirect URI to register with a provider. Spotify (and others) accept
 *  plain http only for a loopback IP literal, so it is 127.0.0.1, not
 *  localhost. VSPARK_OAUTH_REDIRECT_BASE overrides the origin (a tunnel). */
export function oauthRedirectUri(): string {
  const base =
    process.env.VSPARK_OAUTH_REDIRECT_BASE ??
    `http://127.0.0.1:${Number(process.env.PORT) || 3001}`;
  return `${base.replace(/\/$/, '')}/api/plugin-auth/callback`;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function gc() {
  const now = Date.now();
  for (const [k, v] of pendingStates) if (now - v.at > TTL_MS) pendingStates.delete(k);
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The page the popup ends on: tells the opener, then closes. */
function finish(res: Response, payload: { ok: boolean; accountId?: string; message?: string }) {
  const json = JSON.stringify({ source: 'vspark-plugin-oauth', payload }).replace(/</g, '\\u003c');
  res
    .status(payload.ok ? 200 : 400)
    .type('html')
    .send(`<!doctype html><meta charset="utf-8"><title>vspark</title>
<p style="font-family:sans-serif">${payload.ok ? 'Connected — you can close this window.' : `Could not connect: ${esc(payload.message ?? 'unknown error')}`}</p>
<script>try{window.opener&&window.opener.postMessage(${json},'*')}catch(e){}${payload.ok ? 'setTimeout(function(){window.close()},300)' : ''}</script>`);
}

const router = Router();

/**
 * @openapi
 * /api/plugin-auth/start:
 *   get:
 *     tags: [plugins]
 *     summary: Start connecting a plugin account (opened in a popup; redirects to the provider)
 *     parameters:
 *       - { in: query, name: provider, required: true, schema: { type: string } }
 *       - { in: query, name: projectId, required: true, schema: { type: string } }
 *       - { in: query, name: accountId, schema: { type: string }, description: reconnect this account in place }
 *     responses:
 *       302: { description: Redirect to the provider's authorize page }
 *       400: { description: Unknown provider / project, or no app credentials yet }
 */
router.get('/plugin-auth/start', (req, res) => {
  gc();
  const provider = String(req.query.provider ?? '');
  const projectId = String(req.query.projectId ?? '');
  const accountId = req.query.accountId ? String(req.query.accountId) : undefined;
  const def = PROVIDERS.get(provider);
  if (!def) return finish(res, { ok: false, message: 'This account provider is not available (is its plugin running?).' });
  if (!getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId))
    return finish(res, { ok: false, message: 'Unknown project.' });
  const app = getMeshCollection('plugin_app')?.get(`${projectId}:${provider}`) as
    | { fields?: Record<string, string> }
    | undefined;
  const clientId = app?.fields?.clientId?.trim() ?? '';
  if (!clientId) return finish(res, { ok: false, message: 'Enter the app’s client id first.' });

  const state = b64url(randomBytes(24));
  const { verifier, challenge } = pkcePair();
  const redirectUri = oauthRedirectUri();
  pendingStates.set(state, { provider, projectId, accountId, verifier, clientId, redirectUri, at: Date.now() });
  const url = new URL(def.auth.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', def.auth.scopes.join(' '));
  for (const [k, v] of Object.entries(def.auth.extraParams ?? {})) url.searchParams.set(k, v);
  res.redirect(302, url.toString());
});

/**
 * @openapi
 * /api/plugin-auth/callback:
 *   get:
 *     tags: [plugins]
 *     summary: OAuth redirect target of every plugin account provider
 *     responses:
 *       200: { description: Connected (HTML page that notifies the editor and closes) }
 *       400: { description: Refused, expired or failed (HTML page) }
 */
router.get('/plugin-auth/callback', async (req, res) => {
  gc();
  const state = String(req.query.state ?? '');
  const p = pendingStates.get(state);
  if (!p) return finish(res, { ok: false, message: 'This sign-in has expired. Please try again.' });
  pendingStates.delete(state);
  if (req.query.error) return finish(res, { ok: false, message: String(req.query.error) });
  const def = PROVIDERS.get(p.provider);
  if (!def) return finish(res, { ok: false, message: 'The plugin stopped while signing in.' });
  try {
    const tokenRes = await fetch(def.auth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(req.query.code ?? ''),
        redirect_uri: p.redirectUri,
        client_id: p.clientId,
        code_verifier: p.verifier,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
    const j = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    const tokens = {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
      scopes: j.scope ? j.scope.split(' ') : [...def.auth.scopes],
    };
    const who = await def.fetchIdentity(tokens);
    const accountId = upsertAccount({
      accountId: p.accountId,
      projectId: p.projectId,
      provider: p.provider,
      label: who.label,
      identity: who.identity,
      tokens,
    });
    emitAccountsChanged(p.provider, p.projectId);
    finish(res, { ok: true, accountId });
  } catch (e) {
    finish(res, { ok: false, message: (e as Error).message });
  }
});

export default router;
