/**
 * Server-side WS transport: the backend's own browser tabs become ordinary
 * mesh participants. Mount `upgrade()` on the HTTP server's 'upgrade' event
 * for a dedicated path (e.g. /mesh) — separate from the legacy /ws hub.
 *
 * Handshake (principle 9: every participant authenticates):
 *
 *   tab → `{ t:'hello', participantId, token }`
 *   server → `{ t:'welcome', ...welcome() }`, or closes with code 4401
 *
 * After the welcome the server may push `{ t:'info', ... }` frames (see
 * `push`): data for the tab's transports rather than for the mesh, such as
 * ICE servers with short-lived TURN credentials. They go only to tabs that
 * authenticated.
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
  /** Extra fields for the welcome (current transport info for the tab). */
  welcome?: () => Record<string, unknown>;
}

export class WsServerTransport implements MeshTransport {
  private readonly wss = new WebSocketServer({ noServer: true });
  private handlers: TransportHandlers | null = null;
  /** Sockets that completed the handshake. */
  private readonly authed = new Set<WebSocket>();

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

  /** Send transport info to every authenticated tab (see the header). */
  push(info: Record<string, unknown>): void {
    const frame = JSON.stringify({ ...info, t: 'info' });
    for (const ws of this.authed) if (ws.readyState === ws.OPEN) ws.send(frame);
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
        this.authed.add(ws);
        ws.send(JSON.stringify({ ...this.opts.welcome?.(), t: 'welcome' }));
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
      this.authed.delete(ws);
      if (pid !== null) this.handlers?.peerDisconnected(pid);
    });
    ws.on('error', () => {
      /* 'close' follows */
    });
  }
}
