import { SignalGraph } from '../../signal/engine.js';
import { NODE_REGISTRY } from '../../signal/registry.js';
import { Clock } from '../../signal/nodes/clock.js';
import { makeBreathingGraphDescriptor } from './graph.js';
import { broadcastBus } from '../../broadcast/bus.js';
import type { GraphDescriptor } from '@vspark/shared/signal';
import { getDb } from '../../db/index.js';
import { BehaviorKind } from '../decorator.js';

@BehaviorKind({
  kind: 'breathing',
  label: 'Breathing',
  icon: '🫁',
  description:
    'Adds procedural breathing motion to the chest and spine bones using a sine oscillator.',
  applicableTo: ['any'],
  defaultConfig: {},
})
export class BreathingManager {
  private readonly graphs = new Map<string, SignalGraph>();
  private readonly descriptors = new Map<string, GraphDescriptor>();
  private readonly nodeStates = new Map<string, Map<string, unknown>>();
  private readonly behaviorNodeIds = new Map<string, string>();
  private readonly behaviorConfigs = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly cleanups = new Map<string, Array<() => void>>();

  // ── graph management ───────────────────────────────────────────────────────

  private createGraph(behaviorId: string): SignalGraph {
    const descriptor = makeBreathingGraphDescriptor(behaviorId);
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
      // Component graphs are always attached to a scene node.
      'scene_node'
    );

    const fns: Array<() => void> = [];

    // Attach clock nodes so they fire on their own timer (tick-driven, independent of tracking).
    for (const nodeDef of descriptor.nodes) {
      if (nodeDef.kind === 'clock') {
        const defaultHz =
          (nodeDef.defaultConfig?.hz as number | undefined) ?? 30;
        fns.push(
          Clock.attach(
            nodeDef.id,
            defaultHz,
            (gId) => {
              const state = this.nodeStates.get(behaviorId)?.get(gId) as
                | { hz?: number }
                | undefined;
              return state?.hz ?? defaultHz;
            },
            (gId, port, value) => graph.fire(gId, port, value)
          )
        );
      }
    }

    this.cleanups.set(behaviorId, fns);
    return graph;
  }

  private _getNodeConfig(behaviorId: string, nodeId: string): unknown {
    const cfg = this.behaviorConfigs.get(behaviorId) ?? {};
    const nodeId_ = this.behaviorNodeIds.get(behaviorId) ?? '';

    if (nodeId === 'scene_entity') return { nodeId: nodeId_ };
    if (nodeId === 'comp_id') return { behaviorId };

    const descriptor = this.descriptors.get(behaviorId);
    const nodeDef = descriptor?.nodes.find((n) => n.id === nodeId);
    const defaults = nodeDef?.defaultConfig ?? {};
    const overrides = ((
      cfg.nodeConfig as Record<string, unknown> | undefined
    )?.[nodeId] ?? {}) as Record<string, unknown>;
    // _componentConfig is consumed by `component_config` nodes to resolve dotted
    // field paths against the live component config.
    return { ...defaults, ...overrides, _componentConfig: cfg };
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

  // ── component lifecycle ────────────────────────────────────────────────────

  start(behaviorId: string): void {
    if (this.graphs.has(behaviorId)) return;
    const graph = this.createGraph(behaviorId);
    this.graphs.set(behaviorId, graph);
    console.log(`[Breathing] Started component ${behaviorId}`);
  }

  stop(behaviorId: string): void {
    if (!this.graphs.has(behaviorId)) return;
    for (const fn of this.cleanups.get(behaviorId) ?? []) fn();
    this.cleanups.delete(behaviorId);
    this.graphs.delete(behaviorId);
    broadcastBus.removeBehavior(behaviorId);
    console.log(`[Breathing] Stopped component ${behaviorId}`);
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
      if (c.kind !== 'breathing' || !c.enabled) continue;
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
    // Hot-apply config updates.
    for (const c of comps) {
      if (active.has(c.id)) {
        this.behaviorConfigs.set(c.id, c.config);
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
