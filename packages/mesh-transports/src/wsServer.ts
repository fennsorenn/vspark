/**
 * Server-side WS transport: the backend's own browser tabs become ordinary
 * mesh participants. Mount `upgrade()` on the HTTP server's 'upgrade' event
 * for a dedicated path (e.g. /mesh) — separate from the legacy /ws hub.
 *
 * Handshake (principle 9: every participant authenticates):
 *
 *   tab → `{ t:'hello', participantId, token }`
 *   server → `{ t:'welcome' }`, or closes with code 4401
 *
 * The id is `${serverPeerId}#${tabUuid}` (see shared/sync participant ids —
 * the prefix is what lets a single grant cover all of a server's tabs);
 * anything not namespaced under THIS server's peer id is refused, and so is a
 * hello whose token `authenticate` doesn't accept. No mesh message is handled
 * before the welcome.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { isClientParticipant, participantServer } from '@vspark/shared/sync';
import {
  encode,
  type MeshMessage,
  type MeshTransport,
  type PeerLink,
  type TransportHandlers,
} from '@vspark/mesh';

/** Close code for a refused hello (unknown or missing credentials). */
export const UNAUTHENTICATED = 4401;

export interface WsServerTransportOptions {
  /** Accept or refuse a tab's credentials. Required: there is no
   *  unauthenticated mode. */
  authenticate: (hello: { participantId: string; token: string }) => boolean;
}

export class WsServerTransport implements MeshTransport {
  private readonly wss = new WebSocketServer({ noServer: true });
  private handlers: TransportHandlers | null = null;

  constructor(
    private readonly serverPeerId: string,
    private readonly opts: WsServerTransportOptions
  ) {}

  start(h: TransportHandlers): void {
    this.handlers = h;
  }

  stop(): void {
    this.wss.close();
    this.handlers = null;
  }

  /** Wire into `server.on('upgrade')` for the mesh path. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
  }

  private attach(ws: WebSocket): void {
    let pid: string | null = null;
    ws.on('message', (data) => {
      let msg: { t?: string; participantId?: unknown; token?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (pid === null) {
        if (msg?.t !== 'hello') return; // nothing before the handshake
        const requested = msg.participantId;
        const token = msg.token;
        if (
          typeof requested !== 'string' ||
          !isClientParticipant(requested) ||
          participantServer(requested) !== this.serverPeerId ||
          typeof token !== 'string' ||
          !this.opts.authenticate({ participantId: requested, token })
        ) {
          ws.close(UNAUTHENTICATED, 'unauthenticated');
          return;
        }
        pid = requested;
        ws.send(JSON.stringify({ t: 'welcome' }));
        const link: PeerLink = {
          send: (m) => {
            if (ws.readyState === ws.OPEN) ws.send(encode(m));
          },
        };
        this.handlers?.peerConnected(pid, link);
        return;
      }
      if (msg?.t === 'hello') return; // one handshake per socket
      if (typeof msg?.t === 'string')
        this.handlers?.message(pid, msg as MeshMessage);
    });
    ws.on('close', () => {
      if (pid !== null) this.handlers?.peerDisconnected(pid);
    });
    ws.on('error', () => {
      /* 'close' follows */
    });
  }
}
