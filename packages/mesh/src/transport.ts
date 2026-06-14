/**
 * Transport SPI. A transport discovers peers and hands the mesh a link per
 * peer; the mesh peer is transport-agnostic. Implementations live in
 * @vspark/mesh-transports (WebRTC backend↔backend, WebRTC to browser tabs,
 * local-clients WS on the server, backend-link WS in the browser) — plus the
 * in-process loopback in this package for tests.
 */
import type { MeshMessage } from './wire.js';

export interface PeerLink {
  /** Reliable, ordered per pair. */
  send(msg: MeshMessage): void;
  /** Lossy, latest-wins (drop on backpressure). Falls back to `send` when a
   *  transport has no lossy lane (plain WS). */
  sendLossy?(msg: MeshMessage): void;
}

export interface TransportHandlers {
  peerConnected(peerId: string, link: PeerLink): void;
  peerDisconnected(peerId: string): void;
  message(peerId: string, msg: MeshMessage): void;
}

export interface MeshTransport {
  start(handlers: TransportHandlers): void;
  stop(): void;
}
