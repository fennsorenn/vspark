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
import { getMeshPeer, mirrorIntoMesh } from '../mesh/index.js';
import { syncCollabLinks } from '../mesh/collab.js';
import {
  subscribeSharedObject,
  unsubscribeSharedObject,
} from '../mesh/shares.js';
import { publishNodeStream } from '../mesh/streams.js';
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
  indexCollabNode,
  mountSharedScene,
  collabSceneForNode,
  forwardClipPlayback,
  forwardCollabRuntime,
  persistCollabAssets,
  indexAllCollabScenes,
  listAllCollabScenes,
  type CollabLink,
  collabPeersForScene,
  COLLAB_SUBSCRIBE_RTYPE,
  COLLAB_SNAPSHOT_RTYPE,
  COLLAB_PLAYBACK_RTYPE,
  COLLAB_RUNTIME_RTYPE,
  type ClipPlaybackAction,
} from './collabScene.js';
import { _trackClipPlayback } from '../routes/shared.js';
import { dataChannelManager } from '../data_channels/manager.js';
import { runtimeOverrideManager } from '../runtime_overrides/manager.js';
import { spawnManager } from '../spawn/manager.js';
import type { ParamTargetKind } from '@vspark/shared/paramPaths';
import { BlobManager, BLOB_RTYPES } from './blobTransfer.js';
import type { AssetMeta } from './blobs.js';
import {
  clientMeshRelay,
  MESH_RELAY_RTYPE,
  MESH_ROSTER_RTYPE,
} from './clientMeshRelay.js';
import {
  addShare,
  removeShare,
  listObjectGrantees,
  listSharedByMe,
  type SharedByMe,
} from './shares.js';
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

/** Runtime WS broadcast kinds that have NO sync.document / stream mesh path and
 *  must be mirrored to collab peers verbatim: Set Data bus, runtime overrides,
 *  media control, and the ephemeral entities/clips a Spawn node produces (regular
 *  node/clip CRUD goes through sync.document, so those kinds are excluded to avoid
 *  double-forwarding). Clip play frames are handled per-clip in the relay. */
const COLLAB_RELAY_KINDS = new Set<string>([
  'data_channel_set',
  'data_channel_clear',
  'runtime_override_set',
  'runtime_override_clear',
  'media_control',
  'node_added',
  'node_removed',
  'compose_layer_added',
  'compose_layer_removed',
  'track_clip_added',
  'track_clip_removed',
]);

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
  /** Guard: while applying a peer's relayed runtime broadcast, don't re-relay it. */
  private applyingCollabRuntime = false;
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
    // Document fan-out (collab AND object-share) rides the @vspark/mesh peer:
    // the legacy bridge in backend/src/mesh mirrors every sync.document op
    // into it, and subscriptions (collab links / placed objects) route it.
    sync.onDocument((env) => {
      // Keep the collab stream-routing map (nodeScene) current for nodes
      // added after mount — pose/preview streams to collab peers still ride
      // the legacy lossy channel and route through it.
      if (env.rtype === 'scene_node' && env.op === 'upsert') {
        const root = (env.data as { rootSceneNodeId?: string } | undefined)
          ?.rootSceneNodeId;
        if (root) indexCollabNode(env.key, root);
      }
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
    // Collab-scene frames now arrive over the mesh preview channel (bridged
    // to /ws in mesh/streams.ts); only the object-share stream remains here.
    this.mesh.on(
      'streamFrame',
      ({ from, frame }: { from: string; frame: Record<string, unknown> }) => {
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
        } else if (env?.rtype === COLLAB_SUBSCRIBE_RTYPE) {
          this.handleCollabSubscribe(from, env);
        } else if (env?.rtype === COLLAB_SNAPSHOT_RTYPE) {
          void this.handleCollabSnapshot(from, env);
        } else if (env?.rtype === COLLAB_PLAYBACK_RTYPE) {
          // A collab peer's clip play/pause/seek — replicate on our own playback
          // manager (which has the synced clip), anchored to our local clock.
          const d = (env.data ?? {}) as {
            clipId?: string;
            action?: ClipPlaybackAction;
            t?: number;
          };
          if (d.clipId && d.action)
            this.applyClipPlayback(d.clipId, d.action, d.t);
        } else if (env?.rtype === COLLAB_RUNTIME_RTYPE) {
          // A collab peer's runtime broadcast (Set Data, override, spawn, media).
          const d = (env.data ?? {}) as {
            kind?: string;
            payload?: Record<string, unknown>;
          };
          if (d.kind && d.payload) this.applyCollabRuntime(d.kind, d.payload);
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

  /** The WebRTC server mesh (null until init). The new @vspark/mesh peer rides
   *  it via ServerMeshTransport during the parallel-run. */
  getServerMesh(): ServerMesh | null {
    return this.mesh;
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

  /** Stop sharing an object with everyone (Connections-window unshare button). */
  unshareAll(objectId: string): void {
    for (const grantee of listObjectGrantees(objectId))
      this.unshare(objectId, grantee);
  }

  /** Everything this server currently shares with others. */
  sharedByMe(): SharedByMe[] {
    return listSharedByMe();
  }

  /** Every collab-scene link (for the scene-graph chain badge). */
  collabScenes(): CollabLink[] {
    return listAllCollabScenes();
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
    // Mesh: standing RUCD grant + mutual subscription for the new link.
    const mp = getMeshPeer();
    if (mp) syncCollabLinks(mp);
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
    {
      const mp = getMeshPeer();
      if (mp) syncCollabLinks(mp);
    }
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
    // Mesh: mirror the mounted (localized) rows into the replica with their
    // row-derived stamps — old stamps, so the mirror can't out-stamp the
    // author's live state — then grant the owner back + subscribe (live ops
    // + reconciles ride the mesh; this legacy snapshot path remains for
    // asset transfer).
    for (const n of d.snapshot.nodes ?? [])
      mirrorIntoMesh('scene_node', (n as { id: string }).id);
    for (const c of d.snapshot.clips ?? [])
      mirrorIntoMesh('track_clip', (c as { id: string }).id);
    for (const e of d.snapshot.cameraEffects ?? [])
      mirrorIntoMesh('camera_effect', (e as { id: string }).id);
    {
      const mp = getMeshPeer();
      if (mp) syncCollabLinks(mp);
    }
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
    // Collab-scene frames ride the mesh preview channel (mesh/streams.ts);
    // the existing '*'-subtree collab subscriptions route them by node id.
    if (collabSceneForNode(nodeId)) publishNodeStream(nodeId, kind, payload);
  }

  /** Relay a local clip playback control to collab peers (called by the playback
   *  routes). The peer replicates it on its own playback manager. */
  relayClipPlayback(
    clipId: string,
    action: ClipPlaybackAction,
    t?: number
  ): void {
    forwardClipPlayback(clipId, action, t, (peer, env) =>
      this.mesh?.sendEnvelope(peer, env)
    );
  }

  /** Replicate a peer's clip playback control locally (no re-forward — only
   *  user-initiated route actions relay, so this can't echo). */
  private applyClipPlayback(
    clipId: string,
    action: ClipPlaybackAction,
    t?: number
  ): void {
    const pb = _trackClipPlayback;
    if (!pb) return;
    if (action === 'trigger') pb.trigger(clipId);
    else if (action === 'stop') pb.stop(clipId);
    else if (action === 'pause') pb.pause(clipId);
    else if (action === 'resume') pb.resume(clipId);
    else if (action === 'seek' && t != null) pb.seek(clipId, t);
  }

  /** Tap on every local WS broadcast (set via wsSync.setCollabRelay): mirror the
   *  runtime kinds that have no other mesh path to collab peers. Regular clip play
   *  frames are relayed (re-anchored) via relayClipPlayback, so here we relay
   *  track_clip play frames only for ephemeral spawn clips (the receiver has just
   *  the clone). The echo guard stops a re-applied broadcast bouncing back. */
  relayCollabRuntime(kind: string, payload: Record<string, unknown>): void {
    if (this.applyingCollabRuntime || !this.mesh) return;
    if (
      kind === 'track_clip_started' ||
      kind === 'track_clip_paused' ||
      kind === 'track_clip_stopped'
    ) {
      const clipId = (payload.clipId ?? payload.id) as string | undefined;
      if (!clipId || !spawnManager.isEphemeralClip(clipId)) return;
    } else if (!COLLAB_RELAY_KINDS.has(kind)) {
      return;
    }
    forwardCollabRuntime(kind, payload, (peer, env) =>
      this.mesh?.sendEnvelope(peer, env)
    );
  }

  /** Apply a peer's relayed runtime broadcast. Data channels + overrides go
   *  through their managers (so the bus/override state — and reconnect snapshots —
   *  stay consistent); everything else (media, spawned entities/clips/play) is
   *  re-broadcast to our own clients. Guarded so it can't bounce back. */
  private applyCollabRuntime(
    kind: string,
    payload: Record<string, unknown>
  ): void {
    this.applyingCollabRuntime = true;
    try {
      if (kind === 'data_channel_set') {
        dataChannelManager.set(
          payload.scope as string,
          (payload.fields ?? {}) as Record<string, unknown>
        );
      } else if (kind === 'data_channel_clear') {
        dataChannelManager.clear(
          payload.scope as string,
          payload.field as string | undefined
        );
      } else if (kind === 'runtime_override_set') {
        runtimeOverrideManager.set(
          payload.targetKind as ParamTargetKind,
          payload.targetId as string,
          payload.paramPath as string,
          payload.value
        );
      } else if (kind === 'runtime_override_clear') {
        runtimeOverrideManager.clear(
          payload.targetKind as ParamTargetKind,
          payload.targetId as string,
          payload.paramPath as string | undefined
        );
      } else {
        this.broadcast(kind, payload);
      }
    } finally {
      this.applyingCollabRuntime = false;
    }
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

  /** Receiver: (un)subscribe to a peer's shared object (frontend wrapper
   *  place/remove). The document plane always rides a one-way mesh
   *  subscription (snapshot + live ops → our replica → our tabs). The legacy
   *  `_share_subscribe` is sent only when this server should ALSO relay
   *  streams + localized assets (`streams=false` when the browser holds a
   *  direct edge to the owner and serves those itself). */
  subscribeShared(peerId: string, objectId: string, streams = true): void {
    subscribeSharedObject(peerId, objectId);
    if (streams) this.sharing?.subscribe(peerId, objectId);
  }
  unsubscribeShared(peerId: string, objectId: string): void {
    unsubscribeSharedObject(peerId, objectId);
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
