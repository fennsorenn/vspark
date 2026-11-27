/**
 * Plugin account store (plugin-system phase 3).
 *
 * Accounts are `plugin_account` mesh documents persisted in `plugin_accounts`
 * (per project). Their tokens live only in that table's `credentials` column
 * — never in a document, never sent to a tab or a peer. Status is a
 * `server_status` document of kind `plugin_account` about the account.
 * Providers are declared by plugins (`ctx.accounts.defineProvider`) and kept
 * in memory while the plugin is active.
 * See dev-notes/modules/plugins.md#accounts.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { PluginAccountDoc } from '@vspark/shared/types';
import { getDb } from '../../db/index.js';
import { getMeshCollection } from '../../mesh/index.js';
import { clearStatus, publishStatus, statusCollection } from '../../mesh/status.js';
import type {
  AccountProviderDef,
  AccountStatus,
  OAuthTokens,
  PluginAccount,
  PluginAccountsApi,
} from './api.js';

export type RegisteredProvider = AccountProviderDef & { pluginId: string; fullId: string };

/** `<pluginId>:<id>` → provider. */
export const PROVIDERS = new Map<string, RegisteredProvider>();

/** Field names of a provider's app credentials (undefined: unknown provider). */
export function appFieldsOf(provider: string): string[] | undefined {
  return PROVIDERS.get(provider)?.auth.appFields.map((f) => f.path);
}

const events = new EventEmitter();
events.setMaxListeners(0);

const parse = <T>(s: string | null | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};

const accounts = () => getMeshCollection('plugin_account');

function docToAccount(d: PluginAccountDoc): PluginAccount {
  const st = statusCollection()?.get(`plugin_account:${d.id}`) as
    | { status?: AccountStatus; message?: string | null }
    | undefined;
  return {
    id: d.id,
    projectId: d.projectId,
    provider: d.provider,
    label: d.label,
    identity: d.identity ?? {},
    status: st?.status ?? 'disconnected',
    statusMessage: st?.message ?? null,
    isDefault: d.isDefault === true,
  };
}

function rowsOf(projectId: string, provider: string): PluginAccountDoc[] {
  const col = accounts();
  if (col)
    return (col.all() as unknown as PluginAccountDoc[])
      .filter((d) => d.projectId === projectId && d.provider === provider)
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  return [];
}

function readCredentials(id: string): OAuthTokens | undefined {
  const r = getDb().prepare('SELECT credentials FROM plugin_accounts WHERE id = ?').get(id) as
    | { credentials: string }
    | undefined;
  const c = parse<Partial<OAuthTokens>>(r?.credentials, {});
  return typeof c.accessToken === 'string' ? (c as OAuthTokens) : undefined;
}

export function writeCredentials(id: string, tokens: OAuthTokens): void {
  getDb()
    .prepare("UPDATE plugin_accounts SET credentials = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(tokens), id);
}

export function setAccountStatus(id: string, status: AccountStatus, message?: string): void {
  publishStatus(
    'plugin_account',
    id,
    { status, message: message ?? null },
    { rtype: 'plugin_account', id }
  );
}

export function emitAccountsChanged(provider: string, projectId: string): void {
  events.emit(provider.split(':')[0]!, projectId);
}

/** Side effects of committed account documents (mesh persistence tap). */
export const pluginAccountLifecycle = {
  onSaved(d: Record<string, unknown>): void {
    const doc = d as unknown as PluginAccountDoc;
    // One default per (project, provider): the newest default wins.
    if (doc.isDefault)
      for (const other of rowsOf(doc.projectId, doc.provider))
        if (other.id !== doc.id && other.isDefault) accounts()?.set(other.id, 'isDefault', false);
    emitAccountsChanged(doc.provider, doc.projectId);
  },
  onRemoving(id: string): void {
    // The document may already be gone from the replica; the row is not yet.
    const row = getDb()
      .prepare('SELECT project_id, provider FROM plugin_accounts WHERE id = ?')
      .get(id) as { project_id: string; provider: string } | undefined;
    clearStatus('plugin_account', id);
    pendingRefresh.delete(id);
    if (row) setImmediate(() => emitAccountsChanged(row.provider, row.project_id));
  },
};

/** Create (or, with `accountId`, reconnect in place — the id stays stable so
 *  graphs referencing it keep working) an account after a token exchange. */
export function upsertAccount(opts: {
  accountId?: string;
  projectId: string;
  provider: string;
  label: string;
  identity: Record<string, unknown>;
  tokens: OAuthTokens;
}): string {
  const col = accounts();
  if (!col) throw new Error('mesh is not up');
  const existing = opts.accountId ? (col.get(opts.accountId) as unknown as PluginAccountDoc | undefined) : undefined;
  const id = existing?.id ?? randomUUID();
  const isDefault = existing ? existing.isDefault : rowsOf(opts.projectId, opts.provider).length === 0;
  col.set(
    id,
    '',
    {
      id,
      projectId: opts.projectId,
      provider: opts.provider,
      label: opts.label,
      identity: opts.identity,
      isDefault,
      ...(existing?.createdAt ? { createdAt: existing.createdAt } : {}),
    } as never
  );
  writeCredentials(id, opts.tokens);
  setAccountStatus(id, 'connected');
  return id;
}

/** Accounts whose next `withToken` must refresh. */
const pendingRefresh = new Set<string>();
/** In-flight refreshes, so concurrent calls share one. */
const refreshing = new Map<string, Promise<OAuthTokens>>();

export class ReauthRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReauthRequired';
  }
}

async function refresh(account: PluginAccountDoc, tokens: OAuthTokens): Promise<OAuthTokens> {
  const provider = PROVIDERS.get(account.provider);
  if (!provider) throw new Error(`provider ${account.provider} is not available (plugin not running)`);
  if (!tokens.refreshToken) throw new ReauthRequired('no refresh token');
  const app = getMeshCollection('plugin_app')?.get(`${account.projectId}:${account.provider}`) as
    | { fields?: Record<string, string> }
    | undefined;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: app?.fields?.clientId ?? '',
  });
  const res = await fetch(provider.auth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (res.status === 400 || res.status === 401) throw new ReauthRequired(`refresh refused (${res.status})`);
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`);
  const j = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  const next: OAuthTokens = {
    accessToken: j.access_token,
    // Providers that rotate refresh tokens send a new one; others keep the old.
    refreshToken: j.refresh_token ?? tokens.refreshToken,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    scopes: j.scope ? j.scope.split(' ') : tokens.scopes,
  };
  writeCredentials(account.id, next);
  return next;
}

/** A refresh is due 60 s before expiry. */
const expired = (t: OAuthTokens) => t.expiresAt !== undefined && t.expiresAt - 60_000 < Date.now();

export function createAccountsApi(
  pluginId: string,
  onDispose: (fn: () => void) => void
): PluginAccountsApi {
  const own = (provider: string) => provider.startsWith(`${pluginId}:`);
  const getDoc = (id: string) => {
    const d = accounts()?.get(id) as unknown as PluginAccountDoc | undefined;
    return d && own(d.provider) ? d : undefined;
  };
  return {
    defineProvider(def) {
      const fullId = `${pluginId}:${def.id}`;
      if (!/^[a-z][a-z0-9_]*$/.test(def.id)) throw new Error(`invalid provider id "${def.id}"`);
      if (PROVIDERS.has(fullId)) throw new Error(`account provider "${fullId}" already exists`);
      if (def.auth.appFields.some((f) => f.secret))
        throw new Error('secret app fields are not supported (apiVersion 1): use PKCE');
      PROVIDERS.set(fullId, { ...def, pluginId, fullId });
      onDispose(() => PROVIDERS.delete(fullId));
    },
    list: (projectId, provider) => (own(provider) ? rowsOf(projectId, provider).map(docToAccount) : []),
    get: (id) => {
      const d = getDoc(id);
      return d ? docToAccount(d) : undefined;
    },
    defaultFor(projectId, provider) {
      if (!own(provider)) return undefined;
      const rows = rowsOf(projectId, provider);
      const d = rows.find((r) => r.isDefault) ?? rows[0];
      return d ? docToAccount(d) : undefined;
    },
    async withToken(id, fn) {
      const doc = getDoc(id);
      if (!doc) throw new Error('unknown account');
      let tokens = readCredentials(id);
      if (!tokens) throw new ReauthRequired('account has no credentials');
      if (pendingRefresh.has(id) || expired(tokens)) {
        let p = refreshing.get(id);
        if (!p) {
          p = refresh(doc, tokens).finally(() => refreshing.delete(id));
          refreshing.set(id, p);
        }
        try {
          tokens = await p;
          pendingRefresh.delete(id);
        } catch (e) {
          if (e instanceof ReauthRequired) setAccountStatus(id, 'needs_reauth', e.message);
          throw e;
        }
      }
      return fn(tokens.accessToken);
    },
    invalidate: (id) => {
      if (getDoc(id)) pendingRefresh.add(id);
    },
    setStatus: (id, status, message) => {
      if (getDoc(id)) setAccountStatus(id, status, message);
    },
    onChanged(fn) {
      events.on(pluginId, fn);
      const off = () => {
        events.off(pluginId, fn);
      };
      onDispose(off);
      return off;
    },
  };
}
