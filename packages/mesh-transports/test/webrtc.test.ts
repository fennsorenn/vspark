/**
 * Direct links between tabs of two servers that share, over WebRtcTransport.
 *
 * Node has no WebRTC, so a fake RTCPeerConnection stands in: an offer and its
 * answer pair two fakes, and the data channels the dialer created open on both
 * sides. Everything else is real — the servers' rosters tell each tab whom to
 * dial, and the offer/answer travel through the mesh (tab → server → server →
 * tab) as signals.
 */
import { describe, expect, it } from 'vitest';
import {
  createLoopbackPair,
  createMeshPeer,
  type LoopbackPair,
} from '@vspark/mesh';
import { WebRtcTransport } from '../src/webrtc.js';

// --- a minimal in-memory RTCPeerConnection ------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeChannel {
  readyState: RTCDataChannelState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  other: FakeChannel | null = null;
  constructor(readonly label: string) {}
  send(data: string): void {
    const o = this.other;
    if (this.readyState !== 'open' || !o) return;
    setTimeout(() => o.readyState === 'open' && o.onmessage?.({ data }), 0);
  }
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    this.other?.close();
  }
}

const offers = new Map<string, FakePC>();
let nextSdp = 0;

/** The ICE servers each connection was created with. */
const configs: RTCIceServer[][] = [];

class FakePC {
  constructor(cfg: RTCConfiguration) {
    configs.push(cfg.iceServers ?? []);
  }
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((e: { candidate: null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  private readonly channels: FakeChannel[] = [];
  private peer: FakePC | null = null;

  createDataChannel(label: string): FakeChannel {
    const ch = new FakeChannel(label);
    this.channels.push(ch);
    return ch;
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: `sdp-${nextSdp++}` };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: `sdp-${nextSdp++}` };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
    if (d.type === 'offer') offers.set(d.sdp!, this);
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    if (d.type === 'offer') {
      this.peer = offers.get(d.sdp!) ?? null;
      if (this.peer) this.peer.peer = this;
      return;
    }
    // The answer arrived at the dialer: connect.
    const remote = this.peer;
    if (!remote) return;
    await tick();
    for (const mine of this.channels) {
      const theirs = new FakeChannel(mine.label);
      mine.other = theirs;
      theirs.other = mine;
      remote.channels.push(theirs);
      remote.ondatachannel?.({ channel: theirs });
    }
    this.connectionState = remote.connectionState = 'connected';
    for (const ch of [...this.channels, ...remote.channels]) ch.open();
  }
  async addIceCandidate() {}
  close(): void {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    for (const ch of this.channels) ch.close();
    this.peer?.close();
  }
}

// --- the world: two servers that share, a tab on each -------------------------

const ALL = { read: true, update: true, create: true, delete: true };
const grant = (grantee: string) => ({
  grantee,
  entityRtype: 'doc',
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
  rights: ALL,
});
const sub = {
  entityRtype: 'doc',
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
};

function world() {
  const pairs: LoopbackPair[] = [];
  const link = (x: string, y: string) => {
    const lb = createLoopbackPair(x, y);
    pairs.push(lb);
    return lb;
  };
  const s1s2 = link('S1', 'S2');
  const s1a = link('S1', 'S1#a');
  const s2b = link('S2', 'S2#b');
  const ice = { current: [{ urls: 'stun:one' }] as RTCIceServer[] };
  const rtc = () =>
    new WebRtcTransport({
      RTCPeerConnection: FakePC as unknown as typeof RTCPeerConnection,
      iceServers: () => ice.current,
    });
  const s1 = createMeshPeer({
    identity: { peerId: 'S1' },
    transports: [s1s2.a, s1a.a],
  });
  const s2 = createMeshPeer({
    identity: { peerId: 'S2' },
    transports: [s1s2.b, s2b.a],
  });
  const a = createMeshPeer({
    identity: { peerId: 'S1#a' },
    transports: [s1a.b, rtc()],
  });
  const b = createMeshPeer({
    identity: { peerId: 'S2#b' },
    transports: [s2b.b, rtc()],
  });
  const s1Docs = s1.collection<{ id: string; x: number }>('doc');
  s2.collection('doc');
  a.collection('doc');
  const bDocs = b.collection<{ id: string; x: number }>('doc');
  s1.grants.grant(grant('S1'));
  s2.grants.grant(grant('S2'));
  const share = s1.grants.grant(grant('S2'));
  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      for (const p of pairs) await p.flush();
      await tick();
    }
  };
  return { s1, s2, a, b, s1Docs, bDocs, share, settle, ice };
}

describe('WebRtcTransport', () => {
  it('tabs of servers that share link directly and serve each other', async () => {
    const t = world();
    t.s1Docs.create({ id: 'd1', x: 1 });
    await t.settle();
    await t.s2.subscribe(sub);
    await t.a.subscribe(sub);
    const subB = await t.b.subscribe(sub);
    await t.settle();

    expect(t.a.status().peers.map((p) => p.id)).toContain('S2#b');
    expect(subB.sources().sort()).toEqual(['S1#a', 'S2']);
    expect(t.bDocs.get('d1')?.x).toBe(1);
    // B's server learns that B gets A's traffic first-hand.
    expect(t.s2.status().direct['S2#b']).toEqual(['S1#a']);
  });

  it('the link goes when the share does', async () => {
    const t = world();
    await t.settle();
    expect(t.b.status().peers.map((p) => p.id)).toContain('S1#a');
    t.s1.grants.revoke(t.share);
    await t.settle();
    expect(t.b.status().peers.map((p) => p.id)).toEqual(['S2']);
    expect(t.a.status().peers.map((p) => p.id)).toEqual(['S1']);
  });

  it('each new connection reads the current ICE servers', async () => {
    const t = world();
    await t.settle();
    expect(configs.at(-1)).toEqual([{ urls: 'stun:one' }]);
    // Credentials refreshed; the share is withdrawn and restored.
    t.ice.current = [{ urls: 'turn:two', username: 'u', credential: 'c' }];
    t.s1.grants.revoke(t.share);
    await t.settle();
    t.s1.grants.grant(grant('S2'));
    await t.settle();
    expect(t.b.status().peers.map((p) => p.id)).toContain('S1#a');
    expect(configs.at(-1)).toEqual(t.ice.current);
  });
});
