import { SignalGraph } from '../../signal/engine.js';
import { NODE_REGISTRY } from '../../signal/registry.js';
import { OnBlendshapesBroadcast } from '../../signal/nodes/on_blendshapes_broadcast.js';
import { makeBlendshapeLimiterGraphDescriptor } from './graph.js';
import { broadcastBus } from '../../broadcast/bus.js';
import type { GraphDescriptor } from '@vspark/shared/signal';
import { DEFAULT_BLENDSHAPE_LIMITS } from '@vspark/shared/blendshapeLimits';
import { getDb } from '../../db/index.js';
import { BehaviorKind } from '../decorator.js';

/**
 * Drives the `blendshape_limiter` behavior: a blendshape interceptor that keeps
 * expressions from stacking into exaggerated or broken faces.
 *
 * Lifecycle mirrors `ManualCalibrationManager` (per-behavior graph + persisted
 * node state + hot-applied config); the only difference is which registry it
 * registers into — `OnBlendshapesBroadcast.register` puts the graph on the
 * blendshape interceptor chain, so it runs whenever some producer broadcasts
 * expression weights for the avatar.
 */
@BehaviorKind({
  kind: 'blendshape_limiter',
  label: 'Expression Limits',
  icon: '🚦',
  description:
    'Stops expressions from stacking into broken faces: exclusive groups let only the strongest of a set of competing expressions through, and clamp rules cap shapes like mouth-open or eye-close while an expression such as joy is active.',
  applicableTo: ['avatar'],
  defaultConfig: { limits: DEFAULT_BLENDSHAPE_LIMITS },
})
export class BlendshapeLimiterManager {
  private readonly graphs = new Map<string, SignalGraph>();
  private readonly descriptors = new Map<string, GraphDescriptor>();
  private readonly nodeStates = new Map<string, Map<string, unknown>>();
  private readonly behaviorNodeIds = new Map<string, string>();
  private readonly behaviorConfigs = new Map<string, Record<string, unknown>>();
  // Interceptor unregister callbacks per behavior.
  private readonly cleanups = new Map<string, Array<() => void>>();

  // ── graph management ───────────────────────────────────────────────────────

  private createGraph(behaviorId: string): SignalGraph {
    const descriptor = makeBlendshapeLimiterGraphDescriptor(behaviorId);
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

    // Register on_blendshapes_broadcast nodes into the interceptor chain.
    const cleanups: Array<() => void> = [];
    for (const nodeDef of descriptor.nodes) {
      if (nodeDef.kind !== 'on_blendshapes_broadcast') continue;
      const sceneNodeId = this.behaviorNodeIds.get(behaviorId) ?? '';
      const priority =
        (nodeDef.defaultConfig?.priority as number | undefined) ?? 5;
      cleanups.push(
        OnBlendshapesBroadcast.register(
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
    // `_behaviorConfig` is consumed by the `behavior_config` node to resolve the
    // `limits` field against the live behavior config (read fresh per pull, so
    // rule edits hot-apply without a graph rebuild).
    return { ...defaults, ...overrides, _behaviorConfig: cfg };
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
    console.log(`[BlendshapeLimiter] Started behavior ${behaviorId}`);
  }

  stop(behaviorId: string): void {
    if (!this.graphs.has(behaviorId)) return;
    for (const fn of this.cleanups.get(behaviorId) ?? []) fn();
    this.cleanups.delete(behaviorId);
    this.graphs.delete(behaviorId);
    broadcastBus.removeBehavior(behaviorId);
    console.log(`[BlendshapeLimiter] Stopped behavior ${behaviorId}`);
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
      if (c.kind !== 'blendshape_limiter' || !c.enabled) continue;
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
    // Hot-apply config updates (the limits node reads its rule set live).
    for (const c of comps) {
      if (active.has(c.id)) {
        const { _nodeState: _saved, ...liveConfig } = c.config;
        this.behaviorConfigs.set(c.id, liveConfig);
        this.behaviorNodeIds.set(c.id, c.nodeId);
      }
    }
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
