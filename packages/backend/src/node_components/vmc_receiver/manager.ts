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
  private readonly componentConfigs = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly componentNodeIds = new Map<string, string>();
  private readonly componentSkeletons = new Map<
    string,
    VrmSkeletonData | null
  >();
  // Persistent node state: componentId → nodeId → state JSON
  private readonly nodeStates = new Map<string, Map<string, unknown>>();
  // Interceptor unregister callbacks: componentId → list of cleanup fns
  private readonly interceptorCleanups = new Map<string, Array<() => void>>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly ws: WSSync) {
    initPoseBroadcast(ws);
    initBlendshapesBroadcast(ws);
    this.timer = setInterval(() => this.checkTimeouts(), 2000);

    // Send current receiver state to any new WebSocket client (handles page refresh / new tabs).
    ws.onClientConnected((client) => {
      for (const [componentId, info] of this.receivers) {
        ws.sendTo(client, 'vmc_status', {
          componentId,
          connected: info.connected,
        });
        if (info.trackingActive !== null) {
          ws.sendTo(client, 'vmc_tracking_state', {
            componentId,
            tracking: info.trackingActive,
          });
        }
      }
    });
  }

  // ── graph management ───────────────────────────────────────────────────────

  private createGraph(componentId: string): SignalGraph {
    const descriptor = makeVmcGraphDescriptor(componentId);
    this.descriptors.set(componentId, descriptor);
    if (!this.nodeStates.has(componentId))
      this.nodeStates.set(componentId, new Map());
    const graph = SignalGraph.fromDescriptor(
      descriptor,
      NODE_REGISTRY,
      (nodeId) => this.getNodeConfig(componentId, nodeId),
      (nodeId) => this.nodeStates.get(componentId)?.get(nodeId) ?? {},
      (nodeId, state) => {
        this.nodeStates.get(componentId)!.set(nodeId, state);
        // Persist via DB so state survives restarts (stored alongside component).
        this.persistNodeState(componentId, nodeId, state);
      },
      // Component graphs are always attached to a scene node.
      'scene_node'
    );

    // Register any on_pose_broadcast nodes into the interceptor chain.
    const cleanups: Array<() => void> = [];
    for (const nodeDef of descriptor.nodes) {
      if (nodeDef.kind !== 'on_pose_broadcast') continue;
      const sceneNodeId = this.componentNodeIds.get(componentId) ?? '';
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
    this.interceptorCleanups.set(componentId, cleanups);

    return graph;
  }

  private persistNodeState(
    componentId: string,
    nodeId: string,
    state: unknown
  ): void {
    try {
      const existing = getDb()
        .prepare('SELECT config FROM node_components WHERE id = ?')
        .get(componentId) as { config: string } | undefined;
      if (!existing) return;
      const db = getDb();
      const cfg = JSON.parse(existing.config || '{}') as Record<
        string,
        unknown
      >;
      const nodeStateMap = (cfg._nodeState ?? {}) as Record<string, unknown>;
      nodeStateMap[nodeId] = state;
      cfg._nodeState = nodeStateMap;
      db.prepare('UPDATE node_components SET config = ? WHERE id = ?').run(
        JSON.stringify(cfg),
        componentId
      );
    } catch {
      /* non-fatal */
    }
  }

  private getNodeConfig(componentId: string, nodeId: string): unknown {
    const cfg = this.componentConfigs.get(componentId) ?? {};
    const nodeId_ = this.componentNodeIds.get(componentId) ?? '';

    // Infrastructure nodes with non-config-derived values.
    switch (nodeId) {
      case 'comp_id':
        return { componentId };
      case 'scene_entity':
        return { nodeId: nodeId_ };
      case 'head_calib':
        return { boneFilter: HEAD_CALIB_BONES };
      case 'arm_ik_calib':
        return {
          skeleton: this.componentSkeletons.get(componentId) ?? undefined,
        };
    }

    const descriptor = this.descriptors.get(componentId);
    const nodeDef = descriptor?.nodes.find((n) => n.id === nodeId);
    const defaults = nodeDef?.defaultConfig ?? {};
    const overrides = ((
      cfg.nodeConfig as Record<string, unknown> | undefined
    )?.[nodeId] ?? {}) as Record<string, unknown>;

    // component_config nodes get the full live component config injected so they
    // can resolve arbitrary dot-notation field paths.
    if (nodeDef?.kind === 'component_config') {
      return { ...defaults, ...overrides, _componentConfig: cfg };
    }

    return { ...defaults, ...overrides };
  }

  fireGraphEvent(componentId: string, nodeId: string, port: string): void {
    const graph = this.graphs.get(componentId);
    if (!graph) return;
    graph.fire(nodeId, port, mkEvent(undefined));
  }

  /** The GraphDescriptor for a running VMC receiver (for the graph editor). */
  getGraphDescriptor(componentId: string): GraphDescriptor | null {
    return this.descriptors.get(componentId) ?? null;
  }

  /** All active VMC graph descriptors (for the graph list in the scene dock). */
  getAllGraphDescriptors(): GraphDescriptor[] {
    return [...this.descriptors.values()];
  }

  /** Returns the uncalibrated NormalizedPose at the head_calib input (last pulled value). */
  peekBodyCalibInput(componentId: string): NormalizedPose | null {
    const graph = this.graphs.get(componentId);
    if (!graph) return null;
    return graph.peekInput('head_calib', 'pose') as NormalizedPose | null;
  }

  // ── receiver lifecycle ─────────────────────────────────────────────────────

  startReceiver(componentId: string, port: number) {
    const existing = this.receivers.get(componentId);
    if (existing?.port === port) return;
    if (existing) this.stopReceiver(componentId);

    const graph = this.createGraph(componentId);
    this.graphs.set(componentId, graph);

    // Listener is captured here so we can store the unsubscribe handle on `info`
    // before defining the handler — info itself is referenced inside the handler.
    const info: Receiver = {
      unsubscribe: () => {}, // replaced after subscribe() returns
      port,
      lastSeen: 0,
      connected: false,
      prevBodyArgs: [],
      trackingActive: null,
    };
    this.receivers.set(componentId, info);

    const onPacket = (
      buf: Buffer,
      rinfo: { address: string; port: number }
    ) => {
      const wasConnected = info.connected;
      info.lastSeen = Date.now();

      if (!wasConnected) {
        info.connected = true;
        console.log(
          `[VMC] Client connected: ${rinfo.address}:${rinfo.port} → port ${port} (component ${componentId})`
        );
        this.ws.broadcast('vmc_status', {
          componentId,
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
            const nowTracking = diff > TRACKING_THRESHOLD;
            if (nowTracking !== info.trackingActive) {
              info.trackingActive = nowTracking;
              console.log(
                `[VMC] Tracking ${nowTracking ? 'ACTIVE' : 'LOST'} (component ${componentId})`
              );
              this.ws.broadcast('vmc_tracking_state', {
                componentId,
                tracking: nowTracking,
              });
              // Drop our bus slot on tracking loss so the merge falls back to other
              // producers (or the additive-identity fallback frame if we were the
              // only one). Resume is automatic — the next publishBones re-creates it.
              if (!nowTracking) broadcastBus.removeComponent(componentId);
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
        `[VMC] Receiver attached to port ${port} (component ${componentId})`
      );
    });
  }

  stopReceiver(componentId: string) {
    const info = this.receivers.get(componentId);
    if (!info) return;
    info.unsubscribe();
    this.receivers.delete(componentId);
    this.graphs.delete(componentId);
    for (const cleanup of this.interceptorCleanups.get(componentId) ?? [])
      cleanup();
    this.interceptorCleanups.delete(componentId);
    broadcastBus.removeComponent(componentId);
    if (info.connected)
      this.ws.broadcast('vmc_status', { componentId, connected: false });
    console.log(`[VMC] Receiver stopped (component ${componentId})`);
  }

  syncComponents(
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
      this.componentConfigs.set(c.id, liveConfig);
      this.componentNodeIds.set(c.id, c.nodeId);
      this._loadSkeletonForComponent(c.id, c.nodeId);
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
        this.componentConfigs.set(c.id, c.config);
        this.componentNodeIds.set(c.id, c.nodeId);
      }
    }
  }

  private _loadSkeletonForComponent(
    componentId: string,
    sceneNodeId: string
  ): void {
    if (this.componentSkeletons.has(componentId)) return; // already loaded
    try {
      const row = getDb()
        .prepare('SELECT file_path FROM scene_nodes WHERE id = ?')
        .get(sceneNodeId) as { file_path: string | null } | undefined;
      const filePath = row?.file_path;
      if (!filePath) {
        this.componentSkeletons.set(componentId, null);
        return;
      }
      const absPath = join(process.cwd(), filePath);
      const skeleton = loadVrmSkeleton(absPath);
      this.componentSkeletons.set(componentId, skeleton);
      console.log(
        `[VmcManager] Loaded VRM skeleton for component ${componentId}: ${Object.keys(skeleton).length} bones`
      );
    } catch (err) {
      console.warn(
        `[VmcManager] Could not load VRM skeleton for ${componentId}:`,
        (err as Error).message
      );
      this.componentSkeletons.set(componentId, null);
    }
  }

  /** Returns monitoring state for all nodes and edges in a graph. */
  getStates(
    componentId: string
  ): import('@vspark/shared/signal').GraphStateSnapshot | null {
    return this.graphs.get(componentId)?.getStates() ?? null;
  }

  private checkTimeouts() {
    const now = Date.now();
    for (const [componentId, info] of this.receivers) {
      if (info.connected && now - info.lastSeen > 3000) {
        info.connected = false;
        console.log(`[VMC] Client timed out (component ${componentId})`);
        this.ws.broadcast('vmc_status', { componentId, connected: false });
      }
    }
  }

  close() {
    clearInterval(this.timer);
    for (const id of [...this.receivers.keys()]) this.stopReceiver(id);
  }
}
