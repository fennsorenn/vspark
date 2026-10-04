/**
 * Direct links and link state (principle 8).
 *
 * Two servers: S1 holds the documents and grants S2 rights on them (a shared
 * space); tab A belongs to S1, tab B to S2. A and B may also hold a direct
 * link — what a WebRTC link will be; here it is just another loopback
 * transport, since the mesh is transport-agnostic.
 *
 * Nothing here subscribes to a particular peer. B learns from S2 which grants
 * concern it (including the one S1 gave S2), so once the direct link is up, A —
 * a participant of the grantor — is a source for B, and A serves B on S1's
 * behalf with the grants S1 delegated to it. B tells S2 it gets A's traffic
 * first-hand, so S2 stops relaying A's LOSSY ops to B; reliable traffic keeps
 * flowing through the servers as the path that survives a direct link
 * dropping silently, and duplicates apply once.
 */
import { describe, expect, it } from 'vitest';
import { createLoopbackPair, type LoopbackPair } from '../src/loopback.js';
import { createMeshPeer } from '../src/peer.js';
import type { MeshMessage, OpEnvelope } from '../src/wire.js';
import type { MeshTransport } from '../src/transport.js';

interface Doc {
  id: string;
  x?: number;
  [k: string]: unknown;
}

/** Records what a transport delivers, with the link it came over. */
function recorded(
  t: MeshTransport,
  seen: { from: string; msg: MeshMessage }[]
): MeshTransport {
  return {
    start: (h) =>
      t.start({
        ...h,
        message: (peer, msg) => {
          seen.push({ from: peer, msg });
          h.message(peer, msg);
        },
      }),
    stop: () => t.stop(),
  };
}

const ALL = { read: true, update: true, create: true, delete: true };
const grant = (
  grantee: string,
  rtype: string,
  rights: Record<string, boolean> = ALL
) => ({
  grantee,
  entityRtype: rtype,
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
  rights,
});
const sub = (rtype: string, channels?: string[]) => ({
  entityRtype: rtype,
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
  ...(channels ? { channels } : {}),
});

function square() {
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
  const atB: { from: string; msg: MeshMessage }[] = [];
  const a = createMeshPeer({
    identity: { peerId: 'S1#a' },
    transports: [s1a.b],
  });
  const b = createMeshPeer({
    identity: { peerId: 'S2#b' },
    transports: [recorded(s2b.b, atB)],
  });
  const s1Docs = s1.collection<Doc>('doc');
  s2.collection<Doc>('doc');
  const aDocs = a.collection<Doc>('doc');
  const bDocs = b.collection<Doc>('doc');
  // Each server's tabs may do everything; S1 shares its docs with S2.
  const s2Grant = s1.grants.grant(grant('S2', 'doc'));
  s1.grants.grant(grant('S1', 'doc'));
  s2.grants.grant(grant('S2', 'doc'));

  let direct: LoopbackPair | undefined;
  const linkDirect = () => {
    direct = link('S1#a', 'S2#b');
    a.addTransport(direct.a);
    b.addTransport(recorded(direct.b, atB));
  };
  const flush = async () => {
    for (let i = 0; i < 6; i++) for (const p of pairs) await p.flush();
  };
  return {
    s1,
    s2,
    a,
    b,
    s1Docs,
    aDocs,
    bDocs,
    s2Grant,
    atB,
    linkDirect,
    direct: () => direct!,
    link,
    flush,
  };
}

/** How many ops of `origin` reached B over the link to `from`. */
const arrived = (
  seen: { from: string; msg: MeshMessage }[],
  from: string,
  origin: string,
  ch?: string
) =>
  seen.filter(
    ({ from: f, msg: m }) =>
      f === from &&
      m.t === 'op' &&
      m.origin === origin &&
      (ch === undefined || m.ch === ch)
  ).length;

async function shared() {
  const t = square();
  t.s1Docs.create({ id: 'd1', x: 0 });
  await t.flush();
  await t.s2.subscribe(sub('doc'));
  await t.a.subscribe(sub('doc'));
  const subB = await t.b.subscribe(sub('doc'));
  await t.flush();
  return { ...t, subB };
}

describe('sources follow grants', () => {
  it('a subscription is served by whoever granted it, without naming them', async () => {
    const t = await shared();
    expect(t.bDocs.get('d1')?.x).toBe(0); // S1 → S2 → B
    t.aDocs.set('d1', 'x', 3);
    await t.flush();
    expect(t.bDocs.get('d1')?.x).toBe(3);
  });

  it("a direct link makes the grantor's participant a source too", async () => {
    const t = await shared();
    expect(t.subB.sources()).toEqual(['S2']);
    t.linkDirect();
    await t.flush();
    expect(t.subB.sources().sort()).toEqual(['S1#a', 'S2']);
  });

  it('tabs of one server do not subscribe to each other', async () => {
    const t = await shared();
    const lbZ = t.link('S1', 'S1#z');
    const az = t.link('S1#a', 'S1#z');
    const z = createMeshPeer({
      identity: { peerId: 'S1#z' },
      transports: [lbZ.b, az.b],
    });
    t.s1.addTransport(lbZ.a);
    t.a.addTransport(az.a);
    z.collection<Doc>('doc');
    await t.flush();
    const s = await z.subscribe(sub('doc'));
    await t.flush();
    expect(s.sources()).toEqual(['S1']);
  });
});

describe('link state', () => {
  it('the server stops relaying lossy traffic a tab gets directly', async () => {
    const t = await shared();
    // Without a direct link, A's previews reach B through S2.
    t.aDocs.set('d1', 'x', 1, { channel: 'preview' });
    await t.flush();
    expect(arrived(t.atB, 'S2', 'S1#a', 'preview')).toBe(1);
    expect(t.bDocs.get('d1')?.x).toBe(1);

    t.linkDirect();
    await t.flush();
    t.atB.length = 0;
    t.aDocs.set('d1', 'x', 2, { channel: 'preview' });
    await t.flush();
    expect(arrived(t.atB, 'S2', 'S1#a', 'preview')).toBe(0); // not relayed
    expect(arrived(t.atB, 'S1#a', 'S1#a', 'preview')).toBe(1); // first-hand
    expect(t.bDocs.get('d1')?.x).toBe(2);
  });

  it('reliable traffic still flows through the servers', async () => {
    const t = await shared();
    t.linkDirect();
    await t.flush();
    t.atB.length = 0;
    expect((await t.aDocs.set('d1', 'x', 5).ack).status).toBe('acked');
    await t.flush();
    expect(arrived(t.atB, 'S2', 'S1#a')).toBe(1);
    expect(t.bDocs.get('d1')?.x).toBe(5);
  });

  it('relaying resumes when the direct link drops', async () => {
    const t = await shared();
    t.linkDirect();
    await t.flush();
    t.direct().disconnect();
    await t.flush();
    t.atB.length = 0;
    t.aDocs.set('d1', 'x', 9, { channel: 'preview' });
    await t.flush();
    expect(arrived(t.atB, 'S2', 'S1#a', 'preview')).toBe(1);
    expect(t.bDocs.get('d1')?.x).toBe(9);
  });

  it('an addressed message takes the direct link when there is one', async () => {
    const t = await shared();
    const aCmds = t.a.collection<Doc>('cmd', { channels: ['control'] });
    const bCmds = t.b.collection<Doc>('cmd', { channels: ['control'] });
    t.s1.collection<Doc>('cmd', { channels: ['control'] });
    t.s2.collection<Doc>('cmd', { channels: ['control'] });
    t.s1.grants.grant(grant('S2', 'cmd', { read: true }));
    t.linkDirect();
    await t.flush();
    const got: unknown[] = [];
    bCmds.observe('**', (c) => got.push(c.doc));
    t.atB.length = 0;
    aCmds.set('go', '', { id: 'go' }, { channel: 'control', to: 'S2#b' });
    await t.flush();
    expect(got).toHaveLength(1);
    expect(arrived(t.atB, 'S1#a', 'S1#a', 'control')).toBe(1);
    expect(arrived(t.atB, 'S2', 'S1#a', 'control')).toBe(0);
  });
});

describe('direct links and grants', () => {
  it('a tab does not relay what it receives to its own direct subscribers', async () => {
    const t = await shared();
    t.linkDirect();
    await t.flush();
    t.atB.length = 0;
    t.s1Docs.set('d1', 'x', 1, { channel: 'preview' });
    await t.flush();
    expect(t.aDocs.get('d1')?.x).toBe(1);
    expect(arrived(t.atB, 'S1#a', 'S1')).toBe(0); // A forwards nothing
    expect(t.bDocs.get('d1')?.x).toBe(1); // B got it through S2
  });

  it('a peer whose server granted us nothing cannot write into our replica', async () => {
    const t = await shared();
    const lb = t.link('S3#c', 'S2#b');
    t.b.addTransport(lb.b);
    const forged: OpEnvelope = {
      t: 'op',
      rtype: 'doc',
      op: 'patch',
      id: 'd1',
      path: 'x',
      data: 666,
      origin: 'S3#c',
      ch: 'preview',
      qe: 1,
      q: 1,
    };
    lb.a.start({
      peerConnected: (_id, link) => link.send(forged),
      peerDisconnected: () => {},
      message: () => {},
    });
    await t.flush();
    expect(t.bDocs.get('d1')?.x).toBe(0);
  });

  it('a direct subscriber is served under the grants its server delegated, and loses them with the grant', async () => {
    const t = await shared();
    t.linkDirect();
    await t.flush();
    t.atB.length = 0;
    t.aDocs.set('d1', 'x', 4, { channel: 'preview' });
    await t.flush();
    expect(arrived(t.atB, 'S1#a', 'S1#a', 'preview')).toBe(1);

    t.s1.grants.revoke(t.s2Grant); // S1 no longer shares with S2
    await t.flush();
    t.atB.length = 0;
    t.aDocs.set('d1', 'x', 7, { channel: 'preview' });
    await t.flush();
    expect(arrived(t.atB, 'S1#a', 'S1#a')).toBe(0);
    expect(arrived(t.atB, 'S2', 'S1#a')).toBe(0);
    expect(t.bDocs.get('d1')?.x).not.toBe(7);
  });
});

describe('subscriptions survive reconnects', () => {
  it('are renewed when the link returns, and catch up on what was missed', async () => {
    const lb = createLoopbackPair('S', 'S#t');
    const s = createMeshPeer({ identity: { peerId: 'S' }, transports: [lb.a] });
    const t = createMeshPeer({
      identity: { peerId: 'S#t' },
      transports: [lb.b],
    });
    const sd = s.collection<Doc>('doc');
    s.grants.grant(grant('S', 'doc'));
    const td = t.collection<Doc>('doc');
    sd.create({ id: 'd1', x: 1 });
    await t.subscribe(sub('doc'));
    expect(td.get('d1')?.x).toBe(1);

    lb.disconnect();
    sd.set('d1', 'x', 2); // missed while offline
    lb.connect();
    await lb.flush();
    await lb.flush();
    expect(td.get('d1')?.x).toBe(2); // snapshot of the renewed subscription

    sd.set('d1', 'x', 3); // and live again
    await lb.flush();
    expect(td.get('d1')?.x).toBe(3);
  });
});
