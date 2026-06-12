/**
 * Asset follow-up for mesh document arrivals (closes the "model swaps don't
 * carry assets over the mesh" gap).
 *
 * The mesh doc plane carries file PATHS, not blobs. When a scene_node doc
 * arrives whose filePath this server can't resolve locally, the follow-up
 * resolves the path to content-addressed metadata at the sending side
 * (`_blob_meta`), fetches the blob over the existing `_blob_*` protocol into
 * the shared cache, and then localizes:
 *
 *  - COLLAB (persisted): triggered from the scene_node validate transform
 *    (which preserves the old local path — the only place the incoming
 *    foreign path is still visible). After caching, the node is written
 *    THROUGH the store with the local `/uploads/_shared/…` URL, and an
 *    asset_files row is recorded. Peers receiving that write re-localize via
 *    their own validate, so paths stay per-server while content converges.
 *
 *  - PLACE (replica-only): triggered from a scene_node observer for foreign
 *    docs inside a placed subtree. After caching, the ownerPath → localUrl
 *    mapping broadcasts to this server's tabs as `mp_shared_assets`, and the
 *    projection feeder re-projects with the resolved path.
 *
 * Blob access is injected by the multiplayer manager (it owns BlobManager);
 * without multiplayer this module stays inert.
 */
import { getDb } from '../db/index.js';
import { basename } from 'path';
import type { Collection, MeshPeer } from '@vspark/mesh';
import type { AssetMeta } from '../multiplayer/blobs.js';
import {
  collabPeersForScene,
  recordCollabAsset,
} from '../multiplayer/collabScene.js';
import { placedOwnerOf } from './shares.js';

type Dto = Record<string, unknown>;

interface AssetTransfer {
  metaForPath(peerId: string, filePath: string): Promise<AssetMeta | null>;
  ensure(peerId: string, meta: AssetMeta): Promise<string>;
  broadcast(kind: string, payload: Record<string, unknown>): void;
}

let _transfer: AssetTransfer | null = null;
let _col: Collection<Dto> | null = null;
let _peer: MeshPeer | null = null;
/** In-flight/attempted follow-ups (`${nodeId}\0${path}`) — one try per pair. */
const attempted = new Set<string>();
const ATTEMPT_CAP = 2048;

function markAttempted(key: string): boolean {
  if (attempted.has(key)) return false;
  attempted.add(key);
  if (attempted.size > ATTEMPT_CAP) {
    const first = attempted.values().next().value;
    if (first) attempted.delete(first);
  }
  return true;
}

/** The multiplayer manager injects blob access once its BlobManager exists. */
export function setAssetTransfer(t: AssetTransfer): void {
  _transfer = t;
}

/** A locally-servable path needs no fetch: a managed asset row, or an
 *  already-cached shared blob. */
function isLocalPath(filePath: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM asset_files WHERE stored_path = ? LIMIT 1')
    .get(filePath);
}

/** COLLAB: called from the scene_node validate transform when a foreign doc's
 *  filePath differs from our local row (the transform keeps the local path;
 *  this fetches the new content and re-points the row when it lands). */
export function queueCollabAssetFollowUp(
  nodeId: string,
  ownerPath: string,
  sceneId: string
): void {
  if (!_transfer || !_col) return;
  if (isLocalPath(ownerPath)) return; // already resolvable — nothing to fetch
  if (!markAttempted(`${nodeId}\0${ownerPath}`)) return;
  void (async () => {
    for (const link of collabPeersForScene(sceneId)) {
      try {
        const meta = await _transfer!.metaForPath(link.peerId, ownerPath);
        if (!meta) continue; // that peer doesn't have it either
        const url = await _transfer!.ensure(link.peerId, meta);
        const scene = getDb()
          .prepare('SELECT project_id FROM scene_nodes WHERE id = ?')
          .get(sceneId) as { project_id: string } | undefined;
        if (scene)
          recordCollabAsset(
            scene.project_id,
            url,
            meta.hash,
            meta.mime,
            meta.size,
            basename(ownerPath)
          );
        const cur = _col!.get(nodeId);
        if (cur && cur.filePath !== url)
          await _col!.set(nodeId, '', { ...cur, filePath: url }).ack;
        return;
      } catch (e) {
        console.warn(
          `[mesh] collab asset fetch ${ownerPath} from ${link.peerId} failed:`,
          e
        );
      }
    }
  })();
}

/** PLACE: watch foreign docs inside placed subtrees for unresolvable paths. */
export function initMeshAssets(peer: MeshPeer, col: Collection<Dto>): void {
  _peer = peer;
  _col = col;
  col.observe('**', (c) => {
    if (!_transfer || c.op === 'ephemeral' || c.op === 'remove') return;
    if (c.origin === peer.id) return;
    const doc = c.doc;
    const filePath = doc?.filePath;
    if (!doc || typeof filePath !== 'string' || !filePath) return;
    // Local docs (incl. mounted collab — re-scoped projectId) are handled by
    // the validate-side follow-up; only replica-only projections land here.
    if (
      getDb()
        .prepare('SELECT 1 FROM projects WHERE id = ? LIMIT 1')
        .get(doc.projectId as string)
    )
      return;
    const owner = placedOwnerOf(c.id, (a, b) => _peer!.isDescendant(a, b));
    if (!owner) return;
    if (!markAttempted(`${c.id}\0${filePath}`)) return;
    void (async () => {
      try {
        const meta = await _transfer!.metaForPath(owner, filePath);
        if (!meta) return;
        const url = await _transfer!.ensure(owner, meta);
        _transfer!.broadcast('mp_shared_assets', {
          peerId: owner,
          assetUrls: { [filePath]: url },
        });
      } catch (e) {
        console.warn(
          `[mesh] place asset fetch ${filePath} from ${owner} failed:`,
          e
        );
      }
    })();
  });
}
