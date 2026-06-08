/**
 * Client-mesh signaling relay (live-mesh phase, slice 2).
 *
 * Browser clients form a direct WebRTC mesh with each other. They cannot reach
 * the rendezvous, so their SDP/ICE signaling is relayed through backends:
 *   clientA → backendA → (ServerMesh) → backendB → clientB
 * Backends only *relay* here — they are not yet WebRTC peers of browsers (that
 * lands with live-data routing in a later slice).
 *
 * This module also maintains the cross-server participant roster: each backend
 * advertises its local clients to connected server-peers, and pushes the merged
 * roster to its own clients so every participant knows whom to dial.
 *
 * Participant ids are `${serverPeerId}#${tabUuid}` (see @vspark/shared/sync).
 * See dev-notes/plans/live-mesh.md.
 */
import type { WebSocket } from 'ws';
import type { WSSync } from '../ws/index.js';
import { participantServer, type SyncEnvelope } from '@vspark/shared/sync';

/** Reserved ServerMesh control rtypes owned by the relay. */
export const MESH_RELAY_RTYPE = '_mesh_relay';
export const MESH_ROSTER_RTYPE = '_mesh_roster';

interface MeshBridge {
  /** Send a control envelope to a connected server-peer. */
  send: (serverPeerId: string, env: SyncEnvelope) => void;
  /** Currently connected server-peer ids. */
  connectedServers: () => string[];
}

class ClientMeshRelay {
  private ws: WSSync | null = null;
  private bridge: MeshBridge | null = null;
  /** Local browser clients: participant id ↔ their WebSocket. */
  private readonly wsByParticipant = new Map<string, WebSocket>();
  private readonly participantByWs = new Map<WebSocket, string>();
  /** Remote clients learned from each connected server-peer. */
  private readonly remoteRoster = new Map<string, Set<string>>();

  initWs(ws: WSSync): void {
    this.ws = ws;
  }

  /** Wired by the multiplayer manager once the ServerMesh exists. */
  attachBridge(bridge: MeshBridge): void {
    this.bridge = bridge;
  }

  // --- local client lifecycle (driven by index.ts WS hooks) ---------------

  /** A browser client announced its participant id on connect. */
  onHello(wsConn: WebSocket, participantId: string): void {
    // Drop any stale mapping for this socket first.
    this.onWsClose(wsConn);
    this.wsByParticipant.set(participantId, wsConn);
    this.participantByWs.set(wsConn, participantId);
    this.pushRosterToClients();
    this.advertiseRosterToServers();
  }

  onWsClose(wsConn: WebSocket): void {
    const pid = this.participantByWs.get(wsConn);
    if (!pid) return;
    this.participantByWs.delete(wsConn);
    if (this.wsByParticipant.get(pid) === wsConn)
      this.wsByParticipant.delete(pid);
    this.pushRosterToClients();
    this.advertiseRosterToServers();
  }

  /** Relay a client's signal toward its target participant. */
  onSignal(fromWs: WebSocket, to: string, data: unknown): void {
    const from = this.participantByWs.get(fromWs);
    if (!from || !to) return;
    const local = this.wsByParticipant.get(to);
    if (local) {
      this.ws?.sendTo(local, 'mesh_signal', { from, data });
      return;
    }
    // Route to the backend that owns the target client.
    const server = participantServer(to);
    this.bridge?.send(server, {
      rtype: MESH_RELAY_RTYPE,
      op: 'event',
      key: '',
      data: { to, from, data },
    });
  }

  // --- server-peer events (driven by the multiplayer manager) -------------

  onServerConnected(serverPeerId: string): void {
    // Teach the new peer our local clients (and re-push when ours change).
    this.advertiseRosterToServers(serverPeerId);
  }

  onServerDisconnected(serverPeerId: string): void {
    this.remoteRoster.delete(serverPeerId);
    this.pushRosterToClients();
  }

  /** Inbound `_mesh_relay` from a server-peer → deliver to a local client. */
  onServerRelay(env: SyncEnvelope): void {
    const { to, from, data } = (env.data ?? {}) as {
      to?: string;
      from?: string;
      data?: unknown;
    };
    if (!to || !from) return;
    const local = this.wsByParticipant.get(to);
    if (local) this.ws?.sendTo(local, 'mesh_signal', { from, data });
  }

  /** Inbound `_mesh_roster` from a server-peer → merge + re-push. */
  onServerRoster(from: string, env: SyncEnvelope): void {
    const ids = ((env.data as { participants?: string[] })?.participants ??
      []) as string[];
    this.remoteRoster.set(from, new Set(ids));
    this.pushRosterToClients();
  }

  // --- roster fan-out ------------------------------------------------------

  private localIds(): string[] {
    return [...this.wsByParticipant.keys()];
  }

  private fullRoster(): string[] {
    const all = new Set<string>(this.localIds());
    for (const set of this.remoteRoster.values())
      for (const id of set) all.add(id);
    return [...all];
  }

  private pushRosterToClients(): void {
    const participants = this.fullRoster();
    for (const wsConn of this.wsByParticipant.values())
      this.ws?.sendTo(wsConn, 'mesh_roster', { participants });
  }

  private advertiseRosterToServers(only?: string): void {
    if (!this.bridge) return;
    const participants = this.localIds();
    const targets = only ? [only] : this.bridge.connectedServers();
    for (const server of targets)
      this.bridge.send(server, {
        rtype: MESH_ROSTER_RTYPE,
        op: 'event',
        key: '',
        data: { participants },
      });
  }
}

export const clientMeshRelay = new ClientMeshRelay();
