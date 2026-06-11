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
import { BrowserPeerMesh } from './browserMesh.js';
import { SharingManager, SHARE_RTYPES } from './sharing.js';
import { type MeshTransport } from './transport.js';
import { MeshRouter } from '../sync/meshRouter.js';
import { grantsForRequester, canAccess } from '../sync/grants.js';
import { containmentIndex } from '../sync/containmentIndex.js';
import { getDb } from '../db/index.js';
import { gatherObjectSnapshot, gatherSceneSnapshot, type ObjectSnapshot } from './shares.js';
import {
  registerCollabScene,
  removeCollabScene,
  indexCollabScene,
  mountSharedScene,
  forwardCollabOp,
  applyCollabOp,
  applyCollabAssetOp,
  forwardCollabStream,
  persistCollabAssets,
  indexAllCollabScenes,
  gatherReconcile,
  applyReconcile,
  collabScenesForPeer,
  collabPeersForScene,
  COLLAB_OP_RTYPE,
  COLLAB_STREAM_RTYPE,
  COLLAB_SUBSCRIBE_RTYPE,
  COLLAB_SNAPSHOT_RTYPE,
  COLLAB_RECONCILE_RTYPE,
  type ReconcilePayload,
} from './collabScene.js';
import { BlobManager, BLOB_RTYPES } from './blobTransfer.js';
import type { AssetMeta } from './blobs.js';
import {
  clientMeshRelay,
  MESH_RELAY_RTYPE,
  MESH_ROSTER_RTYPE,
} from './clientMeshRelay.js';
import { addShare, removeShare, listObjectGrantees } from './shares.js';
import { sync } from '../sync/index.js';
import {
  upsertKnownPeer,
  removeKnownPeer,
  grantSession,
  revokeSessionGrant,
  hasActiveGrant,
  getKnownPeer,
  listKnownPeers,
  touchLastSeen,
  setPeerDisplayName,
} from './peers.js';
import { isClientParticipant, type SyncEnvelope } from '@vspark/shared/sync';
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
  /** WebRTC edge to remote *browsers* (the client mesh's protocol). Lets this
   *  backend be a full mesh participant of remote browser tabs, not just other
   *  backends. */
  private browserMesh: BrowserPeerMesh | null = null;
  /** Live grant-gated subscription registry (object-share subscribers + the
   *  foundation for namespace pub/sub). */
  private meshRouter: MeshRouter | null = null;
  private sharing: SharingManager | null = null;
  private blob: BlobManager | null = null;
  private enabled = false;
  /** sceneId → target projectId while a collab-scene mount is in flight (between
   *  our subscribe request and the owner's snapshot reply). */
  private readonly pendingCollabMount = new Map<string, string>();
  /** Peers we've received a profile from this connection — so the courtesy
   *  re-send (covering a raced on-connect profile) fires at most once. */
  private readonly profileExchanged = new Set<string>();
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
    // Rebuild the collab node→scene index from the persisted links so live
    // forwarding (edits + pose/preview streams) works after a restart.
    indexAllCollabScenes();
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
    // Transport facade: resolve a participant id to its link — remote browsers
    // (`serverId#tab`) go over the WebRTC browser edge, remote servers over the
    // ServerMesh. Read lazily so `browserMesh` (built just below) is in place by
    // the time anything actually sends. Both sharing and blob transfer ride it,
    // so the owner serves the same protocol to a browser or a server alike.
    const transport: MeshTransport = {
      sendEnvelope: (participant, env) =>
        isClientParticipant(participant)
          ? (this.browserMesh?.send(participant, env) ?? false)
          : (this.mesh?.sendEnvelope(participant, env) ?? false),
      sendStream: (participant, frame) => {
        if (isClientParticipant(participant))
          this.browserMesh?.send(participant, frame as unknown as SyncEnvelope);
        else this.mesh?.sendStream(participant, frame);
      },
    };
    this.blob = new BlobManager(transport);
    // Live grant-gated subscription registry: admit-on-subscribe against this
    // server's real grant store + the containment index. The object-share path
    // holds its subscribers here (replacing a bespoke map); links are attached on
    // connect so `publish()` is ready for the future namespace-pub/sub tier.
    const meshRouter = new MeshRouter(grantsForRequester, (rtype, id2, anc) =>
      containmentIndex.isDescendant(rtype, id2, anc)
    );
    this.meshRouter = meshRouter;
    this.sharing = new SharingManager(
      transport,
      this.broadcast,
      this.blob,
      meshRouter
    );
    // Forward shared objects' document updates to subscribed peers, and mirror
    // collaborative-scene edits to their peers (peer-to-peer, persisted on both).
    sync.onDocument((env) => {
      this.sharing?.forwardDocOp(env);
      forwardCollabOp(env, (peer, e) => this.mesh?.sendEnvelope(peer, e));
    });
    // Bridge the client-mesh signaling relay onto the server mesh.
    clientMeshRelay.attachBridge({
      send: (server, env) => this.mesh?.sendEnvelope(server, env),
      connectedServers: () => this.mesh?.connectedPeers() ?? [],
    });

    // Browser-facing WebRTC edge: this backend answers offers from remote
    // browsers, signaled through the relay (which dispatches signaling addressed
    // to our own peer id to `onBackendSignal`). Browsers always dial us.
    clientMeshRelay.setSelfPeerId(id.peerId);
    const browserSignaling: MeshSignaling = {
      send: (to, data) => clientMeshRelay.sendFromBackend(to, data),
      onSignal: (cb) =>
        clientMeshRelay.onBackendSignal((from, data) =>
          cb(from, data as never)
        ),
    };
    this.browserMesh = new BrowserPeerMesh(
      browserSignaling,
      () => this.iceServers
    );
    this.browserMesh.on('peerConnected', (participant: string) => {
      // Browser edge: single ordered channel, so the lossy link is the same send.
      meshRouter.attach(
        participant,
        (env) => this.browserMesh?.send(participant, env),
        (frame) =>
          this.browserMesh?.send(participant, frame as unknown as SyncEnvelope)
      );
      this.broadcast('mp_browser_peer', { participant, connected: true });
    });
    this.browserMesh.on('peerDisconnected', (participant: string) => {
      this.sharing?.onPeerDisconnected(participant);
      meshRouter.detach(participant); // drops its link + subscriptions
      this.broadcast('mp_browser_peer', { participant, connected: false });
    });
    this.browserMesh.on(
      'envelope',
      ({ from, env }: { from: string; env: SyncEnvelope }) => {
        // A remote browser talks the `_share_*` protocol directly to the owning
        // backend over this edge (subscribe / unsubscribe), and requests asset
        // blobs over the same `_blob_*` protocol a server would. The transport
        // facade routes our replies back over the same WebRTC channel; source-
        // side grant admission still gates what flows.
        if (SHARE_RTYPES.has(env?.rtype)) this.sharing?.handleEnvelope(from, env);
        else if (BLOB_RTYPES.has(env?.rtype)) this.blob?.handleEnvelope(from, env);
      }
    );

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
      meshRouter.attach(
        peerId,
        (env) => this.mesh?.sendEnvelope(peerId, env),
        (frame) => this.mesh?.sendStream(peerId, frame)
      );
      this.broadcast('mp_peer', { peerId, connected: true });
      // Exchange display names so each side shows the other's live (per-project) name.
      this.sendProfile(peerId);
      this.sharing?.onPeerConnected(peerId);
      clientMeshRelay.onServerConnected(peerId);
    });
    this.mesh.on('peerDisconnected', (peerId: string) => {
      this.profileExchanged.delete(peerId);
      this.broadcast('mp_peer', { peerId, connected: false });
      this.sharing?.onPeerDisconnected(peerId);
      meshRouter.detach(peerId); // drops its link + subscriptions
      clientMeshRelay.onServerDisconnected(peerId);
    });
    // Lossy stream frames (shared-avatar pose/blendshapes/drag previews).
    this.mesh.on(
      'streamFrame',
      ({ from, frame }: { from: string; frame: Record<string, unknown> }) => {
        // Collaborative scene: re-broadcast the frame to our own clients under its
        // original kind (vmc_pose / node_transform_preview / …). The node ids are
        // shared, so the frame applies straight to our mounted copy.
        if (frame?.rtype === COLLAB_STREAM_RTYPE) {
          this.broadcast(
            frame.kind as string,
            frame.payload as Record<string, unknown>
          );
          return;
        }
        this.sharing?.handleStreamFrame(from, frame);
      }
    );
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
          // can race the channel setup). For the same reason our own on-connect
          // sendProfile may have raced and never reached them — re-send it once
          // (the first receipt per connection) so names converge both ways.
          if (!this.profileExchanged.has(from)) {
            this.profileExchanged.add(from);
            this.sendProfile(from);
            // Channel is proven live — reconcile any collab scenes we share with
            // this peer (converge edits made while disconnected).
            this.sendReconcile(from);
          }
          this.sharing?.advertise(from);
        } else if (SHARE_RTYPES.has(env?.rtype)) {
          this.sharing?.handleEnvelope(from, env);
        } else if (BLOB_RTYPES.has(env?.rtype)) {
          this.blob?.handleEnvelope(from, env);
        } else if (env?.rtype === MESH_RELAY_RTYPE) {
          clientMeshRelay.onServerRelay(env);
        } else if (env?.rtype === MESH_ROSTER_RTYPE) {
          clientMeshRelay.onServerRoster(from, env);
        } else if (env?.rtype === COLLAB_OP_RTYPE) {
          // A collaborative-scene peer's edit: apply LWW to our persisted copy.
          // applyCollabOp re-emits via sync.document, which fans out to our own
          // clients (so the local editor updates) without echoing back. If the op
          // carries asset metadata (a model/texture), fetch + localize it first so
          // a mid-session model swap renders + persists locally.
          const d = (env.data ?? {}) as {
            sceneId?: string;
            env?: SyncEnvelope;
            asset?: AssetMeta;
          };
          if (d.sceneId && d.env) {
            if (d.asset && this.blob)
              void applyCollabAssetOp(d.sceneId, d.env, d.asset, (a) =>
                this.blob!.ensure(from, a)
              );
            else applyCollabOp(d.sceneId, d.env);
          }
        } else if (env?.rtype === COLLAB_SUBSCRIBE_RTYPE) {
          this.handleCollabSubscribe(from, env);
        } else if (env?.rtype === COLLAB_SNAPSHOT_RTYPE) {
          void this.handleCollabSnapshot(from, env);
        } else if (env?.rtype === COLLAB_RECONCILE_RTYPE) {
          // A peer's full collab-scene state on (re)connect — merge LWW so edits
          // made while we were disconnected converge both ways.
          const payload = env.data as ReconcilePayload | undefined;
          const blob = this.blob;
          if (payload?.sceneId && blob)
            void applyReconcile(from, payload, (a) => blob.ensure(from, a)).then(
              (changed) => {
                if (!changed) return;
                const link = collabPeersForScene(payload.sceneId).find(
                  (l) => l.peerId === from
                );
                if (link)
                  this.broadcast('mp_collab_mounted', {
                    peerId: from,
                    sceneId: payload.sceneId,
                    projectId: link.projectId,
                  });
              }
            );
        }
      }
    );

    // Pairing stores the contact only; the first connection still prompts.
    this.client.on('pairRequest', (peer: PairedPeer) => {
      upsertKnownPeer(peer);
      this.client?.refreshPresence();
      this.broadcast('mp_peer', { peerId: peer.peerId, paired: true });
    });
    // The peer removed us as a contact — drop it on our side too + refetch.
    this.client.on('unpairRequest', ({ from }: { from: string }) => {
      revokeSessionGrant(from);
      this.mesh?.disconnect(from);
      removeKnownPeer(from);
      this.broadcast('mp_peer', { peerId: from, connected: false });
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
    // Symmetric with the creator's `pairRequest` path: tell our own clients a new
    // contact landed so the Connections window refetches live (otherwise the
    // joiner only sees the new contact after a reload).
    this.broadcast('mp_peer', { peerId: peer.peerId, paired: true });
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

  /** Send our full state for every collab scene we share with `peerId`, so a
   *  reconnect re-converges edits made on either side while disconnected. The
   *  doc channel can still be opening when the first profile arrives (dialer and
   *  answerer open asymmetrically), so retry with backoff until it accepts the
   *  send — reconcile is idempotent, so a retried/duplicate send is harmless. */
  private sendReconcile(peerId: string, attempt = 0): void {
    const links = collabScenesForPeer(peerId);
    if (links.length === 0) return;
    let allSent = true;
    for (const link of links) {
      const payload = gatherReconcile(link.sceneId);
      if (!payload) continue;
      const sent = this.mesh?.sendEnvelope(peerId, {
        rtype: COLLAB_RECONCILE_RTYPE,
        op: 'event',
        key: link.sceneId,
        data: payload,
      });
      if (!sent) allSent = false;
    }
    if (!allSent && attempt < 6)
      setTimeout(
        () => this.sendReconcile(peerId, attempt + 1),
        500 * (attempt + 1)
      );
  }

  /** Manual disconnect — revokes the session grant (next inbound re-prompts).
   *  Sends a graceful `bye` so the peer tears down its side (and drops our
   *  shared-object projections) immediately rather than hanging until a
   *  transport timeout. */
  disconnect(peerId: string): void {
    this.mesh?.disconnectGraceful(peerId);
    revokeSessionGrant(peerId);
  }

  /** Remove a contact (unpair). Notifies the peer (rendezvous-relayed, so it
   *  lands even with no mesh edge — unpair almost always happens from the
   *  disconnected Contacts list) so it drops us too, tears down any connection,
   *  forgets the pairing, and tells our own clients so the Connections window
   *  refetches (it otherwise stayed stale). */
  removePeer(peerId: string): void {
    this.client?.sendUnpair(peerId);
    this.disconnect(peerId);
    removeKnownPeer(peerId);
    this.broadcast('mp_peer', { peerId, connected: false });
  }

  // --- sharing ---------------------------------------------------------------

  /** Grant a peer ('*' = all) access to one of my objects + advertise it live. */
  share(
    objectId: string,
    granteePeerId: string,
    shareKind: ShareKind,
    canWrite = false
  ): void {
    addShare(shareKind, objectId, granteePeerId, canWrite);
    this.sharing?.reAdvertiseAll();
  }

  /** Relay one of this server's browser clients' Phase 6 write requests to the
   *  owning peer over the mesh (used when the browser has no direct edge). */
  relayWrite(owner: string, env: SyncEnvelope): void {
    this.sharing?.relayWrite(owner, env);
  }

  /** Revoke a grant + tell every affected subscriber (server peers and direct
   *  browser participants alike) to drop it. Also tears down any collaborative-
   *  scene link to that peer so live sync stops (the peer keeps its persisted
   *  copy — unshare ends the collaboration, it doesn't delete their scene). */
  unshare(objectId: string, granteePeerId: string): void {
    removeShare(objectId, granteePeerId);
    removeCollabScene(objectId, granteePeerId);
    this.sharing?.revokeUnauthorized(objectId);
  }

  /** Grantees of an object (for the "Share with" UI). */
  grantees(objectId: string): string[] {
    return listObjectGrantees(objectId);
  }

  // --- collaborative scene sharing (peer-to-peer, persisted on both) ---------

  /** Owner: offer a scene for collaborative editing. Grants the peer read+write
   *  (which the sharing manager advertises as a scene offer the peer can mount)
   *  and records our 'author' link + indexes the scene for fan-out. */
  shareCollabScene(sceneId: string, granteePeerId: string): void {
    const row = getDb()
      .prepare("SELECT project_id, name FROM scene_nodes WHERE id = ? AND kind = 'scene'")
      .get(sceneId) as { project_id: string; name: string } | undefined;
    if (!row) return;
    addShare('scene', sceneId, granteePeerId, true);
    registerCollabScene(sceneId, granteePeerId, 'author', row.project_id);
    indexCollabScene(sceneId);
    this.sharing?.reAdvertiseAll();
  }

  /** Receiver: ask the owner to send a collab scene so we can mount it into
   *  `projectId`. Remembers the target project until the snapshot arrives. */
  mountCollabScene(ownerPeerId: string, sceneId: string, projectId: string): void {
    this.pendingCollabMount.set(sceneId, projectId);
    this.mesh?.sendEnvelope(ownerPeerId, {
      rtype: COLLAB_SUBSCRIBE_RTYPE,
      op: 'event',
      key: sceneId,
      data: { sceneId },
    });
  }

  /** Owner side: a peer asked for a collab scene — authorize via the grant, then
   *  send the full snapshot. */
  private handleCollabSubscribe(from: string, env: SyncEnvelope): void {
    const sceneId = (env.data as { sceneId?: string })?.sceneId ?? env.key;
    if (
      !canAccess(
        from,
        `scene_node:${sceneId}`,
        'read',
        containmentIndex.isDescendant
      )
    )
      return;
    const row = getDb()
      .prepare('SELECT project_id FROM scene_nodes WHERE id = ?')
      .get(sceneId) as { project_id: string } | undefined;
    const snapshot = gatherSceneSnapshot(sceneId);
    if (!snapshot || !row) return;
    registerCollabScene(sceneId, from, 'author', row.project_id);
    indexCollabScene(sceneId);
    this.mesh?.sendEnvelope(from, {
      rtype: COLLAB_SNAPSHOT_RTYPE,
      op: 'event',
      key: sceneId,
      data: { sceneId, snapshot },
    });
  }

  /** Receiver side: fetch + persist the scene's assets, then persist the snapshot
   *  as a real scene + start syncing. */
  private async handleCollabSnapshot(
    from: string,
    env: SyncEnvelope
  ): Promise<void> {
    const d = (env.data ?? {}) as { sceneId?: string; snapshot?: ObjectSnapshot };
    const sceneId = d.sceneId ?? env.key;
    const projectId = this.pendingCollabMount.get(sceneId);
    if (!d.snapshot || !projectId) return;
    this.pendingCollabMount.delete(sceneId);
    // Transfer + persist the scene's assets (VRM models, textures, …) so the
    // mounted copy renders locally, rewriting node paths to the local files.
    if (this.blob)
      await persistCollabAssets(d.snapshot, projectId, (a) =>
        this.blob!.ensure(from, a)
      );
    mountSharedScene(d.snapshot, projectId, from);
    indexCollabScene(sceneId);
    // Tell our clients to reload scenes (the mount went straight to SQLite).
    this.broadcast('mp_collab_mounted', { peerId: from, sceneId, projectId });
  }

  /** Forward a live pose/blendshape/preview frame for a node — to object-share
   *  subscribers AND to collaborative-scene peers (called by the broadcast bus
   *  for every emitted frame, so the collab check is O(1) cache-only). */
  forwardStream(
    kind: string,
    nodeId: string,
    payload: Record<string, unknown>
  ): void {
    this.sharing?.forwardStream(kind, nodeId, payload);
    forwardCollabStream(kind, nodeId, payload, (peer, frame) =>
      this.mesh?.sendStream(peer, frame)
    );
  }

  /** Forward a clip-driven transform of a shared subtree node to object-share
   *  subscribers (read-only projections that can't evaluate the clip themselves).
   *  NOT sent to collaborative-scene peers: they have the synced clip + playback
   *  state and evaluate it locally, so forwarding the result would double-drive
   *  and fight their own evaluation. */
  forwardNodeTransform(
    nodeId: string,
    transform: Record<string, number>
  ): void {
    this.sharing?.forwardNodeTransform(nodeId, transform);
  }

  /** Owner: forward a runtime override on a shared scene node to subscribers. */
  forwardOverride(op: 'set' | 'clear', payload: Record<string, unknown>): void {
    this.sharing?.forwardOverride(op, payload);
  }

  /** Owner: forward a data-channel set/clear scoped to a shared node. */
  forwardDataChannel(
    op: 'set' | 'clear',
    payload: Record<string, unknown>
  ): void {
    this.sharing?.forwardDataChannel(op, payload);
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
