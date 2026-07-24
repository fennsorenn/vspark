/**
 * Minimal obs-websocket v5 client.
 *
 * Hand-rolled (using the already-present `ws` package + Node `crypto`) rather
 * than pulling in `obs-websocket-js`, matching the repo's hand-rolled
 * `@overlive/*` adapter style and avoiding an ESM/bundling dependency. Covers
 * exactly what the OBS power tier needs: the Hello/Identify SHA256 handshake,
 * request/response correlation, and event fan-out. Reconnection is owned by
 * `ObsWsManager`, so this client stays dumb and unit-testable.
 *
 * Protocol: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 */
import { WebSocket } from 'ws';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';

/** obs-websocket EventSubscription bit flags (subset). */
export const EVENT_SUB = {
  General: 1 << 0,
  Scenes: 1 << 2,
  Inputs: 1 << 3,
  Transitions: 1 << 4,
  Outputs: 1 << 6,
} as const;

/** Phase 1 only needs input volume/mute events. */
const DEFAULT_SUBSCRIPTIONS = EVENT_SUB.Inputs;

const OP = {
  Hello: 0,
  Identify: 1,
  Identified: 2,
  Event: 5,
  Request: 6,
  RequestResponse: 7,
} as const;

/** Reject an in-flight request that gets no response in this many ms. */
const REQUEST_TIMEOUT_MS = 10_000;

interface HelloData {
  authentication?: { challenge: string; salt: string };
}
interface RequestResponseData {
  requestId: string;
  requestStatus: { result: boolean; code: number; comment?: string };
  responseData?: Record<string, unknown>;
}
interface EventData {
  eventType: string;
  eventData?: Record<string, unknown>;
}

export interface ObsWsClientOptions {
  host: string;
  port: number;
  password: string;
  /** EventSubscription bitmask; defaults to Inputs. */
  eventSubscriptions?: number;
}

/**
 * Events emitted: `identified` (handshake complete), `obsEvent`
 * (eventType, eventData), `close` ({code, reason}), `error` (Error).
 */
export class ObsWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly opts: ObsWsClientOptions;
  private readonly pending = new Map<
    string,
    { resolve: (d: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private reqSeq = 0;
  private _identified = false;
  private _closed = false;

  constructor(opts: ObsWsClientOptions) {
    super();
    this.opts = opts;
  }

  get identified(): boolean {
    return this._identified;
  }

  connect(): void {
    const url = `ws://${this.opts.host}:${this.opts.port}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('message', (raw) => this._onMessage(raw.toString()));
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', (code, reason) => {
      this._identified = false;
      this._rejectAllPending(new Error('connection closed'));
      if (!this._closed)
        this.emit('close', { code, reason: reason.toString() });
    });
  }

  /** Close the socket; suppresses the `close` event (caller-initiated). */
  close(): void {
    this._closed = true;
    this._rejectAllPending(new Error('client closed'));
    this.ws?.close();
    this.ws = null;
  }

  /** Send a request and resolve with its responseData (or reject on failure). */
  request(
    requestType: string,
    requestData?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this._identified) {
        reject(new Error('obs-websocket not connected'));
        return;
      }
      const requestId = `r${++this.reqSeq}`;
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId))
          reject(new Error(`obs request ${requestType} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this._send(OP.Request, {
        requestType,
        requestId,
        requestData: requestData ?? {},
      });
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private _send(op: number, d: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify({ op, d }));
  }

  private _onMessage(raw: string): void {
    let msg: { op: number; d: Record<string, unknown> };
    try {
      msg = JSON.parse(raw) as { op: number; d: Record<string, unknown> };
    } catch {
      return;
    }
    switch (msg.op) {
      case OP.Hello:
        this._onHello(msg.d as HelloData);
        return;
      case OP.Identified:
        this._identified = true;
        this.emit('identified');
        return;
      case OP.Event: {
        const d = msg.d as unknown as EventData;
        this.emit('obsEvent', d.eventType, d.eventData ?? {});
        return;
      }
      case OP.RequestResponse:
        this._onResponse(msg.d as unknown as RequestResponseData);
        return;
    }
  }

  private _onHello(d: HelloData): void {
    const identify: Record<string, unknown> = {
      rpcVersion: 1,
      eventSubscriptions:
        this.opts.eventSubscriptions ?? DEFAULT_SUBSCRIPTIONS,
    };
    if (d.authentication) {
      identify.authentication = this._authString(
        d.authentication.challenge,
        d.authentication.salt
      );
    }
    this._send(OP.Identify, identify);
  }

  /** base64( sha256( base64( sha256(password + salt) ) + challenge ) ) */
  private _authString(challenge: string, salt: string): string {
    const secret = createHash('sha256')
      .update(this.opts.password + salt)
      .digest('base64');
    return createHash('sha256').update(secret + challenge).digest('base64');
  }

  private _onResponse(d: RequestResponseData): void {
    const p = this.pending.get(d.requestId);
    if (!p) return;
    this.pending.delete(d.requestId);
    if (d.requestStatus.result) p.resolve(d.responseData ?? {});
    else
      p.reject(
        new Error(
          d.requestStatus.comment ??
            `obs request failed (code ${d.requestStatus.code})`
        )
      );
  }

  private _rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
