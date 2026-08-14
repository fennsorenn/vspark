/**
 * ObsManager — the OBS browser-source bridge.
 *
 * vspark is typically added to OBS as a Browser Source. The page inside that
 * source can talk to OBS via the `window.obsstudio` JS API, but the signal
 * graph runs here in the backend. This manager is the seam:
 *
 *  - Inbound: the frontend bridge forwards `window.obsstudio` events as
 *    `obs_event` WS messages. `handleEvent` routes them into every running
 *    project logic graph's matching `obs_*` source node (same pattern as
 *    OverliveManager). Because OBS events are global to the OBS instance, every
 *    open browser source reports the same global event — so identical events
 *    are de-duplicated within a short window before fan-out.
 *
 *  - Outbound: `obs_*` action nodes call `command(...)`, which broadcasts an
 *    `obs_command` to every client; the bridge invokes the matching
 *    `window.obsstudio` method (gated by the source's OBS page permissions).
 *
 *  - Render-client lifecycle: the WS socket is ephemeral and project-anonymous,
 *    so each client sends a `client_hello` carrying its projectId and a stable
 *    `target` marker. `handleHello` / `handleClientGone` track connections and
 *    fire `client_lifecycle` nodes on connect/disconnect. This is vspark-native
 *    (it works for a plain browser tab too), but lives here because it shares
 *    the same per-socket bookkeeping as the OBS bridge.
 *
 * See dev-notes/modules/obs.md.
 */
import { mkEvent } from '@vspark/shared/signal';
import type { ObsCommand, ObsEvent } from '@vspark/shared';
import { logicManager } from '../logic/manager.js';
import type { WSSync } from '../ws/index.js';
import type { WebSocket } from 'ws';

/** Node kind that receives each OBS event family. */
const OBS_KIND_BY_EVENT: Record<ObsEvent['type'], string> = {
  scene_changed: 'obs_scene_changed',
  output_state: 'obs_output_state',
};

/** Window (ms) within which an identical OBS event from another source is
 *  treated as a duplicate and dropped. Global OBS events fan out to every open
 *  browser source, so without this every source would fire the graph. */
const DEDUP_WINDOW_MS = 400;

interface ClientMeta {
  projectId: string;
  target: string;
}

export class ObsManager {
  private readonly _ws: WSSync | null;
  /** Per-socket identity, populated on client_hello. */
  private readonly _clients = new Map<WebSocket, ClientMeta>();
  /** projectId → live render-client count (for client_lifecycle.count). */
  private readonly _countByProject = new Map<string, number>();
  /** event signature → last-seen epoch ms, for global-event de-duplication. */
  private readonly _lastSeen = new Map<string, number>();

  constructor(ws?: WSSync) {
    this._ws = ws ?? null;
  }

  // ── inbound: OBS events ────────────────────────────────────────────────────

  /** Route an OBS event from a browser source into matching graph nodes. The
   *  source socket resolves the project scope (via its prior client_hello). */
  handleEvent(sourceWs: WebSocket, event: ObsEvent): void {
    const projectId = this._clients.get(sourceWs)?.projectId ?? null;
    if (this._isDuplicate(projectId, event)) return;
    this._deliver(projectId, OBS_KIND_BY_EVENT[event.type], event);
  }

  private _isDuplicate(projectId: string | null, event: ObsEvent): boolean {
    const sig = `${projectId ?? '*'}:${JSON.stringify(event)}`;
    const now = Date.now();
    const last = this._lastSeen.get(sig);
    this._lastSeen.set(sig, now);
    // Opportunistic prune so the map can't grow unbounded.
    if (this._lastSeen.size > 256) {
      for (const [k, t] of this._lastSeen)
        if (now - t > DEDUP_WINDOW_MS) this._lastSeen.delete(k);
    }
    return last !== undefined && now - last < DEDUP_WINDOW_MS;
  }

  // ── outbound: control calls ────────────────────────────────────────────────

  /** Ask every connected browser source to invoke a `window.obsstudio` call.
   *  Fire-and-forget — OBS silently no-ops calls above the source's permission
   *  level, so there's no ack to wait on. */
  command(command: ObsCommand): void {
    this._ws?.broadcast('obs_command', { command });
  }

  // ── render-client lifecycle ────────────────────────────────────────────────

  /** Record a client's identity and fire the `connected` lifecycle event. */
  handleHello(ws: WebSocket, projectId: string, target: string): void {
    // A second hello on the same socket (re-announce) shouldn't double-count.
    if (this._clients.has(ws)) this._forget(ws);
    this._clients.set(ws, { projectId, target });
    const count = (this._countByProject.get(projectId) ?? 0) + 1;
    this._countByProject.set(projectId, count);
    this._deliver(projectId, 'client_lifecycle', {
      phase: 'connected',
      target,
      count,
    });
  }

  /** Fire the `disconnected` lifecycle event for a closed socket. */
  handleClientGone(ws: WebSocket): void {
    const meta = this._clients.get(ws);
    if (!meta) return;
    const count = this._forget(ws);
    this._deliver(meta.projectId, 'client_lifecycle', {
      phase: 'disconnected',
      target: meta.target,
      count,
    });
  }

  /** Drop a socket's bookkeeping; returns the project's remaining client count. */
  private _forget(ws: WebSocket): number {
    const meta = this._clients.get(ws);
    if (!meta) return 0;
    this._clients.delete(ws);
    const count = Math.max(0, (this._countByProject.get(meta.projectId) ?? 1) - 1);
    if (count === 0) this._countByProject.delete(meta.projectId);
    else this._countByProject.set(meta.projectId, count);
    return count;
  }

  // ── fan-out ─────────────────────────────────────────────────────────────────

  /** Deliver a payload into every running node of `kind`. When `projectId` is
   *  known the fan-out is scoped to that project; otherwise it reaches all
   *  projects (OBS events are machine-global, so an un-helloed source still
   *  drives every project's graphs). Per-node config filters run inside the
   *  node's own handler, mirroring the overlive nodes. */
  private _deliver(
    projectId: string | null,
    kind: string,
    payload: unknown
  ): void {
    for (const { graphId, node, projectId: gpId } of logicManager.iterateNodes()) {
      if (projectId !== null && gpId !== projectId) continue;
      if (node.kind !== kind) continue;
      logicManager.fire(graphId, node.id, 'event', mkEvent(payload));
    }
  }

  /** Test/diagnostics: number of tracked render clients for a project. */
  clientCount(projectId: string): number {
    return this._countByProject.get(projectId) ?? 0;
  }
}

// Singleton — wired in src/index.ts.
let _instance: ObsManager | null = null;
export function initObsManager(ws?: WSSync): ObsManager {
  if (_instance) return _instance;
  _instance = new ObsManager(ws);
  return _instance;
}
export function getObsManager(): ObsManager {
  if (!_instance) throw new Error('ObsManager not initialised');
  return _instance;
}
