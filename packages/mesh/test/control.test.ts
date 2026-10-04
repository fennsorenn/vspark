/**
 * The `control` channel: commands, delivered once, optionally addressed to one
 * participant, optionally answered.
 *
 * Topology: one server S with tabs T1, T2, T3 (`S#t1` …) — the star that the
 * routing seam (`nextHop`) resolves today. Tabs hold S as their home.
 */
import { describe, expect, it } from 'vitest';
import { createLoopbackPair } from '../src/loopback.js';
import { createMeshPeer, type MeshPeer } from '../src/peer.js';
import type { Collection } from '../src/collection.js';
import type { AppliedChange } from '../src/replica.js';
import type { MeshTransport } from '../src/transport.js';

interface Cmd {
  id: string;
  action?: string;
  n?: number;
  [k: string]: unknown;
}

/** Wraps a transport so every message it delivers arrives twice — the
 *  situation two delivery paths create. */
function doubled(t: MeshTransport): MeshTransport {
  return {
    start: (h) =>
      t.start({
        ...h,
        message: (peer, msg) => {
          h.message(peer, msg);
          h.message(peer, msg);
        },
      }),
    stop: () => t.stop(),
  };
}

function star(
  opts: { tabRights?: Record<string, boolean>; double?: string } = {}
) {
  const s = createMeshPeer({ identity: { peerId: 'S' }, transports: [] });
  const sCol = s.collection<Cmd>('cmd', {
    channels: ['control'],
    clients: opts.tabRights ?? { read: true, update: true, create: true },
  });
  const flushes: (() => Promise<void>)[] = [];
  const tabs: Record<string, { peer: MeshPeer; col: Collection<Cmd> }> = {};
  for (const name of ['t1', 't2', 't3']) {
    const id = `S#${name}`;
    const lb = createLoopbackPair('S', id);
    s.addTransport(lb.a);
    const peer = createMeshPeer({
      identity: { peerId: id },
      home: 'S',
      transports: [opts.double === name ? doubled(lb.b) : lb.b],
    });
    const col = peer.collection<Cmd>('cmd', {
      channels: ['control'],
      authority: 'S',
    });
    tabs[name] = { peer, col };
    flushes.push(lb.flush);
  }
  const flush = async () => {
    for (let i = 0; i < 3; i++) for (const f of flushes) await f();
  };
  const subscribeAll = async () => {
    for (const t of Object.values(tabs))
      await t.peer.subscribe('S', {
        entityRtype: 'cmd',
        entityId: '*',
        includeDescendants: false,
        pathPrefix: '',
      });
  };
  return { s, sCol, tabs, flush, subscribeAll };
}

function record(col: Collection<Cmd>): AppliedChange<Cmd>[] {
  const seen: AppliedChange<Cmd>[] = [];
  col.observe('**', (c) => seen.push(c));
  return seen;
}

describe('control: delivered once', () => {
  it('a command that arrives twice is applied once', async () => {
    const { sCol, tabs, flush, subscribeAll } = star({ double: 't1' });
    await subscribeAll();
    const seen = record(tabs.t1.col);
    sCol.set(
      'door',
      '',
      { id: 'door', action: 'open' },
      { channel: 'control' }
    );
    sCol.set(
      'door',
      '',
      { id: 'door', action: 'close' },
      { channel: 'control' }
    );
    await flush();
    expect(seen.map((c) => c.doc?.action)).toEqual(['open', 'close']);
  });

  it('a broadcast command reaches every subscribed tab', async () => {
    const { sCol, tabs, flush, subscribeAll } = star();
    await subscribeAll();
    const seen = [
      record(tabs.t1.col),
      record(tabs.t2.col),
      record(tabs.t3.col),
    ];
    sCol.set(
      'door',
      '',
      { id: 'door', action: 'open' },
      { channel: 'control' }
    );
    await flush();
    expect(seen.map((s) => s.length)).toEqual([1, 1, 1]);
  });
});

describe('control: addressed', () => {
  it('reaches only its addressee, through the server, without applying there', async () => {
    const { sCol, tabs, flush, subscribeAll } = star();
    await subscribeAll();
    const atServer = record(sCol);
    const at2 = record(tabs.t2.col);
    const at3 = record(tabs.t3.col);
    tabs.t1.col.set(
      'door',
      '',
      { id: 'door', action: 'open' },
      {
        channel: 'control',
        to: 'S#t2',
      }
    );
    await flush();
    expect(at2.map((c) => c.doc?.action)).toEqual(['open']);
    expect(at3).toHaveLength(0);
    expect(atServer).toHaveLength(0);
  });

  it('the server can address one of its tabs', async () => {
    const { sCol, tabs, flush, subscribeAll } = star();
    await subscribeAll();
    const at1 = record(tabs.t1.col);
    const at2 = record(tabs.t2.col);
    sCol.set(
      'door',
      '',
      { id: 'door', action: 'open' },
      { channel: 'control', to: 'S#t1' }
    );
    await flush();
    expect(at1).toHaveLength(1);
    expect(at2).toHaveLength(0);
  });

  it('refuses addressing on a channel that carries state', () => {
    const p = createMeshPeer({ identity: { peerId: 'P' } });
    const col = p.collection<Cmd>('doc');
    expect(() => col.set('x', '', { id: 'x' }, { to: 'Q' })).toThrow(
      /unstamped/
    );
  });

  it('is relayed only for a sender allowed to write the collection', async () => {
    const { tabs, flush, subscribeAll } = star({ tabRights: { read: true } });
    await subscribeAll();
    const at2 = record(tabs.t2.col);
    tabs.t1.col.set(
      'door',
      '',
      { id: 'door', action: 'open' },
      {
        channel: 'control',
        to: 'S#t2',
      }
    );
    await flush();
    expect(at2).toHaveLength(0);
  });
});

describe('control: request / reply', () => {
  it('a tab asks another tab and gets its answer', async () => {
    const { tabs, flush, subscribeAll } = star();
    await subscribeAll();
    tabs.t2.col.observe('**', (c) => {
      if (c.request) tabs.t2.col.reply(c, { id: c.id, n: (c.doc?.n ?? 0) * 2 });
    });
    const pending = tabs.t1.col.request(
      'calc',
      { id: 'calc', n: 21 },
      { to: 'S#t2' }
    );
    await flush();
    expect(await pending).toEqual({
      status: 'replied',
      data: { id: 'calc', n: 42 },
    });
  });

  it('the server asks a tab', async () => {
    const { sCol, tabs, flush, subscribeAll } = star();
    await subscribeAll();
    tabs.t1.col.observe('**', (c) => {
      if (c.request) tabs.t1.col.reply(c, { id: c.id, action: 'pong' });
    });
    const pending = sCol.request('ping', { id: 'ping' }, { to: 'S#t1' });
    await flush();
    expect(await pending).toMatchObject({
      status: 'replied',
      data: { action: 'pong' },
    });
  });

  it('a request to nobody reachable resolves unreachable', async () => {
    const { s, sCol, tabs, flush, subscribeAll } = star();
    await subscribeAll();
    expect(await sCol.request('x', { id: 'x' }, { to: 'nobody' })).toEqual({
      status: 'unreachable',
    });
    // From a tab: forwarded to the server, which reports it back.
    const pending = tabs.t1.col.request('x', { id: 'x' }, { to: 'S#gone' });
    await flush();
    expect(await pending).toEqual({ status: 'unreachable' });
    expect(s.id).toBe('S');
  });

  it('an unanswered request times out', async () => {
    const { tabs, flush, subscribeAll } = star();
    await subscribeAll();
    const pending = tabs.t1.col.request(
      'x',
      { id: 'x' },
      { to: 'S#t2', timeoutMs: 30 }
    );
    await flush();
    expect(await pending).toEqual({ status: 'timeout' });
  });

  it('a reply from anyone but the addressee is ignored', async () => {
    const { tabs, flush, subscribeAll } = star();
    await subscribeAll();
    let mid = '';
    tabs.t2.col.observe('**', (c) => {
      if (c.request) mid = c.request.mid;
    });
    const pending = tabs.t1.col.request(
      'x',
      { id: 'x' },
      { to: 'S#t2', timeoutMs: 60 }
    );
    await flush();
    // T3 forges an answer to T1's request.
    tabs.t3.col.reply(
      {
        op: 'upsert',
        id: 'x',
        origin: 'S#t1',
        channel: 'control',
        request: { mid, from: 'S#t1' },
      },
      { id: 'x', action: 'forged' }
    );
    await flush();
    expect(await pending).toEqual({ status: 'timeout' });
  });
});

describe('control: delivered, not stored', () => {
  it('a command reaches observers and leaves nothing in the replica', async () => {
    const { sCol, tabs, flush, subscribeAll } = star();
    await subscribeAll();
    const seen = record(tabs.t1.col);
    sCol.set('door', '', { id: 'door', action: 'open' }, { channel: 'control' });
    await flush();
    expect(seen.map((c) => c.doc?.action)).toEqual(['open']);
    expect(tabs.t1.col.get('door')).toBeUndefined();
    expect(sCol.get('door')).toBeUndefined();
  });
});
