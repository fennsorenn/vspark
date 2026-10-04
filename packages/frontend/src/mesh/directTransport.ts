/**
 * Direct links for the tab's mesh peer (principle 8: most direct path).
 *
 * Rides the browser↔browser WebRTC data channels the client mesh already opens
 * to every participant in the cross-server roster (mesh/clientMesh.ts) and
 * hands the ones to tabs of OTHER servers to the mesh peer as links. Tabs on
 * our own server meet through it — a co-located server counts as direct — so
 * those links are left out.
 *
 * Frames are `{ "_mesh": <message> }` on the existing channel, beside the
 * legacy envelopes it carries.
 */
import {
  encode,
  type MeshMessage,
  type MeshTransport,
  type TransportHandlers,
} from '@vspark/mesh';
import { isClientParticipant, participantServer } from '@vspark/shared/sync';
import { clientMesh } from './clientMesh';

export class DirectTransport implements MeshTransport {
  private handlers: TransportHandlers | null = null;
  private readonly announced = new Set<string>();
  private readonly offs: (() => void)[] = [];

  constructor(private readonly ownServer: string) {}

  start(h: TransportHandlers): void {
    this.handlers = h;
    this.offs.push(clientMesh.onLinks((ids) => this.sync(ids)));
    this.offs.push(
      clientMesh.onMeshFrame((from, msg) => {
        if (this.announced.has(from)) h.message(from, msg as MeshMessage);
      })
    );
    this.sync(clientMesh.connectedIds());
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const id of [...this.announced]) this.handlers?.peerDisconnected(id);
    this.announced.clear();
    this.handlers = null;
  }

  private sync(ids: string[]): void {
    const h = this.handlers;
    if (!h) return;
    const want = new Set(
      ids.filter(
        (id) =>
          isClientParticipant(id) && participantServer(id) !== this.ownServer
      )
    );
    for (const id of want) {
      if (this.announced.has(id)) continue;
      this.announced.add(id);
      h.peerConnected(id, {
        send: (m) => void clientMesh.sendMesh(id, `{"_mesh":${encode(m)}}`),
      });
    }
    for (const id of [...this.announced]) {
      if (want.has(id)) continue;
      this.announced.delete(id);
      h.peerDisconnected(id);
    }
  }
}
