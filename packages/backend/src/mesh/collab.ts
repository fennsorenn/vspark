/**
 * Collab scenes over the mesh (§9 step B; one-way since
 * plans/mesh-store-surface.md step 2).
 *
 * A collab link (collab_scenes row) is shared ONE way. The author grants the
 * mounting peer RUCD on the scene subtree (entityRtype '*' — covers nodes,
 * clips, effects, behaviors via cross-type containment), and the mounting
 * peer subscribes to the scene. The author decides every write to it: the
 * mounting peer's writes travel to the author — whoever granted them — and
 * are acked, corrected or refused there; while the author is offline the
 * mounted scene is read-only. Working on it without the author is what a
 * local copy is for.
 *
 * The subscription names no peer: the mesh serves it from whoever granted the
 * scene, renews it after a reconnect, and waits while no grant covers it yet
 * (the first mount races the author's grant). Snapshot-on-subscribe replaces
 * the legacy `_collab_reconcile`. The legacy snapshot/mount path is kept ONLY
 * for the initial mount (asset transfer + path rewriting ride it).
 */
import type { Grant, MeshPeer, MeshSubscription } from '@vspark/mesh';
import { listAllCollabScenes } from '../multiplayer/collabScene.js';

const RUCD = { read: true, update: true, create: true, delete: true };

function sceneGrant(granteePeerId: string, sceneId: string): Grant {
  return {
    grantee: granteePeerId,
    entityRtype: '*',
    entityId: sceneId,
    includeDescendants: true,
    pathPrefix: '',
    rights: RUCD,
  };
}

const granted = new Map<string, string>(); // `${peerId}:${sceneId}` → grant id
const subs = new Map<string, Promise<MeshSubscription>>(); // mounted scenes

/** Author: issue the mesh grant for one collab link (idempotent). */
export function grantCollabScene(
  peer: MeshPeer,
  granteePeerId: string,
  sceneId: string
): void {
  const key = `${granteePeerId}:${sceneId}`;
  if (granted.has(key)) return;
  granted.set(key, peer.grants.grant(sceneGrant(granteePeerId, sceneId)));
}

/** Mounting peer: subscribe to the scene (idempotent; held by the mesh across
 *  reconnects). */
function subscribeCollabScene(
  peer: MeshPeer,
  remotePeerId: string,
  sceneId: string
): void {
  const key = `${remotePeerId}:${sceneId}`;
  if (subs.has(key)) return;
  subs.set(
    key,
    peer.subscribe({
      entityRtype: '*',
      entityId: sceneId,
      includeDescendants: true,
      pathPrefix: '',
    })
  );
}

/** Tear down one collab link's mesh state: revoke our grant to the peer (which
 *  drops THEIR subscription to us, so our subsequent edits/deletes stop fanning
 *  out to them) and drop our subscription to them. Used when a local collab
 *  scene is deleted — disconnecting the collaboration without propagating the
 *  local deletion to the peer (their copy stays intact). */
export function teardownCollabScene(
  peer: MeshPeer,
  remotePeerId: string,
  sceneId: string
): void {
  const key = `${remotePeerId}:${sceneId}`;
  const gid = granted.get(key);
  if (gid) {
    peer.grants.revoke(gid);
    granted.delete(key);
  }
  const sub = subs.get(key);
  if (sub) {
    subs.delete(key);
    void sub.then((s) => s.unsubscribe());
  }
}

/** Bring grants and subscriptions in line with the current collab links.
 *  Called at init and after share/mount. */
export function syncCollabLinks(peer: MeshPeer): void {
  for (const link of listAllCollabScenes()) {
    if (link.role === 'author')
      grantCollabScene(peer, link.peerId, link.sceneId);
    else subscribeCollabScene(peer, link.peerId, link.sceneId);
  }
}

/** Wire collab links to the mesh peer. */
export function initMeshCollab(peer: MeshPeer): void {
  syncCollabLinks(peer);
}
