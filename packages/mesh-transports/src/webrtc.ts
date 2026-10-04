/**
 * Direct links over WebRTC data channels (principle 8: most direct path).
 *
 * Dials whoever the mesh says this peer may link to (`directory.wanted()`,
 * from its server's roster) and accepts offers only from them. Offers, answers
 * and ICE candidates travel through the mesh itself (`directory.signal`),
 * routed over the servers in between; the bytes then flow peer to peer.
 *
 * Two channels per link: `mesh` (reliable, ordered) for everything, and
 * `mesh-lossy` (unordered, no retransmits) for `sendLossy`, so a preview
 * frame never waits behind a lost one.
 *
 * Glare: the smaller id dials, the larger only answers. A dialer whose link
 * fails while the peer is still wanted dials again after `redialMs`.
 */
import {
  encode,
  type MeshMessage,
  type MeshTransport,
  type PeerDirectory,
  type TransportHandlers,
} from '@vspark/mesh';

type Signal =
  | { kind: 'offer' | 'answer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

export interface WebRtcTransportOptions {
  iceServers?: RTCIceServer[];
  /** The platform's RTCPeerConnection (injectable for tests). */
  RTCPeerConnection?: typeof RTCPeerConnection;
  redialMs?: number;
}

interface Link {
  pc: RTCPeerConnection;
  reliable: RTCDataChannel | null;
  lossy: RTCDataChannel | null;
  announced: boolean;
  remoteSet: boolean;
  pendingIce: RTCIceCandidateInit[];
}

export class WebRtcTransport implements MeshTransport {
  private handlers: TransportHandlers | null = null;
  private dir: PeerDirectory | null = null;
  private readonly links = new Map<string, Link>();
  private readonly redials = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly offs: (() => void)[] = [];

  constructor(private readonly opts: WebRtcTransportOptions = {}) {}

  start(h: TransportHandlers): void {
    this.handlers = h;
    this.dir = h.directory;
    this.offs.push(h.directory.onWanted((peers) => this.reconcile(peers)));
    this.offs.push(
      h.directory.onSignal(
        (from, data) => void this.onSignal(from, data as Signal)
      )
    );
    this.reconcile(h.directory.wanted());
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const t of this.redials.values()) clearTimeout(t);
    this.redials.clear();
    for (const id of [...this.links.keys()]) this.drop(id);
    this.handlers = null;
    this.dir = null;
  }

  private wanted(id: string): boolean {
    return this.dir?.wanted().includes(id) ?? false;
  }

  private reconcile(peers: string[]): void {
    const self = this.dir?.self;
    if (!self) return;
    const want = new Set(peers);
    for (const id of want)
      if (!this.links.has(id) && self < id) void this.dial(id);
    for (const id of [...this.links.keys()]) if (!want.has(id)) this.drop(id);
  }

  private newLink(id: string): Link {
    const PC = this.opts.RTCPeerConnection ?? RTCPeerConnection;
    const pc = new PC({ iceServers: this.opts.iceServers ?? [] });
    const link: Link = {
      pc,
      reliable: null,
      lossy: null,
      announced: false,
      remoteSet: false,
      pendingIce: [],
    };
    this.links.set(id, link);
    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.signal(id, { kind: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        if (this.links.get(id) !== link) return;
        this.drop(id);
        this.scheduleRedial(id);
      }
    };
    pc.ondatachannel = (e) => this.wire(id, link, e.channel);
    return link;
  }

  private async dial(id: string): Promise<void> {
    const link = this.newLink(id);
    this.wire(id, link, link.pc.createDataChannel('mesh', { ordered: true }));
    this.wire(
      id,
      link,
      link.pc.createDataChannel('mesh-lossy', {
        ordered: false,
        maxRetransmits: 0,
      })
    );
    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    this.signal(id, { kind: 'offer', sdp: link.pc.localDescription! });
  }

  private scheduleRedial(id: string): void {
    const self = this.dir?.self;
    if (!self || self >= id || this.redials.has(id)) return;
    this.redials.set(
      id,
      setTimeout(() => {
        this.redials.delete(id);
        if (this.wanted(id) && !this.links.has(id)) void this.dial(id);
      }, this.opts.redialMs ?? 2000)
    );
  }

  private async onSignal(from: string, data: Signal): Promise<void> {
    if (!this.wanted(from)) return;
    if (data.kind === 'offer') {
      // A fresh offer replaces whatever link we had (the dialer restarted).
      if (this.links.has(from)) this.drop(from);
      const link = this.newLink(from);
      await link.pc.setRemoteDescription(data.sdp);
      link.remoteSet = true;
      this.flushIce(link);
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      this.signal(from, { kind: 'answer', sdp: link.pc.localDescription! });
    } else if (data.kind === 'answer') {
      const link = this.links.get(from);
      if (!link || link.remoteSet) return;
      await link.pc.setRemoteDescription(data.sdp);
      link.remoteSet = true;
      this.flushIce(link);
    } else if (data.kind === 'ice') {
      const link = this.links.get(from);
      if (!link) return;
      if (link.remoteSet)
        await link.pc.addIceCandidate(data.candidate).catch(() => {});
      else link.pendingIce.push(data.candidate);
    }
  }

  private flushIce(link: Link): void {
    for (const c of link.pendingIce.splice(0))
      void link.pc.addIceCandidate(c).catch(() => {});
  }

  private wire(id: string, link: Link, dc: RTCDataChannel): void {
    if (dc.label === 'mesh-lossy') link.lossy = dc;
    else link.reliable = dc;
    dc.onopen = () => {
      if (dc !== link.reliable || link.announced) return;
      if (this.links.get(id) !== link) return;
      link.announced = true;
      this.handlers?.peerConnected(id, {
        send: (m: MeshMessage) => {
          if (dc.readyState === 'open') dc.send(encode(m));
        },
        sendLossy: (m: MeshMessage) => {
          const ch = link.lossy?.readyState === 'open' ? link.lossy : dc;
          if (ch.readyState === 'open') ch.send(encode(m));
        },
      });
    };
    dc.onclose = () => {
      if (dc === link.reliable && this.links.get(id) === link) {
        this.drop(id);
        this.scheduleRedial(id);
      }
    };
    dc.onmessage = (e) => {
      if (!link.announced) return;
      let msg: MeshMessage;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (typeof (msg as { t?: unknown }).t === 'string')
        this.handlers?.message(id, msg);
    };
  }

  private drop(id: string): void {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    try {
      link.reliable?.close();
      link.lossy?.close();
      link.pc.close();
    } catch {
      /* already closed */
    }
    if (link.announced) this.handlers?.peerDisconnected(id);
  }

  private signal(to: string, data: Signal): void {
    this.dir?.signal(to, data);
  }
}
