/**
 * Phase 6 multiplayer: route edits of a *writable remote* (projected) node to its
 * owner over the mesh instead of this server's REST API. Registered into
 * {@link ../api/client} as the `RemoteWriteRouter`, so every `updateNode` /
 * `deleteNode` call site funnels through here with no per-site changes.
 *
 * The edit is applied optimistically by the call site's `storeUpdateNode` first;
 * we record a pending write, send `_share_write` to the owner, and the owner's
 * authoritative echo (or a `_share_write_nak` → rollback) reconciles it. See
 * dev-notes/plans/multiplayer-phase6.md.
 */
import { useEditorStore } from '../store/editorStore';
import type { StageObject } from '../store/editorStore';
import { canWriteObject } from '../store/connectionsStore';
import { setRemoteWriteRouter } from '../api/client';
import type { SyncEnvelope } from '@vspark/shared/sync';
import {
  owningProjectionRoot,
  ancestorRoute,
  recordPendingWrite,
  addProjectedNode,
} from './sharedProjection';
import { sendShareWriteDirect } from './shareDirect';

/** The owner only applies content (structure is owner-authoritative), so send the
 *  node's editable fields; parentId is informational for create. */
function nodeDto(n: StageObject): Record<string, unknown> {
  return {
    id: n.id,
    parentId: n.parentId,
    name: n.name,
    kind: n.kind,
    filePath: n.filePath,
    components: n.components,
    properties: n.properties,
    hidden: n.hidden ?? false,
  };
}

/** Relay fallback (frontend→own backend→owner over the server mesh), registered
 *  by useWsSync to avoid an import cycle. Used when there's no direct edge. */
let relaySender: ((owner: string, env: SyncEnvelope) => void) | null = null;
export function setShareWriteRelay(
  fn: ((owner: string, env: SyncEnvelope) => void) | null
): void {
  relaySender = fn;
}

function send(owner: string, env: SyncEnvelope): void {
  if (!sendShareWriteDirect(owner, env)) relaySender?.(owner, env);
}

/** Diverts an edit of a writable remote node to its owner. Returns true when it
 *  routed (REST is then skipped); false to fall through to the local REST path. */
export function routeRemoteWrite(
  op: 'update' | 'delete',
  id: string,
  data?: Partial<StageObject>
): boolean {
  const node = useEditorStore.getState().nodes.find((n) => n.id === id);
  if (!node?.remote || !node.remoteOwnerPeerId) return false;
  const owner = node.remoteOwnerPeerId;
  const root = owningProjectionRoot(owner, id);
  if (!root || !canWriteObject(owner, root)) return false;

  if (op === 'delete') {
    recordPendingWrite(owner, root, id, 'delete');
    send(owner, {
      rtype: 'scene_node',
      op: 'remove',
      key: id,
      route: ancestorRoute(owner, root, id),
    });
    return true;
  }
  // update — the optimistic patch is already in the store node.
  recordPendingWrite(owner, root, id, 'update');
  send(owner, {
    rtype: 'scene_node',
    op: 'upsert',
    key: id,
    data: nodeDto({ ...node, ...(data ?? {}) } as StageObject),
  });
  return true;
}

/** Create a child under a writable *remote* node: mint a UUID, add it to the
 *  projection optimistically, and send a `_share_write` upsert to the owner (which
 *  derives the new node's structure from its parent). Returns the optimistic node
 *  (so the caller can select it), or null if the parent isn't writable-remote —
 *  in which case the caller falls through to the normal local create. */
export function createRemoteChild(
  parent: StageObject,
  kind: string,
  name: string,
  components: Record<string, unknown>
): StageObject | null {
  const owner = parent.remoteOwnerPeerId;
  if (!parent.remote || !owner) return null;
  const root = owningProjectionRoot(owner, parent.id);
  if (!root || !canWriteObject(owner, root)) return null;

  const id = crypto.randomUUID();
  const node: StageObject = {
    id,
    parentId: parent.id, // owner-side id — the owner derives structure from it
    rootSceneNodeId: parent.rootSceneNodeId,
    projectId: parent.projectId,
    name,
    kind,
    filePath: null,
    boneAttachment: null,
    components,
    properties: {},
    hidden: false,
    remote: true,
    remoteOwnerPeerId: owner,
  };
  addProjectedNode(owner, root, node as unknown as Record<string, unknown>); // optimistic
  recordPendingWrite(owner, root, id, 'create');
  send(owner, {
    rtype: 'scene_node',
    op: 'upsert',
    key: id,
    data: nodeDto(node),
  });
  return node;
}

setRemoteWriteRouter(routeRemoteWrite);
