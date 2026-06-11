/**
 * Collab scenes over the mesh (§9 step B).
 *
 * A collab link (collab_scenes row) becomes: a standing RUCD grant for the
 * peer on the scene subtree (entityRtype '*' — covers nodes, clips, effects,
 * behaviors via cross-type containment) + a mutual subscription armed
 * whenever the peer is connected. Snapshot-on-subscribe replaces the legacy
 * `_collab_reconcile`; both sides persist incoming ops through the generic
 * tap. The legacy snapshot/mount path is kept ONLY for the initial mount
 * (asset transfer + path rewriting ride it); live ops + reconcile are mesh.
 */
import type { Grant, MeshPeer } from '@vspark/mesh';
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

const granted = new Set<string>(); // `${peerId}:${sceneId}` — dedupe per process
const subscribed = new Set<string>();

/** Issue the mesh grant for one collab link (idempotent per process). */
export function grantCollabScene(
  peer: MeshPeer,
  granteePeerId: string,
  sceneId: string
): void {
  const key = `${granteePeerId}:${sceneId}`;
  if (granted.has(key)) return;
  granted.add(key);
  peer.grants.grant(sceneGrant(granteePeerId, sceneId));
}

/** Subscribe to one collab link's peer now (if connected) and keep it armed
 *  across reconnects. */
function armLink(peer: MeshPeer, remotePeerId: string, sceneId: string): void {
  const key = `${remotePeerId}:${sceneId}`;
  if (subscribed.has(key)) return;
  if (!peer.status().peers.some((p) => p.id === remotePeerId)) return;
  subscribed.add(key);
  peer
    .subscribe(remotePeerId, {
      entityRtype: '*',
      entityId: sceneId,
      includeDescendants: true,
      pathPrefix: '',
    })
    .catch((e) => {
      subscribed.delete(key);
      console.warn(`[mesh] collab subscribe ${sceneId} @ ${remotePeerId}:`, e);
    });
}

/** (Re-)sync grants + subscriptions against the current collab links. Called
 *  at init, on peer connect/disconnect, and after share/mount. */
export function syncCollabLinks(peer: MeshPeer): void {
  const connected = new Set(peer.status().peers.map((p) => p.id));
  for (const link of listAllCollabScenes()) {
    grantCollabScene(peer, link.peerId, link.sceneId);
    const key = `${link.peerId}:${link.sceneId}`;
    if (!connected.has(link.peerId)) {
      subscribed.delete(key); // re-arm on reconnect (snapshot = reconcile)
      continue;
    }
    armLink(peer, link.peerId, link.sceneId);
  }
}

/** Wire collab links to the mesh peer lifecycle. */
export function initMeshCollab(peer: MeshPeer): void {
  syncCollabLinks(peer);
  peer.onStatus(() => syncCollabLinks(peer));
}
