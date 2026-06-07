/**
 * Multiplayer manager — wires this server's identity + contacts DAO to the
 * rendezvous client. Disabled (no-op) unless a rendezvous URL is configured.
 *
 * Pairing both ways stores the peer in `known_peers` and grants it a session
 * (so it can immediately connect, and reconnects stay friction-free). The
 * WebRTC ServerMesh (the actual data channels) is layered on next.
 *
 * See dev-notes/plans/multiplayer-phase5.md.
 */
import { getIdentity, signBytes } from './identity.js';
import {
  RendezvousClient,
  type PairedPeer,
  type RvStatus,
} from './rendezvous_client.js';
import {
  upsertKnownPeer,
  grantSession,
  listKnownPeers,
  touchLastSeen,
} from './peers.js';

class MultiplayerManager {
  private client: RendezvousClient | null = null;
  private enabled = false;

  /** Enable + connect, given a rendezvous URL (else stays disabled). */
  init(url: string | undefined, displayName?: string): void {
    if (!url) return;
    const id = getIdentity();
    this.enabled = true;
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
    // Creator side: a peer joined our code → store it + grant a session.
    this.client.on('pairRequest', (p: PairedPeer) => {
      upsertKnownPeer(p);
      grantSession(p.peerId);
      this.client?.refreshPresence();
    });
    this.client.on(
      'presence',
      ({ peerId, online }: { peerId: string; online: boolean }) => {
        if (online) touchLastSeen(peerId);
      }
    );
    this.client.start();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  status(): { enabled: boolean; status: RvStatus; peerId: string | null } {
    return {
      enabled: this.enabled,
      status: this.client?.status ?? 'idle',
      peerId: this.enabled ? getIdentity().peerId : null,
    };
  }

  async pairCreate(): Promise<string> {
    if (!this.client) throw new Error('multiplayer is not enabled');
    return this.client.pairCreate();
  }

  async pairJoin(code: string): Promise<PairedPeer> {
    if (!this.client) throw new Error('multiplayer is not enabled');
    const peer = await this.client.pairJoin(code);
    upsertKnownPeer(peer);
    grantSession(peer.peerId);
    this.client.refreshPresence();
    return peer;
  }
}

export const multiplayerManager = new MultiplayerManager();
