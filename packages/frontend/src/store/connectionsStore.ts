/**
 * Multiplayer connections state (Phase 5) — kept separate from the large
 * editorStore. Holds this server's identity, rendezvous status, the contacts
 * list, who's currently connected, and pending inbound prompts.
 *
 * Two consumers: the Connections window (full peer list) and the TopBar button
 * (connected count/names + incoming badge). WS messages (mp_*) patch it for
 * instant feedback and bump `revision` so the window refetches the list.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { create } from 'zustand';
import type { ConnectionPeer } from '../api/client';

export interface IncomingRequest {
  peerId: string;
  displayName: string;
}

/** One object a connected peer is offering to share with us. */
export interface SharedOffer {
  objectId: string;
  shareKind: 'object' | 'scene';
  name: string;
  /** Whether the owner granted us edit (update/create/delete) rights too. */
  canWrite?: boolean;
}

interface ConnectionsState {
  enabled: boolean;
  status: 'idle' | 'connecting' | 'ready' | 'closed';
  identityPeerId: string | null;
  peers: ConnectionPeer[];
  /** Peer ids with a live mesh connection (button + window, kept current by WS). */
  connectedIds: string[];
  /** peerId → display name (for the button tooltip without the full list). */
  nameById: Record<string, string>;
  incoming: IncomingRequest[];
  /** peerId → objects that peer currently offers us (from mp_shares). */
  offers: Record<string, SharedOffer[]>;
  /** peerId → objectIds we've subscribed to (placed in our scene). */
  subscribed: Record<string, string[]>;
  /** Participant ids we hold a live direct (client-mesh) data channel to. */
  meshConnected: string[];
  /** Collab-scene links (sceneId → peer + author/mounted role) for the scene-
   *  graph chain badge. Keyed by sceneId. */
  collabScenes: Record<string, { peerId: string; role: 'author' | 'mounted' }>;
  /** Bumped by WS events so the window refetches the peer list. */
  revision: number;

  setMeta: (m: {
    enabled: boolean;
    status: ConnectionsState['status'];
    identityPeerId: string | null;
  }) => void;
  setStatus: (status: ConnectionsState['status']) => void;
  setPeers: (peers: ConnectionPeer[]) => void;
  setConnected: (peerId: string, connected: boolean, name?: string) => void;
  addIncoming: (req: IncomingRequest) => void;
  removeIncoming: (peerId: string) => void;
  setOffers: (peerId: string, offers: SharedOffer[]) => void;
  setSubscribed: (peerId: string, objectId: string, on: boolean) => void;
  clearPeerSharing: (peerId: string) => void;
  setMeshConnected: (ids: string[]) => void;
  setCollabScenes: (
    links: { sceneId: string; peerId: string; role: 'author' | 'mounted' }[]
  ) => void;
  bumpRevision: () => void;
}

export const useConnectionsStore = create<ConnectionsState>((set) => ({
  enabled: false,
  status: 'idle',
  identityPeerId: null,
  peers: [],
  connectedIds: [],
  nameById: {},
  incoming: [],
  offers: {},
  subscribed: {},
  meshConnected: [],
  collabScenes: {},
  revision: 0,

  setMeta: (m) => set(m),
  setStatus: (status) => set({ status }),
  setPeers: (peers) =>
    set({
      peers,
      connectedIds: peers.filter((p) => p.connected).map((p) => p.peerId),
      nameById: Object.fromEntries(
        peers.map((p) => [p.peerId, p.displayName || p.peerId.slice(0, 8)])
      ),
    }),
  setConnected: (peerId, connected, name) =>
    set((s) => ({
      connectedIds: connected
        ? s.connectedIds.includes(peerId)
          ? s.connectedIds
          : [...s.connectedIds, peerId]
        : s.connectedIds.filter((id) => id !== peerId),
      nameById: name ? { ...s.nameById, [peerId]: name } : s.nameById,
    })),
  addIncoming: (req) =>
    set((s) =>
      s.incoming.some((r) => r.peerId === req.peerId)
        ? {}
        : { incoming: [...s.incoming, req] }
    ),
  removeIncoming: (peerId) =>
    set((s) => ({ incoming: s.incoming.filter((r) => r.peerId !== peerId) })),
  setOffers: (peerId, offers) =>
    set((s) => ({ offers: { ...s.offers, [peerId]: offers } })),
  setSubscribed: (peerId, objectId, on) =>
    set((s) => {
      const cur = s.subscribed[peerId] ?? [];
      const next = on
        ? cur.includes(objectId)
          ? cur
          : [...cur, objectId]
        : cur.filter((id) => id !== objectId);
      return { subscribed: { ...s.subscribed, [peerId]: next } };
    }),
  clearPeerSharing: (peerId) =>
    set((s) => {
      const offers = { ...s.offers };
      const subscribed = { ...s.subscribed };
      delete offers[peerId];
      delete subscribed[peerId];
      return { offers, subscribed };
    }),
  setMeshConnected: (ids) => set({ meshConnected: ids }),
  setCollabScenes: (links) =>
    set({
      collabScenes: Object.fromEntries(
        links.map((l) => [l.sceneId, { peerId: l.peerId, role: l.role }])
      ),
    }),
  bumpRevision: () => set((s) => ({ revision: s.revision + 1 })),
}));

/** Whether the owner granted us edit rights on a shared object (Phase 6). Read
 *  from the offer list, outside React (edit-commit paths call it imperatively). */
export function canWriteObject(ownerPeerId: string, objectId: string): boolean {
  return !!useConnectionsStore
    .getState()
    .offers[ownerPeerId]?.find((o) => o.objectId === objectId)?.canWrite;
}
