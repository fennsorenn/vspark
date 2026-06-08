/**
 * Multiplayer manager — wires this server's identity + contacts DAO to the
 * rendezvous client and the WebRTC ServerMesh. Disabled (no-op) unless a
 * rendezvous URL is configured.
 *
 * Accept policy (prompt-once → persisted session grant): an inbound offer from
 * a known contact with an active grant auto-accepts; otherwise the UI is
 * prompted and accepting grants the session. Initiating a connection implicitly
 * grants the target; manual disconnect revokes the grant.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { getIdentity, signBytes } from './identity.js';
import {
  RendezvousClient,
  type PairedPeer,
  type RvStatus,
  type TurnCreds,
} from './rendezvous_client.js';
import { ServerMesh, type MeshSignaling } from './mesh.js';
import { SharingManager, SHARE_RTYPES } from './sharing.js';
import { BlobManager, BLOB_RTYPES } from './blobTransfer.js';
import {
  clientMeshRelay,
  MESH_RELAY_RTYPE,
  MESH_ROSTER_RTYPE,
} from './clientMeshRelay.js';
import { addShare, removeShare, listObjectGrantees } from './shares.js';
import { sync } from '../sync/index.js';
import {
  upsertKnownPeer,
  grantSession,
  revokeSessionGrant,
  hasActiveGrant,
  getKnownPeer,
  listKnownPeers,
  touchLastSeen,
  setPeerDisplayName,
} from './peers.js';
import type { SyncEnvelope } from '@vspark/shared/sync';
import type { ShareKind } from './shares.js';

/** Control envelope carrying a peer's current display name (the per-project
 *  name updates live, so we exchange it on connect + on change). */
const PROFILE_RTYPE = 'peer_profile';

type Broadcast = (kind: string, payload: Record<string, unknown>) => void;

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const TURN_REFRESH_MS = 5 * 60_000;

class MultiplayerManager {
  private client: RendezvousClient | null = null;
  private mesh: ServerMesh | null = null;
  private sharing: SharingManager | null = null;
  private blob: BlobManager | null = null;
  private enabled = false;
  private broadcast: Broadcast = () => {};
  private iceServers: IceServer[] = [];
  private iceFetchedAt = 0;
  private currentDisplayName = 'vspark';

  init(
    url: string | undefined,
    displayName?: string,
    broadcast?: Broadcast
  ): void {
    if (!url) return;
    const id = getIdentity();
    this.enabled = true;
    this.currentDisplayName = displayName || 'vspark';
    if (broadcast) this.broadcast = broadcast;

    this.client = new RendezvousClient(
      url,
      {
        peerId: id.peerId,
        publicKey: id.publicKey,
        sign: signBytes,
        displayName: displayName || 'vspark',
      },
      () =>
        listKnownPeers()
          .filter((p) => !p.blocked)
          .map((p) => p.peerId)
    );

    const signaling: MeshSignaling = {
      send: (to, data) => this.client?.sendSignal(to, data),
      onSignal: (cb) =>
        this.client?.on(
          'signal',
          ({ from, data }: { from: string; data: never }) => cb(from, data)
        ),
    };
    this.mesh = new ServerMesh(signaling, () => this.iceServers);
    this.blob = new BlobManager(this.mesh);
    this.sharing = new SharingManager(this.mesh, this.broadcast, this.blob);
    // Forward shared objects' document updates to subscribed peers.
    sync.onDocument((env) => this.sharing?.forwardDocOp(env));
    // Bridge the client-mesh signaling relay onto the server mesh.
    clientMeshRelay.attachBridge({
      send: (server, env) => this.mesh?.sendEnvelope(server, env),
      connectedServers: () => this.mesh?.connectedPeers() ?? [],
    });

    // Accept policy on inbound offers.
    this.mesh.on('incomingOffer', (peerId: string) => {
      const p = getKnownPeer(peerId);
      if (!p || p.blocked) {
        this.mesh?.rejectOffer(peerId);
        return;
      }
      if (hasActiveGrant(peerId)) {
        void this.mesh?.acceptOffer(peerId);
      } else {
        // Prompt the UI; accept() will grant + acceptOffer.
        this.broadcast('mp_connect_request', {
          peerId,
          displayName: p.displayName,
        });
      }
    });
    this.mesh.on('peerConnected', (peerId: string) => {
      touchLastSeen(peerId);
      this.broadcast('mp_peer', { peerId, connected: true });
      // Exchange display names so each side shows the other's live (per-project) name.
      this.sendProfile(peerId);
      this.sharing?.onPeerConnected(peerId);
      clientMeshRelay.onServerConnected(peerId);
    });
    this.mesh.on('peerDisconnected', (peerId: string) => {
      this.broadcast('mp_peer', { peerId, connected: false });
      this.sharing?.onPeerDisconnected(peerId);
      clientMeshRelay.onServerDisconnected(peerId);
    });
    // Inbound control envelopes: live display name + the sharing protocol.
    this.mesh.on(
      'envelope',
      ({ from, env }: { from: string; env: SyncEnvelope }) => {
        if (env?.rtype === PROFILE_RTYPE) {
          const name =
            (env.data as { displayName?: string })?.displayName ?? '';
          if (name) setPeerDisplayName(from, name);
          this.broadcast('mp_peer', {
            peerId: from,
            connected: true,
            displayName: name,
          });
          // The profile arrives once the peer's channel is fully live, so this is
          // a reliable point to (re-)advertise our shares (the on-connect send
          // can race the channel setup).
          this.sharing?.advertise(from);
        } else if (SHARE_RTYPES.has(env?.rtype)) {
          this.sharing?.handleEnvelope(from, env);
        } else if (BLOB_RTYPES.has(env?.rtype)) {
          this.blob?.handleEnvelope(from, env);
        } else if (env?.rtype === MESH_RELAY_RTYPE) {
          clientMeshRelay.onServerRelay(env);
        } else if (env?.rtype === MESH_ROSTER_RTYPE) {
          clientMeshRelay.onServerRoster(from, env);
        }
      }
    );

    // Pairing stores the contact only; the first connection still prompts.
    this.client.on('pairRequest', (peer: PairedPeer) => {
      upsertKnownPeer(peer);
      this.client?.refreshPresence();
      this.broadcast('mp_peer', { peerId: peer.peerId, paired: true });
    });
    this.client.on(
      'presence',
      ({ peerId, online }: { peerId: string; online: boolean }) => {
        if (online) touchLastSeen(peerId);
        this.broadcast('mp_presence', { peerId, online });
      }
    );
    this.client.on('status', (s: RvStatus) =>
      this.broadcast('mp_status', { status: s })
    );

    this.client.start();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  status(): {
    enabled: boolean;
    status: RvStatus;
    peerId: string | null;
    connected: string[];
  } {
    return {
      enabled: this.enabled,
      status: this.client?.status ?? 'idle',
      peerId: this.enabled ? getIdentity().peerId : null,
      connected: this.mesh?.connectedPeers() ?? [],
    };
  }

  isConnected(peerId: string): boolean {
    return this.mesh?.isConnected(peerId) ?? false;
  }

  async pairCreate(): Promise<string> {
    if (!this.client) throw new Error('multiplayer is not enabled');
    return this.client.pairCreate();
  }

  async pairJoin(code: string): Promise<PairedPeer> {
    if (!this.client) throw new Error('multiplayer is not enabled');
    const peer = await this.client.pairJoin(code);
    upsertKnownPeer(peer);
    this.client.refreshPresence();
    return peer;
  }

  /** Initiate a connection to a contact (implicitly grants them the session). */
  async connect(peerId: string): Promise<void> {
    if (!this.client || !this.mesh)
      throw new Error('multiplayer is not enabled');
    const p = getKnownPeer(peerId);
    if (!p) throw new Error('unknown peer');
    if (p.blocked) throw new Error('peer is blocked');
    grantSession(peerId);
    await this.ensureIce();
    await this.mesh.connect(peerId);
  }

  /** Accept a prompted inbound connection (grants the session). */
  async accept(peerId: string): Promise<void> {
    if (!this.mesh) throw new Error('multiplayer is not enabled');
    grantSession(peerId);
    await this.ensureIce();
    await this.mesh.acceptOffer(peerId);
  }

  reject(peerId: string): void {
    this.mesh?.rejectOffer(peerId);
  }

  /** Update the name peers see (per-project; the caller persists it). Pushes the
   *  new name to the rendezvous (future pairs) and to all connected peers live. */
  setDisplayName(name: string): void {
    this.currentDisplayName = name;
    this.client?.setDisplayName(name);
    for (const peerId of this.mesh?.connectedPeers() ?? [])
      this.sendProfile(peerId);
  }

  private sendProfile(peerId: string): void {
    this.mesh?.sendEnvelope(peerId, {
      rtype: PROFILE_RTYPE,
      op: 'event',
      key: getIdentity().peerId,
      data: { displayName: this.currentDisplayName },
    });
  }

  /** Manual disconnect — revokes the session grant (next inbound re-prompts).
   *  Sends a graceful `bye` so the peer tears down its side (and drops our
   *  shared-object projections) immediately rather than hanging until a
   *  transport timeout. */
  disconnect(peerId: string): void {
    this.mesh?.disconnectGraceful(peerId);
    revokeSessionGrant(peerId);
  }

  // --- sharing ---------------------------------------------------------------

  /** Grant a peer ('*' = all) access to one of my objects + advertise it live. */
  share(objectId: string, granteePeerId: string, shareKind: ShareKind): void {
    addShare(shareKind, objectId, granteePeerId);
    this.sharing?.reAdvertiseAll();
  }

  /** Revoke a grant + tell connected peers to drop it. */
  unshare(objectId: string, granteePeerId: string): void {
    removeShare(objectId, granteePeerId);
    if (granteePeerId === '*') {
      for (const id of this.mesh?.connectedPeers() ?? [])
        this.sharing?.notifyUnshared(id, objectId);
    } else {
      this.sharing?.notifyUnshared(granteePeerId, objectId);
    }
  }

  /** Grantees of an object (for the "Share with" UI). */
  grantees(objectId: string): string[] {
    return listObjectGrantees(objectId);
  }

  /** Replay current share offers to a freshly-connected client (late-join gap). */
  sendSharingSnapshotTo(
    send: (kind: string, payload: Record<string, unknown>) => void
  ): void {
    this.sharing?.sendSnapshotTo(send);
  }

  /** Receiver: (un)subscribe to a peer's shared object (frontend wrapper place/remove). */
  subscribeShared(peerId: string, objectId: string): void {
    this.sharing?.subscribe(peerId, objectId);
  }
  unsubscribeShared(peerId: string, objectId: string): void {
    this.sharing?.unsubscribe(peerId, objectId);
  }

  private async ensureIce(): Promise<void> {
    if (!this.client) return;
    if (
      Date.now() - this.iceFetchedAt < TURN_REFRESH_MS &&
      this.iceServers.length
    )
      return;
    try {
      const creds: TurnCreds = await this.client.requestTurnCreds();
      const ice: IceServer[] = creds.stunUrls.map((u) => ({ urls: u }));
      if (creds.urls.length && creds.username && creds.credential)
        ice.push({
          urls: creds.urls,
          username: creds.username,
          credential: creds.credential,
        });
      this.iceServers = ice;
      this.iceFetchedAt = Date.now();
    } catch {
      /* keep whatever we had; host candidates still work on a LAN/loopback */
    }
  }
}

export const multiplayerManager = new MultiplayerManager();
