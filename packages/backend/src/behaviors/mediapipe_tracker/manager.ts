import { SignalGraph } from '../../signal/engine.js';
import { NODE_REGISTRY } from '../../signal/registry.js';
import { mkEvent, Blendshapes } from '@vspark/shared/signal';
import type { GraphDescriptor } from '@vspark/shared/signal';
import { getDb } from '../../db/index.js';
import { BehaviorKind } from '../decorator.js';
import { trackingGraceMs } from '../tracking_grace.js';
import {
  makeMediapipeGraphDescriptor,
  HEAD_CALIB_BONES,
  FINGER_CALIB_BONES,
  FINGER_MIRROR_PAIRS,
} from './graph.js';
import type { Landmark } from '@vspark/shared';
import type { WSSync } from '../../ws/index.js';
import { broadcastBus } from '../../broadcast/bus.js';

/** Fallback grace period when the avatar node has no `trackingGracePeriod` set.
 *  No landmark frame for this long ⇒ the browser stopped tracking (camera off,
 *  tab hidden, person left frame). Unlike VMC — which must also infer loss from
 *  frame-to-frame /Body deltas — the camera pipeline simply stops sending, so a
 *  plain silence timeout is the only loss path here. Loose enough to ride out a
 *  few dropped frames at ~30 fps. */
const TRACKING_TIMEOUT_MS = 1000;

/** Sweep period. Fixed rather than derived from the configured grace period,
 *  which is per-behavior and hot-editable; 250ms keeps the resolution finer than
 *  the smallest window the "Idle after" field allows (0.1s). */
const SWEEP_MS = 250;

interface TrackingFrame {
  face?: Landmark[];
  leftHand?: Landmark[];
  rightHand?: Landmark[];
  pose?: Landmark[];
  /** ARKit blendshape weights (shape name → 0..1) from MediaPipe's face model. */
  faceBlendshapes?: Record<string, number>;
}

@BehaviorKind({
  kind: 'mediapipe_tracker',
  label: 'MediaPipe Tracking',
  icon: '📷',
  description:
    'Receives face, hand, and body pose landmarks from the browser camera and drives VRM bones and blendshapes in real time.',
  applicableTo: ['avatar'],
  defaultConfig: { enableFace: true, enablePose: true, enableHands: true },
})
export class TrackingManager {
  private readonly graphs = new Map<string, SignalGraph>();
  private readonly descriptors = new Map<string, GraphDescriptor>();
  private readonly nodeStates = new Map<string, Map<string, unknown>>();
  private readonly nodeIds = new Map<string, string>();
  private readonly configs = new Map<string, Record<string, unknown>>();
  /** behaviorId → last landmark-frame timestamp (0 while never seen). */
  private readonly lastInput = new Map<string, number>();
  /** behaviorId → whether we currently consider this tracker live. */
  private readonly trackingActive = new Map<string, boolean>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly ws?: WSSync) {
    // Poll for tracking loss (browser stopped sending).
    this.timer = setInterval(() => this.checkTimeouts(), SWEEP_MS);
    // Re-send current tracking state to a freshly-connected client (refresh /
    // new tab), mirroring the VMC receiver, so the SceneGraph indicator is right
    // immediately.
    this.ws?.onClientConnected((client) => {
      for (const [behaviorId, active] of this.trackingActive) {
        this.ws?.sendTo(client, 'vmc_tracking_state', {
          behaviorId,
          tracking: active,
        });
      }
    });
  }

  private _setTracking(behaviorId: string, active: boolean): void {
    if (this.trackingActive.get(behaviorId) === active) return;
    this.trackingActive.set(behaviorId, active);
    console.log(
      `[MediaPipe] Tracking ${active ? 'ACTIVE' : 'LOST'} (component ${behaviorId})`
    );
    this.ws?.broadcast('vmc_tracking_state', { behaviorId, tracking: active });
    // On loss, drop the bus slot so the tracked pose falls out of the merge
    // (mirrors vmc_receiver). The next landmark frame re-creates it.
    if (!active) broadcastBus.removeBehavior(behaviorId);
  }

  /**
   * Grace period (ms) before a dropout is reported as a loss, read from the avatar
   * node's `trackingGracePeriod` property. Shared with vmc_receiver so both
   * tracking sources on an avatar reach idle on the same clock instead of each
   * honouring its own constant.
   *
   * Falls back to the camera-specific default rather than the shared one: at ~30fps
   * a shorter window is fine here, and this is only reached when the node carries
   * no explicit setting.
   */
  private graceMs(behaviorId: string): number {
    return trackingGraceMs(this.nodeIds.get(behaviorId), TRACKING_TIMEOUT_MS);
  }

  private checkTimeouts(): void {
    const now = Date.now();
    for (const [behaviorId, active] of this.trackingActive) {
      if (!active) continue;
      const last = this.lastInput.get(behaviorId) ?? 0;
      if (now - last > this.graceMs(behaviorId))
        this._setTracking(behaviorId, false);
    }
  }

  private createGraph(behaviorId: string): SignalGraph {
    const descriptor = makeMediapipeGraphDescriptor(behaviorId);
    this.descriptors.set(behaviorId, descriptor);
    if (!this.nodeStates.has(behaviorId))
      this.nodeStates.set(behaviorId, new Map());

    return SignalGraph.fromDescriptor(
      descriptor,
      NODE_REGISTRY,
      (nodeId) => this._getNodeConfig(behaviorId, nodeId),
      (nodeId) => this.nodeStates.get(behaviorId)?.get(nodeId) ?? {},
      (nodeId, state) => {
        this.nodeStates.get(behaviorId)!.set(nodeId, state);
        this._persistNodeState(behaviorId, nodeId, state);
      },
      // Component graphs are always attached to a scene node.
      'scene_node'
    );
  }

  private _getNodeConfig(behaviorId: string, nodeId: string): unknown {
    const cfg = this.configs.get(behaviorId) ?? {};
    const nodeId_ = this.nodeIds.get(behaviorId) ?? '';
    if (nodeId === 'scene_entity') return { nodeId: nodeId_ };
    if (nodeId === 'comp_id') return { behaviorId };
    if (nodeId === 'head_calib') return { boneFilter: HEAD_CALIB_BONES };
    if (nodeId === 'finger_calib')
      return {
        boneFilter: FINGER_CALIB_BONES,
        mirrorPairs: FINGER_MIRROR_PAIRS,
      };

    const descriptor = this.descriptors.get(behaviorId);
    const nodeDef = descriptor?.nodes.find((n) => n.id === nodeId);
    const defaults = nodeDef?.defaultConfig ?? {};

    // behavior_config nodes resolve dot-notation paths against the live component config.
    // No other node type may reach into the component config — calibration values must flow
    // through value-port edges from behavior_config nodes.
    if (nodeDef?.kind === 'behavior_config') {
      return { ...defaults, _behaviorConfig: cfg };
    }

    return defaults;
  }

  fireGraphEvent(behaviorId: string, nodeId: string, port: string): void {
    const graph = this.graphs.get(behaviorId);
    if (!graph) return;
    graph.fire(nodeId, port, mkEvent(undefined));
  }

  private _persistNodeState(
    behaviorId: string,
    nodeId: string,
    state: unknown
  ): void {
    try {
      const existing = getDb()
        .prepare('SELECT config FROM behaviors WHERE id = ?')
        .get(behaviorId) as { config: string } | undefined;
      if (!existing) return;
      const cfg = JSON.parse(existing.config || '{}') as Record<
        string,
        unknown
      >;
      const ns = (cfg._nodeState ?? {}) as Record<string, unknown>;
      ns[nodeId] = state;
      cfg._nodeState = ns;
      getDb()
        .prepare('UPDATE behaviors SET config = ? WHERE id = ?')
        .run(JSON.stringify(cfg), behaviorId);
    } catch {
      /* non-fatal */
    }
  }

  start(behaviorId: string): void {
    if (this.graphs.has(behaviorId)) return;
    const graph = this.createGraph(behaviorId);
    this.graphs.set(behaviorId, graph);
    console.log(`[Tracking] Started component ${behaviorId}`);
  }

  stop(behaviorId: string): void {
    if (!this.graphs.has(behaviorId)) return;
    this.graphs.delete(behaviorId);
    // Behaviour removed/disabled: fall out of the merge and signal loss.
    if (this.trackingActive.get(behaviorId)) this._setTracking(behaviorId, false);
    this.trackingActive.delete(behaviorId);
    this.lastInput.delete(behaviorId);
    console.log(`[Tracking] Stopped component ${behaviorId}`);
  }

  syncBehaviors(
    comps: Array<{
      id: string;
      nodeId: string;
      kind: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }>
  ): void {
    const active = new Set<string>();
    for (const c of comps) {
      if (c.kind !== 'mediapipe_tracker' || !c.enabled) continue;
      const { _nodeState: saved, ...liveConfig } = c.config;
      const stateMap = this.nodeStates.get(c.id) ?? new Map<string, unknown>();
      for (const [nid, st] of Object.entries(
        (saved ?? {}) as Record<string, unknown>
      )) {
        stateMap.set(nid, st);
      }
      this.nodeStates.set(c.id, stateMap);
      this.configs.set(c.id, liveConfig);
      this.nodeIds.set(c.id, c.nodeId);
      this.start(c.id);
      active.add(c.id);
    }
    for (const id of this.graphs.keys()) {
      if (!active.has(id)) this.stop(id);
    }
    for (const c of comps) {
      if (active.has(c.id)) {
        this.configs.set(c.id, c.config);
        this.nodeIds.set(c.id, c.nodeId);
      }
    }
  }

  /** Called by the WS handler for each tracking_input message from the browser. */
  fireLandmarks(behaviorId: string, frame: TrackingFrame): void {
    const graph = this.graphs.get(behaviorId);
    if (!graph) return;
    const ts = Date.now();
    // Any landmark frame means the camera is tracking; refresh the watchdog and
    // flip to active on the first frame after a gap.
    this.lastInput.set(behaviorId, ts);
    this._setTracking(behaviorId, true);
    if (frame.face) graph.fire('mp_source', 'face', mkEvent(frame.face, ts));
    if (frame.leftHand)
      graph.fire('mp_source', 'leftHand', mkEvent(frame.leftHand, ts));
    if (frame.rightHand)
      graph.fire('mp_source', 'rightHand', mkEvent(frame.rightHand, ts));
    if (frame.pose) graph.fire('mp_source', 'pose', mkEvent(frame.pose, ts));
    if (frame.faceBlendshapes)
      graph.fire(
        'mp_source',
        'arkit',
        mkEvent(Blendshapes.fromRecord(frame.faceBlendshapes), ts)
      );
  }

  getStates(
    behaviorId: string
  ): import('@vspark/shared/signal').GraphStateSnapshot | null {
    return this.graphs.get(behaviorId)?.getStates() ?? null;
  }

  getGraphDescriptor(behaviorId: string): GraphDescriptor | null {
    return this.descriptors.get(behaviorId) ?? null;
  }

  getAllGraphDescriptors(): GraphDescriptor[] {
    return [...this.descriptors.values()];
  }

  close(): void {
    clearInterval(this.timer);
    for (const id of [...this.graphs.keys()]) this.stop(id);
  }
}
