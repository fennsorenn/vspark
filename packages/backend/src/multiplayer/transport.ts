/**
 * The mesh's transport abstraction: a single `send(participant, …)` that the
 * subscription/routing logic uses without ever seeing the wire. A participant is
 * either a remote *server* peer (delivered over the {@link ServerMesh}) or a
 * remote *browser* participant (`serverId#tab`, delivered over the
 * {@link BrowserPeerMesh}); the facade in the manager resolves the id to its
 * link. Both the object-share protocol and content-addressed blob transfer ride
 * this, so asset transfer is a symmetric mesh capability — it makes no
 * difference whether a browser or a remote server is on the other end.
 *
 * See dev-notes/plans/permissioned-sync-mesh.md.
 */
import type { SyncEnvelope } from '@vspark/shared/sync';

export interface MeshTransport {
  /** Reliable envelope to a participant. False if the link isn't open. */
  sendEnvelope(participant: string, env: SyncEnvelope): boolean;
  /** Lossy stream frame to a participant (reliable on the browser edge, which
   *  has a single ordered channel). */
  sendStream(participant: string, frame: Record<string, unknown>): void;
}
