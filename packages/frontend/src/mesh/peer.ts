/**
 * The tab's mesh peer: its replica IS the app's document store.
 *
 * Opens one collection per document type the tab holds (`TAB_MODELS`, declared
 * once in `@vspark/shared/models`) and subscribes to each over the /mesh
 * WebSocket. Components read through the typed hooks in this directory and
 * write through the `*Writes` modules; nothing mirrors the replica elsewhere.
 *
 * Lifecycle: `initMeshPeer()` once per tab (idempotent), awaited in main.tsx
 * before the first render, so every hook finds its collection open. The
 * participant id is `${serverPeerId}#${tabUuid}`, new on every page load (see
 * `tabUuid`). Subscriptions re-arm automatically after reconnects.
 */
import {
  createMeshPeer,
  type Collection,
  type MeshPeer,
  type UndoStatus,
} from '@vspark/mesh';
import { WsBackendTransport } from '@vspark/mesh-transports/wsClient';
import { WebRtcTransport } from '@vspark/mesh-transports/webrtc';
import { makeClientParticipantId, randomUUID } from '@vspark/shared/sync';
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

/** ICE servers for direct links, as our server last sent them (STUN, and TURN
 *  with credentials it refreshes; see WsBackendTransport `onInfo`). */
let _iceServers: RTCIceServer[] = [];

/** This tab's id, shared by the mesh peer and the client mesh's WebRTC links. */
export function meshTabUuid(): string {
  return tabUuid();
}

/** New for every page load, never stored. It used to live in sessionStorage
 *  to survive reloads, but browsers copy sessionStorage into a duplicated tab,
 *  and two tabs under one id share one link on the server: the newer tab got
 *  the older one's acks, so the older one's writes reverted. Nothing depends
 *  on the id outliving the page (grants cover the server's prefix). */
let _tabUuid: string | undefined;

function tabUuid(): string {
  return (_tabUuid ??= randomUUID());
}

export function initMeshPeer(): Promise<MeshHandles> {
  // A failed start (server not answering yet) may be retried.
  if (!_init)
    _init = doInit().catch((e) => {
      _init = null;
      throw e;
    });
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
  // A tab's own server decides its writes and delivers its grants; the mesh
  // derives that from the participant id, so nothing here configures it.
  const peer = createMeshPeer({
    identity: { peerId: participantId },
    models: MODELS,
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
        onInfo: (info) => {
          if (Array.isArray(info.iceServers))
            _iceServers = info.iceServers as RTCIceServer[];
        },
      }),
      // Direct links (principle 8) to the tabs of servers ours shares with,
      // as our server reports them; set up through the mesh itself.
      new WebRtcTransport({ iceServers: () => _iceServers }),
    ],
  });

  const collections: Record<string, Collection<Dto>> = {};
  for (const rtype of RTYPES) collections[rtype] = peer.collection<Dto>(rtype);

  // Bridge the peer's undo/redo availability to the module-level observers the
  // TopBar/keybindings subscribe to.
  _undoStatus = peer.undoStatus();
  peer.onUndoChange((s) => {
    _undoStatus = s;
    for (const cb of _undoObservers) cb(s);
  });

  // One subscription per document type. The mesh serves each from whoever
  // granted it — our server, and over a direct link the tabs of a server that
  // shared with ours — and renews it after a reconnect.
  for (const rtype of RTYPES)
    void peer.subscribe({
      entityRtype: rtype,
      entityId: '*',
      includeDescendants: false,
      pathPrefix: '',
    });

  // The app renders only once this resolves (main.tsx), so everything reads a
  // peer that exists.
  _handles = { peer, serverPeerId, collections };
  return _handles;
}
