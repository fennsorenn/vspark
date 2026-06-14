/**
 * Server-side WS transport: the backend's own browser tabs become ordinary
 * mesh participants. Mount `upgrade()` on the HTTP server's 'upgrade' event
 * for a dedicated path (e.g. /mesh) — separate from the legacy /ws hub.
 *
 * Handshake: the tab's first frame is `{ t:'hello', participantId }`, where
 * the id is `${serverPeerId}#${tabUuid}` (see shared/sync participant ids —
 * the prefix is what lets a single grant cover all of a server's tabs).
 * Anything not namespaced under THIS server's peer id is refused.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { isClientParticipant, participantServer } from '@vspark/shared/sync';
import type {
  MeshMessage,
  MeshTransport,
  PeerLink,
  TransportHandlers,
} from '@vspark/mesh';

export class WsServerTransport implements MeshTransport {
  private readonly wss = new WebSocketServer({ noServer: true });
  private handlers: TransportHandlers | null = null;

  constructor(private readonly serverPeerId: string) {}

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
      let msg: { t?: string; participantId?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.t === 'hello') {
        const requested = msg.participantId;
        if (
          pid !== null ||
          typeof requested !== 'string' ||
          !isClientParticipant(requested) ||
          participantServer(requested) !== this.serverPeerId
        ) {
          ws.close();
          return;
        }
        pid = requested;
        const link: PeerLink = {
          send: (m) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
          },
        };
        this.handlers?.peerConnected(pid, link);
        return;
      }
      if (pid !== null && typeof msg?.t === 'string')
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
