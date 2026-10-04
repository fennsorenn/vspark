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
  type Grant,
  type MeshPeer,
  type UndoStatus,
} from '@vspark/mesh';
import { WsBackendTransport } from '@vspark/mesh-transports/wsClient';
import {
  isClientParticipant,
  makeClientParticipantId,
  randomUUID,
} from '@vspark/shared/sync';
import { DirectTransport } from './directTransport';
import { MODELS, TAB_MODELS } from '@vspark/shared/models';

type Dto = Record<string, unknown>;

export interface MeshHandles {
  peer: MeshPeer;
  serverPeerId: string;
  collections: Record<string, Collection<Dto>>;
}

/** Document types this tab opens; their parents, channels and clock fields
 *  are declared once in `@vspark/shared/models`, shared with the backend. */
const RTYPES = TAB_MODELS;

let _init: Promise<MeshHandles> | null = null;

/** This tab's id, shared by the mesh peer and the client mesh's WebRTC links. */
export function meshTabUuid(): string {
  return tabUuid();
}

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
    models: MODELS,
    // Our server is the source of our grants, not a recipient they gate.
    home: serverPeerId,
    // A tab is an endpoint: a direct subscriber gets only what it authors.
    relay: false,
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
      authority: serverPeerId,
    });

  // Grants for participants of other servers, delivered by our server — the
  // grant source of truth (backend mesh/peerGrants.ts). When one of them links
  // to this tab directly, it gets exactly what those grants allow.
  const mirrored = new Map<string, string>();
  collections.peer_grant.observe('**', (c) => {
    const old = mirrored.get(c.id);
    if (old) {
      peer.grants.revoke(old);
      mirrored.delete(c.id);
    }
    const grant = (c.doc as { grant?: Grant } | undefined)?.grant;
    if (c.op !== 'remove' && grant)
      mirrored.set(c.id, peer.grants.grant(grant));
  });

  // Direct links (principle 8): tabs of other servers reached over WebRTC.
  // Each gets a preview-only subscription — committed state keeps arriving
  // through our server, which validates it (plan F6). The other tab may not
  // hold the grants for us yet (its server delivers them a moment later), so
  // a refused subscription is retried with backoff while the link is up.
  peer.addTransport(new DirectTransport(serverPeerId));
  const direct = new Set<string>();
  const subscribeDirect = (id: string, attempt = 0): void => {
    void peer
      .subscribe(id, {
        entityRtype: '*',
        entityId: '*',
        includeDescendants: false,
        pathPrefix: '',
        channels: ['preview'],
        exact: true,
      })
      .catch(() => {
        const delay = Math.min(30_000, 1000 * 2 ** attempt);
        setTimeout(() => {
          if (peer.status().peers.some((p) => p.id === id))
            subscribeDirect(id, attempt + 1);
          else direct.delete(id);
        }, delay);
      });
  };
  peer.onStatus((s) => {
    const linked = new Set(s.peers.map((p) => p.id));
    for (const id of [...direct]) if (!linked.has(id)) direct.delete(id);
    for (const id of linked) {
      if (id === serverPeerId || direct.has(id) || !isClientParticipant(id))
        continue;
      direct.add(id);
      subscribeDirect(id);
    }
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
