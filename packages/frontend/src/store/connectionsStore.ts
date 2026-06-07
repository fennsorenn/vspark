/**
 * Multiplayer connections state (Phase 5) — kept separate from the large
 * editorStore. Holds this server's identity, rendezvous status, the contacts
 * list, and pending inbound connection prompts. WS messages (mp_*) patch it for
 * instant feedback and bump `revision` so the Connections window refetches the
 * authoritative list.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { create } from 'zustand';
import type { ConnectionPeer } from '../api/client';

export interface IncomingRequest {
  peerId: string;
  displayName: string;
}

interface ConnectionsState {
  enabled: boolean;
  status: 'idle' | 'connecting' | 'ready' | 'closed';
  identityPeerId: string | null;
  peers: ConnectionPeer[];
  incoming: IncomingRequest[];
  /** Bumped by WS events so the window refetches the peer list. */
  revision: number;

  setMeta: (m: {
    enabled: boolean;
    status: ConnectionsState['status'];
    identityPeerId: string | null;
  }) => void;
  setStatus: (status: ConnectionsState['status']) => void;
  setPeers: (peers: ConnectionPeer[]) => void;
  patchPeer: (peerId: string, patch: Partial<ConnectionPeer>) => void;
  addIncoming: (req: IncomingRequest) => void;
  removeIncoming: (peerId: string) => void;
  bumpRevision: () => void;
}

export const useConnectionsStore = create<ConnectionsState>((set) => ({
  enabled: false,
  status: 'idle',
  identityPeerId: null,
  peers: [],
  incoming: [],
  revision: 0,

  setMeta: (m) => set(m),
  setStatus: (status) => set({ status }),
  setPeers: (peers) => set({ peers }),
  patchPeer: (peerId, patch) =>
    set((s) => ({
      peers: s.peers.map((p) => (p.peerId === peerId ? { ...p, ...patch } : p)),
    })),
  addIncoming: (req) =>
    set((s) =>
      s.incoming.some((r) => r.peerId === req.peerId)
        ? {}
        : { incoming: [...s.incoming, req] }
    ),
  removeIncoming: (peerId) =>
    set((s) => ({ incoming: s.incoming.filter((r) => r.peerId !== peerId) })),
  bumpRevision: () => set((s) => ({ revision: s.revision + 1 })),
}));
