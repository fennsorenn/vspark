/**
 * WebRTC ServerMesh (Phase 5) — peer-to-peer data channels between paired
 * servers, established via the rendezvous's signaling relay. Two channels per
 * peer: `doc` (reliable/ordered — documents/control) and `stream`
 * (unordered/lossy — 90 Hz pose). Carries the unified {@link SyncEnvelope}.
 *
 * Signaling is injected (the rendezvous client in production) so the mesh is
 * integration-testable on loopback. ICE uses host candidates locally; STUN/TURN
 * (from `iceServers`) handle real NAT. See dev-notes/plans/multiplayer-phase5.md.
 */
import { RTCPeerConnection } from 'werift';
import { EventEmitter } from 'events';
import type { SyncEnvelope } from '@vspark/shared/sync';

export interface MeshSignaling {
  /** Relay an SDP/ICE blob to a peer (→ rendezvous `signal`). */
  send: (to: string, data: unknown) => void;
  /** Register a handler for inbound signaling from a peer. */
  onSignal: (cb: (from: string, data: SignalData) => void) => void;
}

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
  doc?: ReturnType<RTCPeerConnection['createDataChannel']>;
  stream?: ReturnType<RTCPeerConnection['createDataChannel']>;
  connected: boolean;
  initiator: boolean;
  /** Remote description applied — ICE candidates can only be added after this. */
  remoteSet: boolean;
}

/**
 * Events: `incomingOffer`(peerId — awaiting accept/reject), `peerConnected`(peerId),
 * `peerDisconnected`(peerId), `envelope`({from, env}), `streamFrame`({from, frame}).
 */
/** Reserved control rtype: a peer announcing a graceful disconnect. */
const BYE_RTYPE = '_mesh_bye';

const DBG = !!process.env.MESH_DEBUG;
const dbg = (...a: unknown[]): void => {
  if (DBG) console.error('[mesh]', ...a);
};

export class ServerMesh extends EventEmitter {
  private readonly peers = new Map<string, PeerConn>();
  /** ICE candidates that arrived before the peer's remote description was set. */
  private readonly pendingIce = new Map<string, Record<string, unknown>[]>();
  /** Offers awaiting an accept/reject decision (the prompt-once policy lives in
   *  the manager; the mesh just holds the offer so it isn't dropped). */
  private readonly pendingOffers = new Map<
    string,
    { sdp: { type: string; sdp: string } }
  >();

  constructor(
    private readonly signaling: MeshSignaling,
    /** ICE servers (STUN/TURN) for real NAT; empty is fine on loopback. */
    private readonly iceServers: () => IceServer[] = () => []
  ) {
    super();
    this.signaling.onSignal((from, data) => this.onSignal(from, data));
  }

  /** Accept a buffered inbound offer (answer it). Call after the accept policy
   *  approves the peer. No-op if there's no pending offer. */
  async acceptOffer(peerId: string): Promise<void> {
    const pending = this.pendingOffers.get(peerId);
    if (!pending || this.peers.has(peerId)) return;
    this.pendingOffers.delete(peerId);
    const pc = this.newPc(peerId, false);
    const entry: PeerConn = {
      pc,
      connected: false,
      initiator: false,
      remoteSet: false,
    };
    this.peers.set(peerId, entry);
    await pc.setRemoteDescription(pending.sdp as never);
    entry.remoteSet = true;
    this.flushIce(peerId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.signaling.send(peerId, { kind: 'answer', sdp: pc.localDescription });
  }

  /** Reject (drop) a buffered inbound offer. */
  rejectOffer(peerId: string): void {
    this.pendingOffers.delete(peerId);
    this.pendingIce.delete(peerId);
  }

  isConnected(peerId: string): boolean {
    return this.peers.get(peerId)?.connected ?? false;
  }

  connectedPeers(): string[] {
    return [...this.peers.entries()]
      .filter(([, p]) => p.connected)
      .map(([id]) => id);
  }

  /** Initiate a connection to a peer (offerer). No-op if one already exists. */
  async connect(peerId: string): Promise<void> {
    if (this.peers.has(peerId)) return;
    const pc = this.newPc(peerId, true);
    const entry: PeerConn = {
      pc,
      connected: false,
      initiator: true,
      remoteSet: false,
    };
    this.peers.set(peerId, entry);
    entry.doc = this.wireChannel(
      peerId,
      pc.createDataChannel('doc', { ordered: true })
    );
    entry.stream = this.wireChannel(
      peerId,
      pc.createDataChannel('stream', { ordered: false, maxRetransmits: 0 })
    );
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    dbg('connect → offer', peerId);
    this.signaling.send(peerId, { kind: 'offer', sdp: pc.localDescription });
  }

  disconnect(peerId: string): void {
    const p = this.peers.get(peerId);
    if (!p) return;
    this.peers.delete(peerId);
    this.pendingIce.delete(peerId);
    this.pendingOffers.delete(peerId);
    void p.pc.close().catch(() => {});
    if (p.connected) this.emit('peerDisconnected', peerId);
  }

  /** Graceful disconnect: tell the peer we're leaving so it tears down at once,
   *  rather than waiting on a connection-state timeout that may never fire
   *  (observed: the remote side stayed "connected" indefinitely). Sends a `bye`
   *  on the reliable channel, then closes after a short flush window. */
  disconnectGraceful(peerId: string): void {
    const sent = this.sendEnvelope(peerId, {
      rtype: BYE_RTYPE,
      op: 'event',
      key: '',
    });
    if (sent) setTimeout(() => this.disconnect(peerId), 200);
    else this.disconnect(peerId);
  }

  /** Reliable document/control envelope. Returns false if the channel isn't open. */
  sendEnvelope(peerId: string, env: SyncEnvelope): boolean {
    const dc = this.peers.get(peerId)?.doc;
    if (!dc || dc.readyState !== 'open') return false;
    dc.send(JSON.stringify(env));
    return true;
  }

  /** Lossy stream frame (pose). Dropped silently if the channel isn't open. */
  sendStream(peerId: string, frame: Record<string, unknown>): void {
    const dc = this.peers.get(peerId)?.stream;
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(frame));
  }

  broadcastEnvelope(env: SyncEnvelope): void {
    for (const id of this.connectedPeers()) this.sendEnvelope(id, env);
  }

  close(): void {
    for (const id of [...this.peers.keys()]) this.disconnect(id);
  }

  // --- internals ----------------------------------------------------------

  private newPc(peerId: string, _initiator: boolean): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers() as never,
    });
    pc.onIceCandidate.subscribe((c) => {
      if (c)
        this.signaling.send(peerId, {
          kind: 'ice',
          candidate: c as unknown as Record<string, unknown>,
        });
    });
    pc.connectionStateChange.subscribe((state: string) => {
      dbg('connState', peerId, state);
      if (state === 'failed' || state === 'closed' || state === 'disconnected')
        this.disconnect(peerId);
    });
    // Answerer receives its channels here.
    pc.onDataChannel.subscribe((dc) => this.wireChannel(peerId, dc));
    return pc;
  }

  private wireChannel(
    peerId: string,
    dc: ReturnType<RTCPeerConnection['createDataChannel']>
  ): ReturnType<RTCPeerConnection['createDataChannel']> {
    const entry = this.peers.get(peerId);
    if (entry) {
      if (dc.label === 'doc') entry.doc = dc;
      else if (dc.label === 'stream') entry.stream = dc;
    }
    dc.onMessage.subscribe((raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (dc.label === 'doc') {
        // Peer announced it's leaving — tear down now instead of waiting for a
        // transport timeout. Handled inside the mesh so it never surfaces as an
        // application envelope.
        if ((parsed as SyncEnvelope)?.rtype === BYE_RTYPE) {
          this.disconnect(peerId);
          return;
        }
        this.emit('envelope', { from: peerId, env: parsed as SyncEnvelope });
      } else this.emit('streamFrame', { from: peerId, frame: parsed });
    });
    dc.stateChanged.subscribe((s: string) => {
      dbg('dc', peerId, dc.label, s);
      if (s === 'open') this.markConnectedWhenReady(peerId);
    });
    return dc;
  }

  /** Emit peerConnected once the reliable `doc` channel is open. */
  private markConnectedWhenReady(peerId: string): void {
    const e = this.peers.get(peerId);
    if (!e || e.connected) return;
    if (e.doc?.readyState === 'open') {
      e.connected = true;
      dbg('peerConnected', peerId);
      this.emit('peerConnected', peerId);
    }
  }

  private async onSignal(from: string, data: SignalData): Promise<void> {
    dbg('onSignal', from, data.kind);
    if (data.kind === 'offer') {
      if (this.peers.has(from)) return; // glare / already connecting — ignore
      // Buffer the offer and let the manager apply the accept policy
      // (prompt-once-per-session). It calls acceptOffer/rejectOffer.
      this.pendingOffers.set(from, { sdp: data.sdp });
      this.emit('incomingOffer', from);
    } else if (data.kind === 'answer') {
      const e = this.peers.get(from);
      if (e?.initiator) {
        await e.pc.setRemoteDescription(data.sdp as never);
        e.remoteSet = true;
        this.flushIce(from);
      }
    } else if (data.kind === 'ice') {
      const e = this.peers.get(from);
      // Buffer candidates that arrive before the remote description is set
      // (the offerer's ICE often races ahead of the offer reaching the answerer).
      if (e?.remoteSet) {
        await e.pc.addIceCandidate(data.candidate as never).catch(() => {});
      } else {
        const buf = this.pendingIce.get(from) ?? [];
        buf.push(data.candidate);
        this.pendingIce.set(from, buf);
      }
    }
  }

  private flushIce(peerId: string): void {
    const buf = this.pendingIce.get(peerId);
    const e = this.peers.get(peerId);
    if (!buf || !e) return;
    this.pendingIce.delete(peerId);
    for (const cand of buf)
      void e.pc.addIceCandidate(cand as never).catch(() => {});
  }
}
