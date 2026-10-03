/**
 * ObsManager — render-client lifecycle bookkeeping.
 *
 * The WS socket is ephemeral and project-anonymous, so each render client (an
 * OBS Browser Source, or an ordinary browser tab — both count) sends a
 * `client_hello` carrying its projectId and a stable `target` marker.
 * `handleHello` / `handleClientGone` track those connections and fire
 * `client_lifecycle` nodes on connect/disconnect.
 *
 * This used to be the OBS browser-source bridge as well: it routed
 * `window.obsstudio` events into graph nodes and broadcast `obs_command`
 * control calls back out. That half is gone — OBS gates control calls behind
 * the source's page permission level and silently ignores anything above it,
 * so an action could fail with no error anywhere. OBS control and state now go
 * over obs-websocket ([ws_manager.ts]), which needs no page permission and
 * returns a status per request. What is left here is vspark-native and works
 * with no OBS involvement at all.
 *
 * See dev-notes/modules/obs.md.
 */
import { mkEvent } from '@vspark/shared/signal';
import { logicManager } from '../logic/manager.js';
import type { WebSocket } from 'ws';

interface ClientMeta {
  projectId: string;
  target: string;
}

export class ObsManager {
  /** Per-socket identity, populated on client_hello. */
  private readonly _clients = new Map<WebSocket, ClientMeta>();
  /** projectId → live render-client count (for client_lifecycle.count). */
  private readonly _countByProject = new Map<string, number>();

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

  /** Deliver a payload into every running node of `kind` in the project's
   *  graphs. Per-node config filters run inside the node's own handler,
   *  mirroring the overlive nodes. */
  private _deliver(projectId: string, kind: string, payload: unknown): void {
    for (const { graphId, node, projectId: gpId } of logicManager.iterateNodes()) {
      if (gpId !== projectId) continue;
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
export function initObsManager(): ObsManager {
  if (_instance) return _instance;
  _instance = new ObsManager();
  return _instance;
}
export function getObsManager(): ObsManager {
  if (!_instance) throw new Error('ObsManager not initialised');
  return _instance;
}
