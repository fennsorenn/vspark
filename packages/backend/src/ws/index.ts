import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';

export class WSSync {
  private wss: WebSocketServer;
  private clientConnectedHandlers: ((ws: WebSocket) => void)[] = [];
  private messageHandlers: ((
    kind: string,
    payload: unknown,
    ws: WebSocket
  ) => void)[] = [];

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Register a callback that fires whenever a new WebSocket client connects. */
  onClientConnected(handler: (ws: WebSocket) => void) {
    this.clientConnectedHandlers.push(handler);
  }

  /** Register a callback that fires for every parsed message received from any client.
   *  The third argument is the originating WebSocket — pass it as `excludeWs` to
   *  broadcast() to skip echoing the message back to the sender. */
  onMessage(handler: (kind: string, payload: unknown, ws: WebSocket) => void) {
    this.messageHandlers.push(handler);
  }

  upgrade(req: IncomingMessage, socket: any, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
      for (const h of this.clientConnectedHandlers) h(ws);
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            kind?: string;
            [k: string]: unknown;
          };
          if (typeof msg.kind === 'string') {
            for (const h of this.messageHandlers) h(msg.kind, msg, ws);
          }
        } catch {
          /* ignore malformed messages */
        }
      });
    });
  }

  sendTo(ws: WebSocket, kind: string, payload: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ kind, payload, timestamp: Date.now() }));
    }
  }

  broadcast(
    kind: string,
    payload: Record<string, unknown>,
    excludeWs?: WebSocket
  ) {
    const msg = JSON.stringify({
      kind,
      payload,
      timestamp: Date.now(),
    });

    for (const client of this.wss.clients) {
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  get connectedCount() {
    return this.wss.clients.size;
  }

  close() {
    this.wss.close();
  }
}
