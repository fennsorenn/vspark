/**
 * Grants delivered to this server's tabs (principle 9: grants for a direct
 * link come from the brokering server).
 *
 * A tab of ours that another server's tab links to directly (principle 8)
 * must serve it exactly what WE granted that server — we are its grant source
 * of truth. So every grant whose grantee is not this server's own tabs is
 * mirrored into `peer_grant`, a runtime collection only our tabs can read;
 * each tab mirrors it into its own grant store (frontend mesh/peer.ts).
 * Revoking here removes the document, and the tab revokes in turn.
 */
import type { Collection, Grant, MeshPeer } from '@vspark/mesh';

export const PEER_GRANT_RTYPE = 'peer_grant';

interface PeerGrantDoc {
  id: string;
  grant: Grant;
  [k: string]: unknown;
}

export function initPeerGrants(peer: MeshPeer): Collection<PeerGrantDoc> {
  const col = peer.collection<PeerGrantDoc>(PEER_GRANT_RTYPE, {
    channels: ['runtime'],
    authority: 'self',
    clients: { read: true },
  });
  const sync = (list: (Grant & { gid: string })[]): void => {
    // A grant to our own id covers our own tabs: nothing to deliver.
    const want = new Map(
      list.filter((g) => g.grantee !== peer.id).map((g) => [g.gid, g])
    );
    for (const d of col.all())
      if (!want.has(d.id)) col.remove(d.id, { channel: 'runtime' });
    for (const [gid, g] of want) {
      if (col.get(gid)) continue;
      const { gid: _gid, ...grant } = g;
      col.set(gid, '', { id: gid, grant }, { channel: 'runtime' });
    }
  };
  sync(peer.grants.list());
  peer.grants.observe(() => sync(peer.grants.list()));
  return col;
}
