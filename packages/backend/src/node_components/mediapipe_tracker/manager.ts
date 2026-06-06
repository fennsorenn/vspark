import { SignalGraph } from '../../signal/engine.js';
import { NODE_REGISTRY } from '../../signal/registry.js';
import { mkEvent } from '@vspark/shared/signal';
import type { GraphDescriptor } from '@vspark/shared/signal';
import { getDb } from '../../db/index.js';
import { BehaviorKind } from '../decorator.js';
import {
  makeMediapipeGraphDescriptor,
  HEAD_CALIB_BONES,
  FINGER_CALIB_BONES,
  FINGER_MIRROR_PAIRS,
} from './graph.js';
import type { Landmark } from '@vspark/shared';

interface TrackingFrame {
  face?: Landmark[];
  leftHand?: Landmark[];
  rightHand?: Landmark[];
  pose?: Landmark[];
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

    // component_config nodes resolve dot-notation paths against the live component config.
    // No other node type may reach into the component config — calibration values must flow
    // through value-port edges from component_config nodes.
    if (nodeDef?.kind === 'component_config') {
      return { ...defaults, _componentConfig: cfg };
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
    console.log(`[Tracking] Stopped component ${behaviorId}`);
  }

  syncComponents(
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
    if (frame.face) graph.fire('mp_source', 'face', mkEvent(frame.face, ts));
    if (frame.leftHand)
      graph.fire('mp_source', 'leftHand', mkEvent(frame.leftHand, ts));
    if (frame.rightHand)
      graph.fire('mp_source', 'rightHand', mkEvent(frame.rightHand, ts));
    if (frame.pose) graph.fire('mp_source', 'pose', mkEvent(frame.pose, ts));
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
    for (const id of [...this.graphs.keys()]) this.stop(id);
  }
}
