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
 *    ProjectGraph and firing the event into any overlive_<eventType> node
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
import { OverliveKit, type AdapterStateSnapshot } from '@overlive/core'
import { TwitchAdapter } from '@overlive/twitch'
import { SEAdapter } from '@overlive/se'
import { revokeAccessToken } from '@overlive/twitch-oauth'
import type { AdapterEmittedEvent } from '@overlive/core'
import { getDb } from '../db/index.js'
import { projectGraphManager } from '../project_graphs/manager.js'
import type { WSSync } from '../ws/index.js'

// ─── Row shapes (mirror the routes/overlive-accounts.ts types) ────────────────

interface AccountRow {
  id:                  string
  project_id:          string
  platform:            string
  label:               string
  app_credential_id:   string | null
  credentials:         string
  broadcaster_id:      string | null
  broadcaster_login:   string | null
  status:              string
  status_reason:       string | null
  status_message:      string | null
}

interface AppCredentialRow {
  id:            string
  project_id:    string
  client_id:     string
  client_secret: string
  redirect_uri:  string
}

// ─── Manager ──────────────────────────────────────────────────────────────────

interface ProjectEntry {
  kit: OverliveKit
  /** Set of account ids currently registered as adapter instances on the kit. */
  registered: Set<string>
}

export class OverliveManager {
  private readonly projects = new Map<string, ProjectEntry>()

  constructor(private readonly ws?: WSSync) {}

  // ─── Public lifecycle ─────────────────────────────────────────────────────

  /**
   * Boot-time entry — load every project that already has accounts and
   * start their kits. Called once after the DB is initialised.
   */
  async startAll(): Promise<void> {
    const projectIds = (getDb()
      .prepare('SELECT DISTINCT project_id FROM overlive_accounts')
      .all() as Array<{ project_id: string }>).map((r) => r.project_id)
    for (const id of projectIds) {
      try { await this.ensureProject(id) } catch (e) {
        console.error(`[Overlive] Failed to start project ${id}:`, e)
      }
    }
  }

  /**
   * Reconcile a project's kit with its current overlive_accounts rows.
   * Idempotent — call after any account row mutation.
   */
  async refreshProject(projectId: string): Promise<void> {
    const rows = this.loadAccounts(projectId)
    if (rows.length === 0) {
      // No accounts → tear down kit if it exists.
      const entry = this.projects.get(projectId)
      if (entry) {
        await entry.kit.disconnect()
        this.projects.delete(projectId)
      }
      return
    }
    const entry = await this.ensureProject(projectId)

    const desiredIds = new Set(rows.map((r) => r.id))

    // Remove adapters no longer present.
    for (const accId of [...entry.registered]) {
      if (!desiredIds.has(accId)) {
        try { await entry.kit.remove(accId) } catch { /* ignore */ }
        entry.registered.delete(accId)
      }
    }

    // Add adapters for new rows.
    for (const row of rows) {
      if (entry.registered.has(row.id)) continue
      try {
        const adapter = this.makeAdapter(row)
        if (!adapter) continue
        entry.kit.use(adapter, row.id)
        entry.registered.add(row.id)
        // Best-effort connect; surface errors via state.
        adapter.connect().catch((e: unknown) => {
          console.error(`[Overlive] connect failed for ${row.label}:`, e)
        })
      } catch (e) {
        console.error(`[Overlive] Failed to register account ${row.label}:`, e)
        this.persistStatus(row.id, 'error', 'unknown', e instanceof Error ? e.message : String(e))
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
      .get(accountId) as unknown as AccountRow | undefined
    if (!row) return
    const entry = this.projects.get(row.project_id)
    if (entry?.registered.has(accountId)) {
      try { await entry.kit.remove(accountId) } catch { /* ignore */ }
      entry.registered.delete(accountId)
    }
    if (row.platform === 'twitch' && row.app_credential_id) {
      const app = this.getAppCredential(row.app_credential_id)
      const creds = safeJson(row.credentials) as { accessToken?: string }
      if (app && creds.accessToken) {
        try {
          await revokeAccessToken({ clientId: app.client_id, accessToken: creds.accessToken })
        } catch { /* ignore — best effort */ }
      }
    }
  }

  async close(): Promise<void> {
    for (const [id, entry] of this.projects) {
      try { await entry.kit.disconnect() } catch { /* ignore */ }
      this.projects.delete(id)
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async ensureProject(projectId: string): Promise<ProjectEntry> {
    const existing = this.projects.get(projectId)
    if (existing) return existing

    const kit = new OverliveKit({ debug: false })

    // Subscribe to adapter state changes → persist + broadcast over WS.
    kit.on('adapter.state', (snap: AdapterStateSnapshot) => {
      // The kit's instanceId is the account row id (we register it that way).
      const accountId = snap.instanceId
      const status = snap.state === 'connected' ? 'connected'
        : snap.state === 'connecting' ? 'connecting'
        : snap.state === 'reconnecting' ? 'reconnecting'
        : snap.state === 'error' ? (snap.reason === 'token_revoked' || snap.reason === 'scope_missing'
            ? 'needs_reauth' : 'error')
        : 'disconnected'
      this.persistStatus(accountId, status, snap.reason ?? null, snap.message ?? null)
    })

    // Subscribe to every event type so the manager can route them into
    // project graphs. Wildcard subscription via onAny.
    kit.onAny((event) => {
      this.routeEvent(projectId, event as AdapterEmittedEvent & { sourceInstanceId: string })
    })

    const entry: ProjectEntry = { kit, registered: new Set() }
    this.projects.set(projectId, entry)
    return entry
  }

  private makeAdapter(row: AccountRow): TwitchAdapter | SEAdapter | null {
    const creds = safeJson(row.credentials)
    if (row.platform === 'twitch') {
      if (!row.app_credential_id) return null
      const app = this.getAppCredential(row.app_credential_id)
      if (!app) return null
      if (!row.broadcaster_id) return null
      const accessToken  = String(creds['accessToken']  ?? '')
      const refreshToken = String(creds['refreshToken'] ?? '')
      if (!accessToken || !refreshToken) return null
      return new TwitchAdapter({
        clientId:      app.client_id,
        accessToken,
        broadcasterId: row.broadcaster_id,
        clientSecret:  app.client_secret,
        refreshToken,
        onTokenRefreshed: async (tokens) => {
          this.persistRefreshedTokens(row.id, tokens)
        },
      })
    }
    if (row.platform === 'streamelements') {
      const jwt       = String(creds['jwt']       ?? '')
      const channelId = String(creds['channelId'] ?? '')
      if (!jwt || !channelId) return null
      return new SEAdapter({ jwt, channelId })
    }
    return null
  }

  private routeEvent(projectId: string, event: AdapterEmittedEvent & { sourceInstanceId: string }): void {
    // Walk every running project graph and find overlive_* nodes whose
    // accountId matches the source. Per-node filters (channel, kind-specific)
    // are evaluated inside the node's execute() — here we just deliver into
    // the `event` input port.
    const expectedKind = OVERLIVE_KIND_BY_EVENT[event.type]
    if (!expectedKind) return
    let delivered = 0
    let candidates = 0
    for (const { graphId, node, projectId: gpId } of projectGraphManager.iterateNodes()) {
      if (gpId !== projectId) continue
      if (node.kind !== expectedKind) continue
      candidates++
      // The node's "account" config (inline literal stored in defaultConfig
      // when unconnected, or carried via a connected Account value source —
      // but in pull-based execution the engine would resolve it). We use the
      // inline literal directly since events arrive externally and the node
      // doesn't get a chance to pull its inputs first.
      const cfg = (node.defaultConfig ?? {}) as Record<string, unknown>
      const wantAccount = typeof cfg['account'] === 'string' ? cfg['account'] : ''
      if (wantAccount && wantAccount !== event.sourceInstanceId) continue
      const wantChannel = typeof cfg['channel'] === 'string' ? cfg['channel'].trim().toLowerCase() : ''
      if (wantChannel && wantChannel !== event.channel) continue
      // Fire as an event on the node's `event` input port.
      projectGraphManager.fire(graphId, node.id, 'event', event)
      delivered++
    }
    if (candidates > 0 && delivered === 0) {
      console.log(`[Overlive] ${event.type} matched ${candidates} ${expectedKind} node(s) but none accepted (account/channel filters). source=${event.sourceInstanceId} channel=${event.channel}`)
    }
  }

  private persistStatus(
    accountId: string,
    status: string,
    reason: string | null,
    message: string | null,
  ): void {
    try {
      getDb().prepare(
        `UPDATE overlive_accounts SET
           status         = ?,
           status_reason  = ?,
           status_message = ?,
           updated_at     = datetime('now')
         WHERE id = ?`,
      ).run(status, reason, message, accountId)
      this.ws?.broadcast('overlive_account_status', {
        accountId,
        status,
        reason,
        message,
      })
    } catch (e) {
      console.error(`[Overlive] Failed to persist status for ${accountId}:`, e)
    }
  }

  private persistRefreshedTokens(
    accountId: string,
    tokens: { accessToken: string; refreshToken: string; expiresIn: number },
  ): void {
    try {
      const row = getDb().prepare('SELECT credentials FROM overlive_accounts WHERE id = ?').get(accountId) as { credentials: string } | undefined
      if (!row) return
      const creds = safeJson(row.credentials)
      creds['accessToken']  = tokens.accessToken
      creds['refreshToken'] = tokens.refreshToken
      creds['expiresAt']    = Date.now() + tokens.expiresIn * 1000
      getDb().prepare('UPDATE overlive_accounts SET credentials = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(creds), accountId)
    } catch (e) {
      console.error(`[Overlive] Failed to persist refreshed tokens for ${accountId}:`, e)
    }
  }

  // ─── DB helpers ────────────────────────────────────────────────────────────

  private loadAccounts(projectId: string): AccountRow[] {
    return getDb().prepare(
      'SELECT * FROM overlive_accounts WHERE project_id = ?',
    ).all(projectId) as unknown as AccountRow[]
  }

  private getAppCredential(id: string): AppCredentialRow | undefined {
    return getDb().prepare(
      'SELECT id, project_id, client_id, client_secret, redirect_uri FROM overlive_app_credentials WHERE id = ?',
    ).get(id) as unknown as AppCredentialRow | undefined
  }
}

// Event-type → node-kind table. Keep in sync with Phase H node implementations.
const OVERLIVE_KIND_BY_EVENT: Record<string, string> = {
  'redemption':     'overlive_redemption',
  'subscription':   'overlive_subscription',
  'gift_bomb':      'overlive_gift_bomb',
  'raid':           'overlive_raid',
  'follow':         'overlive_follow',
  'chat.message':   'overlive_chat_message',
  'chat.command':   'overlive_chat_command',
  'chat.delete':    'overlive_chat_delete',
  'ad.start':       'overlive_ad_start',
  'ad.end':         'overlive_ad_end',
  'ban':            'overlive_ban',
  'stream.online':  'overlive_stream_online',
  'stream.offline': 'overlive_stream_offline',
}

function safeJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw || '{}') as Record<string, unknown> } catch { return {} }
}

// Singleton wired in src/index.ts.
let _instance: OverliveManager | null = null
export function initOverliveManager(ws?: WSSync): OverliveManager {
  if (_instance) return _instance
  _instance = new OverliveManager(ws)
  return _instance
}
export function getOverliveManager(): OverliveManager {
  if (!_instance) throw new Error('OverliveManager not initialised')
  return _instance
}
