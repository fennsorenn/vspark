/**
 * Mesh-driven feeder for shared-object projections (§9 step D).
 *
 * The legacy `_share_snapshot` / `_share_update` document relay is gone: a
 * placed object's docs ride our server's one-way mesh subscription into its
 * replica, fan out to this tab over /mesh, and land in the tab's own replica.
 * This module watches the mesh `scene_node` collection and drives the
 * existing projection store ({@link ./sharedProjection}) from it:
 *
 *   - a projection is ACTIVE when its container node is placed AND we're
 *     subscribed to (owner, objectId) (connectionsStore.subscribed);
 *   - activation projects the current mesh subtree (applySnapshot); every
 *     later committed change applies incrementally (applyUpdate — which keeps
 *     the Phase-6 stale-drop + pending-write reconciliation);
 *   - asset paths arrive separately (the legacy snapshot is now the asset
 *     manifest): {@link registerAssetUrls} stores the owner-path → local-URL
 *     map and re-projects, so models load from the local cache.
 *
 * Unshare/disconnect teardown stays where it was (useWsSync handlers call
 * removeProjection); this feeder only ever projects the active set.
 */
import { initMeshPeer, getMeshHandles } from '../mesh/peer';
import { useEditorStore } from '../store/editorStore';
import { useConnectionsStore } from '../store/connectionsStore';
import {
  REMOTE_OBJECT_KIND,
  applySnapshot,
  applyUpdate,
  removeProjection,
  isProjected,
  owningProjectionRoot,
} from './sharedProjection';
import type { SyncEnvelope } from '@vspark/shared/sync';

type Dto = Record<string, unknown>;

interface Active {
  owner: string;
  objectId: string;
}

/** peerId → owner file path → localized URL (blob cache / object URL). */
const assetUrls = new Map<string, Map<string, string>>();
let active = new Map<string, Active>();
let started = false;

const keyOf = (owner: string, objectId: string): string =>
  `${owner}\0${objectId}`;

/** Record localized asset URLs for a peer (from the legacy snapshot manifest
 *  or the direct-edge blob fetch) and re-project so models pick them up. */
export function registerAssetUrls(
  peerId: string,
  urls: Record<string, string>
): void {
  let m = assetUrls.get(peerId);
  if (!m) assetUrls.set(peerId, (m = new Map()));
  let changed = false;
  for (const [ownerPath, url] of Object.entries(urls)) {
    if (m.get(ownerPath) !== url) {
      m.set(ownerPath, url);
      changed = true;
    }
  }
  if (!changed) return;
  for (const a of active.values())
    if (a.owner === peerId) project(a.owner, a.objectId);
}

function localize(owner: string, dto: Dto): Dto {
  const fp = dto.filePath;
  if (typeof fp !== 'string') return dto;
  const url = assetUrls.get(owner)?.get(fp);
  return url ? { ...dto, filePath: url } : dto;
}

/** (Re-)project the full mesh subtree of one placed object. */
function project(owner: string, objectId: string): void {
  const h = getMeshHandles();
  if (!h) return;
  const docs = h.collections.scene_node.subtree(objectId) as Dto[];
  if (docs.length === 0) return; // mesh sub still arming — observe() will fire
  const root = docs.find((d) => d.id === objectId);
  applySnapshot(owner, {
    objectId,
    rootName: typeof root?.name === 'string' ? root.name : '',
    nodes: docs.map((d) => localize(owner, d)),
    behaviors: [],
    cameraEffects: [],
  });
}

/** Containers placed in the scene + subscriptions we hold = the active set. */
function computeActive(): Map<string, Active> {
  const subscribed = useConnectionsStore.getState().subscribed;
  const next = new Map<string, Active>();
  for (const n of useEditorStore.getState().nodes) {
    if (n.kind !== REMOTE_OBJECT_KIND) continue;
    const ref = (
      n.components as
        | { remoteRef?: { ownerPeerId?: string; remoteObjectId?: string } }
        | undefined
    )?.remoteRef;
    const owner = ref?.ownerPeerId;
    const objectId = ref?.remoteObjectId;
    if (!owner || !objectId) continue;
    if (!subscribed[owner]?.includes(objectId)) continue;
    next.set(keyOf(owner, objectId), { owner, objectId });
  }
  return next;
}

function refresh(): void {
  const next = computeActive();
  for (const [k, a] of active)
    if (!next.has(k)) removeProjection(a.owner, a.objectId);
  for (const [k, a] of next)
    if (!active.has(k) || !isProjected(a.owner, a.objectId))
      project(a.owner, a.objectId);
  active = next;
}

/** Start observing (idempotent). Safe to call before the mesh peer is up. */
export function startMeshProjection(): void {
  if (started) return;
  started = true;

  // Re-derive the active set when containers or subscriptions change. Both
  // stores update by reference, so a cheap identity memo gates the work.
  let lastNodes = useEditorStore.getState().nodes;
  let lastSubscribed = useConnectionsStore.getState().subscribed;
  useEditorStore.subscribe((s) => {
    if (s.nodes === lastNodes) return;
    lastNodes = s.nodes;
    refresh();
  });
  useConnectionsStore.subscribe((s) => {
    if (s.subscribed === lastSubscribed) return;
    lastSubscribed = s.subscribed;
    refresh();
  });

  void initMeshPeer().then((h) => {
    refresh();
    h.collections.scene_node.observe('**', (change) => {
      if (change.op === 'ephemeral') return; // preview overlays aren't model state
      if (change.op === 'remove') {
        // Containment is already gone — resolve the object via the projection.
        for (const a of active.values()) {
          if (owningProjectionRoot(a.owner, change.id) !== a.objectId) continue;
          applyUpdate(a.owner, a.objectId, {
            rtype: 'scene_node',
            op: 'remove',
            key: change.id,
            v: change.v,
          } as SyncEnvelope);
          return;
        }
        return;
      }
      for (const a of active.values()) {
        const inSubtree =
          change.id === a.objectId ||
          h.peer.isDescendant(change.id, a.objectId);
        if (!inSubtree) continue;
        if (!isProjected(a.owner, a.objectId)) {
          project(a.owner, a.objectId); // first docs after subscribe
        } else if (change.doc) {
          applyUpdate(a.owner, a.objectId, {
            rtype: 'scene_node',
            op: 'upsert',
            key: change.id,
            data: localize(a.owner, change.doc as Dto),
            v: change.v,
          } as SyncEnvelope);
        }
        return;
      }
    });
  });
}
