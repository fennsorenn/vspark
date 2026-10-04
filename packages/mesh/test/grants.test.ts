/**
 * Whitelist grants with field-level reads (principle 9).
 *
 * Unit tests for the pure projection functions, then a matrix over a real peer
 * pair: what a subscriber receives through each message type (snapshot, live
 * op, relayed op, ack/nack, tombstone, ephemeral overlay) under whole-doc,
 * field-level and no grants, and how field-level writers are admitted.
 */
import { describe, expect, it } from 'vitest';
import type { Grant, Subscription } from '@vspark/shared/sync';
import { createLoopbackPair } from '../src/loopback.js';
import { createMeshPeer } from '../src/peer.js';
import {
  grantOverlapsSubscription,
  projectOp,
  projectValue,
  readScope,
} from '../src/grants.js';
import type { OpEnvelope } from '../src/wire.js';

const noTree = () => false;

const grant = (over: Partial<Grant>): Grant => ({
  grantee: 'B',
  entityRtype: 'conn',
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
  rights: { read: true },
  ...over,
});

const allSub: Subscription = {
  entityRtype: 'conn',
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
};

describe('readScope / projectValue', () => {
  const doc = {
    id: 'c1',
    label: 'Studio',
    settings: { host: 'localhost', port: 4455, audio: { gain: 2 } },
    secret: { password: 'pw' },
  };

  it('a permissive prefix grants the whole document', () => {
    const s = readScope([grant({})], 'conn', 'c1', noTree);
    expect(s).toEqual({ kind: 'all' });
    expect(projectValue(doc, s)).toBe(doc);
  });

  it('no read grant reads nothing', () => {
    const s = readScope(
      [grant({ rights: { update: true } })],
      'conn',
      'c1',
      noTree
    );
    expect(s.kind).toBe('none');
    expect(projectValue(doc, s)).toBeUndefined();
  });

  it('field grants select subtrees at any depth', () => {
    const s = readScope(
      [grant({ pathPrefix: 'label' }), grant({ pathPrefix: 'settings.audio' })],
      'conn',
      'c1',
      noTree
    );
    expect(projectValue(doc, s)).toEqual({
      label: 'Studio',
      settings: { audio: { gain: 2 } },
    });
  });

  it('a covering prefix absorbs narrower ones', () => {
    const s = readScope(
      [
        grant({ pathPrefix: 'settings' }),
        grant({ pathPrefix: 'settings.port' }),
      ],
      'conn',
      'c1',
      noTree
    );
    expect(s).toEqual({ kind: 'paths', prefixes: ['settings'] });
  });

  it('projects a value found below the document root', () => {
    const s = readScope(
      [grant({ pathPrefix: 'settings.audio' })],
      'conn',
      'c1',
      noTree
    );
    // The value at 'settings': only its audio subtree is readable.
    expect(projectValue(doc.settings, s, 'settings')).toEqual({
      audio: { gain: 2 },
    });
    // The value at 'settings.audio.gain' is inside the grant: whole.
    expect(projectValue(2, s, 'settings.audio.gain')).toBe(2);
    // A sibling path is not readable at all.
    expect(projectValue(4455, s, 'settings.port')).toBeUndefined();
  });

  it('grants for another entity do not apply', () => {
    const s = readScope([grant({ entityId: 'c2' })], 'conn', 'c1', noTree);
    expect(s.kind).toBe('none');
  });
});

describe('projectOp', () => {
  const op = (over: Partial<OpEnvelope>): OpEnvelope => ({
    t: 'op',
    rtype: 'conn',
    op: 'patch',
    id: 'c1',
    origin: 'A',
    ch: 'committed',
    ...over,
  });
  const labelOnly = readScope(
    [grant({ pathPrefix: 'label' })],
    'conn',
    'c1',
    noTree
  );

  it('drops a patch outside the scope', () => {
    expect(
      projectOp(op({ path: 'secret.password', data: 'x' }), labelOnly)
    ).toBeNull();
  });

  it('keeps a patch inside the scope unchanged', () => {
    const e = op({ path: 'label', data: 'New' });
    expect(projectOp(e, labelOnly)).toBe(e);
  });

  it('narrows a merge-patch and an upsert to the scope', () => {
    expect(
      projectOp(
        op({ data: { label: 'L', secret: { password: 'x' } } }),
        labelOnly
      )?.data
    ).toEqual({ label: 'L' });
    expect(
      projectOp(
        op({
          op: 'upsert',
          data: { id: 'c1', label: 'L', secret: { password: 'x' } },
        }),
        labelOnly
      )?.data
    ).toEqual({ label: 'L' });
  });

  it('drops a merge-patch that touches nothing readable', () => {
    expect(
      projectOp(op({ data: { secret: { password: 'x' } } }), labelOnly)
    ).toBeNull();
  });

  it('delivers removes to anyone who can read part of the entity', () => {
    const e = op({ op: 'remove' });
    expect(projectOp(e, labelOnly)).toBe(e);
    expect(projectOp(e, { kind: 'none' })).toBeNull();
  });
});

describe('grantOverlapsSubscription', () => {
  it('admits a whole-doc subscription when only a field is granted', () => {
    expect(
      grantOverlapsSubscription(grant({ pathPrefix: 'label' }), allSub, noTree)
    ).toBe(true);
  });

  it('refuses without a read right or for another rtype', () => {
    expect(
      grantOverlapsSubscription(
        grant({ rights: { update: true } }),
        allSub,
        noTree
      )
    ).toBe(false);
    expect(
      grantOverlapsSubscription(grant({ entityRtype: 'other' }), allSub, noTree)
    ).toBe(false);
  });

  it('refuses disjoint path prefixes', () => {
    expect(
      grantOverlapsSubscription(
        grant({ pathPrefix: 'label' }),
        { ...allSub, pathPrefix: 'secret' },
        noTree
      )
    ).toBe(false);
  });
});

// --- peer-level matrix --------------------------------------------------------

interface Conn {
  id: string;
  label?: string;
  settings?: { host?: string; port?: number };
  secret?: { password?: string };
  [k: string]: unknown;
}

/** A: the server holding the data. B: a participant with whatever grants the
 *  test issues (not A's home — so everything A sends B is projected). */
function pair() {
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
  const ca = a.collection<Conn>('conn');
  const cb = b.collection<Conn>('conn', { authority: 'A' });
  return { a, b, ca, cb, flush: lb.flush };
}

const full: Conn = {
  id: 'c1',
  label: 'Studio',
  settings: { host: 'localhost', port: 4455 },
  secret: { password: 'pw' },
};

describe('peer: field-level reads', () => {
  it('snapshot and live ops carry only the granted fields', async () => {
    const { a, b, ca, cb, flush } = pair();
    ca.create(full);
    a.grants.grant(grant({ pathPrefix: 'label' }));
    a.grants.grant(grant({ pathPrefix: 'settings' }));
    await b.subscribe('A', allSub);
    expect(cb.get('c1')).toEqual({
      label: 'Studio',
      settings: { host: 'localhost', port: 4455 },
    });

    ca.set('c1', 'secret.password', 'changed');
    ca.set('c1', 'label', 'Renamed');
    ca.update('c1', {
      settings: { port: 4456 },
      secret: { password: 'again' },
    });
    await flush();
    expect(cb.get('c1')).toEqual({
      label: 'Renamed',
      settings: { host: 'localhost', port: 4456 },
    });
    expect(JSON.stringify(cb.get('c1'))).not.toContain('again');
  });

  it('a whole-document replace reaches the subscriber projected', async () => {
    const { a, b, ca, cb, flush } = pair();
    ca.create(full);
    a.grants.grant(grant({ pathPrefix: 'label' }));
    await b.subscribe('A', allSub);
    ca.set('c1', '', {
      ...full,
      label: 'Swapped',
      secret: { password: 'new' },
    });
    await flush();
    expect(cb.get('c1')).toEqual({ label: 'Swapped' });
  });

  it('ephemeral overlays are projected too', async () => {
    const { a, b, ca, cb, flush } = pair();
    ca.create(full);
    a.grants.grant(grant({ pathPrefix: 'label' }));
    await b.subscribe('A', { ...allSub, channels: ['preview'] } as never);
    ca.set('c1', 'secret.password', 'peek', { channel: 'preview' });
    ca.set('c1', 'label', 'Dragging', { channel: 'preview' });
    await flush();
    expect(cb.get('c1')?.secret).toBeUndefined();
    expect(cb.get('c1')?.label).toBe('Dragging');
  });

  it('a subscription without any read grant is refused', async () => {
    const { a, b } = pair();
    a.grants.grant(grant({ rights: { update: true } }));
    await expect(b.subscribe('A', allSub)).rejects.toThrow(/denied/);
  });

  it('revoking a grant stops delivery immediately', async () => {
    const { a, b, ca, cb, flush } = pair();
    ca.create(full);
    const gid = a.grants.grant(grant({}));
    await b.subscribe('A', allSub);
    a.grants.revoke(gid);
    ca.set('c1', 'label', 'After revoke');
    await flush();
    expect(cb.get('c1')?.label).toBe('Studio');
  });
});

describe('peer: field-level writes', () => {
  it('a merge-patch passes when every leaf is writable', async () => {
    const { a, b, ca, cb, flush } = pair();
    ca.create(full);
    a.grants.grant(grant({ rights: { read: true } }));
    a.grants.grant(grant({ pathPrefix: 'settings', rights: { update: true } }));
    await b.subscribe('A', allSub);
    const ok = cb.update('c1', { settings: { port: 1 } });
    expect((await ok.ack).status).toBe('acked');
    await flush();
    expect(ca.get('c1')?.settings?.port).toBe(1);
  });

  it('a merge-patch with an unwritable leaf is rejected whole', async () => {
    const { a, b, ca, cb, flush } = pair();
    ca.create(full);
    a.grants.grant(grant({ rights: { read: true } }));
    a.grants.grant(grant({ pathPrefix: 'settings', rights: { update: true } }));
    await b.subscribe('A', allSub);
    const res = await cb.update('c1', { settings: { port: 2 }, label: 'X' })
      .ack;
    expect(res.status).toBe('rejected');
    await flush();
    expect(ca.get('c1')?.settings?.port).toBe(4455);
    expect(ca.get('c1')?.label).toBe('Studio');
  });

  it("a partial-view writer's upsert only lands on the paths it may write", async () => {
    const { a, b, ca, cb, flush } = pair();
    ca.create(full);
    a.grants.grant(grant({ pathPrefix: 'label' }));
    a.grants.grant(grant({ pathPrefix: 'settings' }));
    a.grants.grant(grant({ pathPrefix: 'settings', rights: { update: true } }));
    await b.subscribe('A', allSub);
    // B holds a partial view and writes it back whole (e.g. an undo).
    const view = cb.get('c1')!;
    cb.set('c1', '', {
      ...view,
      label: 'Not mine',
      settings: { host: 'h2', port: 9 },
    });
    await flush();
    const doc = ca.get('c1')!;
    expect(doc.settings).toEqual({ host: 'h2', port: 9 });
    expect(doc.label).toBe('Studio'); // readable, not writable
    expect(doc.secret).toEqual({ password: 'pw' }); // invisible, untouched
  });

  it('write-only: a field can be set without ever being read back', async () => {
    const { a, b, ca, cb, flush } = pair();
    ca.create(full);
    a.grants.grant(grant({ pathPrefix: 'label' }));
    a.grants.grant(grant({ pathPrefix: 'secret', rights: { update: true } }));
    await b.subscribe('A', allSub);
    expect((await cb.set('c1', 'secret.password', 'typed').ack).status).toBe(
      'acked'
    );
    await flush();
    expect(ca.get('c1')?.secret?.password).toBe('typed');
    // A later change by someone else never reaches B.
    ca.set('c1', 'secret.password', 'rotated');
    await flush();
    expect(cb.get('c1')?.secret?.password).toBe('typed'); // B's own write, nothing more
  });
});

describe('peer: the nack leak', () => {
  it('a rejected write learns only what the writer may read', async () => {
    const { a, b, ca, cb } = pair();
    ca.create(full);
    a.grants.grant(grant({ pathPrefix: 'label' }));
    await b.subscribe('A', allSub);
    // No update grant: rejected. The nack must not carry the secret.
    const res = await cb.set('c1', 'label', 'Nope').ack;
    expect(res.status).toBe('rejected');
    const current = (res as { current?: Conn }).current;
    expect(current).toEqual({ label: 'Studio' });
    expect(JSON.stringify(cb.get('c1'))).not.toContain('pw');
  });

  it('a writer without any read grant gets no value at all', async () => {
    const { a, b, ca, cb, flush } = pair();
    ca.create(full);
    a.grants.grant(grant({ pathPrefix: 'label', rights: { read: true } }));
    await b.subscribe('A', allSub);
    a.grants.grant(grant({ entityId: 'c2', rights: { read: true } }));
    ca.create({ id: 'c2', label: 'other', secret: { password: 'zz' } });
    await flush();
    // B may read c2 but not write it: the rejection carries c2 projected —
    // whole here — and never c1's hidden fields.
    const res = await cb.set('c2', 'label', 'x').ack;
    expect(res.status).toBe('rejected');
    expect(JSON.stringify(res)).not.toContain('"pw"');
  });
});

describe('peer: tombstone scoping', () => {
  const parent = (n: { parentId?: string | null }) =>
    n.parentId ? { rtype: 'node', id: n.parentId } : null;
  const subtree = (root: string): Grant => ({
    grantee: 'B',
    entityRtype: '*',
    entityId: root,
    includeDescendants: true,
    pathPrefix: '',
    rights: { read: true },
  });

  it("a snapshot carries only the tombstones inside the subscriber's grants", async () => {
    const lb = createLoopbackPair('A', 'B');
    const a = createMeshPeer({ identity: { peerId: 'A' }, transports: [lb.a] });
    const b = createMeshPeer({ identity: { peerId: 'B' }, transports: [lb.b] });
    type N = { id: string; parentId?: string | null };
    const na = a.collection<N>('node', { parent });
    b.collection<N>('node', { parent });
    na.create({ id: 'mine', parentId: null });
    na.create({ id: 'mine-child', parentId: 'mine' });
    na.create({ id: 'theirs', parentId: null });
    na.create({ id: 'theirs-child', parentId: 'theirs' });
    na.remove('mine-child');
    na.remove('theirs-child');
    a.grants.grant(subtree('mine'));

    let seen: string[] = [];
    // Tap B's link to observe what A actually sends.
    const original = (
      a as unknown as { egress: (p: string, m: unknown) => unknown }
    ).egress.bind(a);
    (a as unknown as { egress: (p: string, m: unknown) => unknown }).egress = (
      p,
      m
    ) => {
      const out = original(p, m) as {
        t?: string;
        tombstones?: { id: string }[];
      } | null;
      if (out?.t === 'sub_ok') seen = (out.tombstones ?? []).map((t) => t.id);
      return out;
    };
    await b.subscribe('A', {
      entityRtype: 'node',
      entityId: 'mine',
      includeDescendants: true,
      pathPrefix: '',
    });
    expect(seen).toEqual(['mine-child']);
  });

  it('a tombstone without known ancestry reaches only rtype-wide grants', async () => {
    const lb = createLoopbackPair('A', 'B');
    const a = createMeshPeer({ identity: { peerId: 'A' }, transports: [lb.a] });
    const b = createMeshPeer({ identity: { peerId: 'B' }, transports: [lb.b] });
    type N = { id: string; parentId?: string | null };
    const na = a.collection<N>('node', { parent });
    const nb = b.collection<N>('node', { parent });
    na.create({ id: 'root', parentId: null });
    nb.put({ id: 'orphan', parentId: 'root' }, { v: { t: 1, c: 0, n: 'A' } });
    na.putTombstone('orphan', { t: 99, c: 0, n: 'A' }); // no ancestry
    a.grants.grant(subtree('root'));
    await b.subscribe('A', {
      entityRtype: 'node',
      entityId: 'root',
      includeDescendants: true,
      pathPrefix: '',
    });
    // Withheld: A can't prove the tombstone is inside B's subtree grant.
    expect(nb.get('orphan')).toBeDefined();
  });
});
