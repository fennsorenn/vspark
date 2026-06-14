/**
 * MeshTransport adapter over the existing WebRTC {@link ServerMesh} — backend
 * mesh peers reach each other through the same two data channels the legacy
 * multiplayer system uses.
 *
 * Coexistence: during the parallel-run, legacy collab envelopes and mesh wire
 * messages share the `doc` channel. Mesh traffic is namespaced inside a
 * reserved legacy envelope (`rtype: '_mesh2'`) so legacy handlers ignore it
 * and this adapter ignores everything else; same for the lossy `stream`
 * channel (`k: '_mesh2'`). Once the legacy paths are deleted, the wrapper can
 * be dropped with a protocol bump.
 */
import type { SyncEnvelope } from '@vspark/shared/sync';
import type {
  MeshMessage,
  MeshTransport,
  TransportHandlers,
} from '@vspark/mesh';
import type { ServerMesh } from '../multiplayer/mesh.js';

/** Reserved rtype carrying mesh wire messages over the legacy doc channel. */
export const MESH2_RTYPE = '_mesh2';

export class ServerMeshTransport implements MeshTransport {
  private handlers: TransportHandlers | null = null;
  private readonly unsubs: (() => void)[] = [];

  constructor(private readonly mesh: ServerMesh) {}

  start(h: TransportHandlers): void {
    this.handlers = h;
    const onConnected = (peerId: string) => this.announce(peerId);
    const onDisconnected = (peerId: string) =>
      this.handlers?.peerDisconnected(peerId);
    const onEnvelope = ({ from, env }: { from: string; env: SyncEnvelope }) => {
      if (env?.rtype !== MESH2_RTYPE) return; // legacy traffic — not ours
      this.handlers?.message(from, env.data as MeshMessage);
    };
    const onStreamFrame = ({
      from,
      frame,
    }: {
      from: string;
      frame: Record<string, unknown>;
    }) => {
      if (frame?.k !== MESH2_RTYPE) return;
      this.handlers?.message(from, frame.m as MeshMessage);
    };
    this.mesh.on('peerConnected', onConnected);
    this.mesh.on('peerDisconnected', onDisconnected);
    this.mesh.on('envelope', onEnvelope);
    this.mesh.on('streamFrame', onStreamFrame);
    this.unsubs.push(
      () => this.mesh.off('peerConnected', onConnected),
      () => this.mesh.off('peerDisconnected', onDisconnected),
      () => this.mesh.off('envelope', onEnvelope),
      () => this.mesh.off('streamFrame', onStreamFrame)
    );
    // Peers that connected before this adapter attached.
    for (const peerId of this.mesh.connectedPeers()) this.announce(peerId);
  }

  stop(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.handlers = null;
  }

  private announce(peerId: string): void {
    this.handlers?.peerConnected(peerId, {
      send: (m: MeshMessage) =>
        void this.mesh.sendEnvelope(peerId, {
          rtype: MESH2_RTYPE,
          op: 'event',
          key: '',
          data: m,
        }),
      sendLossy: (m: MeshMessage) =>
        this.mesh.sendStream(peerId, { k: MESH2_RTYPE, m }),
    });
  }
}
