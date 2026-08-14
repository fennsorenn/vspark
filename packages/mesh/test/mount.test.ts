/**
 * A mount is not a reconnect.
 *
 * Reconnecting peers share history and comparable clocks, so ordinary LWW
 * reconciles them. Mounting brings in a tree this peer has no history with —
 * and the failure it causes is not subtle: if the receiver once held those ids
 * and deleted them, its tombstones out-stamp the author's live documents. The
 * mount lands empty, and because the subscription is mutual, those tombstones
 * then propagate BACK and delete the author's scene.
 *
 * So a mount records when it happened, and documents in the mounted scope
 * reconcile against max(write stamp, mount stamp). The stamp is local metadata
 * on the mount — never written to the documents, which is what keeps "a
 * document has exactly one truth" intact and stops anything leaking back.
 */
import { describe, expect, it } from 'vitest';
import { createLoopbackPair } from '../src/loopback.js';
import { createMeshPeer, type MeshPeer } from '../src/peer.js';
import type { Collection } from '../src/collection.js';

interface Node {
  id: string;
  name: string;
  parentId?: string | null;
  [k: string]: unknown;
}

function pair() {
  const lb = createLoopbackPair('OWNER', 'RECV');
  const owner = createMeshPeer({
    identity: { peerId: 'OWNER' },
    transports: [lb.a],
    ackTimeoutMs: 60,
  });
  const recv = createMeshPeer({
    identity: { peerId: 'RECV' },
    transports: [lb.b],
    ackTimeoutMs: 60,
  });
  const parent = (n: Node) =>
    n.parentId ? { rtype: 'node', id: n.parentId } : null;
  const co = owner.collection<Node>('node', { parent, authority: 'self' });
  const cr = recv.collection<Node>('node', { parent, authority: 'self' });
  owner.grants.grant({
    grantee: 'RECV',
    entityRtype: 'node',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true, update: true, create: true, delete: true },
  });
  recv.grants.grant({
    grantee: 'OWNER',
    entityRtype: 'node',
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true, update: true, create: true, delete: true },
  });
  return { owner, recv, co, cr, flush: lb.flush };
}

/** The receiver knew these ids once and deleted them — the state that makes a
 *  naive mount destructive. Local writes, so the tombstones carry the
 *  receiver's own (recent) stamps. */
function deletedHere(col: Collection<Node>, ids: string[]) {
  for (const id of ids) {
    col.set(id, '', { id, name: `old ${id}` });
    col.remove(id);
  }
}

/** Apply a document the way an inbound op does — with the AUTHOR's stamp.
 *
 *  This has to go through `applyOp`, not `replica.upsert`: the mount scope is
 *  resolved there, and a test that wrote straight to the replica would pass
 *  whether or not the mechanism exists. The stamp is deliberately old — the
 *  author wrote these documents long before this peer deleted its copies,
 *  which is precisely why a naive mount loses to the tombstones. */
function fromAuthor(
  col: Collection<Node>,
  doc: Node,
  t = 1
): ReturnType<Collection<Node>['applyOp']> {
  return col.applyOp(
    'upsert',
    doc.id,
    undefined,
    doc,
    { t, c: 0, n: 'OWNER' },
    { origin: 'OWNER', channel: 'committed' }
  );
}

describe('mount', () => {
  it('lets a mounted document beat a tombstone the receiver already had', async () => {
    const { recv, cr } = pair();
    deletedHere(cr, ['scene']);
    // Baseline: without a mount, the author's older document loses — this is
    // the destructive case, and it is the behaviour everywhere else.
    fromAuthor(cr, { id: 'scene', name: 'Shared' });
    expect(cr.get('scene')).toBeUndefined();

    recv.mount('scene');
    fromAuthor(cr, { id: 'scene', name: 'Shared' });
    expect(cr.get('scene')?.name).toBe('Shared');
  });

  it('covers the whole subtree, not just the root', async () => {
    const { recv, cr } = pair();
    // Containment first: the child must be indexed under the root for the
    // scope walk to reach it.
    cr.set('scene', '', { id: 'scene', name: 'Shared' });
    cr.set('deep', '', { id: 'deep', name: 'x', parentId: 'scene' });
    cr.remove('deep');

    recv.mount('scene');
    fromAuthor(cr, { id: 'deep', name: 'back', parentId: 'scene' });

    expect(cr.get('deep')?.name).toBe('back');
  });

  it('leaves documents outside the mounted scope alone', async () => {
    const { recv, cr } = pair();
    cr.set('mine', '', { id: 'mine', name: 'local' });
    cr.remove('mine');

    recv.mount('scene');
    // An unrelated stale write must still lose to the local delete: the mount
    // is a scope, not a global amnesty.
    fromAuthor(cr, { id: 'mine', name: 'zombie' });
    expect(cr.get('mine')).toBeUndefined();
  });

  it('expires by itself once the author writes again', async () => {
    const { recv, cr } = pair();
    recv.mount('scene');
    cr.set('scene', '', { id: 'scene', name: 'At mount' });

    // A write after the mount carries a newer stamp, so max() is the write
    // stamp — ordinary LWW, no flag to clear.
    cr.set('scene', 'name', 'Later');
    expect(cr.get('scene')?.name).toBe('Later');

    // And a write from BEFORE the mount still loses, which is the point: the
    // mount is the truth as of when it happened.
    fromAuthor(cr, { id: 'scene', name: 'stale' });
    expect(cr.get('scene')?.name).toBe('Later');
  });

  it('does not stamp the documents, so nothing leaks back to the author', async () => {
    const { owner, recv, co, cr, flush } = pair();
    co.set('scene', '', { id: 'scene', name: 'Owned' });
    await flush();

    await recv.subscribe('OWNER', {
      entityRtype: 'node',
      entityId: 'scene',
      includeDescendants: true,
      pathPrefix: '',
    });
    await flush();
    recv.mount('scene');
    await flush();

    // The receiver's replica may reconcile the doc against the mount, but the
    // document it holds is the author's, unchanged — no receiver-authored
    // stamp to re-publish, so the author cannot be handed back a version of
    // their own scene that this peer appears to have written.
    expect(cr.get('scene')).toEqual({ id: 'scene', name: 'Owned' });
    expect(co.get('scene')).toEqual({ id: 'scene', name: 'Owned' });
    expect(owner.undoStatus().canUndo).toBe(true); // the author's own create
  });

  it('unmount returns the scope to ordinary LWW', async () => {
    const { recv, cr } = pair();
    cr.set('scene', '', { id: 'scene', name: 'Shared' });
    cr.remove('scene');

    recv.mount('scene');
    recv.unmount('scene');
    fromAuthor(cr, { id: 'scene', name: 'zombie' });
    expect(cr.get('scene')).toBeUndefined();
  });

  it('re-mounting moves the stamp forward — a second mount is a second act', async () => {
    const { recv, cr } = pair();
    recv.mount('scene');
    fromAuthor(cr, { id: 'scene', name: 'First' });
    cr.remove('scene'); // deleted HERE, after the mount — a local decision

    // The first mount's stamp is now older than that delete, so the author's
    // document stays gone…
    fromAuthor(cr, { id: 'scene', name: 'First' });
    expect(cr.get('scene')).toBeUndefined();

    // …until the user mounts again, which is a second deliberate act.
    recv.mount('scene');
    fromAuthor(cr, { id: 'scene', name: 'Second' });
    expect(cr.get('scene')?.name).toBe('Second');
  });
});
