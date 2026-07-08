/**
 * Mesh-native undo/redo. Committed writes are logged per-peer; undo re-emits
 * the inverse as a fresh committed write, so propagation/persistence/LWW fall
 * out of the normal write path. Preview writes are never logged (the commit is
 * the action boundary). Guarded policy (default) skips an inverse on a doc a
 * collaborator changed since. See dev-notes/plans/mesh-native-undo.md.
 */
import { describe, expect, it } from 'vitest';
import { createLoopbackPair } from '../src/loopback.js';
import { createMeshPeer, type MeshPeer } from '../src/peer.js';
import type { Collection } from '../src/collection.js';

interface Node {
  id: string;
  name: string;
  val?: number;
  [k: string]: unknown;
}

/** Self-authority peer, no transport — committed local writes resolve inline. */
function solo(undo?: { depth?: number; policy?: 'guarded' | 'naive' }) {
  const p = createMeshPeer({ identity: { peerId: 'S' }, undo });
  const nodes = p.collection<Node>('node', { authority: 'self' });
  return { p, nodes };
}

describe('mesh undo/redo — core matrix (self authority)', () => {
  it('create → undo removes; redo re-creates', () => {
    const { p, nodes } = solo();
    nodes.create({ id: 'n1', name: 'a' });
    expect(nodes.get('n1')).toEqual({ id: 'n1', name: 'a' });
    expect(p.undoStatus()).toEqual({ canUndo: true, canRedo: false });

    expect(p.undo()).toBe(true);
    expect(nodes.get('n1')).toBeUndefined();
    expect(p.undoStatus()).toEqual({ canUndo: false, canRedo: true });

    expect(p.redo()).toBe(true);
    expect(nodes.get('n1')).toEqual({ id: 'n1', name: 'a' });
    expect(p.undoStatus()).toEqual({ canUndo: true, canRedo: false });
  });

  it('modify → undo restores the prior committed doc', () => {
    const { p, nodes } = solo();
    nodes.create({ id: 'n1', name: 'a' });
    nodes.update('n1', { name: 'b' });
    expect(nodes.get('n1')?.name).toBe('b');

    expect(p.undo()).toBe(true);
    expect(nodes.get('n1')).toEqual({ id: 'n1', name: 'a' });

    expect(p.redo()).toBe(true);
    expect(nodes.get('n1')?.name).toBe('b');
  });

  it('remove → undo re-upserts the removed doc', () => {
    const { p, nodes } = solo();
    nodes.create({ id: 'n1', name: 'a', val: 7 });
    nodes.remove('n1');
    expect(nodes.get('n1')).toBeUndefined();

    expect(p.undo()).toBe(true);
    expect(nodes.get('n1')).toEqual({ id: 'n1', name: 'a', val: 7 });

    expect(p.redo()).toBe(true);
    expect(nodes.get('n1')).toBeUndefined();
  });

  it('undoes a multi-step history in LIFO order', () => {
    const { p, nodes } = solo();
    nodes.create({ id: 'n1', name: 'a' });
    nodes.update('n1', { name: 'b' });
    nodes.update('n1', { name: 'c' });
    expect(nodes.get('n1')?.name).toBe('c');
    p.undo();
    expect(nodes.get('n1')?.name).toBe('b');
    p.undo();
    expect(nodes.get('n1')?.name).toBe('a');
    p.undo();
    expect(nodes.get('n1')).toBeUndefined();
    expect(p.canUndo()).toBe(false);
  });

  it('preview / ephemeral writes are never logged', () => {
    const { p, nodes } = solo();
    nodes.create({ id: 'n1', name: 'a' });
    // A drag stream: many preview writes, no commit.
    nodes.set('n1', 'val', 1, { channel: 'preview' });
    nodes.set('n1', 'val', 2, { channel: 'preview' });
    nodes.set('n1', 'val', 3, { channel: 'preview' });
    // Only the create is on the stack — undo removes the node outright.
    expect(p.undo()).toBe(true);
    expect(nodes.get('n1')).toBeUndefined();
    expect(p.canUndo()).toBe(false);
  });

  it('a new committed write clears the redo stack', () => {
    const { p, nodes } = solo();
    nodes.create({ id: 'a', name: 'a' });
    nodes.create({ id: 'b', name: 'b' });
    p.undo(); // undo b → redo has b
    expect(p.canRedo()).toBe(true);
    nodes.create({ id: 'c', name: 'c' }); // new future invalidates redo
    expect(p.canRedo()).toBe(false);
    expect(nodes.get('b')).toBeUndefined();
  });

  it('caps the undo stack at the configured depth', () => {
    const { p, nodes } = solo({ depth: 2 });
    nodes.create({ id: 'a', name: 'a' });
    nodes.create({ id: 'b', name: 'b' });
    nodes.create({ id: 'c', name: 'c' }); // pushes 'a' out
    expect(p.undo()).toBe(true); // c
    expect(p.undo()).toBe(true); // b
    expect(p.undo()).toBe(false); // a's create was dropped
    expect(nodes.get('a')).toEqual({ id: 'a', name: 'a' });
    expect(nodes.get('b')).toBeUndefined();
    expect(nodes.get('c')).toBeUndefined();
  });

  it('undo()/redo() return false with nothing to do', () => {
    const { p } = solo();
    expect(p.undo()).toBe(false);
    expect(p.redo()).toBe(false);
  });

  it('clearUndoHistory drops both stacks', () => {
    const { p, nodes } = solo();
    nodes.create({ id: 'n1', name: 'a' });
    p.undo();
    expect(p.canRedo()).toBe(true);
    p.clearUndoHistory();
    expect(p.undoStatus()).toEqual({ canUndo: false, canRedo: false });
  });

  it('onUndoChange fires on every stack transition', () => {
    const { p, nodes } = solo();
    const seen: { canUndo: boolean; canRedo: boolean }[] = [];
    p.onUndoChange((s) => seen.push(s));
    nodes.create({ id: 'n1', name: 'a' });
    expect(seen.at(-1)).toEqual({ canUndo: true, canRedo: false });
    p.undo();
    expect(seen.at(-1)).toEqual({ canUndo: false, canRedo: true });
    p.redo();
    expect(seen.at(-1)).toEqual({ canUndo: true, canRedo: false });
  });
});

describe('mesh undo/redo — concurrency policy', () => {
  it('guarded (default) skips an inverse when the doc changed since', () => {
    const { p, nodes } = solo(); // guarded default
    nodes.create({ id: 'n1', name: 'a' });
    // Someone else lands a newer committed value (simulated via a hydrate put
    // with a fresh stamp — not part of this peer's undo-log).
    nodes.put({ id: 'n1', name: 'ext' }, { v: p.clock.tick() });
    expect(nodes.get('n1')?.name).toBe('ext');

    // Guarded: the create's logged `after` no longer matches → skip, consume.
    expect(p.undo()).toBe(false);
    expect(nodes.get('n1')?.name).toBe('ext');
    expect(p.canUndo()).toBe(false);
  });

  it('naive applies the inverse regardless (last-writer-wins)', () => {
    const { p, nodes } = solo({ policy: 'naive' });
    nodes.create({ id: 'n1', name: 'a' });
    nodes.put({ id: 'n1', name: 'ext' }, { v: p.clock.tick() });

    expect(p.undo()).toBe(true); // remove wins with a fresh stamp
    expect(nodes.get('n1')).toBeUndefined();
  });

  it('guarded redo is gated on the undone-to value', () => {
    const { p, nodes } = solo();
    nodes.create({ id: 'n1', name: 'a' });
    nodes.update('n1', { name: 'b' });
    p.undo(); // back to {name:'a'}
    // Concurrent edit lands before the redo.
    nodes.put({ id: 'n1', name: 'ext' }, { v: p.clock.tick() });
    expect(p.redo()).toBe(false); // current ≠ the value undo restored
    expect(nodes.get('n1')?.name).toBe('ext');
  });
});

// --- collaboration (loopback pair) -----------------------------------------

interface Rig {
  a: MeshPeer;
  b: MeshPeer;
  na: Collection<Node>;
  nb: Collection<Node>;
  flush: () => Promise<void>;
}

function pair(opts?: {
  policy?: 'guarded' | 'naive';
  validateA?: (data: unknown) => Node;
}): Rig {
  const lb = createLoopbackPair('A', 'B');
  const a = createMeshPeer({
    identity: { peerId: 'A' },
    transports: [lb.a],
    ackTimeoutMs: 60,
    undo: { policy: opts?.policy },
  });
  const b = createMeshPeer({
    identity: { peerId: 'B' },
    transports: [lb.b],
    ackTimeoutMs: 60,
    undo: { policy: opts?.policy },
  });
  const na = a.collection<Node>('node', {
    authority: 'self',
    validate: opts?.validateA,
  });
  const nb = b.collection<Node>('node', { authority: 'A' });
  a.grants.grant({
    grantee: 'B',
    entityRtype: 'node',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true, update: true, create: true, delete: true },
  });
  return { a, b, na, nb, flush: lb.flush };
}

describe('mesh undo/redo — collaboration', () => {
  it('remote-authority write logs only once acked', async () => {
    const r = pair();
    // B subscribes so its writes fan home and it observes the acked state.
    await r.b.subscribe('A', {
      entityRtype: 'node',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
    });
    r.nb.create({ id: 'n1', name: 'a' });
    await r.flush();
    expect(r.b.canUndo()).toBe(true);
    expect(r.na.get('n1')).toEqual({ id: 'n1', name: 'a' });

    // Undo re-emits a remove to the authority.
    expect(r.b.undo()).toBe(true);
    await r.flush();
    expect(r.na.get('n1')).toBeUndefined();
    expect(r.nb.get('n1')).toBeUndefined();
  });

  it('a rejected optimistic write leaves no undo entry', async () => {
    // A rejects any name === 'bad'.
    const r = pair({
      validateA: (d) => {
        const n = d as Node;
        if (n.name === 'bad') throw new Error('nope');
        return n;
      },
    });
    r.nb.create({ id: 'n1', name: 'bad' });
    await r.flush();
    expect(r.b.canUndo()).toBe(false); // nacked → not logged
  });

  it('undo stacks are per-peer (A cannot undo B’s action)', async () => {
    const r = pair();
    await r.b.subscribe('A', {
      entityRtype: 'node',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
    });
    r.na.create({ id: 'a1', name: 'A-owned' });
    r.nb.create({ id: 'b1', name: 'B-owned' });
    await r.flush();

    // A undoes only its own action.
    expect(r.a.undo()).toBe(true);
    await r.flush();
    expect(r.na.get('a1')).toBeUndefined();
    expect(r.na.get('b1')).toEqual({ id: 'b1', name: 'B-owned' });
    expect(r.a.canUndo()).toBe(false);
    // B's action is still on B's stack.
    expect(r.b.canUndo()).toBe(true);
  });

  it('guarded undo no-ops when a collaborator changed the doc', async () => {
    const r = pair(); // guarded default
    await r.b.subscribe('A', {
      entityRtype: 'node',
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
    });
    r.na.create({ id: 'n1', name: 'a' });
    await r.flush();
    // B (collaborator) edits the same doc.
    r.nb.update('n1', { name: 'b-edit' });
    await r.flush();
    expect(r.na.get('n1')?.name).toBe('b-edit');

    // A tries to undo its create — guarded skip (doc changed since).
    expect(r.a.undo()).toBe(false);
    expect(r.na.get('n1')?.name).toBe('b-edit');
  });
});
