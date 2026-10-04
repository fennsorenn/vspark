/**
 * Browser-side WS transport: connects a tab's mesh peer to its backend over
 * the /mesh path, with auto-reconnect. Uses the platform WebSocket (browser,
 * or Node ≥21 in tests).
 *
 * The tab mints its own participant id up front
 * (`makeClientParticipantId(serverPeerId, tabUuid)` — fetch the backend's
 * peer id via REST before creating the mesh peer) so the peer identity is
 * stable across reconnects.
 *
 * Every connection authenticates (see WsServerTransport): the hello carries
 * the tab's token, and the backend is announced as a peer only once it has
 * answered with a welcome. A refused hello (close code 4401) is reported to
 * `onUnauthorized`, which can obtain a new token before the next attempt.
 * Transport info the server sends (the welcome's extra fields, and later
 * `info` frames) goes to `onInfo`.
 */
import {
  encode,
  type MeshMessage,
  type MeshTransport,
  type PeerLink,
  type TransportHandlers,
} from '@vspark/mesh';

/** Close code the backend uses for a refused hello. */
const UNAUTHENTICATED = 4401;

export interface WsBackendTransportOptions {
  /** e.g. `ws://localhost:3001/mesh` */
  url: string;
  /** this tab's participant id: `${serverPeerId}#${tabUuid}` */
  participantId: string;
  /** the backend's peer id — surfaced as the connected peer */
  serverPeerId: string;
  /** The credential sent in each hello (read fresh on every connect). */
  token: () => string | undefined | Promise<string | undefined>;
  /** Called when the backend refuses the credential; the next connect waits
   *  for it to settle (typically: enroll again and store the new token). */
  onUnauthorized?: () => void | Promise<void>;
  /** Transport info from the server, e.g. `{ iceServers }`. */
  onInfo?: (info: Record<string, unknown>) => void;
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
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const token = await this.opts.token();
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          participantId: this.opts.participantId,
          token: token ?? '',
        })
      );
    };
    ws.onmessage = (e) => {
      let msg: MeshMessage & { t?: string };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const t = (msg as { t?: string }).t;
      if (t === 'welcome' || t === 'info') {
        const { t: _t, ...info } = msg as unknown as Record<string, unknown>;
        if (Object.keys(info).length) this.opts.onInfo?.(info);
      }
      if (t === 'info') return;
      if (t === 'welcome') {
        if (this.announced) return;
        const link: PeerLink = {
          send: (m: MeshMessage) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(encode(m));
          },
        };
        this.announced = true;
        this.handlers?.peerConnected(this.opts.serverPeerId, link);
        return;
      }
      if (this.announced && typeof msg?.t === 'string')
        this.handlers?.message(this.opts.serverPeerId, msg);
    };
    ws.onclose = (e) => {
      if (this.announced) {
        this.announced = false;
        this.handlers?.peerDisconnected(this.opts.serverPeerId);
      }
      if (this.stopped) return;
      const retry = () =>
        setTimeout(
          () => void this.connect(),
          this.opts.reconnectDelayMs ?? 1500
        );
      if (e.code === UNAUTHENTICATED && this.opts.onUnauthorized)
        void Promise.resolve(this.opts.onUnauthorized()).finally(retry);
      else retry();
    };
    ws.onerror = () => {
      /* 'close' follows */
    };
  }
}
