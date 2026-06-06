/**
 * OverliveManager — one shared OverliveKit per loaded project.
 *
 * Responsibilities:
 *  - On project load, instantiate a kit and register one adapter per
 *    configured overlive_accounts row (Twitch via app_credential, SE via JWT).
 *  - Wire token-refresh callbacks back to the DB so rotated refresh tokens
 *    persist; surface adapter state changes as updates to the
 *    overlive_accounts.status / status_reason / status_message columns,
 *    broadcast over WebSocket as `overlive_account_status`.
 *  - Route inbound events into project graphs by walking every running
 *    logic and firing the event into any overlive_<eventType> node
 *    whose `account` input matches the source account id and whose
 *    `channel` filter is empty or matches.
 *
 * The kit is created lazily — the first time the project gets either an
 * account or a project-graph reference. Accounts can be added/removed at
 * runtime; refresh() reconciles.
 *
 * Credentials are read/written plaintext from `overlive_accounts.credentials`
 * (JSON). Encryption-at-rest is required before multi-user — flagged in
 * ARCHITECTURE.md.
 */
import { OverliveKit, type AdapterStateSnapshot } from '@overlive/core';
import { TwitchAdapter } from '@overlive/twitch';
import { SEAdapter } from '@overlive/se';
import { revokeAccessToken } from '@overlive/twitch-oauth';
import type { AdapterEmittedEvent, ChatMessageEvent } from '@overlive/core';
import { tokensToHtml } from '@overlive/emotes';
import { mkEvent } from '@vspark/shared/signal';
import { getDb } from '../db/index.js';
import { logicManager } from '../logic/manager.js';
import type { WSSync } from '../ws/index.js';

/**
 * One accumulated chat message in the overlive chat ring-buffer. Mirrors the
 * `overlive_chat_message` node's per-message output, plus `id` (stable React
 * key), `channel`, and `timestamp` for the feed/template layer. This shape is
 * what `overlive_chat_feed.messages` emits and what `set_data` publishes when
 * wired to a chat channel — the template interpolates whichever of these fields
 * it references.
 */
export interface ChatFeedItem {
  /** Platform message id — stable key for per-item CSS enter/exit + scroll. */
  id: string;
  channel: string;
  /** Epoch ms the message was received. */
  timestamp: number;
  username: string;
  displayName: string;
  text: string;
  /** XSS-safe HTML with inline emote <img>s (sanitised again on the frontend). */
  html: string;
  color: string;
  isMod: boolean;
  isSub: boolean;
  isBroadcaster: boolean;
  isAction: boolean;
  isHighlighted: boolean;
  cheerAmount: number;
}

/** Hard upper bound on retained messages per account ring-buffer. Bounded so a
 *  long-running session doesn't grow without limit; each `overlive_chat_feed`
 *  node trims this snapshot to its own (smaller) configured `maxLength`. */
const CHAT_BUFFER_MAX = 500;

// ─── Row shapes (mirror the routes/overlive-accounts.ts types) ────────────────

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
}

interface AppCredentialRow {
  id: string;
  project_id: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

interface ProjectEntry {
  kit: OverliveKit;
  /** Set of account ids currently registered as adapter instances on the kit. */
  registered: Set<string>;
}

export class OverliveManager {
  private readonly projects = new Map<string, ProjectEntry>();
  /** projectId -> account id currently marked is_default = 1. Cached lookup,
   *  read on every overlive event for projects where some node has an empty
   *  `account` config; invalidated on every refreshProject (called by REST
   *  account mutations including set-default). */
  private readonly defaultAccountByProject = new Map<string, string | null>();
  /** Set of project ids we've already warned "no default account" for; avoids
   *  spamming the log when a project has overlive nodes but no accounts. */
  private readonly warnedNoDefault = new Set<string>();
  /** accountId (sourceInstanceId) → bounded chat ring-buffer. Durable history
   *  lives here (not in graph node state, which is per-instance + rebuilt on
   *  reconcile); `overlive_chat_feed` is a thin view over this buffer. */
  private readonly chatBuffers = new Map<string, ChatFeedItem[]>();

  constructor(private readonly ws?: WSSync) {}

  /** Look up the project's default account id (the row with is_default = 1).
   *  Cached; invalidated on `refreshProject`. */
  getDefaultAccountId(projectId: string): string | null {
    if (this.defaultAccountByProject.has(projectId))
      return this.defaultAccountByProject.get(projectId) ?? null;
    const row = getDb()
      .prepare(
        'SELECT id FROM overlive_accounts WHERE project_id = ? AND is_default = 1 LIMIT 1'
      )
      .get(projectId) as { id: string } | undefined;
    const id = row?.id ?? null;
    this.defaultAccountByProject.set(projectId, id);
    return id;
  }

  /** Per-project one-shot warn so a misconfigured graph doesn't spam logs. */
  warnNoDefaultOnce(projectId: string): void {
    if (this.warnedNoDefault.has(projectId)) return;
    this.warnedNoDefault.add(projectId);
    console.warn(
      `[Overlive] project ${projectId} has an overlive node with no \`account\` set, and no default account is marked. Set a default in the Accounts modal or pick an explicit account on the node.`
    );
  }

  // ─── Public lifecycle ─────────────────────────────────────────────────────

  /**
   * Boot-time entry — load every project that already has accounts and
   * start their kits. Called once after the DB is initialised.
   */
  async startAll(): Promise<void> {
    const projectIds = (
      getDb()
        .prepare('SELECT DISTINCT project_id FROM overlive_accounts')
        .all() as Array<{ project_id: string }>
    ).map((r) => r.project_id);
    for (const id of projectIds) {
      try {
        await this.refreshProject(id);
      } catch (e) {
        console.error(`[Overlive] Failed to start project ${id}:`, e);
      }
    }
  }

  /**
   * Reconcile a project's kit with its current overlive_accounts rows.
   * Idempotent — call after any account row mutation.
   */
  async refreshProject(projectId: string): Promise<void> {
    // Drop the cached default and warn state so subsequent events re-query.
    this.defaultAccountByProject.delete(projectId);
    this.warnedNoDefault.delete(projectId);
    const rows = this.loadAccounts(projectId);
    if (rows.length === 0) {
      // No accounts → tear down kit if it exists.
      const entry = this.projects.get(projectId);
      if (entry) {
        await entry.kit.disconnect();
        this.projects.delete(projectId);
      }
      return;
    }
    const entry = await this.ensureProject(projectId);

    const desiredIds = new Set(rows.map((r) => r.id));

    // Remove adapters no longer present.
    for (const accId of [...entry.registered]) {
      if (!desiredIds.has(accId)) {
        try {
          await entry.kit.remove(accId);
        } catch {
          /* ignore */
        }
        entry.registered.delete(accId);
      }
    }

    // Add adapters for new rows.
    for (const row of rows) {
      if (entry.registered.has(row.id)) continue;
      try {
        const adapter = this.makeAdapter(row);
        if (!adapter) continue;
        entry.kit.use(adapter, row.id);
        entry.registered.add(row.id);
        // Best-effort connect; surface errors via state.
        adapter.connect().catch((e: unknown) => {
          console.error(`[Overlive] connect failed for ${row.label}:`, e);
        });
      } catch (e) {
        console.error(`[Overlive] Failed to register account ${row.label}:`, e);
        this.persistStatus(
          row.id,
          'error',
          'unknown',
          e instanceof Error ? e.message : String(e)
        );
      }
    }
  }

  /**
   * Revoke an account's tokens (Twitch) and remove its adapter from the kit.
   * Caller deletes the DB row afterwards via the standard REST handler.
   */
  async beforeAccountDelete(accountId: string): Promise<void> {
    const row = getDb()
      .prepare('SELECT * FROM overlive_accounts WHERE id = ?')
      .get(accountId) as unknown as AccountRow | undefined;
    if (!row) return;
    const entry = this.projects.get(row.project_id);
    if (entry?.registered.has(accountId)) {
      try {
        await entry.kit.remove(accountId);
      } catch {
        /* ignore */
      }
      entry.registered.delete(accountId);
    }
    if (row.platform === 'twitch' && row.app_credential_id) {
      const app = this.getAppCredential(row.app_credential_id);
      const creds = safeJson(row.credentials) as { accessToken?: string };
      if (app && creds.accessToken) {
        try {
          await revokeAccessToken({
            clientId: app.client_id,
            accessToken: creds.accessToken,
          });
        } catch {
          /* ignore — best effort */
        }
      }
    }
  }

  async close(): Promise<void> {
    for (const [id, entry] of this.projects) {
      try {
        await entry.kit.disconnect();
      } catch {
        /* ignore */
      }
      this.projects.delete(id);
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async ensureProject(projectId: string): Promise<ProjectEntry> {
    const existing = this.projects.get(projectId);
    if (existing) return existing;

    const kit = new OverliveKit({ debug: false });

    // Subscribe to adapter state changes → persist + broadcast over WS.
    kit.on('adapter.state', (snap: AdapterStateSnapshot) => {
      // The kit's instanceId is the account row id (we register it that way).
      const accountId = snap.instanceId;
      const status =
        snap.state === 'connected'
          ? 'connected'
          : snap.state === 'connecting'
            ? 'connecting'
            : snap.state === 'reconnecting'
              ? 'reconnecting'
              : snap.state === 'error'
                ? snap.reason === 'token_revoked' ||
                  snap.reason === 'scope_missing'
                  ? 'needs_reauth'
                  : 'error'
                : 'disconnected';
      this.persistStatus(
        accountId,
        status,
        snap.reason ?? null,
        snap.message ?? null
      );
    });

    // Subscribe to every event type so the manager can route them into
    // project graphs. Wildcard subscription via onAny.
    kit.onAny((event) => {
      this.routeEvent(
        projectId,
        event as AdapterEmittedEvent & { sourceInstanceId: string }
      );
    });

    const entry: ProjectEntry = { kit, registered: new Set() };
    this.projects.set(projectId, entry);
    return entry;
  }

  private makeAdapter(row: AccountRow): TwitchAdapter | SEAdapter | null {
    const creds = safeJson(row.credentials);
    if (row.platform === 'twitch') {
      if (!row.app_credential_id) return null;
      const app = this.getAppCredential(row.app_credential_id);
      if (!app) return null;
      if (!row.broadcaster_id) return null;
      const accessToken = String(creds['accessToken'] ?? '');
      const refreshToken = String(creds['refreshToken'] ?? '');
      if (!accessToken || !refreshToken) return null;
      return new TwitchAdapter({
        clientId: app.client_id,
        accessToken,
        broadcasterId: row.broadcaster_id,
        clientSecret: app.client_secret,
        refreshToken,
        onTokenRefreshed: async (tokens) => {
          this.persistRefreshedTokens(row.id, tokens);
        },
      });
    }
    if (row.platform === 'streamelements') {
      const jwt = String(creds['jwt'] ?? '');
      const channelId = String(creds['channelId'] ?? '');
      if (!jwt || !channelId) return null;
      return new SEAdapter({ jwt, channelId });
    }
    return null;
  }

  private routeEvent(
    projectId: string,
    event: AdapterEmittedEvent & { sourceInstanceId: string }
  ): void {
    // Walk every running project graph and find overlive_* nodes whose
    // accountId matches the source. Per-node filters (channel, kind-specific)
    // are evaluated inside the node's execute() — here we just deliver into
    // the `event` input port.
    // Chat messages also accumulate into the durable ring-buffer that feeds
    // overlive_chat_feed nodes — independent of whether any plain
    // overlive_chat_message node exists.
    if (event.type === 'chat.message') {
      this.pushChatAndNotifyFeed(
        projectId,
        event as ChatMessageEvent & { sourceInstanceId: string }
      );
    }

    const expectedKind = OVERLIVE_KIND_BY_EVENT[event.type];
    if (!expectedKind) return;
    let delivered = 0;
    let candidates = 0;
    for (const {
      graphId,
      node,
      projectId: gpId,
    } of logicManager.iterateNodes()) {
      if (gpId !== projectId) continue;
      if (node.kind !== expectedKind) continue;
      candidates++;
      const cfg = (node.defaultConfig ?? {}) as Record<string, unknown>;
      if (!this.nodeAcceptsEvent(projectId, cfg, event)) continue;
      // Fire as an event on the node's `event` input port. The node helpers
      // unwrap `inputs.event.payload`, so wrap the overlive event in the
      // engine's Event envelope rather than passing it raw.
      logicManager.fire(graphId, node.id, 'event', mkEvent(event));
      delivered++;
    }
    if (candidates > 0 && delivered === 0) {
      console.log(
        `[Overlive] ${event.type} matched ${candidates} ${expectedKind} node(s) but none accepted (account/channel filters). source=${event.sourceInstanceId} channel=${event.channel}`
      );
    }
  }

  /**
   * Resolve a node's `account` / `channel` config against an incoming event.
   * The node's "account" config is the inline literal stored in defaultConfig
   * (events arrive externally, so the node doesn't get to pull its inputs
   * first). Empty config or an unresolved `__preset:*` placeholder both fall
   * back to the project's default account; with no default we warn once and
   * reject rather than fanning out to every account.
   */
  private nodeAcceptsEvent(
    projectId: string,
    cfg: Record<string, unknown>,
    event: AdapterEmittedEvent & { sourceInstanceId: string }
  ): boolean {
    const rawAccount = typeof cfg['account'] === 'string' ? cfg['account'] : '';
    const isUnresolved =
      rawAccount === '' || rawAccount.startsWith('__preset:');
    const wantAccount = isUnresolved
      ? this.getDefaultAccountId(projectId)
      : rawAccount;
    if (!wantAccount) {
      this.warnNoDefaultOnce(projectId);
      return false;
    }
    if (wantAccount !== event.sourceInstanceId) return false;
    const wantChannel =
      typeof cfg['channel'] === 'string'
        ? cfg['channel'].trim().toLowerCase()
        : '';
    if (wantChannel && wantChannel !== event.channel) return false;
    return true;
  }

  /**
   * Append a chat message to the per-account ring-buffer, then notify every
   * matching `overlive_chat_feed` node with the current buffer snapshot (newest
   * last). Channel filtering on the feed node restricts the delivered slice.
   */
  private pushChatAndNotifyFeed(
    projectId: string,
    event: ChatMessageEvent & { sourceInstanceId: string }
  ): void {
    const accountId = event.sourceInstanceId;
    const item: ChatFeedItem = {
      id: event.data.messageId,
      channel: event.channel,
      timestamp:
        event.timestamp instanceof Date
          ? event.timestamp.getTime()
          : Date.now(),
      username: event.data.username,
      displayName: event.data.displayName,
      text: event.data.text,
      html: tokensToHtml(event.data.tokens ?? [], event.data.text),
      color: event.data.color ?? '',
      isMod: event.data.isMod,
      isSub: event.data.isSub,
      isBroadcaster: event.data.isBroadcaster,
      isAction: event.data.isAction,
      isHighlighted: event.data.isHighlighted,
      cheerAmount: event.data.cheerAmount ?? 0,
    };
    let buf = this.chatBuffers.get(accountId);
    if (!buf) {
      buf = [];
      this.chatBuffers.set(accountId, buf);
    }
    buf.push(item);
    if (buf.length > CHAT_BUFFER_MAX)
      buf.splice(0, buf.length - CHAT_BUFFER_MAX);

    for (const {
      graphId,
      node,
      projectId: gpId,
    } of logicManager.iterateNodes()) {
      if (gpId !== projectId) continue;
      if (node.kind !== 'overlive_chat_feed') continue;
      const cfg = (node.defaultConfig ?? {}) as Record<string, unknown>;
      if (!this.nodeAcceptsEvent(projectId, cfg, event)) continue;
      // Deliver the buffer slice this node cares about. An empty channel filter
      // means "all channels for this account"; otherwise restrict to the match.
      const wantChannel =
        typeof cfg['channel'] === 'string'
          ? cfg['channel'].trim().toLowerCase()
          : '';
      const slice = wantChannel
        ? buf.filter((m) => m.channel === wantChannel)
        : buf.slice();
      logicManager.fire(graphId, node.id, 'event', mkEvent(slice));
    }
  }

  private persistStatus(
    accountId: string,
    status: string,
    reason: string | null,
    message: string | null
  ): void {
    try {
      getDb()
        .prepare(
          `UPDATE overlive_accounts SET
           status         = ?,
           status_reason  = ?,
           status_message = ?,
           updated_at     = datetime('now')
         WHERE id = ?`
        )
        .run(status, reason, message, accountId);
      this.ws?.broadcast('overlive_account_status', {
        accountId,
        status,
        reason,
        message,
      });
    } catch (e) {
      console.error(`[Overlive] Failed to persist status for ${accountId}:`, e);
    }
  }

  private persistRefreshedTokens(
    accountId: string,
    tokens: { accessToken: string; refreshToken: string; expiresIn: number }
  ): void {
    try {
      const row = getDb()
        .prepare('SELECT credentials FROM overlive_accounts WHERE id = ?')
        .get(accountId) as { credentials: string } | undefined;
      if (!row) return;
      const creds = safeJson(row.credentials);
      creds['accessToken'] = tokens.accessToken;
      creds['refreshToken'] = tokens.refreshToken;
      creds['expiresAt'] = Date.now() + tokens.expiresIn * 1000;
      getDb()
        .prepare(
          "UPDATE overlive_accounts SET credentials = ?, updated_at = datetime('now') WHERE id = ?"
        )
        .run(JSON.stringify(creds), accountId);
    } catch (e) {
      console.error(
        `[Overlive] Failed to persist refreshed tokens for ${accountId}:`,
        e
      );
    }
  }

  // ─── DB helpers ────────────────────────────────────────────────────────────

  private loadAccounts(projectId: string): AccountRow[] {
    return getDb()
      .prepare('SELECT * FROM overlive_accounts WHERE project_id = ?')
      .all(projectId) as unknown as AccountRow[];
  }

  private getAppCredential(id: string): AppCredentialRow | undefined {
    return getDb()
      .prepare(
        'SELECT id, project_id, client_id, client_secret, redirect_uri FROM overlive_app_credentials WHERE id = ?'
      )
      .get(id) as unknown as AppCredentialRow | undefined;
  }
}

// Event-type → node-kind table. Keep in sync with Phase H node implementations.
const OVERLIVE_KIND_BY_EVENT: Record<string, string> = {
  redemption: 'overlive_redemption',
  subscription: 'overlive_subscription',
  gift_bomb: 'overlive_gift_bomb',
  raid: 'overlive_raid',
  follow: 'overlive_follow',
  'chat.message': 'overlive_chat_message',
  'chat.command': 'overlive_chat_command',
  'chat.delete': 'overlive_chat_delete',
  'ad.start': 'overlive_ad_start',
  'ad.end': 'overlive_ad_end',
  ban: 'overlive_ban',
  'stream.online': 'overlive_stream_online',
  'stream.offline': 'overlive_stream_offline',
};

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Singleton wired in src/index.ts.
let _instance: OverliveManager | null = null;
export function initOverliveManager(ws?: WSSync): OverliveManager {
  if (_instance) return _instance;
  _instance = new OverliveManager(ws);
  return _instance;
}
export function getOverliveManager(): OverliveManager {
  if (!_instance) throw new Error('OverliveManager not initialised');
  return _instance;
}
