/**
 * vspark rendezvous — the one publicly-reachable coordination point for
 * cross-server multiplayer (Phase 5). Servers connect OUTBOUND (so no port
 * forwarding on their side); the rendezvous:
 *   - authenticates each peer (proves Ed25519 key ownership),
 *   - tracks presence and pushes online/offline to interested peers,
 *   - bootstraps pairing via a short-lived code (relays pubkeys both ways),
 *   - relays WebRTC signaling (SDP/ICE) between peers by peer id,
 *   - mints short-lived TURN credentials (so coturn isn't an open relay).
 *
 * It holds NO long-term state and is NOT trusted for identity — peers
 * authenticate each other end-to-end with the stored pubkey. See
 * dev-notes/plans/multiplayer-phase5.md.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { fingerprint, verifyBytes } from './crypto.js';
import { mintTurnCreds } from './turn.js';

const PORT = Number(process.env.PORT ?? 8787);
const TURN_SECRET = process.env.TURN_SECRET ?? '';
const TURN_URLS = (process.env.TURN_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STUN_URLS = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const AUTH_WINDOW_MS = Number(process.env.AUTH_WINDOW_MS ?? 30_000);
const CODE_TTL_MS = Number(process.env.CODE_TTL_MS ?? 10 * 60_000);

interface PeerSocket extends WebSocket {
  peerId?: string;
  /** peer ids this socket wants online/offline notifications for. */
  watching?: Set<string>;
}

interface Msg {
  type: string;
  [k: string]: unknown;
}

/** Online authenticated peers. */
const peers = new Map<string, PeerSocket>();
/** Pairing codes → creator info, one-time + TTL. */
const pairCodes = new Map<
  string,
  { peerId: string; publicKey: string; displayName: string; expiresAt: number }
>();

function send(ws: WebSocket, msg: Msg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function makeCode(): string {
  // 8 chars, unambiguous alphabet (no 0/O/1/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 8; i++)
    c += alphabet[Math.floor(Math.random() * alphabet.length)];
  return c;
}

function notifyWatchers(peerId: string, online: boolean): void {
  for (const ws of peers.values()) {
    if (ws.watching?.has(peerId))
      send(ws, { type: online ? 'peer_online' : 'peer_offline', peerId });
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (raw: WebSocket) => {
  const ws = raw as PeerSocket;
  ws.watching = new Set();

  ws.on('message', (buf) => {
    let msg: Msg;
    try {
      msg = JSON.parse(buf.toString()) as Msg;
    } catch {
      return;
    }
    if (typeof msg.type !== 'string') return;

    // --- auth gate: only `hello` is allowed before authentication ---
    if (!ws.peerId && msg.type !== 'hello') {
      send(ws, { type: 'error', code: 'not_authenticated' });
      return;
    }

    switch (msg.type) {
      case 'hello': {
        const { peerId, publicKey, ts, sig, displayName } = msg as {
          peerId?: string;
          publicKey?: string;
          ts?: number;
          sig?: string;
          displayName?: string;
        };
        if (
          typeof peerId !== 'string' ||
          typeof publicKey !== 'string' ||
          typeof ts !== 'number' ||
          typeof sig !== 'string'
        ) {
          send(ws, { type: 'error', code: 'bad_hello' });
          return;
        }
        if (
          fingerprint(publicKey) !== peerId ||
          Math.abs(Date.now() - ts) > AUTH_WINDOW_MS ||
          !verifyBytes(publicKey, `hello:${peerId}:${ts}`, sig)
        ) {
          send(ws, { type: 'error', code: 'auth_failed' });
          ws.close();
          return;
        }
        // Replace any previous socket for this peer.
        peers.get(peerId)?.close();
        ws.peerId = peerId;
        (ws as PeerSocket & { displayName?: string }).displayName =
          typeof displayName === 'string' ? displayName : '';
        peers.set(peerId, ws);
        send(ws, { type: 'hello_ok', peerId });
        notifyWatchers(peerId, true);
        return;
      }

      case 'presence_subscribe': {
        const ids = (msg.peerIds as string[]) ?? [];
        ws.watching = new Set(ids);
        send(ws, {
          type: 'presence',
          online: ids.filter((id) => peers.has(id)),
        });
        return;
      }

      case 'pair_create': {
        const code = makeCode();
        pairCodes.set(code, {
          peerId: ws.peerId!,
          publicKey: (msg.publicKey as string) ?? '',
          displayName: (msg.displayName as string) ?? '',
          expiresAt: Date.now() + CODE_TTL_MS,
        });
        send(ws, { type: 'pair_code', code, ttlMs: CODE_TTL_MS });
        return;
      }

      case 'pair_join': {
        const code = (msg.code as string)?.toUpperCase();
        const entry = code ? pairCodes.get(code) : undefined;
        if (!entry || entry.expiresAt < Date.now()) {
          send(ws, { type: 'error', code: 'pair_invalid' });
          return;
        }
        pairCodes.delete(code); // one-time
        const creator = peers.get(entry.peerId);
        if (!creator) {
          send(ws, { type: 'error', code: 'pair_creator_offline' });
          return;
        }
        // Relay each side's identity to the other; consent + storage is app-side.
        send(creator, {
          type: 'pair_request',
          peerId: ws.peerId,
          publicKey: msg.publicKey ?? '',
          displayName: msg.displayName ?? '',
        });
        send(ws, {
          type: 'pair_info',
          peerId: entry.peerId,
          publicKey: entry.publicKey,
          displayName: entry.displayName,
        });
        return;
      }

      case 'signal':
      case 'connect_request': {
        const to = msg.to as string;
        const target = to ? peers.get(to) : undefined;
        if (!target) {
          send(ws, { type: 'error', code: 'peer_offline', peerId: to });
          return;
        }
        send(target, {
          type: msg.type,
          from: ws.peerId,
          data: msg.data ?? null,
        });
        return;
      }

      case 'turn_creds': {
        if (!TURN_SECRET || TURN_URLS.length === 0) {
          send(ws, { type: 'turn_creds', urls: [], stunUrls: STUN_URLS });
          return;
        }
        const creds = mintTurnCreds(TURN_SECRET, ws.peerId!);
        send(ws, {
          type: 'turn_creds',
          urls: TURN_URLS,
          stunUrls: STUN_URLS,
          username: creds.username,
          credential: creds.credential,
          ttlSec: creds.ttlSec,
        });
        return;
      }

      default:
        send(ws, { type: 'error', code: 'unknown_type' });
    }
  });

  ws.on('close', () => {
    if (ws.peerId && peers.get(ws.peerId) === ws) {
      peers.delete(ws.peerId);
      notifyWatchers(ws.peerId, false);
    }
  });
});

// Periodic housekeeping: drop expired pairing codes.
setInterval(() => {
  const now = Date.now();
  for (const [code, e] of pairCodes)
    if (e.expiresAt < now) pairCodes.delete(code);
}, 60_000).unref();

// eslint-disable-next-line no-console
console.log(
  `[rendezvous] listening on :${PORT} (turn=${TURN_URLS.length > 0 ? 'on' : 'off'})`
);
