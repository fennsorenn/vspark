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
const subscribed = new Set<string>(); // in-flight/active subscription dedupe
const subs = new Map<string, MeshSubscription>(); // active subscription handles

/** Issue the mesh grant for one collab link (idempotent per process). */
export function grantCollabScene(
  peer: MeshPeer,
  granteePeerId: string,
  sceneId: string
): void {
  const key = `${granteePeerId}:${sceneId}`;
  if (granted.has(key)) return;
  granted.set(key, peer.grants.grant(sceneGrant(granteePeerId, sceneId)));
}

/** First-mount race: we may subscribe before the remote side has issued our
 *  grant (it grants on mount / on snapshot receipt) — retry denials. */
const SUBSCRIBE_RETRY_MS = 3000;
const SUBSCRIBE_MAX_RETRIES = 40;

/** Subscribe to one collab link's peer now (if connected) and keep it armed
 *  across reconnects. */
function armLink(
  peer: MeshPeer,
  remotePeerId: string,
  sceneId: string,
  attempt = 0
): void {
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
    .then((sub) => {
      if (process.env.COLLAB_DEBUG)
        console.log(
          `[collab-dbg] subscribed to ${remotePeerId} for scene ${sceneId} (attempt ${attempt}) — receiver→author ops can now flow`
        );
      // Torn down while the subscribe was in flight → drop it immediately.
      if (subscribed.has(key)) subs.set(key, sub);
      else sub.unsubscribe();
    })
    .catch((e) => {
      subscribed.delete(key);
      if (process.env.COLLAB_DEBUG)
        console.log(
          `[collab-dbg] subscribe to ${remotePeerId} for scene ${sceneId} DENIED (attempt ${attempt}): ${String((e as Error)?.message ?? e)}`
        );
      if (attempt < SUBSCRIBE_MAX_RETRIES) {
        setTimeout(
          () => armLink(peer, remotePeerId, sceneId, attempt + 1),
          SUBSCRIBE_RETRY_MS
        );
      } else {
        console.warn(
          `[mesh] collab subscribe ${sceneId} @ ${remotePeerId} gave up:`,
          e
        );
      }
    });
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
    try {
      sub.unsubscribe();
    } catch {
      /* link already gone */
    }
    subs.delete(key);
  }
  subscribed.delete(key);
}

/** (Re-)sync grants + subscriptions against the current collab links. Called
 *  at init, on peer connect/disconnect, and after share/mount. */
export function syncCollabLinks(peer: MeshPeer): void {
  const connected = new Set(peer.status().peers.map((p) => p.id));
  for (const link of listAllCollabScenes()) {
    if (process.env.COLLAB_DEBUG)
      console.log(
        `[collab-dbg] syncLink role=${link.role} peer=${link.peerId} scene=${link.sceneId} connected=${connected.has(link.peerId)} — granting peer + arming subscription`
      );
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
