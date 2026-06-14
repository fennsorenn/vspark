/**
 * Browser-side WS transport: connects a tab's mesh peer to its backend over
 * the /mesh path, with auto-reconnect. Uses the platform WebSocket (browser,
 * or Node ≥21 in tests).
 *
 * The tab mints its own participant id up front
 * (`makeClientParticipantId(serverPeerId, tabUuid)` — fetch the backend's
 * peer id via REST before creating the mesh peer) so the peer identity is
 * stable across reconnects.
 */
import type {
  MeshMessage,
  MeshTransport,
  PeerLink,
  TransportHandlers,
} from '@vspark/mesh';

export interface WsBackendTransportOptions {
  /** e.g. `ws://localhost:3001/mesh` */
  url: string;
  /** this tab's participant id: `${serverPeerId}#${tabUuid}` */
  participantId: string;
  /** the backend's peer id — surfaced as the connected peer */
  serverPeerId: string;
  reconnectDelayMs?: number;
}

export class WsBackendTransport implements MeshTransport {
  private handlers: TransportHandlers | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private announced = false;

  constructor(private readonly opts: WsBackendTransportOptions) {}

  start(h: TransportHandlers): void {
    this.handlers = h;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ t: 'hello', participantId: this.opts.participantId })
      );
      const link: PeerLink = {
        send: (m: MeshMessage) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
        },
      };
      this.announced = true;
      this.handlers?.peerConnected(this.opts.serverPeerId, link);
    };
    ws.onmessage = (e) => {
      let msg: MeshMessage & { t?: string };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (typeof msg?.t === 'string')
        this.handlers?.message(this.opts.serverPeerId, msg);
    };
    ws.onclose = () => {
      if (this.announced) {
        this.announced = false;
        this.handlers?.peerDisconnected(this.opts.serverPeerId);
      }
      if (!this.stopped)
        setTimeout(() => this.connect(), this.opts.reconnectDelayMs ?? 1500);
    };
    ws.onerror = () => {
      /* 'close' follows */
    };
  }
}
