import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';

export class WSSync {
  private wss: WebSocketServer;
  private clientConnectedHandlers: ((ws: WebSocket) => void)[] = [];

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Register a callback that fires whenever a new WebSocket client connects. */
  onClientConnected(handler: (ws: WebSocket) => void) {
    this.clientConnectedHandlers.push(handler);
  }

  upgrade(req: IncomingMessage, socket: any, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
      for (const h of this.clientConnectedHandlers) h(ws);
    });
  }

  sendTo(ws: WebSocket, kind: string, payload: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ kind, payload, timestamp: Date.now() }));
    }
  }

  broadcast(kind: string, payload: Record<string, unknown>, excludeWs?: WebSocket) {
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
