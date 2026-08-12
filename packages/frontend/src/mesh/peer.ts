/**
 * The tab's mesh peer — parallel-run scaffold.
 *
 * Mirrors the backend's document collections into an in-tab replica over the
 * /mesh WebSocket. Nothing in the UI reads from it yet; it exists so features
 * can migrate onto mesh bindings (`@vspark/mesh-react`) one by one while the
 * legacy REST + /ws paths keep working. Plan: dev-notes/plans/mesh-sync-refactor.md §8.
 *
 * Lifecycle: `initMeshPeer()` once per tab (idempotent, kicked off from the
 * editor/viewer pages). The participant id is `${serverPeerId}#${tabUuid}` and
 * stable across reloads (sessionStorage), so HLC origins and grants stay
 * consistent per tab. Subscriptions re-arm automatically after reconnects.
 */
import {
  createMeshPeer,
  type Collection,
  type MeshPeer,
  type UndoStatus,
} from '@vspark/mesh';
import { WsBackendTransport } from '@vspark/mesh-transports/wsClient';
import { makeClientParticipantId } from '@vspark/shared/sync';

type Dto = Record<string, unknown>;

export interface MeshHandles {
  peer: MeshPeer;
  serverPeerId: string;
  collections: Record<string, Collection<Dto>>;
}

const RTYPES = [
  'scene_node',
  'behavior',
  'camera_effect',
  'compose_layer',
  'track_clip',
  'animation_clip',
  'scheduled_animation',
] as const;

const childOfNode = (d: Dto) =>
  typeof d.nodeId === 'string' ? { rtype: 'scene_node', id: d.nodeId } : null;

const PARENTS: Partial<
  Record<string, (d: Dto) => { rtype: string; id: string } | null>
> = {
  scene_node: (d) =>
    typeof d.parentId === 'string'
      ? { rtype: 'scene_node', id: d.parentId }
      : typeof d.rootSceneNodeId === 'string' && d.rootSceneNodeId !== d.id
        ? { rtype: 'scene_node', id: d.rootSceneNodeId }
        : null,
  behavior: childOfNode,
  camera_effect: childOfNode,
  compose_layer: (d) =>
    typeof d.parentId === 'string'
      ? { rtype: 'compose_layer', id: d.parentId }
      : typeof d.rootComposeSceneId === 'string' && d.rootComposeSceneId !== d.id
        ? { rtype: 'compose_layer', id: d.rootComposeSceneId }
        : null,
  track_clip: (d) =>
    typeof d.ownerNodeId === 'string'
      ? { rtype: 'scene_node', id: d.ownerNodeId }
      : typeof d.ownerLayerId === 'string'
        ? { rtype: 'compose_layer', id: d.ownerLayerId }
        : null,
  animation_clip: (d) =>
    typeof d.sourceNodeId === 'string'
      ? { rtype: 'scene_node', id: d.sourceNodeId }
      : null,
  scheduled_animation: (d) =>
    typeof d.avatarNodeId === 'string'
      ? { rtype: 'scene_node', id: d.avatarNodeId }
      : null,
};

let _init: Promise<MeshHandles> | null = null;

function tabUuid(): string {
  const KEY = 'vspark.mesh.tab';
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

export function initMeshPeer(): Promise<MeshHandles> {
  if (!_init) _init = doInit();
  return _init;
}

/** The handles, if the peer is already up (sync accessor for UI code). */
export function getMeshHandles(): MeshHandles | null {
  return _handles;
}

let _handles: MeshHandles | null = null;

// --- undo/redo (tab peer) ----------------------------------------------------
//
// Mesh-native undo lives on the peer that AUTHORS the committed write. Once a UI
// write path flows through this tab peer's collections (the open "writes →
// collection.set" migration), the action is logged here and undo/redo work with
// no extra wiring. Until then canUndo/canRedo stay false and the TopBar buttons
// are (correctly) disabled — the plumbing below is what those writes light up.

let _undoStatus: UndoStatus = { canUndo: false, canRedo: false };
const _undoObservers = new Set<(s: UndoStatus) => void>();

/** Undo this tab's last committed mesh action. No-op (false) if nothing to undo. */
export function meshUndo(): boolean {
  return _handles?.peer.undo() ?? false;
}

/** Redo the last undone action. No-op (false) if nothing to redo. */
export function meshRedo(): boolean {
  return _handles?.peer.redo() ?? false;
}

/** Run `fn`, grouping every committed mesh write it makes into ONE undo
 *  action. Use for edits that are conceptually single but structurally
 *  several — deleting a node together with its descendants, or detaching
 *  children before removing their parent. No-op wrapper when the peer isn't
 *  up yet (those writes fall back to REST and aren't undoable anyway). */
export function meshBatch<T>(fn: () => T): T {
  const peer = _handles?.peer;
  return peer ? peer.batch(fn) : fn();
}

/** Current undo/redo availability (button enablement). */
export function getMeshUndoStatus(): UndoStatus {
  return _undoStatus;
}

/** Subscribe to undo/redo availability changes. Fires immediately with the
 *  current status and on every subsequent transition. */
export function onMeshUndoChange(cb: (s: UndoStatus) => void): () => void {
  _undoObservers.add(cb);
  cb(_undoStatus);
  return () => _undoObservers.delete(cb);
}

async function doInit(): Promise<MeshHandles> {
  const res = await fetch('/api/mesh/identity');
  const { serverPeerId } = (await res.json()) as { serverPeerId: string };
  const participantId = makeClientParticipantId(serverPeerId, tabUuid());
  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const peer = createMeshPeer({
    identity: { peerId: participantId },
    transports: [
      new WsBackendTransport({
        url: `${wsProto}://${window.location.host}/mesh`,
        participantId,
        serverPeerId,
      }),
    ],
  });

  const collections: Record<string, Collection<Dto>> = {};
  for (const rtype of RTYPES)
    collections[rtype] = peer.collection<Dto>(rtype, {
      parent: PARENTS[rtype],
      authority: serverPeerId,
    });

  // Bridge the peer's undo/redo availability to the module-level observers the
  // TopBar/keybindings subscribe to.
  _undoStatus = peer.undoStatus();
  peer.onUndoChange((s) => {
    _undoStatus = s;
    for (const cb of _undoObservers) cb(s);
  });

  // Subscribe to every document rtype; re-arm after each reconnect (the peer
  // marks outgoing subscriptions stale on disconnect — they don't auto-renew).
  let armed = false;
  let arming = false;
  let stale: { unsubscribe(): void }[] = [];
  const armSubscriptions = async () => {
    const connected = peer.status().peers.some((p) => p.id === serverPeerId);
    if (!connected) {
      armed = false;
      return;
    }
    if (armed || arming) return;
    arming = true;
    try {
      for (const s of stale) s.unsubscribe();
      stale = [];
      for (const rtype of RTYPES)
        stale.push(
          await peer.subscribe(serverPeerId, {
            entityRtype: rtype,
            entityId: '*',
            includeDescendants: false,
            pathPrefix: '',
          })
        );
      armed = true;
    } catch (e) {
      console.warn('[mesh] subscribe failed (will retry on reconnect):', e);
    } finally {
      arming = false;
    }
  };
  peer.onStatus(() => void armSubscriptions());
  void armSubscriptions();

  _handles = { peer, serverPeerId, collections };
  return _handles;
}
