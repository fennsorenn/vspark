/**
 * Two-peer integration over the loopback transport: A is the durable
 * authority (with a fake-DB persistence tap), B a subscriber with a write
 * grant — the symmetric collab case from the design doc.
 */
import { describe, expect, it } from 'vitest';
import { createLoopbackPair } from '../src/loopback.js';
import { createMeshPeer, type MeshPeer } from '../src/peer.js';
import type { Collection } from '../src/collection.js';
import type { AppliedChange } from '../src/replica.js';

interface Node {
  id: string;
  name: string;
  parentId?: string | null;
  pos?: { x: number; y: number };
  val?: number;
  [k: string]: unknown;
}

interface Rig {
  a: MeshPeer;
  b: MeshPeer;
  na: Collection<Node>;
  nb: Collection<Node>;
  db: Map<string, Node>; // A's fake persistence
  flush: () => Promise<void>;
  disconnect: () => void;
  connect: () => void;
}

function rig(opts?: {
  validateA?: (data: unknown) => Node;
  subChannels?: string[];
}): Rig {
  const lb = createLoopbackPair('A', 'B');
  const a = createMeshPeer({
    identity: { peerId: 'A' },
    transports: [lb.a],
    ackTimeoutMs: 60,
  });
  const b = createMeshPeer({
    identity: { peerId: 'B' },
    transports: [lb.b],
    ackTimeoutMs: 60,
  });
  const parent = (n: Node) =>
    n.parentId ? { rtype: 'node', id: n.parentId } : null;
  const na = a.collection<Node>('node', {
    parent,
    authority: 'self',
    validate: opts?.validateA,
  });
  const nb = b.collection<Node>('node', { parent, authority: 'A' });

  const db = new Map<string, Node>();
  na.onCommitted((c: AppliedChange<Node>) => {
    if (c.op === 'remove') db.delete(c.id);
    else db.set(c.id, c.doc as Node);
  });

  a.grants.grant({
    grantee: 'B',
    entityRtype: 'node',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true, update: true, create: true, delete: true },
  });

  return {
    a,
    b,
    na,
    nb,
    db,
    flush: lb.flush,
    disconnect: lb.disconnect,
    connect: lb.connect,
  };
}

const subAll = (channels?: string[]) => ({
  entityRtype: 'node',
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
  channels,
});

describe('mesh peer pair', () => {
  it('subscribe delivers a snapshot, then live ops', async () => {
    const r = rig();
    r.na.create({ id: 'n1', name: 'first' });
    await r.b.subscribe('A', subAll());
    expect(r.nb.get('n1')?.name).toBe('first');

    r.na.set('n1', 'name', 'renamed');
    r.na.create({ id: 'n2', name: 'second' });
    await r.flush();
    expect(r.nb.get('n1')?.name).toBe('renamed');
    expect(r.nb.get('n2')?.name).toBe('second');
  });

  it('snapshot carries tombstones (deletions survive late join)', async () => {
    const r = rig();
    r.na.create({ id: 'gone', name: 'x' });
    r.na.remove('gone');
    // B has a stale copy from an out-of-band path; the snapshot must kill it.
    await r.b.subscribe('A', subAll());
    expect(r.nb.get('gone')).toBeUndefined();
  });

  it('granted subscriber writes converge AND persist on the authority', async () => {
    const r = rig();
    r.na.create({ id: 'n1', name: 'orig', pos: { x: 0, y: 0 } });
    await r.b.subscribe('A', subAll());

    const h = r.nb.update('n1', { name: 'edited-by-B' });
    expect(r.nb.get('n1')?.name).toBe('edited-by-B'); // optimistic
    const outcome = await h.ack;
    expect(outcome.status).toBe('acked');
    await r.flush();
    expect(r.na.get('n1')?.name).toBe('edited-by-B');
    expect(r.db.get('n1')?.name).toBe('edited-by-B'); // tap ran
  });

  it('REST-style local write on the authority resolves synchronously-ish and persists', async () => {
    const r = rig();
    const h = r.na.create({ id: 'n1', name: 'via-rest' });
    expect((await h.ack).status).toBe('acked');
    expect(r.db.get('n1')?.name).toBe('via-rest');
  });

  it("authority corrections supersede the writer's optimistic value", async () => {
    const r = rig({
      validateA: (data) => {
        const d = data as Node;
        return { ...d, val: Math.min(d.val ?? 0, 1) }; // clamp
      },
    });
    await r.b.subscribe('A', subAll());

    const h = r.nb.create({ id: 'n1', name: 'n', val: 5 });
    expect(r.nb.get('n1')?.val).toBe(5); // optimistic
    const outcome = await h.ack;
    expect(outcome.status).toBe('corrected');
    await r.flush();
    expect(r.nb.get('n1')?.val).toBe(1); // converged on the clamp
    expect(r.na.get('n1')?.val).toBe(1);
    expect(r.db.get('n1')?.val).toBe(1);
  });

  it('rejections roll back and converge on the authority value', async () => {
    const r = rig({
      validateA: (data) => {
        const d = data as Node;
        if (d.name === 'bad') throw new Error('name not allowed');
        return d;
      },
    });
    r.na.create({ id: 'n1', name: 'good' });
    await r.b.subscribe('A', subAll());

    const h = r.nb.set('n1', '', { id: 'n1', name: 'bad' });
    expect(r.nb.get('n1')?.name).toBe('bad'); // optimistic
    const outcome = await h.ack;
    expect(outcome.status).toBe('rejected');
    expect(r.nb.get('n1')?.name).toBe('good'); // rolled back + converged
    expect(r.na.get('n1')?.name).toBe('good');
  });

  it('gates guarded writes while the authority is down', async () => {
    const r = rig();
    r.na.create({ id: 'n1', name: 'x' });
    await r.b.subscribe('A', subAll());
    r.disconnect();
    expect(r.nb.canWrite()).toBe(false);
    const outcome = await r.nb.update('n1', { name: 'nope' }).ack;
    expect(outcome).toMatchObject({
      status: 'rejected',
      reason: 'authority-offline',
    });
    expect(r.nb.get('n1')?.name).toBe('x'); // never applied
  });

  it('ack timeout reverts the optimistic write (recency-gated)', async () => {
    const r = rig();
    r.na.create({ id: 'n1', name: 'before' });
    await r.b.subscribe('A', subAll());

    const h = r.nb.update('n1', { name: 'lost' }); // passes the gate…
    r.disconnect(); // …but the op dies on the wire
    expect(r.nb.get('n1')?.name).toBe('lost'); // optimistic
    const outcome = await h.ack;
    expect(outcome.status).toBe('reverted');
    expect(r.nb.get('n1')?.name).toBe('before');
  });

  it('ephemeral channel: overlays flow, nothing persists, committed clears', async () => {
    const r = rig();
    r.na.create({ id: 'n1', name: 'x', pos: { x: 0, y: 0 } });
    await r.b.subscribe('A', subAll());

    r.nb.set('n1', 'pos', { x: 9, y: 9 }, { channel: 'preview' });
    await r.flush();
    expect(r.na.get('n1')?.pos).toEqual({ x: 9, y: 9 }); // overlay visible
    expect(r.na.replica.raw('n1')?.pos).toEqual({ x: 0, y: 0 }); // not retained
    expect(r.db.get('n1')?.pos).toEqual({ x: 0, y: 0 }); // tap never ran

    const h = r.nb.set('n1', 'pos', { x: 5, y: 5 }); // landing write
    await h.ack;
    await r.flush();
    expect(r.na.replica.raw('n1')?.pos).toEqual({ x: 5, y: 5 });
    expect(r.db.get('n1')?.pos).toEqual({ x: 5, y: 5 });
  });

  it('committed-only subscriptions never see preview traffic', async () => {
    const r = rig();
    r.na.create({ id: 'n1', name: 'x', pos: { x: 0, y: 0 } });
    await r.b.subscribe('A', subAll(['committed']));

    r.na.set('n1', 'pos', { x: 7, y: 7 }, { channel: 'preview' });
    await r.flush();
    expect(r.nb.get('n1')?.pos).toEqual({ x: 0, y: 0 }); // preview filtered

    r.na.set('n1', 'pos', { x: 2, y: 2 }); // committed still arrives
    await r.flush();
    expect(r.nb.get('n1')?.pos).toEqual({ x: 2, y: 2 });
  });

  it('removes propagate and tombstone the subscriber replica', async () => {
    const r = rig();
    r.na.create({ id: 'n1', name: 'x' });
    await r.b.subscribe('A', subAll());
    expect(r.nb.get('n1')).toBeDefined();

    await r.nb.remove('n1').ack;
    await r.flush();
    expect(r.nb.get('n1')).toBeUndefined();
    expect(r.na.get('n1')).toBeUndefined();
    expect(r.db.has('n1')).toBe(false);
  });

  it('tree reads work over the containment feed', async () => {
    const r = rig();
    r.na.create({ id: 'root', name: 'root', parentId: null });
    r.na.create({ id: 'c1', name: 'child1', parentId: 'root' });
    r.na.create({ id: 'g1', name: 'grandchild', parentId: 'c1' });
    expect(r.na.children('root').map((n) => n.id)).toEqual(['c1']);
    expect(r.na.subtree('root').map((n) => n.id).sort()).toEqual([
      'c1',
      'g1',
      'root',
    ]);
  });

  it('ungranted peers cannot subscribe', async () => {
    const lb = createLoopbackPair('A', 'C');
    const a = createMeshPeer({ identity: { peerId: 'A' }, transports: [lb.a] });
    const c = createMeshPeer({ identity: { peerId: 'C' }, transports: [lb.b] });
    a.collection<Node>('node', {});
    c.collection<Node>('node', { authority: 'A' });
    await expect(c.subscribe('A', subAll())).rejects.toThrow(/denied/);
  });

  it('hydration puts restore stamps and skip the tap', async () => {
    const r = rig();
    r.na.put({ id: 'h1', name: 'from-db' }, { v: { t: 100, c: 0, n: 'A' } });
    expect(r.na.get('h1')?.name).toBe('from-db');
    expect(r.db.has('h1')).toBe(false); // tap skipped: data came FROM the db
    // A stale remote write older than the restored stamp must lose.
    expect(
      r.na.replica.upsert(
        'h1',
        { id: 'h1', name: 'stale' },
        { t: 50, c: 0, n: 'B' },
        { origin: 'B', channel: 'committed' }
      )
    ).toBeNull();
  });
});

describe('one-way place (read grant + subscribe, no write rights)', () => {
  function placeRig() {
    const lb = createLoopbackPair('O', 'R');
    const o = createMeshPeer({ identity: { peerId: 'O' }, transports: [lb.a] });
    const r = createMeshPeer({ identity: { peerId: 'R' }, transports: [lb.b] });
    const parent = (n: Node) =>
      n.parentId ? { rtype: 'node', id: n.parentId } : null;
    const no = o.collection<Node>('node', { parent, authority: 'self' });
    const nr = r.collection<Node>('node', { parent, authority: 'self' });
    no.create({ id: 'obj', name: 'avatar', parentId: null });
    no.create({ id: 'limb', name: 'arm', parentId: 'obj' });
    o.grants.grant({
      grantee: 'R',
      entityRtype: '*',
      entityId: 'obj',
      includeDescendants: true,
      pathPrefix: '',
      rights: { read: true },
    });
    return { o, r, no, nr, flush: lb.flush };
  }

  it("owner's docs + live edits flow; the receiver's writes never reach back", async () => {
    const t = placeRig();
    await t.r.subscribe('O', {
      entityRtype: '*',
      entityId: 'obj',
      includeDescendants: true,
      pathPrefix: '',
    });
    expect(t.nr.get('limb')?.name).toBe('arm'); // snapshot

    t.no.set('limb', 'name', 'leg'); // live op rides the subscription
    await t.flush();
    expect(t.nr.get('limb')?.name).toBe('leg');

    // Receiver-local write: applies locally (its own replica is its business)
    // but the owner has no subscription to R and R holds no write grant — the
    // op must not land on O.
    t.nr.set('limb', 'name', 'rogue');
    await t.flush();
    expect(t.no.get('limb')?.name).toBe('leg');
  });
});

describe('pure-stream collections (preview-only, routed by containment)', () => {
  it('frames keyed by another collection\'s ids ride subtree subscriptions', async () => {
    const lb = createLoopbackPair('A', 'B');
    const a = createMeshPeer({ identity: { peerId: 'A' }, transports: [lb.a] });
    const b = createMeshPeer({ identity: { peerId: 'B' }, transports: [lb.b] });
    const parent = (n: Node) =>
      n.parentId ? { rtype: 'node', id: n.parentId } : null;
    const na = a.collection<Node>('node', { parent });
    b.collection<Node>('node', { parent, authority: 'A' });
    interface Frame {
      id: string;
      kind: string;
      [k: string]: unknown;
    }
    const sa = a.collection<Frame>('stream', { channels: ['preview'] });
    const sb = b.collection<Frame>('stream', { channels: ['preview'] });
    const seen: Frame[] = [];
    sb.observe('**', (c) => {
      if (c.doc) seen.push(c.doc);
    });

    na.create({ id: 'root', name: 'scene', parentId: null });
    na.create({ id: 'avatar', name: 'av', parentId: 'root' });
    a.grants.grant({
      grantee: 'B',
      entityRtype: '*',
      entityId: 'root',
      includeDescendants: true,
      pathPrefix: '',
      rights: { read: true },
    });
    await b.subscribe('A', {
      entityRtype: '*',
      entityId: 'root',
      includeDescendants: true,
      pathPrefix: '',
    });

    // Frame keyed by a scene-node id: containment (from the 'node' collection)
    // routes it through the subtree subscription; nothing is retained.
    sa.set('avatar', '', { id: 'avatar', kind: 'pose' }, { channel: 'preview' });
    await lb.flush();
    expect(seen.map((f) => f.kind)).toEqual(['pose']);
    expect(sb.get('avatar')?.kind).toBe('pose'); // overlay composed
    expect(sb.replica.raw('avatar')).toBeUndefined(); // never retained

    // A frame keyed OUTSIDE the granted subtree never crosses.
    sa.set('elsewhere', '', { id: 'elsewhere', kind: 'x' }, { channel: 'preview' });
    await lb.flush();
    expect(sb.get('elsewhere')).toBeUndefined();
  });
});

describe('snapshot relay (subscribe-through topology)', () => {
  it("a server's tabs receive docs the server itself got via snapshot", async () => {
    // T(tab) — S(server) — O(owner): T subscribes to S first; S then
    // subscribes to O. O's snapshot must flow through to T.
    const st = createLoopbackPair('S', 'T');
    const so = createLoopbackPair('S', 'O');
    const s = createMeshPeer({ identity: { peerId: 'S' }, transports: [st.a] });
    const t = createMeshPeer({ identity: { peerId: 'T' }, transports: [st.b] });
    const o = createMeshPeer({ identity: { peerId: 'O' }, transports: [so.b] });
    s.addTransport(so.a);

    const parent = (n: Node) =>
      n.parentId ? { rtype: 'node', id: n.parentId } : null;
    const ns = s.collection<Node>('node', { parent });
    const nt = t.collection<Node>('node', { parent, authority: 'S' });
    const no = o.collection<Node>('node', { parent });

    no.create({ id: 'obj', name: 'shared', parentId: null });
    s.grants.grant({
      grantee: 'T',
      entityRtype: '*',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
      rights: { read: true, update: true, create: true, delete: true },
    });
    o.grants.grant({
      grantee: 'S',
      entityRtype: '*',
      entityId: 'obj',
      includeDescendants: true,
      pathPrefix: '',
      rights: { read: true },
    });

    await t.subscribe('S', subAll()); // tab first — replica empty
    expect(nt.get('obj')).toBeUndefined();

    await s.subscribe('O', {
      entityRtype: '*',
      entityId: 'obj',
      includeDescendants: true,
      pathPrefix: '',
    });
    expect(ns.get('obj')?.name).toBe('shared');
    await st.flush();
    await so.flush();
    expect(nt.get('obj')?.name).toBe('shared'); // snapshot relayed onward
  });
});

describe('subtree-scoped collab (grant on a root, not the rtype)', () => {
  it('admits creates of brand-new children under the granted subtree', async () => {
    const lb = createLoopbackPair('A', 'B');
    const a = createMeshPeer({ identity: { peerId: 'A' }, transports: [lb.a] });
    const b = createMeshPeer({ identity: { peerId: 'B' }, transports: [lb.b] });
    const parent = (n: Node) =>
      n.parentId ? { rtype: 'node', id: n.parentId } : null;
    const na = a.collection<Node>('node', { parent, authority: 'self' });
    const nb = b.collection<Node>('node', { parent, authority: 'A' });
    const db = new Map<string, Node>();
    na.onCommitted((c) => {
      if (c.op === 'remove') db.delete(c.id);
      else db.set(c.id, c.doc as Node);
    });

    na.create({ id: 'root', name: 'scene', parentId: null });
    na.create({ id: 'child', name: 'existing', parentId: 'root' });
    // Subtree grant — like a collab-scene link, NOT an entityId '*' grant.
    a.grants.grant({
      grantee: 'B',
      entityRtype: '*',
      entityId: 'root',
      includeDescendants: true,
      pathPrefix: '',
      rights: { read: true, update: true, create: true, delete: true },
    });
    await b.subscribe('A', {
      entityRtype: '*',
      entityId: 'root',
      includeDescendants: true,
      pathPrefix: '',
    });
    expect(nb.get('child')?.name).toBe('existing'); // snapshot covered subtree

    // The bug-3 case: a brand-new id, unknown to A's containment index, is
    // admitted because its parent reference places it inside the grant.
    const h = nb.create({ id: 'c-new', name: 'made-by-B', parentId: 'child' });
    expect((await h.ack).status).toBe('acked');
    expect(na.get('c-new')?.name).toBe('made-by-B');
    expect(db.get('c-new')?.name).toBe('made-by-B');

    // …and a create OUTSIDE the subtree is still denied.
    const h2 = nb.create({ id: 'rogue', name: 'nope', parentId: null });
    const outcome = await h2.ack;
    expect(outcome.status).not.toBe('acked');
    expect(na.get('rogue')).toBeUndefined();
    expect(db.has('rogue')).toBe(false);
  });
});
