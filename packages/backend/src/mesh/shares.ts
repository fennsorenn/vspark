/**
 * Object shares ("place") over the mesh (§9 step D).
 *
 * Owner side: every legacy share grant (sync/grants store, the persistent
 * source of truth) is mirrored into the mesh peer's grant store as a
 * cross-type subtree grant (entityRtype '*'), so a receiver's one-way
 * subscribe is admitted and snapshot-on-subscribe carries the object's
 * document plane. Revoking the legacy grant revokes the mirror, which
 * evicts the receiver's incoming subscription (fan-out stops).
 *
 * Receiver side: placing a shared object arms a one-way mesh subscription
 * on the owner. Nothing is persisted from it — the persistence tap skips
 * docs that don't resolve to local rows (see ./index.ts) — so the docs live
 * only in the replica and fan out to this server's tabs, which project them.
 * Subscriptions are re-armed by the frontend on reconnect (it re-issues
 * the subscribe REST call whenever the owner comes back).
 *
 * Streams (pose/preview), asset transfer, Phase-6 writes, and the
 * advertise/unshared offer flow stay on the legacy `_share_*` protocol.
 */
import type { Grant, MeshPeer, MeshSubscription } from '@vspark/mesh';
import { listAllGrants } from '../sync/grants.js';
import { getMeshPeer } from './index.js';

const gids = new Map<string, string>(); // `${grantee}\0${objectId}` → mesh gid

function key(grantee: string, objectId: string): string {
  return `${grantee}\0${objectId}`;
}

/** Owner: mirror one legacy share grant into the mesh (replaces any prior
 *  mirror for the same grantee+object, so a canWrite toggle re-mirrors). */
export function mirrorShareGrant(
  grantee: string,
  objectId: string,
  rights: Grant['rights'],
  peer: MeshPeer | null = getMeshPeer()
): void {
  if (!peer) return;
  const k = key(grantee, objectId);
  const prior = gids.get(k);
  if (prior) peer.grants.revoke(prior);
  gids.set(
    k,
    peer.grants.grant({
      grantee,
      entityRtype: '*', // cross-type: nodes + behaviors/effects/clips via containment
      entityId: objectId,
      includeDescendants: true,
      pathPrefix: '',
      rights,
    })
  );
}

/** Owner: drop the mesh mirror of a revoked legacy share grant. */
export function dropShareGrant(grantee: string, objectId: string): void {
  const peer = getMeshPeer();
  const gid = gids.get(key(grantee, objectId));
  if (!peer || !gid) return;
  gids.delete(key(grantee, objectId));
  peer.grants.revoke(gid);
}

/** Hydrate mirrors for every persisted share grant (boot). Collab-scene
 *  shares are mirrored too — duplicating collab.ts's link grant is harmless
 *  (both admit the same traffic) and keeps revocation uniform. */
export function hydrateShareGrants(peer: MeshPeer): void {
  for (const g of listAllGrants()) {
    if (g.entityRtype !== 'scene_node' || !g.rights.read) continue;
    mirrorShareGrant(g.grantee, g.entityId, g.rights, peer);
  }
}

// --- receiver: placed-object subscriptions -----------------------------------

const placed = new Map<string, MeshSubscription>(); // `${owner}\0${objectId}`
const arming = new Set<string>();

/** First-place race: the owner mirrors the grant when the share is created,
 *  but a just-granted share may still beat the advertise round-trip. */
const SUBSCRIBE_RETRY_MS = 3000;
const SUBSCRIBE_MAX_RETRIES = 10;

/** Receiver: subscribe to a peer's shared object over the mesh (idempotent;
 *  retried on denial). The snapshot seeds the replica; live ops follow. */
export function subscribeSharedObject(
  owner: string,
  objectId: string,
  attempt = 0
): void {
  const peer = getMeshPeer();
  if (!peer) return;
  const k = key(owner, objectId);
  if (placed.has(k) || arming.has(k)) return;
  if (!peer.status().peers.some((p) => p.id === owner)) return;
  arming.add(k);
  peer
    .subscribe(owner, {
      entityRtype: '*',
      entityId: objectId,
      includeDescendants: true,
      pathPrefix: '',
    })
    .then((sub) => {
      arming.delete(k);
      placed.set(k, sub);
    })
    .catch((e) => {
      arming.delete(k);
      if (attempt < SUBSCRIBE_MAX_RETRIES) {
        setTimeout(
          () => subscribeSharedObject(owner, objectId, attempt + 1),
          SUBSCRIBE_RETRY_MS
        );
      } else {
        console.warn(`[mesh] place subscribe ${objectId} @ ${owner} gave up:`, e);
      }
    });
}

/** Receiver: drop a placed subscription (container removed / unshared). */
export function unsubscribeSharedObject(owner: string, objectId: string): void {
  const k = key(owner, objectId);
  const sub = placed.get(k);
  placed.delete(k);
  arming.delete(k);
  try {
    sub?.unsubscribe();
  } catch {
    /* link may already be gone */
  }
}

/** Prune placed subscriptions whose owner disconnected, so the frontend's
 *  re-subscribe on reconnect arms a fresh one (snapshot = reconcile). */
function pruneStalePlaced(peer: MeshPeer): void {
  const connected = new Set(peer.status().peers.map((p) => p.id));
  for (const k of [...placed.keys()]) {
    const owner = k.split('\0')[0];
    if (!connected.has(owner)) placed.delete(k);
  }
}

/** Wire share grants + placed subscriptions to the mesh peer lifecycle. */
export function initMeshShares(peer: MeshPeer): void {
  hydrateShareGrants(peer);
  peer.onStatus(() => pruneStalePlaced(peer));
}
