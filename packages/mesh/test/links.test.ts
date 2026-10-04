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
