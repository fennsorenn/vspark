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
let _animCol: Collection<Dto> | null = null;
let _peer: MeshPeer | null = null;

/** Bind the animation_clip collection (its follow-up re-points sourceFilePath). */
export function setAnimationClipCollection(col: Collection<Dto>): void {
  _animCol = col;
}
/** In-flight follow-ups (`${docId}\0${path}`) — dedupes concurrent triggers
 *  for the same target+path, cleared on completion so a later switch BACK to a
 *  previously-seen path re-runs (and re-points the doc). The author write-back
 *  bounce is prevented by alreadyHaveContent(), not by this set, so a
 *  permanent dedupe here is wrong: it stranded a model switch to an
 *  already-loaded model on the old path. */
const inFlight = new Set<string>();

function beginFollowUp(key: string): boolean {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

/** The multiplayer manager injects blob access once its BlobManager exists. */
export function setAssetTransfer(t: AssetTransfer): void {
  _transfer = t;
}

/** A content-addressed shared URL embeds its blob's sha256. */
const SHARED_HASH_RE = /_shared\/([0-9a-f]{64})/;

/** Whether this server already holds the content `filePath` refers to — so a
 *  fetch + re-point would be redundant. Covers (a) a managed asset row at this
 *  exact path, and (b) a `_shared/<hash>` URL whose hash we already hold under
 *  ANY path. (b) is what stops a peer's `_shared` write-back from bouncing the
 *  author into re-fetching its own asset and re-pointing its row: the author
 *  keeps its local path, content already converged. */
function alreadyHaveContent(filePath: string): boolean {
  const db = getDb();
  if (
    db
      .prepare('SELECT 1 FROM asset_files WHERE stored_path = ? LIMIT 1')
      .get(filePath)
  )
    return true;
  const m = SHARED_HASH_RE.exec(filePath);
  return (
    !!m &&
    !!db
      .prepare('SELECT 1 FROM asset_files WHERE hash = ? LIMIT 1')
      .get(m[1])
  );
}

/** COLLAB: called from the scene_node validate transform when a foreign doc's
 *  filePath differs from our local row (the transform keeps the local path;
 *  this fetches the new content and re-points the row when it lands). */
export function queueCollabAssetFollowUp(
  nodeId: string,
  ownerPath: string,
  sceneId: string
): void {
  collabFollowUp(_col, 'filePath', nodeId, ownerPath, sceneId);
}

/** COLLAB: same follow-up for an animation clip's source file (FBX/BVH). The
 *  animation_clip validate keeps the local source_file_path and queues this
 *  when a foreign doc references content we don't hold. */
export function queueAnimationAssetFollowUp(
  clipId: string,
  ownerPath: string,
  sceneId: string
): void {
  collabFollowUp(_animCol, 'sourceFilePath', clipId, ownerPath, sceneId);
}

/** Shared collab follow-up: fetch `ownerPath`'s content from one of the
 *  scene's collab peers, record the asset row, and re-point the doc's path
 *  field to the local /uploads/_shared URL through the store. */
function collabFollowUp(
  col: Collection<Dto> | null,
  pathField: string,
  docId: string,
  ownerPath: string,
  sceneId: string
): void {
  if (!_transfer || !col) return;
  if (alreadyHaveContent(ownerPath)) return; // resolvable / content already held
  const key = `${docId}\0${ownerPath}`;
  if (!beginFollowUp(key)) return;
  void (async () => {
    try {
      for (const link of collabPeersForScene(sceneId)) {
        try {
          const meta = await _transfer!.metaForPath(link.peerId, ownerPath);
          if (!meta) continue; // that peer doesn't have it either
          // ensure() returns the cached URL without re-downloading when the
          // blob is already held — so a switch to a previously-loaded model
          // costs only a meta round-trip, then re-points.
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
          const cur = col.get(docId);
          if (cur && cur[pathField] !== url)
            await col.set(docId, '', { ...cur, [pathField]: url }).ack;
          return;
        } catch (e) {
          console.warn(
            `[mesh] collab asset fetch ${ownerPath} from ${link.peerId} failed:`,
            e
          );
        }
      }
    } finally {
      inFlight.delete(key);
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
    const key = `${c.id}\0${filePath}`;
    if (!beginFollowUp(key)) return;
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
      } finally {
        inFlight.delete(key);
      }
    })();
  });
}
