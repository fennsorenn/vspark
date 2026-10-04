/**
 * Direct links and link state (principle 8). Tabs A and B of server S also
 * hold a direct link to each other — what a WebRTC link will be; here it is
 * just another loopback transport, since the mesh is transport-agnostic.
 *
 * B tells S it reaches A directly, so S stops relaying A's LOSSY traffic to B
 * (B has it first-hand); reliable traffic keeps flowing through S as the path
 * that survives a direct link dropping silently. Duplicates that do arrive
 * over both paths apply once.
 */
import { describe, expect, it } from 'vitest';
import { createLoopbackPair } from '../src/loopback.js';
import { createMeshPeer, type MeshPeer } from '../src/peer.js';
import type { Collection } from '../src/collection.js';
import type { MeshMessage } from '../src/wire.js';
import type { MeshTransport } from '../src/transport.js';

interface Doc {
  id: string;
  x?: number;
  [k: string]: unknown;
}

/** Counts the ops a transport delivers, by origin. */
function counted(t: MeshTransport, seen: MeshMessage[]): MeshTransport {
  return {
    start: (h) =>
      t.start({
        ...h,
        message: (peer, msg) => {
          seen.push(msg);
          h.message(peer, msg);
        },
      }),
    stop: () => t.stop(),
  };
}

const ALL = { read: true, update: true, create: true, delete: true };
const sub = (rtype: string, channels?: string[]) => ({
  entityRtype: rtype,
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
  ...(channels ? { channels } : {}),
});

function triangle() {
  const s = createMeshPeer({ identity: { peerId: 'S' } });
  const sDocs = s.collection<Doc>('doc', { clients: ALL });
  const viaServer: MeshMessage[] = [];
  const peers: Record<string, { peer: MeshPeer; col: Collection<Doc> }> = {};
  const flushes: (() => Promise<void>)[] = [];
  for (const name of ['a', 'b']) {
    const id = `S#${name}`;
    const lb = createLoopbackPair('S', id);
    s.addTransport(lb.a);
    const peer = createMeshPeer({
      identity: { peerId: id },
      home: 'S',
      transports: [name === 'b' ? counted(lb.b, viaServer) : lb.b],
    });
    peers[name] = {
      peer,
      col: peer.collection<Doc>('doc', { authority: 'S' }),
    };
    flushes.push(lb.flush);
  }
  const direct = createLoopbackPair('S#a', 'S#b');
  const linkDirect = () => {
    peers.a.peer.addTransport(direct.a);
    peers.b.peer.addTransport(direct.b);
  };
  // A serves B directly: A's grants come from S (delivered at link setup in
  // the app); here A grants B by hand.
  peers.a.peer.grants.grant({
    grantee: 'S#b',
    entityRtype: 'doc',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true },
  });
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      for (const f of flushes) await f();
      await direct.flush();
    }
  };
  return {
    s,
    sDocs,
    a: peers.a,
    b: peers.b,
    viaServer,
    linkDirect,
    direct,
    flush,
  };
}

const previewsFrom = (msgs: MeshMessage[], origin: string) =>
  msgs.filter((m) => m.t === 'op' && m.origin === origin && m.ch === 'preview')
    .length;

describe('link state', () => {
  it('the server stops relaying lossy traffic a tab gets directly', async () => {
    const t = triangle();
    t.sDocs.create({ id: 'd1', x: 0 });
    await t.b.peer.subscribe('S', sub('doc', ['preview']));
    await t.a.peer.subscribe('S', sub('doc', ['preview']));

    // Without a direct link, A's previews reach B through S.
    t.a.col.set('d1', 'x', 1, { channel: 'preview' });
    await t.flush();
    expect(previewsFrom(t.viaServer, 'S#a')).toBe(1);
    expect(t.b.col.get('d1')?.x).toBe(1);

    // Link A and B directly; B subscribes to A for the lossy channel.
    t.linkDirect();
    await t.flush();
    await t.b.peer.subscribe('S#a', sub('doc', ['preview']));
    t.viaServer.length = 0;

    t.a.col.set('d1', 'x', 2, { channel: 'preview' });
    await t.flush();
    expect(previewsFrom(t.viaServer, 'S#a')).toBe(0); // not relayed
    expect(t.b.col.get('d1')?.x).toBe(2); // arrived directly
  });

  it('reliable traffic still flows through the server', async () => {
    const t = triangle();
    t.sDocs.create({ id: 'd1', x: 0 });
    await t.b.peer.subscribe('S', sub('doc'));
    await t.a.peer.subscribe('S', sub('doc'));
    t.linkDirect();
    await t.flush();
    t.viaServer.length = 0;
    expect((await t.a.col.set('d1', 'x', 5).ack).status).toBe('acked');
    await t.flush();
    expect(
      t.viaServer.filter((m) => m.t === 'op' && m.origin === 'S#a').length
    ).toBe(1);
    expect(t.b.col.get('d1')?.x).toBe(5);
  });

  it('relaying resumes when the direct link drops', async () => {
    const t = triangle();
    t.sDocs.create({ id: 'd1', x: 0 });
    await t.b.peer.subscribe('S', sub('doc', ['preview']));
    t.linkDirect();
    await t.flush();
    t.direct.disconnect();
    await t.flush();
    t.viaServer.length = 0;
    t.a.col.set('d1', 'x', 9, { channel: 'preview' });
    await t.flush();
    expect(previewsFrom(t.viaServer, 'S#a')).toBe(1);
    expect(t.b.col.get('d1')?.x).toBe(9);
  });

  it('an addressed message takes the direct link when there is one', async () => {
    const t = triangle();
    t.linkDirect();
    await t.flush();
    await t.b.peer.subscribe('S', sub('doc'));
    const cmds = t.b.peer.collection<Doc>('cmd', { channels: ['control'] });
    const aCmds = t.a.peer.collection<Doc>('cmd', { channels: ['control'] });
    t.b.peer.grants.grant({
      grantee: 'S#a',
      entityRtype: 'cmd',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
      rights: { read: true, update: true, create: true },
    });
    // The sender projects what it sends through the recipient's grants too.
    t.a.peer.grants.grant({
      grantee: 'S#b',
      entityRtype: 'cmd',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
      rights: { read: true },
    });
    const got: unknown[] = [];
    cmds.observe('**', (c) => got.push(c.doc));
    t.viaServer.length = 0;
    aCmds.set('go', '', { id: 'go' }, { channel: 'control', to: 'S#b' });
    await t.flush();
    expect(got).toHaveLength(1);
    expect(t.viaServer.filter((m) => m.t === 'op').length).toBe(0);
  });
});

describe('subscriptions survive reconnects', () => {
  it('are renewed when the link returns, and catch up on what was missed', async () => {
    const lb = createLoopbackPair('S', 'S#t');
    const s = createMeshPeer({ identity: { peerId: 'S' }, transports: [lb.a] });
    const t = createMeshPeer({
      identity: { peerId: 'S#t' },
      home: 'S',
      transports: [lb.b],
    });
    const sd = s.collection<Doc>('doc', { clients: ALL });
    const td = t.collection<Doc>('doc', { authority: 'S' });
    sd.create({ id: 'd1', x: 1 });
    await t.subscribe('S', sub('doc'));
    expect(td.get('d1')?.x).toBe(1);

    lb.disconnect();
    sd.set('d1', 'x', 2); // missed while offline
    lb.connect();
    await lb.flush();
    expect(td.get('d1')?.x).toBe(2); // snapshot of the renewed subscription

    sd.set('d1', 'x', 3); // and live again
    await lb.flush();
    expect(td.get('d1')?.x).toBe(3);
  });
});

describe('direct-link subscriptions', () => {
  it('an exact preview subscription gets previews only: no snapshot, no committed ops', async () => {
    const lb = createLoopbackPair('A', 'B');
    const a = createMeshPeer({ identity: { peerId: 'A' }, transports: [lb.a] });
    const b = createMeshPeer({ identity: { peerId: 'B' }, transports: [lb.b] });
    const da = a.collection<Doc>('doc');
    const db = b.collection<Doc>('doc');
    a.grants.grant({
      grantee: 'B',
      entityRtype: 'doc',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
      rights: { read: true },
    });
    da.create({ id: 'd1', x: 1 });
    await b.subscribe('A', { ...sub('doc', ['preview']), exact: true });
    expect(db.get('d1')).toBeUndefined(); // no snapshot over this link

    // B holds the committed doc through its own home, as a real tab does.
    db.put({ id: 'd1', x: 1 }, { v: { t: 1, c: 0, n: 'home' } });
    da.set('d1', 'x', 2); // committed: not on this subscription
    da.set('d1', 'x', 3, { channel: 'preview' });
    await lb.flush();
    expect(db.replica.raw('d1')?.x).toBe(1); // committed value untouched
    expect(db.get('d1')?.x).toBe(3); // the preview, over it
  });

  it('a tab does not relay what it receives to its own direct subscribers', async () => {
    const t = triangle();
    for (const p of [t.a.peer, t.b.peer])
      (p as unknown as { cfg: { relay?: boolean } }).cfg.relay = false;
    t.sDocs.create({ id: 'd1', x: 0 });
    await t.a.peer.subscribe('S', sub('doc', ['preview']));
    t.linkDirect();
    await t.flush();
    // B subscribes to A directly; S writes a preview. A gets it from S but
    // must not forward it to B (B isn't subscribed to S here).
    await t.b.peer.subscribe('S#a', {
      ...sub('doc', ['preview']),
      exact: true,
    });
    const atB: unknown[] = [];
    t.b.col.observe('**', (c) => atB.push(c));
    t.sDocs.set('d1', 'x', 1, { channel: 'preview' });
    await t.flush();
    expect(t.a.col.get('d1')?.x).toBe(1);
    expect(atB).toHaveLength(0);
    // What A itself authors does reach B directly.
    t.a.col.set('d1', 'x', 2, { channel: 'preview' });
    await t.flush();
    expect(atB).toHaveLength(1);
  });
});

describe('link state needs an active subscription', () => {
  it('a link with no subscription over it does not stop the relay', async () => {
    const t = triangle();
    t.sDocs.create({ id: 'd1', x: 0 });
    await t.b.peer.subscribe('S', sub('doc', ['preview']));
    t.linkDirect(); // linked, but B never subscribes to A (e.g. refused)
    await t.flush();
    t.viaServer.length = 0;
    t.a.col.set('d1', 'x', 7, { channel: 'preview' });
    await t.flush();
    expect(previewsFrom(t.viaServer, 'S#a')).toBe(1);
    expect(t.b.col.get('d1')?.x).toBe(7);
  });
});
