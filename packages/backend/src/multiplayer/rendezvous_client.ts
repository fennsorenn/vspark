/**
 * Outbound client to the public rendezvous (Phase 5). Each vspark server keeps
 * one of these open: it authenticates with a signed hello, subscribes to the
 * presence of its contacts, bootstraps pairing via a code, and relays WebRTC
 * signaling. Pure protocol/transport — identity is injected so it is unit- and
 * integration-testable without the DB singletons.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

export interface RvIdentity {
  peerId: string;
  publicKey: string;
  /** Sign a string → base64 signature (this server's Ed25519 private key). */
  sign: (data: string) => string;
  displayName?: string;
}

export interface PairedPeer {
  peerId: string;
  publicKey: string;
  displayName: string;
}

export interface TurnCreds {
  urls: string[];
  stunUrls: string[];
  username?: string;
  credential?: string;
  ttlSec?: number;
}

export type RvStatus = 'idle' | 'connecting' | 'ready' | 'closed';

interface Waiter {
  types: Set<string>;
  resolve: (m: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Events: `status`(RvStatus), `pairRequest`(PairedPeer — someone joined my code),
 * `signal`({from,data}), `connectRequest`({from}), `presence`({peerId,online}).
 */
export class RendezvousClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly waiters: Waiter[] = [];
  private _status: RvStatus = 'idle';

  constructor(
    private readonly url: string,
    private readonly identity: RvIdentity,
    /** peer ids to watch presence for (contacts); re-sent on each (re)connect. */
    private watchPeerIds: () => string[] = () => []
  ) {
    super();
  }

  get status(): RvStatus {
    return this._status;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  /** Refresh the presence subscription (call when contacts change). */
  refreshPresence(): void {
    this.sendRaw({ type: 'presence_subscribe', peerIds: this.watchPeerIds() });
  }

  /** Create a one-time pairing code to hand to another server. */
  async pairCreate(): Promise<string> {
    this.sendRaw({
      type: 'pair_create',
      publicKey: this.identity.publicKey,
      displayName: this.identity.displayName ?? '',
    });
    const m = await this.once1(['pair_code']);
    return m.code as string;
  }

  /** Join a peer's pairing code; resolves with the creator's identity. */
  async pairJoin(code: string): Promise<PairedPeer> {
    this.sendRaw({
      type: 'pair_join',
      code,
      publicKey: this.identity.publicKey,
      displayName: this.identity.displayName ?? '',
    });
    const m = await this.once1(['pair_info', 'error']);
    if (m.type === 'error')
      throw new Error(`pair_join failed: ${String(m.code)}`);
    return {
      peerId: m.peerId as string,
      publicKey: m.publicKey as string,
      displayName: (m.displayName as string) ?? '',
    };
  }

  async requestTurnCreds(): Promise<TurnCreds> {
    this.sendRaw({ type: 'turn_creds' });
    const m = await this.once1(['turn_creds']);
    return {
      urls: (m.urls as string[]) ?? [],
      stunUrls: (m.stunUrls as string[]) ?? [],
      username: m.username as string | undefined,
      credential: m.credential as string | undefined,
      ttlSec: m.ttlSec as number | undefined,
    };
  }

  /** Relay a WebRTC signaling blob (SDP/ICE) to a peer. */
  sendSignal(to: string, data: unknown): void {
    this.sendRaw({ type: 'signal', to, data });
  }

  /** Tell a peer we want to open a connection (so it can apply accept policy). */
  sendConnectRequest(to: string): void {
    this.sendRaw({ type: 'connect_request', to });
  }

  // --- internals ----------------------------------------------------------

  private setStatus(s: RvStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.emit('status', s);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      const ts = Date.now();
      this.sendRaw({
        type: 'hello',
        peerId: this.identity.peerId,
        publicKey: this.identity.publicKey,
        ts,
        sig: this.identity.sign(`hello:${this.identity.peerId}:${ts}`),
        displayName: this.identity.displayName ?? '',
      });
    });

    ws.on('message', (buf) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      this.handle(m);
    });

    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) {
        this.setStatus('connecting');
        this.scheduleReconnect();
      }
    });
    ws.on('error', () => {
      /* close handler drives reconnect */
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handle(m: Record<string, unknown>): void {
    // Resolve any pending request waiters first.
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.types.has(m.type as string)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(m);
      }
    }
    switch (m.type) {
      case 'hello_ok':
        this.reconnectAttempt = 0;
        this.setStatus('ready');
        this.refreshPresence();
        break;
      case 'pair_request':
        this.emit('pairRequest', {
          peerId: m.peerId,
          publicKey: m.publicKey,
          displayName: m.displayName ?? '',
        });
        break;
      case 'signal':
        this.emit('signal', { from: m.from, data: m.data });
        break;
      case 'connect_request':
        this.emit('connectRequest', { from: m.from });
        break;
      case 'peer_online':
        this.emit('presence', { peerId: m.peerId, online: true });
        break;
      case 'peer_offline':
        this.emit('presence', { peerId: m.peerId, online: false });
        break;
    }
  }

  private once1(types: string[]): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`rendezvous request timed out (${types.join('|')})`));
      }, REQUEST_TIMEOUT_MS);
      this.waiters.push({ types: new Set(types), resolve, reject, timer });
    });
  }

  private sendRaw(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(msg));
  }
}
