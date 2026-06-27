import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';

/** A connected editor client, addressable by the UI-control channel. */
interface UiSession {
  sessionId: string;
  ws: WebSocket;
  projectId: string | null;
  connectedAt: number;
}

export class WSSync {
  private wss: WebSocketServer;
  /** sessionId → session; lets REST UI-action routes target one editor tab. */
  private sessions = new Map<string, UiSession>();
  private wsToSession = new WeakMap<WebSocket, UiSession>();
  private clientConnectedHandlers: ((ws: WebSocket) => void)[] = [];
  private messageHandlers: ((
    kind: string,
    payload: unknown,
    ws: WebSocket
  ) => void)[] = [];
  /** Optional tap: every broadcast is offered to this relay so the multiplayer
   *  layer can mirror runtime data (data channels, overrides, spawned clips, …)
   *  to collab peers. The relay itself filters by kind. */
  private collabRelay:
    | ((kind: string, payload: Record<string, unknown>) => void)
    | null = null;
  /** In-flight feed-preview round-trips (requestId → resolver). The assistant's
   *  render_feed_template tool asks a connected editor to rasterize a feed and
   *  reply with a PNG; this correlates the reply back to the awaiting request. */
  private pendingPreviews = new Map<
    string,
    { resolve: (pngBase64: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Install the collab broadcast relay (injected at startup). */
  setCollabRelay(
    relay: (kind: string, payload: Record<string, unknown>) => void
  ) {
    this.collabRelay = relay;
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
      // Register a UI session so the agent / MCP can drive this exact tab.
      const session: UiSession = {
        sessionId: randomUUID(),
        ws,
        projectId: null,
        connectedAt: Date.now(),
      };
      this.sessions.set(session.sessionId, session);
      this.wsToSession.set(ws, session);
      this.sendTo(ws, 'session_hello', { sessionId: session.sessionId });
      ws.on('close', () => this.sessions.delete(session.sessionId));
      for (const h of this.clientConnectedHandlers) h(ws);
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            kind?: string;
            [k: string]: unknown;
          };
          if (typeof msg.kind === 'string') {
            // The client tags its session with the project it has open so
            // list_ui_sessions can label tabs.
            if (msg.kind === 'ui_register') {
              const pid = (msg as { projectId?: unknown }).projectId;
              if (typeof pid === 'string') session.projectId = pid;
            }
            // Editor's reply to a feed-preview request: resolve the awaiting tool.
            if (msg.kind === 'feed_preview_result') {
              const m = msg as {
                requestId?: string;
                pngBase64?: string;
                error?: string;
              };
              if (typeof m.requestId === 'string')
                this.settlePreview(m.requestId, m.pngBase64, m.error);
            }
            for (const h of this.messageHandlers) h(msg.kind, msg, ws);
          }
        } catch {
          /* ignore malformed messages */
        }
      });
    });
  }

  /** The session id assigned to a socket (for the in-app agent). */
  sessionIdFor(ws: WebSocket): string | null {
    return this.wsToSession.get(ws)?.sessionId ?? null;
  }

  /** The project this socket has open (tagged via ui_register), if known. */
  projectIdFor(ws: WebSocket): string | null {
    return this.wsToSession.get(ws)?.projectId ?? null;
  }

  /** Active editor sessions, for list_ui_sessions. */
  listSessions(): { sessionId: string; projectId: string | null; connectedAt: number }[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.ws.readyState === WebSocket.OPEN)
      .map((s) => ({
        sessionId: s.sessionId,
        projectId: s.projectId,
        connectedAt: s.connectedAt,
      }));
  }

  /** Push a UI-control action to one editor session. Returns false if the
   *  session is gone (closed tab / bad id). */
  sendUiAction(sessionId: string, action: Record<string, unknown>): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return false;
    this.sendTo(session.ws, 'ui_action', action);
    return true;
  }

  /** Ask one editor session to rasterize a feed template (real renderer, this
   *  browser's engine) and resolve with the PNG (base64). Rejects if the session
   *  is gone, the editor reports an error, or it doesn't reply in time. */
  requestFeedPreview(
    sessionId: string,
    payload: Record<string, unknown>,
    timeoutMs = 15000
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error('no editor session is connected to render the preview')
      );
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPreviews.delete(requestId);
        reject(new Error('the editor did not return a preview in time'));
      }, timeoutMs);
      this.pendingPreviews.set(requestId, { resolve, reject, timer });
      this.sendTo(session.ws, 'feed_preview_request', { requestId, ...payload });
    });
  }

  private settlePreview(requestId: string, pngBase64?: string, error?: string) {
    const pending = this.pendingPreviews.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPreviews.delete(requestId);
    if (error) pending.reject(new Error(error));
    else if (pngBase64) pending.resolve(pngBase64);
    else pending.reject(new Error('the editor returned an empty preview'));
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
    // Offer to the collab relay (mirror runtime data to peers; it filters by kind).
    this.collabRelay?.(kind, payload);
  }

  get connectedCount() {
    return this.wss.clients.size;
  }

  close() {
    this.wss.close();
  }
}
