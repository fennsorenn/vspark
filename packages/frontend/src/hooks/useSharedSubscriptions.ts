/**
 * Keeps placed remote-object containers subscribed to their owner (Phase 5
 * multiplayer). A `remote_object` container persists in the receiver's project,
 * but its projected contents are ephemeral. Whenever the owning peer is
 * connected and we haven't subscribed yet, (re)subscribe so the owner sends a
 * fresh snapshot — covering page reload while connected and peer reconnects.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useConnectionsStore } from '../store/connectionsStore';
import { peerSubscribe } from '../api/client';
import { REMOTE_OBJECT_KIND } from '../sync/sharedProjection';
import { hasDirectEdge, subscribeDirect } from '../sync/shareDirect';

interface RemoteRef {
  ownerPeerId?: string;
  remoteObjectId?: string;
}

export function useSharedSubscriptions(): void {
  const nodes = useEditorStore((s) => s.nodes);
  const connectedIds = useConnectionsStore((s) => s.connectedIds);
  const meshConnected = useConnectionsStore((s) => s.meshConnected);
  const subscribed = useConnectionsStore((s) => s.subscribed);
  const setSubscribed = useConnectionsStore((s) => s.setSubscribed);

  useEffect(() => {
    for (const n of nodes) {
      if (n.kind !== REMOTE_OBJECT_KIND) continue;
      const ref = (n.components as { remoteRef?: RemoteRef } | undefined)
        ?.remoteRef;
      const owner = ref?.ownerPeerId;
      const objectId = ref?.remoteObjectId;
      if (!owner || !objectId) continue;
      if (!connectedIds.includes(owner)) continue;
      if (subscribed[owner]?.includes(objectId)) continue;
      // Mark first so this effect doesn't re-fire a duplicate before the
      // snapshot round-trips; the owner ignores SUBSCRIBE if no longer granted.
      setSubscribed(owner, objectId, true);
      // Document plane: our server always arms a mesh subscription on the
      // owner (the projection reads from the mesh replica). Streams + assets
      // stay legacy: served over the direct WebRTC edge when one is up,
      // otherwise relayed by our server (streams=true) — one path each, so
      // no double-delivery.
      const direct = hasDirectEdge(owner) && subscribeDirect(owner, objectId);
      void peerSubscribe(owner, objectId, !direct).catch(() => {});
    }
  }, [nodes, connectedIds, meshConnected, subscribed, setSubscribed]);
}
