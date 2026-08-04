import { SignalGraph } from '../../signal/engine.js';
import { NODE_REGISTRY } from '../../signal/registry.js';
import { OnPoseBroadcast } from '../../signal/nodes/on_pose_broadcast.js';
import { makePoseStylizerGraphDescriptor } from './graph.js';
import { broadcastBus } from '../../broadcast/bus.js';
import type { GraphDescriptor } from '@vspark/shared/signal';
import {
  DEFAULT_STYLE_RESPONSE,
  DEFAULT_STYLE_RIG,
} from '@vspark/shared/style_rig';
import { getDb } from '../../db/index.js';
import { BehaviorKind } from '../decorator.js';

/**
 * Node kinds whose state is a transient per-frame carrier and must NOT be written
 * back to SQLite. `on_pose_broadcast` has the whole pose injected into its state
 * before every single fire, so persisting it would mean a read-modify-write of the
 * behavior row at the pose rate (~60Hz) — and the value is meaningless on restart.
 */
const EPHEMERAL_STATE_KINDS = new Set(['on_pose_broadcast']);

/**
 * Drives the `pose_stylizer` behavior: a pose interceptor that re-expresses
 * accurate tracking as stylized, whole-body motion (see
 * dev-notes/modules/stylized-tracking.md).
 *
 * Lifecycle mirrors `ManualCalibrationManager` — per-behavior graph, hot-applied
 * config, and registration into the pose interceptor chain rather than attaching a
 * source of its own, so it only runs while some producer is actually broadcasting
 * a pose for the avatar.
 */
@BehaviorKind({
  kind: 'pose_stylizer',
  label: 'Stylized Tracking',
  icon: '🎭',
  description:
    'Post-processes tracking into stylized motion: a few drivers (head, torso, arms) are read off the performance and fanned back out across the whole body, the way a 2D avatar is rigged. Adds follow-through and keeps tracking glitches from producing broken poses.',
  applicableTo: ['avatar'],
  defaultConfig: {
    amount: 1,
    lag: 0.08,
    restUnmapped: false,
    response: { ...DEFAULT_STYLE_RESPONSE },
    // null = use the built-in rig verbatim; the UI writes only the bones it changes.
    rig: null,
  },
})
export class PoseStylizerManager {
  private readonly graphs = new Map<string, SignalGraph>();
  private readonly descriptors = new Map<string, GraphDescriptor>();
  private readonly nodeStates = new Map<string, Map<string, unknown>>();
  private readonly behaviorNodeIds = new Map<string, string>();
  private readonly behaviorConfigs = new Map<string, Record<string, unknown>>();
  // Interceptor unregister callbacks per behavior.
  private readonly cleanups = new Map<string, Array<() => void>>();

  // ── graph management ───────────────────────────────────────────────────────

  private createGraph(behaviorId: string): SignalGraph {
    const descriptor = makePoseStylizerGraphDescriptor(behaviorId);
    this.descriptors.set(behaviorId, descriptor);
    if (!this.nodeStates.has(behaviorId))
      this.nodeStates.set(behaviorId, new Map());

    const graph = SignalGraph.fromDescriptor(
      descriptor,
      NODE_REGISTRY,
      (nodeId) => this._getNodeConfig(behaviorId, nodeId),
      (nodeId) => this.nodeStates.get(behaviorId)?.get(nodeId) ?? {},
      (nodeId, state) => {
        this.nodeStates.get(behaviorId)!.set(nodeId, state);
        this._persistNodeState(behaviorId, nodeId, state);
      },
      // Behavior graphs are always attached to a scene node.
      'scene_node'
    );

    // Register on_pose_broadcast nodes into the interceptor chain.
    const cleanups: Array<() => void> = [];
    for (const nodeDef of descriptor.nodes) {
      if (nodeDef.kind !== 'on_pose_broadcast') continue;
      const sceneNodeId = this.behaviorNodeIds.get(behaviorId) ?? '';
      const priority =
        (nodeDef.defaultConfig?.priority as number | undefined) ?? 8;
      cleanups.push(
        OnPoseBroadcast.register(
          sceneNodeId,
          nodeDef.id,
          priority,
          (gNodeId, state) => graph.setNodeState(gNodeId, state),
          (gNodeId, port, value) => graph.fire(gNodeId, port, value)
        )
      );
    }
    this.cleanups.set(behaviorId, cleanups);

    return graph;
  }

  private _getNodeConfig(behaviorId: string, nodeId: string): unknown {
    const cfg = this.behaviorConfigs.get(behaviorId) ?? {};
    const descriptor = this.descriptors.get(behaviorId);
    const nodeDef = descriptor?.nodes.find((n) => n.id === nodeId);
    const defaults = nodeDef?.defaultConfig ?? {};
    const overrides = ((
      cfg.nodeConfig as Record<string, unknown> | undefined
    )?.[nodeId] ?? {}) as Record<string, unknown>;
    // `_behaviorConfig` is consumed by the `behavior_config` nodes to resolve
    // amount / lag / response / rig against the live behavior config (read fresh
    // per pull, so edits hot-apply without a graph rebuild).
    return { ...defaults, ...overrides, _behaviorConfig: cfg };
  }

  private _persistNodeState(
    behaviorId: string,
    nodeId: string,
    state: unknown
  ): void {
    const kind = this.descriptors
      .get(behaviorId)
      ?.nodes.find((n) => n.id === nodeId)?.kind;
    if (kind && EPHEMERAL_STATE_KINDS.has(kind)) return;
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
      const ns = (cfg._nodeState ?? {}) as Record<string, unknown>;
      ns[nodeId] = state;
      cfg._nodeState = ns;
      db.prepare('UPDATE behaviors SET config = ? WHERE id = ?').run(
        JSON.stringify(cfg),
        behaviorId
      );
    } catch {
      /* non-fatal */
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  start(behaviorId: string): void {
    if (this.graphs.has(behaviorId)) return;
    const graph = this.createGraph(behaviorId);
    this.graphs.set(behaviorId, graph);
    console.log(`[PoseStylizer] Started behavior ${behaviorId}`);
  }

  stop(behaviorId: string): void {
    if (!this.graphs.has(behaviorId)) return;
    for (const fn of this.cleanups.get(behaviorId) ?? []) fn();
    this.cleanups.delete(behaviorId);
    this.graphs.delete(behaviorId);
    broadcastBus.removeBehavior(behaviorId);
    console.log(`[PoseStylizer] Stopped behavior ${behaviorId}`);
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
      if (c.kind !== 'pose_stylizer' || !c.enabled) continue;
      const { _nodeState: saved, ...liveConfig } = c.config;
      // Restore persisted node state.
      const stateMap = this.nodeStates.get(c.id) ?? new Map<string, unknown>();
      for (const [nid, st] of Object.entries(
        (saved ?? {}) as Record<string, unknown>
      )) {
        stateMap.set(nid, st);
      }
      this.nodeStates.set(c.id, stateMap);
      this.behaviorConfigs.set(c.id, liveConfig);
      this.behaviorNodeIds.set(c.id, c.nodeId);
      this.start(c.id);
      active.add(c.id);
    }
    for (const id of this.graphs.keys()) {
      if (!active.has(id)) this.stop(id);
    }
    // Hot-apply config updates (amount / lag / response / rig read config live).
    for (const c of comps) {
      if (active.has(c.id)) {
        const { _nodeState: _saved, ...liveConfig } = c.config;
        this.behaviorConfigs.set(c.id, liveConfig);
        this.behaviorNodeIds.set(c.id, c.nodeId);
      }
    }
  }

  /** The stock rig, for callers that want to show or seed it (e.g. the UI via REST). */
  getDefaultRig() {
    return DEFAULT_STYLE_RIG;
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
