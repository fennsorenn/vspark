/**
 * Backend↔remote-browser WebRTC edge (permissioned-sync-mesh, transport slice).
 *
 * The full mesh needs FrontA↔BackB links: a backend must accept WebRTC from
 * *remote browsers*, not just other backends. `ServerMesh` can't serve this —
 * it opens `doc`+`stream` channels and waits for `doc`, whereas a browser
 * ({@link ../../frontend/src/mesh/clientMesh}) opens a single `mesh` channel.
 * So the browser-facing backend mesh has to speak the *client* mesh's protocol:
 * one ordered `mesh` channel carrying JSON, ping/pong clock-sync, and bare
 * {@link SyncEnvelope}s for data.
 *
 * Asymmetry: browsers always *dial* the backend (the frontend treats backend
 * peer ids — those without a `#tab` suffix — as always-initiate), so this mesh
 * only ever *answers*. Inbound offers auto-accept: trust comes from the
 * signaling relay (a backend only relays for its own clients, and the
 * `serverId#tab` prefix is server-assigned), per the connection-based trust
 * model. Source-side grant admission still gates what actually flows.
 *
 * Signaling is injected (the {@link ../multiplayer/clientMeshRelay} in
 * production) so the mesh is loopback-testable. See
 * dev-notes/plans/permissioned-sync-mesh.md.
 */
import { RTCPeerConnection } from 'werift';
import { EventEmitter } from 'events';
import { makeOffsetTracker, type SyncEnvelope } from '@vspark/shared/sync';
import type { MeshSignaling } from './mesh.js';

type SignalData =
  | { kind: 'offer' | 'answer'; sdp: { type: string; sdp: string } }
  | { kind: 'ice'; candidate: Record<string, unknown> };

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface PeerConn {
  pc: RTCPeerConnection;
  mesh?: ReturnType<RTCPeerConnection['createDataChannel']>;
  connected: boolean;
  remoteSet: boolean;
  offset: ReturnType<typeof makeOffsetTracker>;
  pingTimer?: ReturnType<typeof setInterval>;
}

const PING_MS = 5000;

const DBG = !!process.env.MESH_DEBUG;
const dbg = (...a: unknown[]): void => {
  if (DBG) console.error('[browserMesh]', ...a);
};

/**
 * Events: `peerConnected`(participantId), `peerDisconnected`(participantId),
 * `envelope`({from, env}). Participant ids here are browser ids
 * (`${serverPeerId}#${tabUuid}`).
 */
export class BrowserPeerMesh extends EventEmitter {
  private readonly peers = new Map<string, PeerConn>();
  /** ICE that arrived before the remote description was set. */
  private readonly pendingIce = new Map<string, Record<string, unknown>[]>();

  constructor(
    private readonly signaling: MeshSignaling,
    private readonly iceServers: () => IceServer[] = () => []
  ) {
    super();
    this.signaling.onSignal((from, data) =>
      this.onSignal(from, data as SignalData)
    );
  }

  isConnected(participant: string): boolean {
    return this.peers.get(participant)?.connected ?? false;
  }

  connectedParticipants(): string[] {
    return [...this.peers.entries()]
      .filter(([, p]) => p.connected)
      .map(([id]) => id);
  }

  /** Clock offset (originClock − localClock) for a participant, 0 if unknown. */
  offsetFor(participant: string): number {
    return this.peers.get(participant)?.offset.offset() ?? 0;
  }

  /** Send a reliable envelope to a browser participant. Returns false (never
   *  throws) if the channel isn't open or the send fails. */
  send(participant: string, env: SyncEnvelope): boolean {
    const dc = this.peers.get(participant)?.mesh;
    if (!dc || dc.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify(env));
      return true;
    } catch (e) {
      dbg('send failed', participant, env.rtype, e);
      return false;
    }
  }

  /** Drop a participant (e.g. it left the roster). */
  disconnect(participant: string): void {
    const p = this.peers.get(participant);
    if (!p) return;
    this.peers.delete(participant);
    this.pendingIce.delete(participant);
    if (p.pingTimer) clearInterval(p.pingTimer);
    void p.pc.close().catch(() => {});
    if (p.connected) this.emit('peerDisconnected', participant);
  }

  close(): void {
    for (const id of [...this.peers.keys()]) this.disconnect(id);
  }

  // --- internals ----------------------------------------------------------

  private newPc(participant: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers() as never,
    });
    pc.onIceCandidate.subscribe((c) => {
      if (c)
        this.signaling.send(participant, {
          kind: 'ice',
          candidate: c as unknown as Record<string, unknown>,
        });
    });
    pc.connectionStateChange.subscribe((state: string) => {
      dbg('connState', participant, state);
      if (
        (state === 'failed' ||
          state === 'closed' ||
          state === 'disconnected') &&
        // Only tear down if this pc is still the active one for the participant.
        this.peers.get(participant)?.pc === pc
      )
        this.disconnect(participant);
    });
    // The browser opens the `mesh` channel; we receive it here.
    pc.onDataChannel.subscribe((dc) => this.wireChannel(participant, dc));
    return pc;
  }

  private wireChannel(
    participant: string,
    dc: ReturnType<RTCPeerConnection['createDataChannel']>
  ): void {
    if (dc.label !== 'mesh') return;
    const entry = this.peers.get(participant);
    if (entry) entry.mesh = dc;
    dc.onMessage.subscribe((raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
      this.onMessage(participant, text);
    });
    dc.stateChanged.subscribe((s: string) => {
      dbg('dc', participant, s);
      if (s === 'open') this.markConnected(participant);
    });
  }

  private markConnected(participant: string): void {
    const e = this.peers.get(participant);
    if (!e || e.connected) return;
    if (e.mesh?.readyState !== 'open') return;
    e.connected = true;
    dbg('peerConnected', participant);
    // Clock-sync: ping immediately + on an interval (symmetric with clientMesh,
    // so each side learns its offset to the other).
    const ping = (): void => {
      if (e.mesh?.readyState === 'open')
        try {
          e.mesh.send(JSON.stringify({ kind: '__ping', t0: Date.now() }));
        } catch {
          /* channel closing */
        }
    };
    ping();
    e.pingTimer = setInterval(ping, PING_MS);
    this.emit('peerConnected', participant);
  }

  private onMessage(participant: string, raw: string): void {
    let msg: {
      kind?: string;
      t0?: number;
      tr?: number;
      rtype?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const peer = this.peers.get(participant);
    if (!peer) return;
    if (msg.kind === '__ping') {
      // Respond so the browser can compute its offset to us.
      if (peer.mesh?.readyState === 'open')
        try {
          peer.mesh.send(
            JSON.stringify({ kind: '__pong', t0: msg.t0, tr: Date.now() })
          );
        } catch {
          /* channel closing */
        }
    } else if (msg.kind === '__pong' && typeof msg.t0 === 'number') {
      peer.offset.observe(msg.t0, msg.tr ?? Date.now(), Date.now());
    } else if (typeof msg.rtype === 'string') {
      this.emit('envelope', { from: participant, env: msg as SyncEnvelope });
    }
  }

  private async onSignal(from: string, data: SignalData): Promise<void> {
    dbg('onSignal', from, data.kind);
    if (data.kind === 'offer') {
      // Browsers may re-dial after a reconnect; replace any stale slot.
      if (this.peers.has(from)) this.disconnect(from);
      const pc = this.newPc(from);
      const entry: PeerConn = {
        pc,
        connected: false,
        remoteSet: false,
        offset: makeOffsetTracker(),
      };
      this.peers.set(from, entry);
      await pc.setRemoteDescription(data.sdp as never);
      entry.remoteSet = true;
      this.flushIce(from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.send(from, { kind: 'answer', sdp: pc.localDescription });
    } else if (data.kind === 'answer') {
      // We never offer, so an answer is unexpected — ignore.
      dbg('unexpected answer', from);
    } else if (data.kind === 'ice') {
      const e = this.peers.get(from);
      if (e?.remoteSet) {
        await e.pc.addIceCandidate(data.candidate as never).catch(() => {});
      } else {
        const buf = this.pendingIce.get(from) ?? [];
        buf.push(data.candidate);
        this.pendingIce.set(from, buf);
      }
    }
  }

  private flushIce(participant: string): void {
    const buf = this.pendingIce.get(participant);
    const e = this.peers.get(participant);
    if (!buf || !e) return;
    this.pendingIce.delete(participant);
    for (const cand of buf)
      void e.pc.addIceCandidate(cand as never).catch(() => {});
  }
}
