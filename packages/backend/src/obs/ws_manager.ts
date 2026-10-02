/**
 * ObsWsManager — the whole OBS integration: one backend-held obs-websocket
 * connection per project, carrying every OBS source and action node (scene,
 * transition, output control, audio volume/mute, replay path). Modeled on
 * OverliveManager: per-project connection lifecycle, a status state machine
 * persisted + broadcast over WS, inbound event fan-out into project logic
 * graphs, and outbound request methods the action nodes call.
 *
 * It started as a "power tier" beside the `window.obsstudio` browser-source
 * bridge, for control that API couldn't reach. The bridge is gone: OBS gates
 * its control calls behind the source's page permission level and silently
 * ignores anything above it, so actions failed with no error anywhere.
 * obs-websocket has no such gate and returns a status per request — which is
 * why every action here reports why it couldn't act.
 *
 * vspark is self-hosted, so the backend is co-located with OBS and reaches
 * `ws://localhost:4455` directly. See dev-notes/modules/obs.md.
 */
import { mkEvent } from '@vspark/shared/signal';
import type {
  ObsConnectionStatus,
  ObsEvent,
  ObsOutputKind,
  ObsOutputState,
} from '@vspark/shared';
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
  /** OBS base canvas size, read once per connection (see `_loadCanvasSize`). */
  canvas: { width: number; height: number };
}

/** Delay before retrying a dropped connection (fixed; OBS is local). */
const RECONNECT_MS = 5_000;

/**
 * Arg-less control verbs → their obs-websocket request name.
 *
 * The verb keys are the historical `window.obsstudio` method names, kept
 * verbatim so existing `obs_control` node configs (`config.action`) keep
 * working after the transport moved off the browser bridge.
 */
const CONTROL_REQUESTS = {
  startStreaming: 'StartStream',
  stopStreaming: 'StopStream',
  startRecording: 'StartRecord',
  stopRecording: 'StopRecord',
  pauseRecording: 'PauseRecord',
  unpauseRecording: 'ResumeRecord',
  startReplayBuffer: 'StartReplayBuffer',
  stopReplayBuffer: 'StopReplayBuffer',
  saveReplayBuffer: 'SaveReplayBuffer',
  startVirtualcam: 'StartVirtualCam',
  stopVirtualcam: 'StopVirtualCam',
} as const;

/** The verbs `obs_control` can issue. */
export type ObsControlVerb = keyof typeof CONTROL_REQUESTS;

/** Output run-state event → which OBS output it describes. */
const OUTPUT_BY_EVENT: Record<string, ObsOutputKind> = {
  StreamStateChanged: 'streaming',
  RecordStateChanged: 'recording',
  ReplayBufferStateChanged: 'replay',
  ReplayBufferSaved: 'replay',
  VirtualcamStateChanged: 'virtualcam',
};

/**
 * obs-websocket `outputState` enum → the folded `output_state` vocabulary the
 * `obs_output_state` node has always emitted. Deliberately partial: OBS's
 * reconnecting / reconnected / unknown states have no equivalent in that
 * vocabulary and had none on the browser bridge either, so they are dropped.
 */
const OUTPUT_STATE_BY_OBS: Record<string, ObsOutputState | undefined> = {
  OBS_WEBSOCKET_OUTPUT_STARTING: 'starting',
  OBS_WEBSOCKET_OUTPUT_STARTED: 'started',
  OBS_WEBSOCKET_OUTPUT_STOPPING: 'stopping',
  OBS_WEBSOCKET_OUTPUT_STOPPED: 'stopped',
  OBS_WEBSOCKET_OUTPUT_PAUSED: 'paused',
  OBS_WEBSOCKET_OUTPUT_RESUMED: 'unpaused',
};

export function isObsControlVerb(v: string): v is ObsControlVerb {
  return v in CONTROL_REQUESTS;
}

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
      canvas: { width: 0, height: 0 },
    };
    this._byProject.set(row.project_id, conn);
    this._setStatus(conn, 'connecting');

    client.on('identified', () => {
      this._setStatus(conn, 'connected');
      void this._loadCanvasSize(conn);
    });
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
      return;
    }
    if (eventType === 'InputMuteStateChanged') {
      this._deliver(projectId, 'obs_mute_changed', {
        input: data.inputName,
        muted: data.inputMuted,
      });
      return;
    }
    if (eventType === 'CurrentProgramSceneChanged') {
      const conn = this._byProject.get(projectId);
      this._deliver(projectId, 'obs_scene_changed', {
        type: 'scene_changed',
        name: String(data.sceneName ?? ''),
        width: conn?.canvas.width ?? 0,
        height: conn?.canvas.height ?? 0,
      } satisfies Extract<ObsEvent, { type: 'scene_changed' }>);
      return;
    }
    const output = OUTPUT_BY_EVENT[eventType];
    if (output) this._onOutputEvent(projectId, output, eventType, data);
  }

  /** Translate an output run-state event into the folded `output_state` shape
   *  the `obs_output_state` node has always consumed. */
  private _onOutputEvent(
    projectId: string,
    output: ObsOutputKind,
    eventType: string,
    data: Record<string, unknown>
  ): void {
    // ReplayBufferSaved is its own event, not a run-state transition.
    if (eventType === 'ReplayBufferSaved') {
      this._deliver(projectId, 'obs_output_state', {
        type: 'output_state',
        output,
        state: 'saved',
        active: true,
      } satisfies Extract<ObsEvent, { type: 'output_state' }>);
      return;
    }
    const state = OUTPUT_STATE_BY_OBS[String(data.outputState ?? '')];
    // Reconnecting / reconnected / unknown have no slot in the node's state
    // vocabulary and never existed on the browser bridge — drop them rather
    // than widen the payload shape graphs are matching on.
    if (!state) return;
    this._deliver(projectId, 'obs_output_state', {
      type: 'output_state',
      output,
      state,
      active: data.outputActive === true,
    } satisfies Extract<ObsEvent, { type: 'output_state' }>);
  }

  /** Read OBS's base canvas size once per connection, so `obs_scene_changed`
   *  can keep reporting the width/height the browser event used to carry.
   *  obs-websocket has no canvas-resize event, hence connect-time only. */
  private async _loadCanvasSize(conn: Conn): Promise<void> {
    try {
      const res = await conn.client.request('GetVideoSettings');
      conn.canvas = {
        width: Number(res.baseWidth ?? 0),
        height: Number(res.baseHeight ?? 0),
      };
    } catch {
      /* leave the canvas at 0×0; the scene name is the useful part */
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
  private _clientFor(projectId: string, what: string): ObsWsClient | null {
    if (!projectId) {
      console.warn(`[obs-ws] ${what}: no projectId on the node config`);
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

  /** Require a name argument, saying where to supply it when it's missing. */
  private _requireName(
    name: string | undefined,
    what: string,
    hint: string
  ): string | null {
    const trimmed = (name ?? '').trim();
    if (trimmed) return trimmed;
    console.warn(`[obs-ws] ${what}: no name given (${hint})`);
    return null;
  }

  /** Log a rejected obs-websocket request rather than dropping it. */
  private _report(what: string, req: Promise<unknown>): void {
    void req.catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[obs-ws] ${what} failed: ${msg}`);
    });
  }

  /** Switch OBS's active program scene (fire-and-forget). */
  setScene(projectId: string, scene: string): void {
    const what = 'SetCurrentProgramScene';
    const sceneName = this._requireName(
      scene,
      what,
      'wire `scene` or set config.scene'
    );
    if (!sceneName) return;
    const client = this._clientFor(projectId, what);
    if (!client) return;
    this._report(
      `${what}(${sceneName})`,
      client.request(what, { sceneName })
    );
  }

  /** Set OBS's active scene transition (fire-and-forget). */
  setTransition(projectId: string, transition: string): void {
    const what = 'SetCurrentSceneTransition';
    const transitionName = this._requireName(
      transition,
      what,
      'wire `transition` or set config.transition'
    );
    if (!transitionName) return;
    const client = this._clientFor(projectId, what);
    if (!client) return;
    this._report(
      `${what}(${transitionName})`,
      client.request(what, { transitionName })
    );
  }

  /** Issue an arg-less control verb (start/stop stream, record, replay, cam). */
  control(projectId: string, verb: ObsControlVerb): void {
    const request = CONTROL_REQUESTS[verb];
    const client = this._clientFor(projectId, request);
    if (!client) return;
    this._report(request, client.request(request));
  }

  /** Set an input's volume by dB or linear multiplier (fire-and-forget). */
  setVolume(
    projectId: string,
    input: string,
    value: { db?: number; mul?: number }
  ): void {
    const what = 'SetInputVolume';
    const inputName = this._requireName(
      input,
      what,
      'wire `input` or set config.inputName'
    );
    if (!inputName) return;
    const client = this._clientFor(projectId, what);
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
    input: string,
    action: 'mute' | 'unmute' | 'toggle'
  ): void {
    const what = 'SetInputMute';
    const inputName = this._requireName(
      input,
      what,
      'wire `input` or set config.inputName'
    );
    if (!inputName) return;
    const client = this._clientFor(projectId, what);
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
