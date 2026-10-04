/**
 * A space shared one way (plans/mesh-store-surface.md step 2): S1 holds the
 * documents and grants S2 rights on them; S1 decides every write to them,
 * wherever it was made. S2 and its tab B write through S2, which forwards the
 * write — and carries S1's verdict back. Nothing is configured per peer: the
 * authority follows from who granted the write.
 */
import { describe, expect, it } from 'vitest';
import { createLoopbackPair, type LoopbackPair } from '../src/loopback.js';
import { createMeshPeer } from '../src/peer.js';
import type { AppliedChange } from '../src/replica.js';

interface Doc {
  id: string;
  name?: string;
  [k: string]: unknown;
}

const ALL = { read: true, update: true, create: true, delete: true };
const grant = (grantee: string, rtype: string, entityId = '*') => ({
  grantee,
  entityRtype: rtype,
  entityId,
  includeDescendants: false,
  pathPrefix: '',
  rights: ALL,
});
const sub = (rtype: string) => ({
  entityRtype: rtype,
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
});

/** S1's rule: names are trimmed, and 'forbidden' is refused. */
const s1Rule = (doc: unknown): Doc => {
  const d = doc as Doc;
  if (d.name === 'forbidden') throw new Error('forbidden name');
  return typeof d.name === 'string' ? { ...d, name: d.name.trim() } : d;
};

async function space() {
  const pairs: LoopbackPair[] = [];
  const link = (x: string, y: string) => {
    const lb = createLoopbackPair(x, y);
    pairs.push(lb);
    return lb;
  };
  const s1s2 = link('S1', 'S2');
  const s2b = link('S2', 'S2#b');
  const s1 = createMeshPeer({
    identity: { peerId: 'S1' },
    transports: [s1s2.a],
    ackTimeoutMs: 500,
  });
  const s2 = createMeshPeer({
    identity: { peerId: 'S2' },
    transports: [s1s2.b, s2b.a],
    ackTimeoutMs: 500,
  });
  const b = createMeshPeer({
    identity: { peerId: 'S2#b' },
    transports: [s2b.b],
    ackTimeoutMs: 500,
  });
  const s1Docs = s1.collection<Doc>('doc', { validate: s1Rule });
  const s2Docs = s2.collection<Doc>('doc');
  const bDocs = b.collection<Doc>('doc');
  const s1Saved: string[] = [];
  s1Docs.onCommitted((c: AppliedChange<Doc>) =>
    s1Saved.push(`${c.id}:${c.doc?.name}`)
  );
  s1.grants.grant(grant('S2', 'doc', 'shared'));
  s2.grants.grant(grant('S2', 'doc')); // S2's tabs
  s1Docs.create({ id: 'shared', name: 'original' });
  s2Docs.create({ id: 'own', name: 'mine' });
  const flush = async () => {
    for (let i = 0; i < 6; i++) for (const p of pairs) await p.flush();
  };
  await flush();
  await s2.subscribe(sub('doc'));
  await b.subscribe(sub('doc'));
  await flush();
  return { s1, s2, b, s1Docs, s2Docs, bDocs, s1Saved, s1s2, flush };
}

describe('a space shared one way', () => {
  it('the grantor decides a write made by a tab of the other server', async () => {
    const t = await space();
    expect(t.bDocs.get('shared')?.name).toBe('original');
    const h = t.bDocs.set('shared', 'name', 'renamed');
    await t.flush();
    expect((await h.ack).status).toBe('acked');
    expect(t.s1Docs.get('shared')?.name).toBe('renamed');
    expect(t.s1Saved).toContain('shared:renamed');
  });

  it("the grantor's refusal reaches the writer and every replica", async () => {
    const t = await space();
    const h = t.bDocs.set('shared', 'name', 'forbidden');
    await t.flush();
    expect((await h.ack).status).toBe('rejected');
    expect(t.bDocs.get('shared')?.name).toBe('original');
    expect(t.s2Docs.get('shared')?.name).toBe('original');
    expect(t.s1Docs.get('shared')?.name).toBe('original');
  });

  it("the grantor's correction reaches the writer and every replica", async () => {
    const t = await space();
    const h = t.bDocs.set('shared', 'name', '  padded  ');
    await t.flush();
    expect((await h.ack).status).toBe('corrected');
    for (const c of [t.bDocs, t.s2Docs, t.s1Docs])
      expect(c.get('shared')?.name).toBe('padded');
  });

  it("the other server's own writes into the space are decided by the grantor too", async () => {
    const t = await space();
    const h = t.s2Docs.set('shared', 'name', 'forbidden');
    await t.flush();
    expect((await h.ack).status).toBe('rejected');
    expect(t.s2Docs.get('shared')?.name).toBe('original');
  });

  it('what the other server holds of its own stays its own to decide', async () => {
    const t = await space();
    expect((await t.s2Docs.set('own', 'name', 'forbidden').ack).status).toBe(
      'acked'
    );
    expect(t.s2Docs.get('own')?.name).toBe('forbidden'); // S1's rule isn't S2's
    expect(t.s1Docs.get('own')).toBeUndefined(); // never shared with S1
  });

  it('the shared space is read-only while its grantor is offline', async () => {
    const t = await space();
    t.s1s2.disconnect();
    await t.flush();
    expect(t.bDocs.canWrite()).toBe(true); // B's own server is there
    const fromS2 = await t.s2Docs.set('shared', 'name', 'offline edit').ack;
    expect(fromS2).toMatchObject({
      status: 'rejected',
      reason: 'authority-offline',
    });
    expect(t.s2Docs.get('shared')?.name).toBe('original');
  });
});
