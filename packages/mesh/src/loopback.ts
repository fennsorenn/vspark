/**
 * In-process loopback transport — two MeshTransports joined back-to-back.
 * Delivery is asynchronous (macrotask) to mimic a real link; `disconnect()` /
 * `connect()` simulate outages; `flush()` resolves once all in-flight
 * messages (including cascades they trigger) have been delivered.
 *
 * Test infrastructure, but also the reference MeshTransport implementation.
 */
import type { MeshTransport, PeerLink, TransportHandlers } from './transport.js';
import type { MeshMessage } from './wire.js';

export interface LoopbackPair {
  a: MeshTransport;
  b: MeshTransport;
  /** Drop the link (peers see a disconnect; queued messages are lost). */
  disconnect(): void;
  /** Re-establish the link (peers see a fresh connect). */
  connect(): void;
  /** Wait until every in-flight delivery has settled. */
  flush(): Promise<void>;
}

export function createLoopbackPair(aId: string, bId: string): LoopbackPair {
  let connected = true;
  let inFlight = 0;
  let ha: TransportHandlers | null = null;
  let hb: TransportHandlers | null = null;

  const post = (fn: () => void): void => {
    inFlight++;
    setTimeout(() => {
      try {
        fn();
      } finally {
        inFlight--;
      }
    }, 0);
  };

  const linkTo = (
    fromId: string,
    handlers: () => TransportHandlers | null
  ): PeerLink => ({
    send: (msg: MeshMessage) => {
      if (!connected) return;
      post(() => {
        if (connected) handlers()?.message(fromId, msg);
      });
    },
    // Loopback never backpressures; lossy === reliable here.
  });

  const tryConnect = (): void => {
    if (!connected || !ha || !hb) return;
    ha.peerConnected(bId, linkTo(aId, () => hb));
    hb.peerConnected(aId, linkTo(bId, () => ha));
  };

  // `set` stores the handler and attempts the handshake itself.
  const side = (set: (h: TransportHandlers | null) => void): MeshTransport => ({
    start: (h) => set(h),
    stop: () => set(null),
  });

  return {
    a: side((h) => {
      ha = h;
      tryConnect();
    }),
    b: side((h) => {
      hb = h;
      tryConnect();
    }),
    disconnect: () => {
      if (!connected) return;
      connected = false;
      ha?.peerDisconnected(bId);
      hb?.peerDisconnected(aId);
    },
    connect: () => {
      if (connected) return;
      connected = true;
      tryConnect();
    },
    flush: async () => {
      while (inFlight > 0) await new Promise((r) => setTimeout(r, 0));
    },
  };
}
