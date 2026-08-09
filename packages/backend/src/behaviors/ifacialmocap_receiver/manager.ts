import { BoneRotations, Blendshapes, mkEvent } from '@vspark/shared/signal';
import { udpSocketPool } from '../../vmc/udp_socket_pool.js';
import type { GraphDescriptor } from '@vspark/shared/signal';
import type { WSSync } from '../../ws/index.js';
import { SignalGraph } from '../../signal/engine.js';
import { NODE_REGISTRY } from '../../signal/registry.js';
import { initPoseBroadcast } from '../../signal/nodes/pose_broadcast.js';
import { initBlendshapesBroadcast } from '../../signal/nodes/blendshapes_broadcast.js';
import { OnPoseBroadcast } from '../../signal/nodes/on_pose_broadcast.js';
import { broadcastBus } from '../../broadcast/bus.js';
import { makeIFacialMocapGraphDescriptor, HEAD_CALIB_BONES } from './graph.js';
import {
  IFM_DEFAULT_PORT,
  IFM_HANDSHAKE,
  parseIFacialMocapPacket,
  type IFacialMocapAxisFlips,
} from './protocol.js';
import { getDb } from '../../db/index.js';
import { BehaviorKind } from '../decorator.js';

/** No packet for this long ⇒ the device stopped streaming. Matches the VMC receiver. */
const CONNECT_TIMEOUT_MS = 3000;
/** Summed frame-to-frame delta over the frame signature below which we call it "not tracking". */
const TRACKING_THRESHOLD = 0.01;
/** Handshake re-send cadence while the device is silent / already streaming. */
const HANDSHAKE_IDLE_MS = 1000;
const HANDSHAKE_KEEPALIVE_MS = 5000;
/** Manager tick — drives both the connect timeout and the handshake retry. */
const TICK_MS = 1000;

interface Receiver {
  /** Returned by udpSocketPool.subscribe — drops our listener and closes the
   *  shared socket if we were the last subscriber on that port. */
  unsubscribe: () => void;
  port: number;
  /** Address of the iOS device, or '' when the phone is configured to push to us. */
  deviceHost: string;
  lastSeen: number;
  /** Timestamp of the last handshake datagram we sent. */
  lastHandshake: number;
  connected: boolean;
  /** Previous frame signature for frame-diff tracking detection. */
  prevSignature: number[];
  /** null = not enough frames yet to determine. */
  trackingActive: boolean | null;
}

/**
 * iFacialMocap receiver — the ARKit-face sibling of `VmcManager`.
 *
 * Deliberately kept parallel to `behaviors/vmc_receiver/manager.ts`: same graph
 * lifecycle, same `_nodeState` persistence, same interceptor registration, same
 * `vmc_status` / `vmc_tracking_state` WebSocket surface, same broadcast-bus
 * slot semantics. The protocol-level differences are documented in
 * `protocol.ts` and in dev-notes/modules/component-managers.md.
 */
@BehaviorKind({
  kind: 'ifacialmocap_receiver',
  label: 'iFacialMocap Receiver',
  icon: '📱',
  description:
    'Receives ARKit face tracking from the iFacialMocap iOS app over UDP and drives head, eyes and blendshapes.',
  applicableTo: ['avatar'],
  defaultConfig: {
    deviceHost: '',
    port: IFM_DEFAULT_PORT,
    mirror: false,
    invertPitch: false,
    invertYaw: false,
    invertRoll: false,
  },
})
export class IFacialMocapManager {
  private readonly receivers = new Map<string, Receiver>();
  private readonly graphs = new Map<string, SignalGraph>();
  private readonly descriptors = new Map<string, GraphDescriptor>();
  private readonly behaviorConfigs = new Map<string, Record<string, unknown>>();
  private readonly behaviorNodeIds = new Map<string, string>();
  // Persistent node state: behaviorId → nodeId → state JSON
  private readonly nodeStates = new Map<string, Map<string, unknown>>();
  // Interceptor unregister callbacks: behaviorId → list of cleanup fns
  private readonly interceptorCleanups = new Map<string, Array<() => void>>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly ws: WSSync) {
    initPoseBroadcast(ws);
    initBlendshapesBroadcast(ws);
    this.timer = setInterval(() => this.tick(), TICK_MS);

    // Send current receiver state to any new WebSocket client (handles page refresh / new tabs).
    ws.onClientConnected((client) => {
      for (const [behaviorId, info] of this.receivers) {
        ws.sendTo(client, 'vmc_status', {
          behaviorId,
          connected: info.connected,
        });
        if (info.trackingActive !== null) {
          ws.sendTo(client, 'vmc_tracking_state', {
            behaviorId,
            tracking: info.trackingActive,
          });
        }
      }
    });
  }

  // ── graph management ───────────────────────────────────────────────────────

  private createGraph(behaviorId: string): SignalGraph {
    const descriptor = makeIFacialMocapGraphDescriptor(behaviorId);
    this.descriptors.set(behaviorId, descriptor);
    if (!this.nodeStates.has(behaviorId))
      this.nodeStates.set(behaviorId, new Map());
    const graph = SignalGraph.fromDescriptor(
      descriptor,
      NODE_REGISTRY,
      (nodeId) => this.getNodeConfig(behaviorId, nodeId),
      (nodeId) => this.nodeStates.get(behaviorId)?.get(nodeId) ?? {},
      (nodeId, state) => {
        this.nodeStates.get(behaviorId)!.set(nodeId, state);
        // Persist via DB so state survives restarts (stored alongside behavior).
        this.persistNodeState(behaviorId, nodeId, state);
      },
      // Behavior graphs are always attached to a scene node.
      'scene_node'
    );

    // Register any on_pose_broadcast nodes into the interceptor chain.
    const cleanups: Array<() => void> = [];
    for (const nodeDef of descriptor.nodes) {
      if (nodeDef.kind !== 'on_pose_broadcast') continue;
      const sceneNodeId = this.behaviorNodeIds.get(behaviorId) ?? '';
      const priority =
        (nodeDef.defaultConfig?.priority as number | undefined) ?? 1;
      const graphNodeId = nodeDef.id;
      cleanups.push(
        OnPoseBroadcast.register(
          sceneNodeId,
          graphNodeId,
          priority,
          (gNodeId, state) => graph.setNodeState(gNodeId, state),
          (gNodeId, port, value) => graph.fire(gNodeId, port, value)
        )
      );
    }
    this.interceptorCleanups.set(behaviorId, cleanups);

    return graph;
  }

  private persistNodeState(
    behaviorId: string,
    nodeId: string,
    state: unknown
  ): void {
    try {
      const existing = getDb()
        .prepare('SELECT config FROM behaviors WHERE id = ?')
        .get(behaviorId) as { config: string } | undefined;
      if (!existing) return;
      const db = getDb();
      const cfg = JSON.parse(existing.config || '{}') as Record<
        string,
        unknown
      >;
      const nodeStateMap = (cfg._nodeState ?? {}) as Record<string, unknown>;
      nodeStateMap[nodeId] = state;
      cfg._nodeState = nodeStateMap;
      db.prepare('UPDATE behaviors SET config = ? WHERE id = ?').run(
        JSON.stringify(cfg),
        behaviorId
      );
    } catch {
      /* non-fatal */
    }
  }

  private getNodeConfig(behaviorId: string, nodeId: string): unknown {
    const cfg = this.behaviorConfigs.get(behaviorId) ?? {};
    const sceneNodeId = this.behaviorNodeIds.get(behaviorId) ?? '';

    // Infrastructure nodes with non-config-derived values.
    switch (nodeId) {
      case 'comp_id':
        return { behaviorId };
      case 'scene_entity':
        return { nodeId: sceneNodeId };
      case 'head_calib':
        return { boneFilter: HEAD_CALIB_BONES };
    }

    const descriptor = this.descriptors.get(behaviorId);
    const nodeDef = descriptor?.nodes.find((n) => n.id === nodeId);
    const defaults = nodeDef?.defaultConfig ?? {};
    const overrides = ((
      cfg.nodeConfig as Record<string, unknown> | undefined
    )?.[nodeId] ?? {}) as Record<string, unknown>;

    // behavior_config nodes get the full live behavior config injected so they
    // can resolve arbitrary dot-notation field paths.
    if (nodeDef?.kind === 'behavior_config') {
      return { ...defaults, ...overrides, _behaviorConfig: cfg };
    }

    return { ...defaults, ...overrides };
  }

  fireGraphEvent(behaviorId: string, nodeId: string, port: string): void {
    const graph = this.graphs.get(behaviorId);
    if (!graph) return;
    graph.fire(nodeId, port, mkEvent(undefined));
  }

  /** The GraphDescriptor for a running receiver (for the graph editor). */
  getGraphDescriptor(behaviorId: string): GraphDescriptor | null {
    return this.descriptors.get(behaviorId) ?? null;
  }

  /** All active graph descriptors (for the graph list in the scene dock). */
  getAllGraphDescriptors(): GraphDescriptor[] {
    return [...this.descriptors.values()];
  }

  // ── receiver lifecycle ─────────────────────────────────────────────────────

  startReceiver(behaviorId: string, port: number, deviceHost = '') {
    const existing = this.receivers.get(behaviorId);
    if (existing?.port === port && existing.deviceHost === deviceHost) return;
    if (existing) this.stopReceiver(behaviorId);

    const graph = this.createGraph(behaviorId);
    this.graphs.set(behaviorId, graph);

    // Listener is captured here so we can store the unsubscribe handle on `info`
    // before defining the handler — info itself is referenced inside the handler.
    const info: Receiver = {
      unsubscribe: () => {}, // replaced after subscribe() returns
      port,
      deviceHost,
      lastSeen: 0,
      lastHandshake: 0,
      connected: false,
      prevSignature: [],
      trackingActive: null,
    };
    this.receivers.set(behaviorId, info);

    const onPacket = (
      buf: Buffer,
      rinfo: { address: string; port: number }
    ) => {
      const frame = parseIFacialMocapPacket(
        buf.toString('utf8'),
        this.axisFlips(behaviorId)
      );
      // Another behavior may share this port (the socket pool fans every packet
      // out to all subscribers). Anything we can't parse isn't ours.
      if (!frame) return;

      const wasConnected = info.connected;
      info.lastSeen = Date.now();

      if (!wasConnected) {
        info.connected = true;
        console.log(
          `[iFacialMocap] Device connected: ${rinfo.address}:${rinfo.port} → port ${port} (behavior ${behaviorId})`
        );
        this.ws.broadcast('vmc_status', {
          behaviorId,
          connected: true,
          remoteAddress: rinfo.address,
        });
      }

      // Tracking detection: same frame-delta approach as the VMC receiver's
      // /Body diff. The app keeps streaming the last values when it loses the
      // face, so silence alone is not enough to tell tracking from idling.
      if (info.prevSignature.length === frame.signature.length) {
        let diff = 0;
        for (let i = 0; i < frame.signature.length; i++)
          diff += Math.abs(frame.signature[i] - info.prevSignature[i]);
        this.setTracking(behaviorId, info, diff > TRACKING_THRESHOLD);
      }
      info.prevSignature = frame.signature;

      const ts = Date.now();

      if (Object.keys(frame.bones).length > 0) {
        graph.fire(
          'ifm',
          'bones',
          mkEvent(BoneRotations.fromRecord(frame.bones), ts)
        );
      }
      if (Object.keys(frame.arkit).length > 0) {
        graph.fire(
          'ifm',
          'arkit',
          mkEvent(Blendshapes.fromRecord(frame.arkit), ts)
        );
      }
    };

    info.unsubscribe = udpSocketPool.subscribe(port, onPacket, () => {
      console.log(
        `[iFacialMocap] Receiver attached to port ${port} (behavior ${behaviorId})`
      );
      // The socket is bound now — nudge the device straight away rather than
      // waiting up to a full tick for the retry.
      this.sendHandshake(info);
    });
  }

  stopReceiver(behaviorId: string) {
    const info = this.receivers.get(behaviorId);
    if (!info) return;
    info.unsubscribe();
    this.receivers.delete(behaviorId);
    this.graphs.delete(behaviorId);
    for (const cleanup of this.interceptorCleanups.get(behaviorId) ?? [])
      cleanup();
    this.interceptorCleanups.delete(behaviorId);
    broadcastBus.removeBehavior(behaviorId);
    if (info.connected)
      this.ws.broadcast('vmc_status', { behaviorId, connected: false });
    // Signal tracking loss on teardown, or every client keeps a stale
    // `tracking: true` forever (pinning avatars to their base animation).
    // Mirrors VmcManager.stopReceiver().
    if (info.trackingActive)
      this.ws.broadcast('vmc_tracking_state', {
        behaviorId,
        tracking: false,
      });
    console.log(`[iFacialMocap] Receiver stopped (behavior ${behaviorId})`);
  }

  syncBehaviors(
    comps: Array<{
      id: string;
      nodeId: string;
      kind: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }>
  ) {
    const active = new Set<string>();
    for (const c of comps) {
      if (c.kind !== 'ifacialmocap_receiver' || !c.enabled) continue;
      // Restore persisted node state from the config's _nodeState namespace.
      const savedStates = (c.config._nodeState ?? {}) as Record<
        string,
        unknown
      >;
      const stateMap = this.nodeStates.get(c.id) ?? new Map<string, unknown>();
      for (const [nid, st] of Object.entries(savedStates))
        stateMap.set(nid, st);
      this.nodeStates.set(c.id, stateMap);
      // Strip _nodeState from the live config so nodes don't see it.
      const { _nodeState: _removed, ...liveConfig } = c.config;
      this.behaviorConfigs.set(c.id, liveConfig);
      this.behaviorNodeIds.set(c.id, c.nodeId);
      const port = (c.config.port as number) ?? IFM_DEFAULT_PORT;
      const deviceHost = (c.config.deviceHost as string) ?? '';
      this.startReceiver(c.id, port, deviceHost);
      active.add(c.id);
    }
    for (const id of [...this.receivers.keys()]) {
      if (!active.has(id)) this.stopReceiver(id);
    }
    // Hot-apply config + nodeId updates to running receivers.
    for (const c of comps) {
      if (active.has(c.id)) {
        this.behaviorConfigs.set(c.id, c.config);
        this.behaviorNodeIds.set(c.id, c.nodeId);
      }
    }
  }

  /** Returns monitoring state for all nodes and edges in a graph. */
  getStates(
    behaviorId: string
  ): import('@vspark/shared/signal').GraphStateSnapshot | null {
    return this.graphs.get(behaviorId)?.getStates() ?? null;
  }

  // ── device handshake + timeouts ────────────────────────────────────────────

  private axisFlips(behaviorId: string): IFacialMocapAxisFlips {
    const cfg = this.behaviorConfigs.get(behaviorId) ?? {};
    return {
      invertPitch: cfg.invertPitch === true,
      invertYaw: cfg.invertYaw === true,
      invertRoll: cfg.invertRoll === true,
    };
  }

  /**
   * Ask the device to (keep) streaming. iFacialMocap only sends once it has been
   * handshaked, and it must come from the port we listen on — hence the shared
   * socket pool's `send`. A no-op when the user hasn't given us a device address
   * (the app can also be pointed at this machine from the phone side).
   */
  private sendHandshake(info: Receiver): void {
    if (!info.deviceHost) return;
    const sent = udpSocketPool.send(
      info.port,
      Buffer.from(IFM_HANDSHAKE, 'utf8'),
      info.deviceHost,
      info.port
    );
    if (sent) info.lastHandshake = Date.now();
  }

  private setTracking(
    behaviorId: string,
    info: Receiver,
    nowTracking: boolean
  ): void {
    if (nowTracking === info.trackingActive) return;
    info.trackingActive = nowTracking;
    console.log(
      `[iFacialMocap] Tracking ${nowTracking ? 'ACTIVE' : 'LOST'} (behavior ${behaviorId})`
    );
    this.ws.broadcast('vmc_tracking_state', {
      behaviorId,
      tracking: nowTracking,
    });
    // Drop our bus slot on tracking loss so the merge falls back to other
    // producers (or the additive-identity fallback frame if we were the only
    // one). Resume is automatic — the next publishBones re-creates it.
    if (!nowTracking) broadcastBus.removeBehavior(behaviorId);
  }

  private tick() {
    const now = Date.now();
    for (const [behaviorId, info] of this.receivers) {
      if (info.connected && now - info.lastSeen > CONNECT_TIMEOUT_MS) {
        info.connected = false;
        console.log(`[iFacialMocap] Device timed out (behavior ${behaviorId})`);
        this.ws.broadcast('vmc_status', { behaviorId, connected: false });
        // Unlike VMC — where loss is inferred from packet deltas that stop
        // arriving — a silent device here means the app was closed or the phone
        // slept, so drop tracking too instead of leaving it latched on.
        if (info.trackingActive) this.setTracking(behaviorId, info, false);
        info.prevSignature = [];
      }
      const due = info.connected ? HANDSHAKE_KEEPALIVE_MS : HANDSHAKE_IDLE_MS;
      if (now - info.lastHandshake >= due) this.sendHandshake(info);
    }
  }

  close() {
    clearInterval(this.timer);
    for (const id of [...this.receivers.keys()]) this.stopReceiver(id);
  }
}
