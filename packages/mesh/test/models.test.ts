/**
 * Declared models and the one validator (plans/mesh-store-surface.md step 1).
 *
 * A model is declared once and shared by every peer; the validator always sees
 * the document a write would leave behind, whatever shape the write had; clock
 * fields are translated per hop instead of inside a validator.
 */
import { describe, expect, it } from 'vitest';
import { createLoopbackPair } from '../src/loopback.js';
import { createMeshPeer, type MeshPeer } from '../src/peer.js';
import type { ModelDecl } from '../src/collection.js';

interface Inst {
  id: string;
  sceneId: string;
  sourceSceneId?: string;
  name?: string;
  startEpoch?: number | null;
  [k: string]: unknown;
}

/** An instance may not embed the scene it sits in. */
const noSelfEmbed = (doc: unknown): Inst => {
  const d = doc as Inst;
  if (d.sourceSceneId === d.sceneId) throw new Error('embeds itself');
  return d;
};

const MODELS: Record<string, ModelDecl<any>> = {
  inst: { validate: noSelfEmbed, clockFields: ['startEpoch'] },
};

const RUCD = { read: true, update: true, create: true, delete: true };

/** A (authority) and B (writer with a grant), both opening the declared model. */
async function pair(opts?: {
  localValidate?: (doc: unknown) => Inst;
  skewB?: number;
}) {
  const lb = createLoopbackPair('A', 'B');
  const a = createMeshPeer({
    identity: { peerId: 'A' },
    transports: [lb.a],
    models: MODELS,
  });
  const b = createMeshPeer({
    identity: { peerId: 'B' },
    transports: [lb.b],
    models: MODELS,
    ...(opts?.skewB ? { now: () => Date.now() + opts.skewB! } : {}),
  });
  const ia = a.collection<Inst>('inst', {
    authority: 'self',
    ...(opts?.localValidate ? { validate: opts.localValidate } : {}),
  });
  const ib = b.collection<Inst>('inst', { authority: 'A' });
  a.grants.grant({
    grantee: 'B',
    entityRtype: 'inst',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: RUCD,
  });
  await lb.flush();
  await b.subscribe('A', {
    entityRtype: 'inst',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
  });
  const close = () => [a, b].forEach((p: MeshPeer) => p.close());
  return { a, b, ia, ib, flush: lb.flush, close };
}

describe('declared models', () => {
  it('a declared validator applies on every peer that opens the model', async () => {
    const t = await pair();
    try {
      // Local fail-fast on B, before anything is sent.
      const h = t.ib.create({ id: 'i1', sceneId: 'S', sourceSceneId: 'S' });
      expect((await h.ack).status).toBe('rejected');
      expect(t.ib.get('i1')).toBeUndefined();
    } finally {
      t.close();
    }
  });

  it("a peer's own validate runs after the declared one, on its result", async () => {
    const seen: unknown[] = [];
    const t = await pair({
      localValidate: (doc) => {
        seen.push(doc);
        return { ...(doc as Inst), name: 'normalized' };
      },
    });
    try {
      t.ia.create({ id: 'i1', sceneId: 'S', sourceSceneId: 'T', name: 'x' });
      expect(t.ia.get('i1')?.name).toBe('normalized');
      expect(() =>
        t.ia.create({ id: 'i2', sceneId: 'S', sourceSceneId: 'S' })
      ).not.toThrow();
      expect(t.ia.get('i2')).toBeUndefined(); // the declared check refused it
      expect(seen).toHaveLength(1); // own validate never saw the refused doc
    } finally {
      t.close();
    }
  });
});

describe('one validator, every write shape', () => {
  it('a single-path edit is checked against the whole resulting document', async () => {
    const t = await pair();
    try {
      t.ib.create({ id: 'i1', sceneId: 'S', sourceSceneId: 'T' });
      await t.flush();
      expect(t.ia.get('i1')?.sourceSceneId).toBe('T');

      // The edit that used to slip through: only the one field, as a patch.
      const h = t.ib.set('i1', 'sourceSceneId', 'S');
      expect((await h.ack).status).toBe('rejected'); // B's own copy refuses it
      expect(t.ib.get('i1')?.sourceSceneId).toBe('T');
    } finally {
      t.close();
    }
  });

  it('the authority refuses a patch the author could not check, and the author rolls back', async () => {
    // Only A knows the rule: B opens the type without the declared validator.
    const lb = createLoopbackPair('A', 'B');
    const a = createMeshPeer({
      identity: { peerId: 'A' },
      transports: [lb.a],
      models: MODELS,
    });
    const b = createMeshPeer({ identity: { peerId: 'B' }, transports: [lb.b] });
    const ia = a.collection<Inst>('inst', { authority: 'self' });
    const ib = b.collection<Inst>('inst', { authority: 'A' });
    a.grants.grant({
      grantee: 'B',
      entityRtype: 'inst',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
      rights: RUCD,
    });
    await lb.flush();
    await b.subscribe('A', {
      entityRtype: 'inst',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
    });
    try {
      ia.create({ id: 'i1', sceneId: 'S', sourceSceneId: 'T' });
      await lb.flush();
      const h = ib.set('i1', 'sourceSceneId', 'S');
      expect(ib.get('i1')?.sourceSceneId).toBe('S'); // optimistic
      await lb.flush();
      expect((await h.ack).status).toBe('rejected');
      expect(ib.get('i1')?.sourceSceneId).toBe('T');
      expect(ia.get('i1')?.sourceSceneId).toBe('T');
    } finally {
      a.close();
      b.close();
    }
  });

  it('a corrected patch reaches the author and subscribers as the whole corrected document', async () => {
    const t = await pair({
      localValidate: (doc) => {
        const d = doc as Inst;
        return { ...d, name: (d.name ?? '').trim() };
      },
    });
    try {
      t.ia.create({ id: 'i1', sceneId: 'S', sourceSceneId: 'T', name: 'a' });
      await t.flush();
      const h = t.ib.set('i1', 'name', '  spaced  ');
      await t.flush();
      const out = await h.ack;
      expect(out.status).toBe('corrected');
      expect(t.ia.get('i1')?.name).toBe('spaced');
      expect(t.ib.get('i1')?.name).toBe('spaced');
      expect(t.ib.get('i1')?.sourceSceneId).toBe('T'); // whole doc intact
    } finally {
      t.close();
    }
  });
});

describe('clock fields', () => {
  it("are translated onto the receiver's clock, for whole docs and single-path edits", async () => {
    const SKEW = 5000; // B's clock runs 5s ahead of A's
    const t = await pair({ skewB: SKEW });
    try {
      const onB = Date.now() + SKEW;
      t.ib.create({
        id: 'i1',
        sceneId: 'S',
        sourceSceneId: 'T',
        startEpoch: onB,
      });
      await t.flush();
      expect(
        Math.abs((t.ia.get('i1')?.startEpoch ?? 0) - Date.now())
      ).toBeLessThan(50);
      // B keeps its own frame for its own write.
      expect(t.ib.get('i1')?.startEpoch).toBe(onB);

      const later = Date.now() + SKEW + 1000;
      t.ib.set('i1', 'startEpoch', later);
      await t.flush();
      expect(
        Math.abs((t.ia.get('i1')?.startEpoch ?? 0) - (Date.now() + 1000))
      ).toBeLessThan(50);

      // A's write arrives on B translated onto B's clock.
      const onA = Date.now() + 2000;
      t.ia.set('i1', 'startEpoch', onA);
      await t.flush();
      expect(
        Math.abs((t.ib.get('i1')?.startEpoch ?? 0) - (onA + SKEW))
      ).toBeLessThan(50);
    } finally {
      t.close();
    }
  });

  it('a field edit does not re-translate a clock field it did not touch', async () => {
    const SKEW = 5000;
    const t = await pair({ skewB: SKEW });
    try {
      const onB = Date.now() + SKEW;
      t.ib.create({
        id: 'i1',
        sceneId: 'S',
        sourceSceneId: 'T',
        startEpoch: onB,
      });
      await t.flush();
      const before = t.ia.get('i1')?.startEpoch;
      t.ib.set('i1', 'name', 'renamed');
      await t.flush();
      expect(t.ia.get('i1')?.name).toBe('renamed');
      expect(t.ia.get('i1')?.startEpoch).toBe(before);
    } finally {
      t.close();
    }
  });
});
