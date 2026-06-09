/**
 * Brings up the browser-side WebRTC mesh (live-mesh phase, slice 2).
 *
 * Builds this tab's participant id (`${serverPeerId}#${tabUuid}`) from the
 * server identity, configures the {@link clientMesh} with a WS sender + a
 * store callback, and tears the mesh down on unmount. Inbound `mesh_roster`
 * and `mesh_signal` messages are routed into the mesh by useWsSync, and the
 * `mesh_hello` handshake is (re)sent on every WS open there too.
 *
 * See dev-notes/plans/live-mesh.md.
 */
import { useEffect } from 'react';
import { makeClientParticipantId } from '@vspark/shared/sync';
import type { SyncEnvelope } from '@vspark/shared/sync';
import { getConnectionIdentity } from '../api/client';
import { clientMesh } from '../mesh/clientMesh';
import { handleBlobEnvelope } from '../mesh/blobReceiver';
import { handleShareEnvelope } from '../sync/shareDirect';
import { editorWsRef } from './useWsSync';
import { useConnectionsStore } from '../store/connectionsStore';

/** One stable per-tab id for the lifetime of the page. */
const TAB_UUID =
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

/** Route a data envelope arriving over a peer's mesh channel: blob transfer to
 *  the blob receiver, object-share protocol to the direct-share consumer. */
function dispatchMeshEnvelope(from: string, env: SyncEnvelope): void {
  if (env.rtype?.startsWith('_blob_')) handleBlobEnvelope(env);
  else if (env.rtype?.startsWith('_share_')) handleShareEnvelope(from, env);
}

export function useClientMesh(): void {
  const setMeshConnected = useConnectionsStore((s) => s.setMeshConnected);

  useEffect(() => {
    let cancelled = false;
    void getConnectionIdentity()
      .then((id) => {
        if (cancelled || !id?.peerId) return;
        clientMesh.configure({
          selfId: makeClientParticipantId(id.peerId, TAB_UUID),
          getWs: () => editorWsRef.current,
          onChange: (ids) => setMeshConnected(ids),
          onEnvelope: dispatchMeshEnvelope,
        });
        // The WS may already be open (identity fetch is async) — say hello now;
        // useWsSync also re-sends on every (re)open.
        clientMesh.sendHello();
      })
      .catch(() => {
        /* multiplayer disabled / offline — mesh stays idle */
      });
    return () => {
      cancelled = true;
      clientMesh.reset();
    };
  }, [setMeshConnected]);
}
