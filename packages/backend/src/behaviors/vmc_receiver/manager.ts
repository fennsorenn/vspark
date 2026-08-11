import { BoneRotations, Blendshapes, mkEvent } from '@vspark/shared/signal';
import { udpSocketPool } from '../../vmc/udp_socket_pool.js';
import { ARKIT_SHAPES } from '../../signal/nodes/arkit_vrm_mapper.js';
import type { NormalizedPose, GraphDescriptor } from '@vspark/shared/signal';
import type { WSSync } from '../../ws/index.js';
import { SignalGraph } from '../../signal/engine.js';
import { NODE_REGISTRY } from '../../signal/registry.js';
import { initPoseBroadcast } from '../../signal/nodes/pose_broadcast.js';
import { initBlendshapesBroadcast } from '../../signal/nodes/blendshapes_broadcast.js';
import { OnPoseBroadcast } from '../../signal/nodes/on_pose_broadcast.js';
import { broadcastBus } from '../../broadcast/bus.js';
import { makeVmcGraphDescriptor, HEAD_CALIB_BONES } from './graph.js';
import { loadVrmSkeleton } from '../../vrm/skeleton.js';
import type { VrmSkeletonData } from '../../vrm/skeleton.js';
import { join } from 'path';
import { getDb } from '../../db/index.js';
import { BehaviorKind } from '../decorator.js';
import { trackingGraceMs } from '../tracking_grace.js';

// ---------- Minimal OSC parser ----------

type OscArg = string | number;
interface OscMsg {
  address: string;
  args: OscArg[];
}

function readOscString(buf: Buffer, off: number): [string, number] {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return [
    buf.toString('utf8', off, end),
    off + Math.ceil((end - off + 1) / 4) * 4,
  ];
}

function parseMsg(buf: Buffer, off: number): [OscMsg | null, number] {
  try {
    if (buf[off] !== 0x2f) return [null, off];
    const [address, off1] = readOscString(buf, off);
    const [typeTags, off2] = readOscString(buf, off1);
    let cur = off2;
    const args: OscArg[] = [];
    for (let i = 1; i < typeTags.length; i++) {
      switch (typeTags[i]) {
        case 'f':
          args.push(buf.readFloatBE(cur));
          cur += 4;
          break;
        case 'i':
          args.push(buf.readInt32BE(cur));
          cur += 4;
          break;
        case 'd':
          args.push(buf.readDoubleBE(cur));
          cur += 8;
          break;
        case 'h':
          cur += 8;
          break; // int64 — skip, not representable
        case 'b':
          cur += 4 + Math.ceil(buf.readUInt32BE(cur) / 4) * 4;
          break; // blob — skip
        case 's': {
          const [s, next] = readOscString(buf, cur);
          args.push(s);
          cur = next;
          break;
        }
        case 'T':
          args.push(1);
          break;
        case 'F':
          args.push(0);
          break;
        case 'N':
          break;
        default:
          // Unknown type tag — we can't know the size, so bail on this message only.
          console.warn(
            `[VMC] Unknown OSC type tag '${typeTags[i]}' in ${address}, skipping message`
          );
          return [null, off];
      }
    }
    return [{ address, args }, cur];
  } catch {
    return [null, off];
  }
}

function parsePacket(buf: Buffer): OscMsg[] {
  const msgs: OscMsg[] = [];
  if (buf.length >= 16 && buf.toString('utf8', 0, 8) === '#bundle\0') {
    let off = 16;
    while (off + 4 <= buf.length) {
      const size = buf.readUInt32BE(off);
      off += 4;
      if (size === 0 || off + size > buf.length) break;
      const [msg] = parseMsg(buf, off);
      if (msg) msgs.push(msg);
      off += size;
    }
    return msgs;
  }
  let off = 0;
  while (off < buf.length) {
    const [msg, next] = parseMsg(buf, off);
    if (!msg || next <= off) break;
    msgs.push(msg);
    off = next;
  }
  return msgs;
}

// RhyLive /Body bone order = Unity HumanBodyBones enum (0..54)
const RHYLIVE_BONES = [
  'Hips',
  'LeftUpperLeg',
  'RightUpperLeg',
  'LeftLowerLeg',
  'RightLowerLeg', // 0-4
  'LeftFoot',
  'RightFoot',
  'Spine',
  'Chest',
  'Neck',
  'Head', // 5-10
  'LeftShoulder',
  'RightShoulder',
  'LeftUpperArm',
  'RightUpperArm', // 11-14
  'LeftLowerArm',
  'RightLowerArm',
  'LeftHand',
  'RightHand', // 15-18
  'LeftToes',
  'RightToes',
  'LeftEye',
  'RightEye',
  'Jaw', // 19-23
  'LeftThumbProximal',
  'LeftThumbIntermediate',
  'LeftThumbDistal', // 24-26
  'LeftIndexProximal',
  'LeftIndexIntermediate',
  'LeftIndexDistal', // 27-29
  'LeftMiddleProximal',
  'LeftMiddleIntermediate',
  'LeftMiddleDistal', // 30-32
  'LeftRingProximal',
  'LeftRingIntermediate',
  'LeftRingDistal', // 33-35
  'LeftLittleProximal',
  'LeftLittleIntermediate',
  'LeftLittleDistal', // 36-38
  'RightThumbProximal',
  'RightThumbIntermediate',
  'RightThumbDistal', // 39-41
  'RightIndexProximal',
  'RightIndexIntermediate',
  'RightIndexDistal', // 42-44
  'RightMiddleProximal',
  'RightMiddleIntermediate',
  'RightMiddleDistal', // 45-47
  'RightRingProximal',
  'RightRingIntermediate',
  'RightRingDistal', // 48-50
  'RightLittleProximal',
  'RightLittleIntermediate',
  'RightLittleDistal', // 51-53
  'UpperChest', // 54
];

// ---------- Receiver ----------

interface Receiver {
  /** Returned by udpSocketPool.subscribe — drops our listener and closes the
   *  shared socket if we were the last subscriber on that port. */
  unsubscribe: () => void;
  port: number;
  lastSeen: number;
  connected: boolean;
  /** Previous /Body float array for frame-diff tracking detection. */
  prevBodyArgs: number[];
  /** null = not enough frames yet to determine. */
  trackingActive: boolean | null;
  /** Timestamp the current tracking-loss candidate started, or null when the
   *  signal is live. Set the moment motion stops (frame diff under threshold)
   *  or packets stop arriving; cleared by any real movement. `tracking: false`
   *  is only broadcast once this has stood for the behavior's grace period, so
   *  a brief dropout no longer snaps the avatar to idle. See `checkTimeouts`. */
  quietSince: number | null;
}

@BehaviorKind({
  kind: 'vmc_receiver',
  label: 'VMC Receiver',
  icon: '📡',
  description:
    'Receives motion capture data from RhyLive or any VMC-compatible app over UDP.',
  applicableTo: ['any'],
  defaultConfig: { host: '0.0.0.0', port: 39539, mirror: false },
})
export class VmcManager {
  private readonly receivers = new Map<string, Receiver>();
  private readonly graphs = new Map<string, SignalGraph>();
  private readonly descriptors = new Map<string, GraphDescriptor>();
  private readonly behaviorConfigs = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly behaviorNodeIds = new Map<string, string>();
  private readonly behaviorSkeletons = new Map<
    string,
    VrmSkeletonData | null
  >();
  // Persistent node state: behaviorId → nodeId → state JSON
  private readonly nodeStates = new Map<string, Map<string, unknown>>();
  // Interceptor unregister callbacks: behaviorId → list of cleanup fns
  private readonly interceptorCleanups = new Map<string, Array<() => void>>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly ws: WSSync) {
    initPoseBroadcast(ws);
    initBlendshapesBroadcast(ws);
    // 250ms, not 2s: the sweep now also resolves the tracking grace period, whose
    // configured window starts at 0.1s. A 2s tick would round every short "Idle
    // after" setting up to its own period.
    this.timer = setInterval(() => this.checkTimeouts(), 250);

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
    const descriptor = makeVmcGraphDescriptor(behaviorId);
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
        // Persist via DB so state survives restarts (stored alongside component).
        this.persistNodeState(behaviorId, nodeId, state);
      },
      // Component graphs are always attached to a scene node.
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
    const nodeId_ = this.behaviorNodeIds.get(behaviorId) ?? '';

    // Infrastructure nodes with non-config-derived values.
    switch (nodeId) {
      case 'comp_id':
        return { behaviorId };
      case 'scene_entity':
        return { nodeId: nodeId_ };
      case 'head_calib':
        return { boneFilter: HEAD_CALIB_BONES };
      case 'arm_ik_calib':
        return {
          skeleton: this.behaviorSkeletons.get(behaviorId) ?? undefined,
        };
    }

    const descriptor = this.descriptors.get(behaviorId);
    const nodeDef = descriptor?.nodes.find((n) => n.id === nodeId);
    const defaults = nodeDef?.defaultConfig ?? {};
    const overrides = ((
      cfg.nodeConfig as Record<string, unknown> | undefined
    )?.[nodeId] ?? {}) as Record<string, unknown>;

    // behavior_config nodes get the full live component config injected so they
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

  /** The GraphDescriptor for a running VMC receiver (for the graph editor). */
  getGraphDescriptor(behaviorId: string): GraphDescriptor | null {
    return this.descriptors.get(behaviorId) ?? null;
  }

  /** All active VMC graph descriptors (for the graph list in the scene dock). */
  getAllGraphDescriptors(): GraphDescriptor[] {
    return [...this.descriptors.values()];
  }

  /** Returns the uncalibrated NormalizedPose at the head_calib input (last pulled value). */
  peekBodyCalibInput(behaviorId: string): NormalizedPose | null {
    const graph = this.graphs.get(behaviorId);
    if (!graph) return null;
    return graph.peekInput('head_calib', 'pose') as NormalizedPose | null;
  }

  /**
   * Grace period (ms) before a tracking dropout is reported as a loss, read from
   * the avatar node's `trackingGracePeriod` property.
   *
   * Both loss paths share it: motion going still and packets going away. Without
   * it a single repeated /Body packet flipped tracking off immediately, which
   * snapped the avatar into idle on every momentary dropout.
   */
  private graceMs(behaviorId: string): number {
    return trackingGraceMs(this.behaviorNodeIds.get(behaviorId));
  }

  /**
   * Broadcast a tracking-state transition, collapsing no-op repeats.
   * Both loss paths and the movement-resume path funnel through here so the
   * bus-slot teardown stays paired with the transition that caused it.
   */
  private setTracking(behaviorId: string, tracking: boolean) {
    const info = this.receivers.get(behaviorId);
    if (!info || info.trackingActive === tracking) return;
    info.trackingActive = tracking;
    console.log(
      `[VMC] Tracking ${tracking ? 'ACTIVE' : 'LOST'} (component ${behaviorId})`
    );
    this.ws.broadcast('vmc_tracking_state', { behaviorId, tracking });
    // Drop our bus slot on tracking loss so the merge falls back to other
    // producers (or the additive-identity fallback frame if we were the
    // only one). Resume is automatic — the next publishBones re-creates it.
    if (!tracking) broadcastBus.removeBehavior(behaviorId);
  }

  // ── receiver lifecycle ─────────────────────────────────────────────────────

  startReceiver(behaviorId: string, port: number) {
    const existing = this.receivers.get(behaviorId);
    if (existing?.port === port) return;
    if (existing) this.stopReceiver(behaviorId);

    const graph = this.createGraph(behaviorId);
    this.graphs.set(behaviorId, graph);

    // Listener is captured here so we can store the unsubscribe handle on `info`
    // before defining the handler — info itself is referenced inside the handler.
    const info: Receiver = {
      unsubscribe: () => {}, // replaced after subscribe() returns
      port,
      lastSeen: 0,
      connected: false,
      prevBodyArgs: [],
      trackingActive: null,
      quietSince: null,
    };
    this.receivers.set(behaviorId, info);

    const onPacket = (
      buf: Buffer,
      rinfo: { address: string; port: number }
    ) => {
      const wasConnected = info.connected;
      info.lastSeen = Date.now();

      if (!wasConnected) {
        info.connected = true;
        console.log(
          `[VMC] Client connected: ${rinfo.address}:${rinfo.port} → port ${port} (component ${behaviorId})`
        );
        this.ws.broadcast('vmc_status', {
          behaviorId,
          connected: true,
          remoteAddress: rinfo.address,
        });
      }

      const msgs = parsePacket(buf);
      const rawBones: Record<string, [number, number, number, number]> = {};
      const rawArkit: Record<string, number> = {};

      for (const msg of msgs) {
        if (msg.address === '/VMC/Ext/Bone/Pos' && msg.args.length >= 8) {
          const name = msg.args[0] as string;
          rawBones[name] = [
            msg.args[4] as number,
            msg.args[5] as number,
            msg.args[6] as number,
            msg.args[7] as number,
          ];
        } else if (msg.address === '/Body' && msg.args.length >= 220) {
          const TRACKING_THRESHOLD = 0.001;
          const cur = msg.args as number[];
          if (info.prevBodyArgs.length === cur.length) {
            let diff = 0;
            for (let i = 0; i < cur.length; i++)
              diff += Math.abs(cur[i] - info.prevBodyArgs[i]);
            // Movement resumes tracking immediately; going still only *starts*
            // the grace period. The actual loss is declared in checkTimeouts once
            // `quietSince` has stood for the configured window — a repeated packet
            // or two no longer counts as a loss.
            if (diff > TRACKING_THRESHOLD) {
              info.quietSince = null;
              this.setTracking(behaviorId, true);
            } else if (info.quietSince === null) {
              info.quietSince = Date.now();
            }
          }
          info.prevBodyArgs = cur.slice();
          for (let i = 0; i < RHYLIVE_BONES.length; i++) {
            rawBones[RHYLIVE_BONES[i]] = [
              msg.args[i * 4] as number,
              msg.args[i * 4 + 1] as number,
              msg.args[i * 4 + 2] as number,
              msg.args[i * 4 + 3] as number,
            ];
          }
        } else if (msg.address === '/Face' && msg.args.length >= 52) {
          for (let i = 0; i < ARKIT_SHAPES.length && i < msg.args.length; i++) {
            rawArkit[ARKIT_SHAPES[i]] = msg.args[i] as number;
          }
        }
      }

      const ts = Date.now();

      if (Object.keys(rawBones).length > 0) {
        graph.fire(
          'vmc',
          'bones',
          mkEvent(BoneRotations.fromRecord(rawBones), ts)
        );
      }
      if (Object.keys(rawArkit).length > 0) {
        graph.fire(
          'vmc',
          'arkit',
          mkEvent(Blendshapes.fromRecord(rawArkit), ts)
        );
      }
    };

    info.unsubscribe = udpSocketPool.subscribe(port, onPacket, () => {
      console.log(
        `[VMC] Receiver attached to port ${port} (component ${behaviorId})`
      );
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
    // Signal tracking loss on teardown. Tracking-false is otherwise only emitted
    // from the /Body handler, which needs packets still arriving — disabling the
    // source stops them, so the transition would never fire and every client
    // would keep a stale `tracking: true` forever (pinning avatars to their base
    // animation, unreachable idle). Mirrors MediaPipeTrackerManager.stop().
    if (info.trackingActive)
      this.ws.broadcast('vmc_tracking_state', {
        behaviorId,
        tracking: false,
      });
    console.log(`[VMC] Receiver stopped (component ${behaviorId})`);
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
      if (c.kind !== 'vmc_receiver' || !c.enabled) continue;
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
      this._loadSkeletonForBehavior(c.id, c.nodeId);
      const port = (c.config.port as number) ?? 39539;
      this.startReceiver(c.id, port);
      active.add(c.id);
    }
    for (const id of this.receivers.keys()) {
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

  private _loadSkeletonForBehavior(
    behaviorId: string,
    sceneNodeId: string
  ): void {
    if (this.behaviorSkeletons.has(behaviorId)) return; // already loaded
    try {
      const row = getDb()
        .prepare('SELECT file_path FROM scene_nodes WHERE id = ?')
        .get(sceneNodeId) as { file_path: string | null } | undefined;
      const filePath = row?.file_path;
      if (!filePath) {
        this.behaviorSkeletons.set(behaviorId, null);
        return;
      }
      const absPath = join(process.cwd(), filePath);
      const skeleton = loadVrmSkeleton(absPath);
      this.behaviorSkeletons.set(behaviorId, skeleton);
      console.log(
        `[VmcManager] Loaded VRM skeleton for component ${behaviorId}: ${Object.keys(skeleton).length} bones`
      );
    } catch (err) {
      console.warn(
        `[VmcManager] Could not load VRM skeleton for ${behaviorId}:`,
        (err as Error).message
      );
      this.behaviorSkeletons.set(behaviorId, null);
    }
  }

  /** Returns monitoring state for all nodes and edges in a graph. */
  getStates(
    behaviorId: string
  ): import('@vspark/shared/signal').GraphStateSnapshot | null {
    return this.graphs.get(behaviorId)?.getStates() ?? null;
  }

  private checkTimeouts() {
    const now = Date.now();
    for (const [behaviorId, info] of this.receivers) {
      // Connection status (the status dot) keeps its own fixed window — "is the
      // source reachable" is a different question from "is it tracking", and the
      // dot should not start lying because someone set a long grace period.
      if (info.connected && now - info.lastSeen > 3000) {
        info.connected = false;
        console.log(`[VMC] Client timed out (component ${behaviorId})`);
        this.ws.broadcast('vmc_status', { behaviorId, connected: false });
      }

      // Both loss paths resolve here, on one clock. The signal counts as alive
      // until BOTH have gone quiet: the last movement (`quietSince`, set by the
      // /Body frame-diff) and the last packet (`lastSeen`). Taking the earlier of
      // the two means whichever dropout started first drives the window, so a
      // source that freezes and then disconnects doesn't restart its grace period
      // on the disconnect.
      //
      // Loss path 2 used to fire `vmc_status` only, leaving `trackingActive` stuck
      // true and clients relying on their own hardcoded watchdog to reach idle.
      // `trackingActive !== true` covers both already-lost and never-tracked
      // (null): a receiver that never latched on has no loss to report, and
      // announcing one would contradict the connect-time snapshot, which skips
      // null for exactly that reason.
      if (info.trackingActive !== true || info.lastSeen === 0) continue;
      const quietSince = Math.min(info.quietSince ?? now, info.lastSeen);
      if (now - quietSince > this.graceMs(behaviorId))
        this.setTracking(behaviorId, false);
    }
  }

  close() {
    clearInterval(this.timer);
    for (const id of [...this.receivers.keys()]) this.stopReceiver(id);
  }
}
