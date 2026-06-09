/**
 * Receiver-side consumption of a peer's shared object over the **direct WebRTC
 * edge** (permissioned-sync-mesh). When a browser holds a direct mesh link to a
 * remote owner, it subscribes straight to the owner and the owner streams the
 * snapshot, live updates, pose, overrides, data channels, and asset blobs over
 * that link — no relay hop through the receiver's own server.
 *
 * This mirrors the WS `mp_shared_*` path in {@link ../hooks/useWsSync} (same
 * store/projection calls), with one addition: the owner does *not* localize
 * assets for a browser (there's no receiver backend in the path), so we fetch
 * each asset over the same edge via {@link ../mesh/blobReceiver} and rewrite the
 * node file paths to object URLs ourselves — the browser-side equivalent of the
 * backend's relaySnapshot/relayUpdate.
 *
 * Offers still arrive over the relay (`mp_shares`); only the heavy data rides the
 * direct edge. See dev-notes/plans/permissioned-sync-mesh.md.
 */
import { clientMesh } from '../mesh/clientMesh';
import { ensureBlob, type BlobMeta } from '../mesh/blobReceiver';
import { useEditorStore } from '../store/editorStore';
import { useConnectionsStore } from '../store/connectionsStore';
import {
  applySnapshot as applySharedSnapshot,
  applyUpdate as applySharedUpdate,
  removeProjection as removeSharedProjection,
} from './sharedProjection';
import { setVmcPose, setVmcBlendshapes } from '../vmcPoseStore';
import { smoothNodeTransform } from '../previewSmoother';
import { setIkTargets } from '../ikTargetStore';
import type { IkTargetFrame, AnimationBlendMode } from '@vspark/shared/types';
import type { SyncEnvelope } from '@vspark/shared/sync';

const ADVERTISE = '_share_advertise';
const SNAPSHOT = '_share_snapshot';
const UPDATE = '_share_update';
const UNSHARED = '_share_unshared';
const STREAM = '_share_stream';
const OVERRIDE = '_share_override';
const DATACHANNEL = '_share_datachannel';
const SUBSCRIBE = '_share_subscribe';
const UNSUBSCRIBE = '_share_unsubscribe';

/** Whether a remote owner is reachable over a direct mesh edge right now. */
export function hasDirectEdge(owner: string): boolean {
  return clientMesh.isConnected(owner);
}

/** Subscribe to an owner's object directly over the edge. Returns whether sent. */
export function subscribeDirect(owner: string, objectId: string): boolean {
  return clientMesh.sendEnvelope(owner, {
    rtype: SUBSCRIBE,
    op: 'event',
    key: objectId,
    data: { objectId },
  });
}

export function unsubscribeDirect(owner: string, objectId: string): boolean {
  return clientMesh.sendEnvelope(owner, {
    rtype: UNSUBSCRIBE,
    op: 'event',
    key: objectId,
    data: { objectId },
  });
}

interface SnapshotAsset extends BlobMeta {
  filePath: string;
}
interface ObjectSnapshot {
  objectId: string;
  nodes: Record<string, unknown>[];
  assets?: SnapshotAsset[];
}

/** Dispatch a `_share_*` envelope received from `from` over the direct edge. */
export function handleShareEnvelope(from: string, env: SyncEnvelope): void {
  const data = (env.data ?? {}) as Record<string, unknown>;
  switch (env.rtype) {
    case ADVERTISE: {
      const shares = (data.shares ?? []) as import('../store/connectionsStore').SharedOffer[];
      useConnectionsStore.getState().setOffers(from, shares);
      break;
    }
    case SNAPSHOT:
      void applyDirectSnapshot(from, data.snapshot as ObjectSnapshot);
      break;
    case UPDATE:
      void applyDirectUpdate(
        from,
        data.objectId as string,
        data.env as SyncEnvelope,
        data.asset as SnapshotAsset | undefined
      );
      break;
    case UNSHARED:
      removeSharedProjection(from, data.objectId as string);
      useConnectionsStore
        .getState()
        .setSubscribed(from, data.objectId as string, false);
      break;
    case STREAM:
      applyDirectStream(env as unknown as Record<string, unknown>);
      break;
    case OVERRIDE:
      applyDirectOverride(data);
      break;
    case DATACHANNEL:
      applyDirectDataChannel(data);
      break;
  }
}

/** Fetch every asset over the edge and rewrite node file paths to object URLs,
 *  then project. Owner paths are kept on a fetch failure (still resolves if both
 *  servers share an uploads dir). */
async function applyDirectSnapshot(
  from: string,
  snapshot: ObjectSnapshot
): Promise<void> {
  if (!snapshot) return;
  const urlByPath = new Map<string, string>();
  await Promise.all(
    (snapshot.assets ?? []).map(async (a) => {
      try {
        urlByPath.set(a.filePath, await ensureBlob(from, a));
      } catch {
        /* keep the owner path */
      }
    })
  );
  if (urlByPath.size > 0)
    for (const n of snapshot.nodes) {
      const fp = (n as { filePath?: string }).filePath;
      if (fp && urlByPath.has(fp))
        (n as { filePath?: string }).filePath = urlByPath.get(fp);
    }
  applySharedSnapshot(
    from,
    snapshot as unknown as Parameters<typeof applySharedSnapshot>[1]
  );
  useConnectionsStore.getState().setSubscribed(from, snapshot.objectId, true);
}

async function applyDirectUpdate(
  from: string,
  objectId: string,
  env: SyncEnvelope,
  asset: SnapshotAsset | undefined
): Promise<void> {
  const node = env?.data as { filePath?: string } | undefined;
  if (asset && node?.filePath) {
    try {
      node.filePath = await ensureBlob(from, asset);
    } catch {
      /* keep the owner path */
    }
  }
  applySharedUpdate(from, objectId, env);
}

function applyDirectStream(f: Record<string, unknown>): void {
  const kind = f.kind as string;
  const payload = (f.payload ?? {}) as Record<string, unknown>;
  if (kind === 'vmc_pose') {
    setVmcPose(
      payload.nodeId as string,
      payload.bones as Record<string, [number, number, number, number]>,
      (payload.animationBlendMode as AnimationBlendMode | undefined) ??
        'override'
    );
  } else if (kind === 'vmc_blendshapes') {
    setVmcBlendshapes(
      payload.nodeId as string,
      payload.blendshapes as Record<string, number>
    );
  } else if (kind === 'pose_ik_targets') {
    setIkTargets(payload.nodeId as string, payload as unknown as IkTargetFrame);
  } else if (kind === 'node_transform_preview') {
    smoothNodeTransform(
      payload.nodeId as string,
      payload.transform as Record<string, number>
    );
  }
}

function applyDirectOverride(data: Record<string, unknown>): void {
  const op = data.op as 'set' | 'clear';
  const targetKind = data.targetKind as 'scene_node' | 'compose_layer';
  const targetId = data.targetId as string;
  const paramPath = data.paramPath as string | undefined;
  const value = data.value as number | string | boolean | undefined;
  if (op === 'set' && paramPath != null && value != null) {
    useEditorStore
      .getState()
      .setRuntimeOverride(targetKind, targetId, paramPath, value);
  } else if (op === 'clear') {
    useEditorStore
      .getState()
      .clearRuntimeOverride(targetKind, targetId, paramPath);
  }
}

function applyDirectDataChannel(data: Record<string, unknown>): void {
  const op = data.op as 'set' | 'clear';
  const scope = (data.scope as string) ?? '';
  if (op === 'set') {
    useEditorStore
      .getState()
      .mergeDataChannels(scope, (data.fields ?? {}) as Record<string, unknown>);
  } else {
    useEditorStore
      .getState()
      .clearDataChannels(scope, data.field as string | undefined);
  }
}
