/**
 * Browser-side WebRTC mesh (live-mesh phase, slice 2).
 *
 * Each tab is a mesh participant (`${serverPeerId}#${tabUuid}`) that forms a
 * direct data channel to every other participant in the roster. Signaling is
 * relayed through the backend (WS `mesh_signal`); the bytes flow peer-to-peer.
 *
 * This slice only establishes channels + a per-peer clock offset (ping/pong);
 * routing live `stream`/`field` envelopes over the mesh is the next slice.
 *
 * Glare is avoided by a deterministic rule: the lexicographically smaller
 * participant id initiates; the larger only ever answers. See
 * dev-notes/plans/live-mesh.md.
 */
import {
  isClientParticipant,
  makeOffsetTracker,
  participantServer,
  type SyncEnvelope,
} from '@vspark/shared/sync';

type Signal =
  | { kind: 'offer' | 'answer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

interface MeshPeer {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  connected: boolean;
  remoteSet: boolean;
  pendingIce: RTCIceCandidateInit[];
  offset: ReturnType<typeof makeOffsetTracker>;
  pingTimer?: ReturnType<typeof setInterval>;
}

const PING_MS = 5000;

class ClientMesh {
  private selfId = '';
  private getWs: () => WebSocket | null = () => null;
  private onChange: (ids: string[]) => void = () => {};
  /** Sink for data envelopes (rtype messages) arriving over a peer's channel —
   *  the object-share + blob-transfer protocols ride this. */
  private onEnvelope: (from: string, env: SyncEnvelope) => void = () => {};
  private iceServers: RTCIceServer[] = [];
  private readonly peers = new Map<string, MeshPeer>();

  configure(opts: {
    selfId: string;
    getWs: () => WebSocket | null;
    onChange: (ids: string[]) => void;
    onEnvelope?: (from: string, env: SyncEnvelope) => void;
    iceServers?: RTCIceServer[];
  }): void {
    this.selfId = opts.selfId;
    this.getWs = opts.getWs;
    this.onChange = opts.onChange;
    if (opts.onEnvelope) this.onEnvelope = opts.onEnvelope;
    if (opts.iceServers) this.iceServers = opts.iceServers;
  }

  /** Send a data envelope to a connected participant over its mesh channel.
   *  Returns false (never throws) if the channel isn't open. */
  sendEnvelope(id: string, env: SyncEnvelope): boolean {
    const dc = this.peers.get(id)?.dc;
    if (!dc || dc.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify(env));
      return true;
    } catch {
      return false;
    }
  }

  /** Whether we hold a live data channel to a participant. */
  isConnected(id: string): boolean {
    return this.peers.get(id)?.connected ?? false;
  }

  /** Announce our participant id to the backend (call on every WS (re)open). */
  sendHello(): void {
    if (this.selfId) this.send('mesh_hello', { participantId: this.selfId });
  }

  /** Apply the latest roster: open links to new participants, drop departed ones.
   *
   *  - **remote backends** (ids without a `#tab` suffix) answer only, so we
   *    always initiate toward them — except our *own* server, which we reach
   *    over the WebSocket, never WebRTC.
   *  - **other browsers** use the deterministic glare rule: the smaller id dials,
   *    the larger waits for the offer. */
  setRoster(participants: string[]): void {
    const present = new Set(participants);
    const myServer = participantServer(this.selfId);
    for (const id of participants) {
      if (id === this.selfId || this.peers.has(id)) continue;
      if (!isClientParticipant(id)) {
        if (id !== myServer) void this.dial(id); // remote backend — always dial
      } else if (this.selfId < id) {
        void this.dial(id); // browser↔browser — we initiate
      }
      // else: a larger-id browser peer — wait for their offer
    }
    for (const id of [...this.peers.keys()])
      if (!present.has(id)) this.drop(id);
  }

  /** Inbound SDP/ICE relayed from `from`. */
  async handleSignal(from: string, data: Signal): Promise<void> {
    if (data.kind === 'offer') {
      const peer = this.peers.get(from) ?? this.newPeer(from);
      await peer.pc.setRemoteDescription(data.sdp);
      peer.remoteSet = true;
      this.flushIce(from);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.send('mesh_signal', {
        to: from,
        data: { kind: 'answer', sdp: peer.pc.localDescription },
      });
    } else if (data.kind === 'answer') {
      const peer = this.peers.get(from);
      if (peer) {
        await peer.pc.setRemoteDescription(data.sdp);
        peer.remoteSet = true;
        this.flushIce(from);
      }
    } else if (data.kind === 'ice') {
      const peer = this.peers.get(from);
      if (!peer) return;
      if (peer.remoteSet)
        await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pendingIce.push(data.candidate);
    }
  }

  connectedIds(): string[] {
    return [...this.peers.entries()]
      .filter(([, p]) => p.connected)
      .map(([id]) => id);
  }

  /** Clock offset (originClock − localClock) for a participant, 0 if unknown. */
  offsetFor(id: string): number {
    return this.peers.get(id)?.offset.offset() ?? 0;
  }

  reset(): void {
    for (const id of [...this.peers.keys()]) this.drop(id);
  }

  // --- internals -----------------------------------------------------------

  private newPeer(id: string): MeshPeer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: MeshPeer = {
      pc,
      dc: null,
      connected: false,
      remoteSet: false,
      pendingIce: [],
      offset: makeOffsetTracker(),
    };
    this.peers.set(id, peer);
    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.send('mesh_signal', {
          to: id,
          data: { kind: 'ice', candidate: e.candidate.toJSON() },
        });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected')
        this.drop(id);
    };
    pc.ondatachannel = (e) => this.wireChannel(id, e.channel);
    return peer;
  }

  private async dial(id: string): Promise<void> {
    const peer = this.newPeer(id);
    this.wireChannel(id, peer.pc.createDataChannel('mesh', { ordered: true }));
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.send('mesh_signal', {
      to: id,
      data: { kind: 'offer', sdp: peer.pc.localDescription },
    });
  }

  private wireChannel(id: string, dc: RTCDataChannel): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.dc = dc;
    dc.onopen = () => {
      peer.connected = true;
      this.onChange(this.connectedIds());
      // Clock-sync: ping immediately + on an interval.
      const ping = () =>
        dc.readyState === 'open' &&
        dc.send(JSON.stringify({ kind: '__ping', t0: Date.now() }));
      ping();
      peer.pingTimer = setInterval(ping, PING_MS);
    };
    dc.onclose = () => {
      peer.connected = false;
      this.onChange(this.connectedIds());
    };
    dc.onmessage = (e) => this.onMessage(id, e.data as string);
  }

  private onMessage(id: string, raw: string): void {
    let msg: { kind?: string; t0?: number; tr?: number; rtype?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const peer = this.peers.get(id);
    if (!peer) return;
    if (msg.kind === '__ping') {
      peer.dc?.send(
        JSON.stringify({ kind: '__pong', t0: msg.t0, tr: Date.now() })
      );
    } else if (msg.kind === '__pong' && typeof msg.t0 === 'number') {
      peer.offset.observe(msg.t0, msg.tr ?? Date.now(), Date.now());
    } else if (typeof msg.rtype === 'string') {
      // Data envelope (object-share / blob transfer) — hand to the sink.
      this.onEnvelope(id, msg as SyncEnvelope);
    }
  }

  private flushIce(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    const buf = peer.pendingIce;
    peer.pendingIce = [];
    for (const c of buf) void peer.pc.addIceCandidate(c).catch(() => {});
  }

  private drop(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (peer.pingTimer) clearInterval(peer.pingTimer);
    try {
      peer.dc?.close();
      peer.pc.close();
    } catch {
      /* already closed */
    }
    this.onChange(this.connectedIds());
  }

  private send(kind: string, payload: Record<string, unknown>): void {
    const ws = this.getWs();
    // Frontend→backend WS messages are flat ({kind, ...fields}); the backend
    // reads fields straight off the message. (Backend→frontend is wrapped under
    // `payload`.) Spread, don't nest.
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ kind, ...payload }));
  }
}

export const clientMesh = new ClientMesh();
