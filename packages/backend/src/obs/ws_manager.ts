/**
 * ObsWsManager — the OBS "power tier": one backend-held obs-websocket
 * connection per project, unlocking control the browser-source bridge
 * ([manager.ts]) can't reach (audio volume/mute, replay path, source/scene
 * control). Modeled on OverliveManager: per-project connection lifecycle, a
 * status state machine persisted + broadcast over WS, inbound event fan-out
 * into project logic graphs, and outbound request methods the obs-websocket
 * action nodes call.
 *
 * vspark is self-hosted, so the backend is co-located with OBS and reaches
 * `ws://localhost:4455` directly. See dev-notes/plans/obs-websocket-tier.md.
 */
import { mkEvent } from '@vspark/shared/signal';
import type { ObsConnectionStatus } from '@vspark/shared';
import { getDb } from '../db/index.js';
import { logicManager } from '../logic/manager.js';
import { ObsWsClient, type ObsWsClientOptions } from './ws_client.js';
import type { WSSync } from '../ws/index.js';

interface ObsConnectionRow {
  id: string;
  project_id: string;
  label: string;
  host: string;
  port: number;
  password: string;
  enabled: 0 | 1;
}

interface Conn {
  id: string;
  projectId: string;
  client: ObsWsClient;
  status: ObsConnectionStatus;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

/** Delay before retrying a dropped connection (fixed; OBS is local). */
const RECONNECT_MS = 5_000;

/** Injectable so tests can supply a fake client without a real socket. */
export type ObsWsClientFactory = (opts: ObsWsClientOptions) => ObsWsClient;

export class ObsWsManager {
  private readonly _ws: WSSync | null;
  private readonly _makeClient: ObsWsClientFactory;
  private readonly _byProject = new Map<string, Conn>();

  constructor(ws?: WSSync, clientFactory?: ObsWsClientFactory) {
    this._ws = ws ?? null;
    this._makeClient = clientFactory ?? ((opts) => new ObsWsClient(opts));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /** Boot entry — connect every project that has an enabled connection row. */
  startAll(): void {
    const rows = getDb()
      .prepare(
        'SELECT DISTINCT project_id FROM obs_connections WHERE enabled = 1'
      )
      .all() as Array<{ project_id: string }>;
    for (const { project_id } of rows) this.refreshProject(project_id);
  }

  /** Reconcile a project's connection with its (single) enabled row: reconnect
   *  on config change, tear down when disabled/removed. Called after CRUD. */
  refreshProject(projectId: string): void {
    const row = this._loadRow(projectId);
    this._teardown(projectId);
    if (row) this._connect(row);
  }

  close(): void {
    for (const projectId of [...this._byProject.keys()])
      this._teardown(projectId);
  }

  private _loadRow(projectId: string): ObsConnectionRow | null {
    return (
      (getDb()
        .prepare(
          'SELECT * FROM obs_connections WHERE project_id = ? AND enabled = 1 ORDER BY created_at LIMIT 1'
        )
        .get(projectId) as ObsConnectionRow | undefined) ?? null
    );
  }

  private _connect(row: ObsConnectionRow): void {
    const client = this._makeClient({
      host: row.host,
      port: row.port,
      password: row.password,
    });
    const conn: Conn = {
      id: row.id,
      projectId: row.project_id,
      client,
      status: 'connecting',
      reconnectTimer: null,
    };
    this._byProject.set(row.project_id, conn);
    this._setStatus(conn, 'connecting');

    client.on('identified', () => this._setStatus(conn, 'connected'));
    client.on('obsEvent', (type: string, data: Record<string, unknown>) =>
      this._onObsEvent(conn.projectId, type, data)
    );
    client.on('error', (err: Error) =>
      this._setStatus(conn, 'error', 'connect_error', err.message)
    );
    client.on('close', () => {
      // Only act if this conn is still the active one for the project.
      if (this._byProject.get(conn.projectId) !== conn) return;
      this._setStatus(conn, 'reconnecting', 'closed');
      this._scheduleReconnect(conn.projectId);
    });

    client.connect();
  }

  private _scheduleReconnect(projectId: string): void {
    const conn = this._byProject.get(projectId);
    if (!conn) return;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = setTimeout(() => {
      // Re-read config in case it changed while we were down.
      this.refreshProject(projectId);
    }, RECONNECT_MS);
  }

  private _teardown(projectId: string): void {
    const conn = this._byProject.get(projectId);
    if (!conn) return;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.client.removeAllListeners();
    conn.client.close();
    this._byProject.delete(projectId);
  }

  // ── status ──────────────────────────────────────────────────────────────────

  private _setStatus(
    conn: Conn,
    status: ObsConnectionStatus,
    reason?: string,
    message?: string
  ): void {
    const prev = conn.status;
    conn.status = status;
    try {
      getDb()
        .prepare(
          "UPDATE obs_connections SET status = ?, status_reason = ?, status_message = ?, updated_at = datetime('now') WHERE id = ?"
        )
        .run(status, reason ?? null, message ?? null, conn.id);
    } catch {
      /* row may have been deleted mid-flight */
    }
    this._ws?.broadcast('obs_connection_status', {
      connectionId: conn.id,
      projectId: conn.projectId,
      status,
      reason: reason ?? null,
      message: message ?? null,
    });
    // Drive obs_connection_state nodes on the connected/disconnected edges.
    const wasUp = prev === 'connected';
    const isUp = status === 'connected';
    if (isUp && !wasUp)
      this._deliver(conn.projectId, 'obs_connection_state', {
        connected: true,
      });
    else if (!isUp && wasUp)
      this._deliver(conn.projectId, 'obs_connection_state', {
        connected: false,
      });
  }

  // ── inbound events ───────────────────────────────────────────────────────────

  private _onObsEvent(
    projectId: string,
    eventType: string,
    data: Record<string, unknown>
  ): void {
    if (eventType === 'InputVolumeChanged') {
      this._deliver(projectId, 'obs_volume_changed', {
        input: data.inputName,
        mul: data.inputVolumeMul,
        db: data.inputVolumeDb,
      });
    } else if (eventType === 'InputMuteStateChanged') {
      this._deliver(projectId, 'obs_mute_changed', {
        input: data.inputName,
        muted: data.inputMuted,
      });
    }
  }

  /** Fan a payload into every running node of `kind` in the project's graphs. */
  private _deliver(projectId: string, kind: string, payload: unknown): void {
    for (const {
      graphId,
      node,
      projectId: gpId,
    } of logicManager.iterateNodes()) {
      if (gpId !== projectId) continue;
      if (node.kind !== kind) continue;
      logicManager.fire(graphId, node.id, 'event', mkEvent(payload));
    }
  }

  // ── outbound (called by obs-websocket action nodes) ──────────────────────────

  /** True when the project's connection is up and identified. */
  isConnected(projectId: string): boolean {
    const conn = this._byProject.get(projectId);
    return !!conn && conn.client.identified;
  }

  private _client(projectId: string): ObsWsClient | null {
    const conn = this._byProject.get(projectId);
    return conn && conn.client.identified ? conn.client : null;
  }

  /**
   * Resolve the client for an action node, logging *why* when it can't act.
   *
   * These actions are fire-and-forget by design, but silence made a failed
   * action indistinguishable from a working one: a wrong input name, a project
   * with no OBS connection, and a dropped socket all produced exactly nothing.
   * Every early return now says which case it hit, once per occurrence.
   */
  private _clientFor(
    projectId: string,
    inputName: string,
    what: string
  ): ObsWsClient | null {
    if (!projectId) {
      console.warn(`[obs-ws] ${what}: no projectId on the node config`);
      return null;
    }
    if (!inputName) {
      console.warn(`[obs-ws] ${what}: no input name (wire \`input\` or set config.inputName)`);
      return null;
    }
    const conn = this._byProject.get(projectId);
    if (!conn) {
      console.warn(`[obs-ws] ${what}: project ${projectId} has no OBS connection`);
      return null;
    }
    if (!conn.client.identified) {
      console.warn(`[obs-ws] ${what}: OBS connection not identified (status=${conn.status})`);
      return null;
    }
    return conn.client;
  }

  /** Log a rejected obs-websocket request rather than dropping it. */
  private _report(what: string, req: Promise<unknown>): void {
    void req.catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[obs-ws] ${what} failed: ${msg}`);
    });
  }

  /** Set an input's volume by dB or linear multiplier (fire-and-forget). */
  setVolume(
    projectId: string,
    inputName: string,
    value: { db?: number; mul?: number }
  ): void {
    const client = this._clientFor(projectId, inputName, 'SetInputVolume');
    if (!client) return;
    const data: Record<string, unknown> = { inputName };
    if (typeof value.mul === 'number') data.inputVolumeMul = value.mul;
    else if (typeof value.db === 'number') data.inputVolumeDb = value.db;
    else {
      console.warn('[obs-ws] SetInputVolume: neither `db` nor `mul` was provided');
      return;
    }
    this._report(`SetInputVolume(${inputName})`, client.request('SetInputVolume', data));
  }

  /** Mute / unmute / toggle an input (fire-and-forget). */
  setMute(
    projectId: string,
    inputName: string,
    action: 'mute' | 'unmute' | 'toggle'
  ): void {
    const client = this._clientFor(projectId, inputName, 'SetInputMute');
    if (!client) return;
    const req =
      action === 'toggle'
        ? client.request('ToggleInputMute', { inputName })
        : client.request('SetInputMute', {
            inputName,
            inputMuted: action === 'mute',
          });
    this._report(`SetInputMute(${inputName}, ${action})`, req);
  }

  /** Resolve the last saved replay-buffer file path, or '' if unavailable. */
  async getLastReplayPath(projectId: string): Promise<string> {
    const client = this._client(projectId);
    if (!client) return '';
    try {
      const res = await client.request('GetLastReplayBufferReplay');
      return typeof res.savedReplayPath === 'string' ? res.savedReplayPath : '';
    } catch {
      return '';
    }
  }

  /** List OBS inputs (for the node-editor picker). Empty when disconnected. */
  async listInputs(
    projectId: string
  ): Promise<Array<{ name: string; kind: string }>> {
    const client = this._client(projectId);
    if (!client) return [];
    try {
      const res = await client.request('GetInputList');
      const inputs = (res.inputs as Array<Record<string, unknown>>) ?? [];
      return inputs.map((i) => ({
        name: String(i.inputName ?? ''),
        kind: String(i.inputKind ?? ''),
      }));
    } catch {
      return [];
    }
  }
}

// Singleton — wired in src/index.ts.
let _instance: ObsWsManager | null = null;
export function initObsWsManager(
  ws?: WSSync,
  clientFactory?: ObsWsClientFactory
): ObsWsManager {
  if (_instance) return _instance;
  _instance = new ObsWsManager(ws, clientFactory);
  return _instance;
}
export function getObsWsManager(): ObsWsManager {
  if (!_instance) throw new Error('ObsWsManager not initialised');
  return _instance;
}
