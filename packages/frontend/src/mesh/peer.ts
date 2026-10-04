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
import { makeClientParticipantId, randomUUID } from '@vspark/shared/sync';

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
  'clip_playback',
  'logic',
  'runtime_override',
  'data_field',
  'media_control',
  'server_status',
] as const;

/** Built-in mesh channels (packages/mesh/src/channels.ts): `runtime` is
 *  retained state without undo, `control` is commands that are never replayed
 *  to a tab that connects later. */
const RUNTIME_CHANNEL = 'runtime';
const CONTROL_CHANNEL = 'control';

/** rtypes that live on a channel other than the default committed/preview
 *  pair. The collection's allowed set has to include the channel its writes
 *  arrive on, or they never apply. */
const CHANNELS: Partial<Record<string, string[]>> = {
  runtime_override: [RUNTIME_CHANNEL],
  data_field: [RUNTIME_CHANNEL],
  media_control: [CONTROL_CHANNEL],
  server_status: [RUNTIME_CHANNEL],
};

const childOfNode = (d: Dto) =>
  typeof d.nodeId === 'string' ? { rtype: 'scene_node', id: d.nodeId } : null;

// Transport state → its clip. Keyed on `clipId`, NOT `id`: the mesh
// ContainmentIndex keys by id alone across every rtype, so a playback doc
// sharing its clip's id would collide with the clip's own entry. Must match
// the backend BINDINGS entry exactly or the two indexes diverge silently.
const childOfClip = (d: Dto) =>
  typeof d.clipId === 'string' ? { rtype: 'track_clip', id: d.clipId } : null;

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
      : typeof d.rootComposeSceneId === 'string' &&
          d.rootComposeSceneId !== d.id
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
  clip_playback: childOfClip,
  // A runtime override hangs off the entity it overrides, so a scene-subtree
  // grant covers every override inside it. Must match the backend
  // (mesh/runtime.ts `overrideParent`) or the two indexes diverge silently.
  runtime_override: (d) =>
    (d.targetKind === 'scene_node' || d.targetKind === 'compose_layer') &&
    typeof d.targetId === 'string'
      ? { rtype: d.targetKind, id: d.targetId }
      : null,
  // A scoped data field hangs off the entity it is scoped to; a GLOBAL field
  // (scope '') belongs to no entity and has no parent. The document carries
  // `scopeKind` so this stays a pure function on both peers.
  data_field: (d) =>
    (d.scopeKind === 'scene_node' || d.scopeKind === 'compose_layer') &&
    typeof d.scope === 'string' &&
    d.scope !== ''
      ? { rtype: d.scopeKind, id: d.scope }
      : null,
  media_control: (d) =>
    (d.targetKind === 'scene_node' || d.targetKind === 'compose_layer') &&
    typeof d.targetId === 'string'
      ? { rtype: d.targetKind, id: d.targetId }
      : null,
  // A status about a document hangs off it (backend mesh/status.ts `of`).
  server_status: (d) => {
    const of = d.of as { rtype?: unknown; id?: unknown } | null | undefined;
    return of && typeof of.rtype === 'string' && typeof of.id === 'string'
      ? { rtype: of.rtype, id: of.id }
      : null;
  },
  // Owned polymorphically. A project-owned graph has no parent: there is no
  // `project` rtype in the mesh. Must match the backend BINDINGS entry exactly.
  logic: (d) =>
    d.ownerKind === 'scene_node' && typeof d.ownerId === 'string'
      ? { rtype: 'scene_node', id: d.ownerId }
      : d.ownerKind === 'compose_layer' && typeof d.ownerId === 'string'
        ? { rtype: 'compose_layer', id: d.ownerId }
        : null,
};

let _init: Promise<MeshHandles> | null = null;

function tabUuid(): string {
  const KEY = 'vspark.mesh.tab';
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = randomUUID();
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

const _readyObservers = new Set<(h: MeshHandles) => void>();

/** Called once the tab's peer and its collections exist. Fires immediately if
 *  they already do, so a late subscriber is not left waiting for an event that
 *  has already happened. Returns an unsubscribe. */
export function onMeshReady(cb: (h: MeshHandles) => void): () => void {
  if (_handles) cb(_handles);
  else _readyObservers.add(cb);
  return () => _readyObservers.delete(cb);
}

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

// --- authentication ---------------------------------------------------------
//
// Every participant authenticates (principle 9). This tab presents a token the
// backend issued when this browser enrolled; a browser on the vspark machine
// enrolls automatically, any other one with the pairing code vspark shows.

const TOKEN_KEY = 'vspark.mesh.token';

function storedToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeToken(token: string | undefined): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the token lives for this page only */
  }
}

/** Asks the user for the pairing code (registered by the editor, which owns
 *  the dialog). Resolves null when they cancel. */
type PairingPrompt = () => Promise<string | null>;
let _askPairing: PairingPrompt | null = null;
const _pairingWaiters: ((ask: PairingPrompt) => void)[] = [];
let _pairingDeclined = false;

/** Register the dialog that asks for a pairing code. */
export function setPairingPrompt(ask: PairingPrompt): void {
  _askPairing = ask;
  for (const w of _pairingWaiters.splice(0)) w(ask);
}

async function askPairingCode(): Promise<string | null> {
  const ask =
    _askPairing ??
    (await new Promise<PairingPrompt>((r) => _pairingWaiters.push(r)));
  return ask();
}

let _token: string | undefined = storedToken();
let _enrolling: Promise<string | undefined> | null = null;

/** Get a token from the backend, asking for the pairing code if this browser
 *  is not on the vspark machine. Concurrent callers share one attempt. */
function enroll(): Promise<string | undefined> {
  _enrolling ??= (async () => {
    let code: string | undefined;
    for (;;) {
      const res = await fetch('/api/mesh/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: navigator.userAgent.slice(0, 120),
          code,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        data?: { token?: string };
        error?: { code?: string };
      } | null;
      if (res.ok && body?.data?.token) return body.data.token;
      if (body?.error?.code !== 'PAIRING_REQUIRED' || _pairingDeclined)
        return undefined;
      const entered = await askPairingCode();
      if (!entered?.trim()) {
        _pairingDeclined = true; // don't keep asking after a cancel
        return undefined;
      }
      code = entered.trim();
    }
  })().finally(() => {
    _enrolling = null;
  });
  return _enrolling.then((token) => {
    _token = token;
    storeToken(token);
    return token;
  });
}

async function doInit(): Promise<MeshHandles> {
  const res = await fetch('/api/mesh/identity');
  const { serverPeerId } = (await res.json()) as { serverPeerId: string };
  const participantId = makeClientParticipantId(serverPeerId, tabUuid());
  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const peer = createMeshPeer({
    identity: { peerId: participantId },
    // Our server is the source of our grants, not a recipient they gate.
    home: serverPeerId,
    transports: [
      new WsBackendTransport({
        url: `${wsProto}://${window.location.host}/mesh`,
        participantId,
        serverPeerId,
        token: () => _token ?? enroll(),
        // A token the backend no longer accepts (revoked, or a fresh
        // database) is dropped and replaced.
        onUnauthorized: async () => {
          _token = undefined;
          storeToken(undefined);
          await enroll();
        },
      }),
    ],
  });

  const collections: Record<string, Collection<Dto>> = {};
  for (const rtype of RTYPES)
    collections[rtype] = peer.collection<Dto>(rtype, {
      parent: PARENTS[rtype],
      channels: CHANNELS[rtype],
      authority: serverPeerId,
    });

  // Bridge the peer's undo/redo availability to the module-level observers the
  // TopBar/keybindings subscribe to.
  _undoStatus = peer.undoStatus();
  peer.onUndoChange((s) => {
    _undoStatus = s;
    for (const cb of _undoObservers) cb(s);
  });

  // Subscribe to every rtype once. The peer renews them itself after a
  // reconnect; this only retries the ones that never got through.
  const subscribed = new Set<string>();
  let arming = false;
  const armSubscriptions = async () => {
    const connected = peer.status().peers.some((p) => p.id === serverPeerId);
    if (!connected || arming) return;
    arming = true;
    try {
      for (const rtype of RTYPES) {
        if (subscribed.has(rtype)) continue;
        await peer.subscribe(serverPeerId, {
          entityRtype: rtype,
          entityId: '*',
          includeDescendants: false,
          pathPrefix: '',
        });
        subscribed.add(rtype);
        for (const cb of _snapshotObservers) cb(rtype);
      }
    } catch (e) {
      console.warn('[mesh] subscribe failed (will retry on reconnect):', e);
    } finally {
      arming = false;
    }
  };
  peer.onStatus(() => void armSubscriptions());
  void armSubscriptions();

  _handles = { peer, serverPeerId, collections };
  // The peer arrives asynchronously, so anything holding a reference to a
  // collection has to be told when there finally is one. Without this a
  // component that reads the replica renders empty forever: it mounts before
  // `doInit` resolves and nothing re-renders it afterwards.
  for (const cb of _readyObservers) cb(_handles);
  return _handles;
}

/** Drop rows the mesh has already seen removed.
 *
 *  The editor still loads from the REST scene bundle (W6 of
 *  plans/mesh-sole-channel.md replaces that with the subscription snapshot).
 *  A bundle fetched before another tab's delete can arrive AFTER the delete
 *  reached this tab through the mesh — and would put the deleted document back
 *  into the store. The replica's tombstone is the newer truth. */
export function withoutRemoved<T extends { id: string }>(
  rtype: string,
  rows: T[]
): T[] {
  const col = _handles?.collections[rtype];
  return col ? rows.filter((r) => !col.replica.isTombstoned(r.id)) : rows;
}

const _snapshotObservers = new Set<(rtype: string) => void>();

/** Be told when the first snapshot of an rtype has been applied: from then on
 *  the replica is the authority for that collection, and anything the store
 *  got elsewhere (the REST bundle) that the replica doesn't hold is stale. */
export function onSnapshot(cb: (rtype: string) => void): () => void {
  _snapshotObservers.add(cb);
  return () => _snapshotObservers.delete(cb);
}
