/**
 * Who may dial whom (principle 8): rosters and link-setup signaling.
 *
 * Two servers share (S1 grants S2); each has a tab. A server tells the server
 * it shares with which of its participants are connected, and tells its own
 * participants what it heard. A transport that dials (WebRTC) reads that as
 * `directory.wanted()` and sends its offers through `directory.signal`, which
 * the mesh routes over the servers in between.
 */
import { describe, expect, it } from 'vitest';
import { createLoopbackPair, type LoopbackPair } from '../src/loopback.js';
import { createMeshPeer } from '../src/peer.js';
import type {
  MeshTransport,
  PeerDirectory,
  PeerLink,
} from '../src/transport.js';
import type { MeshMessage } from '../src/wire.js';

/** A transport that only captures the directory it is handed. */
function probe(): MeshTransport & { dir: () => PeerDirectory } {
  let dir: PeerDirectory | undefined;
  return {
    start: (h) => {
      dir = h.directory;
    },
    stop: () => {},
    dir: () => dir!,
  };
}

/** Wraps a transport and keeps the link it hands the peer, so a test can
 *  send raw messages as that peer. */
function captured(t: MeshTransport): MeshTransport & { link: () => PeerLink } {
  let link: PeerLink | undefined;
  return {
    start: (h) =>
      t.start({
        ...h,
        peerConnected: (id, l) => {
          link = l;
          h.peerConnected(id, l);
        },
      }),
    stop: () => t.stop(),
    link: () => link!,
  };
}

const ALL = { read: true, update: true, create: true, delete: true };
const grant = (grantee: string) => ({
  grantee,
  entityRtype: 'doc',
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
  rights: ALL,
});

function world(opts: { share?: boolean } = {}) {
  const pairs: LoopbackPair[] = [];
  const link = (x: string, y: string) => {
    const lb = createLoopbackPair(x, y);
    pairs.push(lb);
    return lb;
  };
  const s1s2 = link('S1', 'S2');
  const s1a = link('S1', 'S1#a');
  const s2b = link('S2', 'S2#b');
  const s1 = createMeshPeer({
    identity: { peerId: 'S1' },
    transports: [s1s2.a, s1a.a],
  });
  const s2 = createMeshPeer({
    identity: { peerId: 'S2' },
    transports: [s1s2.b, s2b.a],
  });
  const pa = probe();
  const pb = probe();
  const bToS2 = captured(s2b.b);
  const a = createMeshPeer({
    identity: { peerId: 'S1#a' },
    transports: [s1a.b, pa],
  });
  const b = createMeshPeer({
    identity: { peerId: 'S2#b' },
    transports: [bToS2, pb],
  });
  const share = opts.share === false ? null : s1.grants.grant(grant('S2'));
  const flush = async () => {
    for (let i = 0; i < 6; i++) for (const p of pairs) await p.flush();
  };
  return { s1, s2, a, b, pa, pb, share, link, flush, bToS2 };
}

describe('rosters', () => {
  it("tabs of servers that share learn each other's ids, both ways", async () => {
    const t = world();
    await t.flush();
    expect(t.pa.dir().wanted()).toEqual(['S2#b']);
    expect(t.pb.dir().wanted()).toEqual(['S1#a']);
    expect(t.pa.dir().self).toBe('S1#a');
  });

  it('servers that share nothing tell each other nothing', async () => {
    const t = world({ share: false });
    await t.flush();
    expect(t.pa.dir().wanted()).toEqual([]);
    expect(t.pb.dir().wanted()).toEqual([]);
  });

  it('revoking the share withdraws the roster; a new tab joins it', async () => {
    const t = world();
    await t.flush();
    const seen: string[][] = [];
    t.pb.dir().onWanted((p) => seen.push(p));

    const s1c = t.link('S1', 'S1#c');
    t.s1.addTransport(s1c.a);
    createMeshPeer({ identity: { peerId: 'S1#c' }, transports: [s1c.b] });
    await t.flush();
    expect(t.pb.dir().wanted()).toEqual(['S1#a', 'S1#c']);

    t.s1.grants.revoke(t.share!);
    await t.flush();
    expect(t.pb.dir().wanted()).toEqual([]);
    expect(seen.at(-1)).toEqual([]);
  });
});

describe('signaling', () => {
  it('link-setup data reaches the other tab through both servers', async () => {
    const t = world();
    await t.flush();
    const got: { from: string; data: unknown }[] = [];
    t.pb.dir().onSignal((from, data) => got.push({ from, data }));
    t.pa.dir().signal('S2#b', { kind: 'offer', sdp: 'x' });
    await t.flush();
    expect(got).toEqual([{ from: 'S1#a', data: { kind: 'offer', sdp: 'x' } }]);
  });

  it('a tab cannot speak for someone else', async () => {
    const t = world();
    await t.flush();
    const got: string[] = [];
    t.pa.dir().onSignal((from) => got.push(from));
    // B's own link to S2 carries a signal claiming another tab sent it.
    const forged: MeshMessage = {
      t: 'signal',
      to: 'S1#a',
      from: 'S1#z',
      data: 'evil',
    };
    t.bToS2.link().send(forged);
    await t.flush();
    expect(got).toEqual([]);
  });
});
