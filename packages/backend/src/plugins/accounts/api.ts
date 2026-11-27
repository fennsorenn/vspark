/**
 * `ctx.accounts` — the account store plugins use (generic, provider-based).
 * Account rows are per project, like Overlive accounts (decided: user,
 * 2026-11-26). See dev-notes/modules/plugins.md#accounts.
 */
export type AccountStatus =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disconnected'
  | 'error'
  | 'needs_reauth';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  scopes?: string[];
}

export interface PluginAccount {
  id: string;
  projectId: string;
  /** Full provider id `<pluginId>:<provider>`. */
  provider: string;
  label: string;
  identity: Record<string, unknown>;
  status: AccountStatus;
  statusMessage: string | null;
  isDefault: boolean;
}

/** A declarative form field for a provider's app credentials. */
export interface AppField {
  path: string;
  control: 'text';
  label: string;
  hint?: string;
  secret?: boolean;
}

export interface AccountProviderDef {
  /** Unique within the plugin; full id `<pluginId>:<id>`. */
  id: string;
  /** i18n key (plugin namespace). */
  label: string;
  icon?: string;
  auth: {
    kind: 'oauth_pkce';
    authorizeUrl: string;
    tokenUrl: string;
    scopes: readonly string[];
    /** App credentials entered once per project (`clientId`, …). */
    appFields: readonly AppField[];
    extraParams?: Record<string, string>;
  };
  /** After a token exchange: the label and identity shown in the list. */
  fetchIdentity(tokens: OAuthTokens): Promise<{ label: string; identity: Record<string, unknown> }>;
  /** i18n key of a markdown setup walkthrough (`{{redirectUri}}` is filled in). */
  setupHelp?: string;
}

export interface PluginAccountsApi {
  defineProvider(def: AccountProviderDef): void;
  list(projectId: string, provider: string): PluginAccount[];
  get(accountId: string): PluginAccount | undefined;
  /** The project's default account of a provider (the first one when none is
   *  marked default). Empty `account` inputs resolve to it. */
  defaultFor(projectId: string, provider: string): PluginAccount | undefined;
  /** Runs `fn` with a valid access token, refreshing (and persisting rotated
   *  tokens) when it is expired or was invalidated. A refused refresh marks the
   *  account `needs_reauth` and rejects. */
  withToken<T>(accountId: string, fn: (accessToken: string) => Promise<T>): Promise<T>;
  /** Force a refresh on the next `withToken` (e.g. after a 401). */
  invalidate(accountId: string): void;
  setStatus(accountId: string, status: AccountStatus, message?: string): void;
  /** Fires with the project id after an account of this plugin is created,
   *  reconnected, changed or deleted. */
  onChanged(fn: (projectId: string) => void): () => void;
}
