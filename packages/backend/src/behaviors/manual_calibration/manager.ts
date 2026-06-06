import { SignalGraph } from '../../signal/engine.js';
import { NODE_REGISTRY } from '../../signal/registry.js';
import { OnPoseBroadcast } from '../../signal/nodes/on_pose_broadcast.js';
import { makeManualCalibrationGraphDescriptor } from './graph.js';
import { broadcastBus } from '../../broadcast/bus.js';
import type { GraphDescriptor } from '@vspark/shared/signal';
import { getDb } from '../../db/index.js';
import { BehaviorKind } from '../decorator.js';

/**
 * Drives the `manual_calibration` behavior: a pose interceptor that applies
 * per-bone, per-axis multiplier + offset to an avatar's pose before broadcast.
 *
 * Lifecycle mirrors BreathingManager (per-behavior graph + persisted node
 * state), but instead of attaching clocks it registers the graph's
 * `on_pose_broadcast` node into the interceptor chain (like VmcManager), so the
 * calibration runs whenever some producer broadcasts a pose for the avatar.
 */
@BehaviorKind({
  kind: 'manual_calibration',
  label: 'Manual Calibration',
  icon: '🎚️',
  description:
    'Manually calibrate the pose: per bone, a multiplier and offset per axis. Multiplier scales how far a rotation travels; offset shifts the neutral 0.',
  applicableTo: ['avatar'],
  defaultConfig: {},
})
export class ManualCalibrationManager {
  private readonly graphs = new Map<string, SignalGraph>();
  private readonly descriptors = new Map<string, GraphDescriptor>();
  private readonly nodeStates = new Map<string, Map<string, unknown>>();
  private readonly behaviorNodeIds = new Map<string, string>();
  private readonly behaviorConfigs = new Map<string, Record<string, unknown>>();
  // Interceptor unregister callbacks per behavior.
  private readonly cleanups = new Map<string, Array<() => void>>();

  // ── graph management ───────────────────────────────────────────────────────

  private createGraph(behaviorId: string): SignalGraph {
    const descriptor = makeManualCalibrationGraphDescriptor(behaviorId);
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

    // Register on_pose_broadcast nodes into the interceptor chain.
    const cleanups: Array<() => void> = [];
    for (const nodeDef of descriptor.nodes) {
      if (nodeDef.kind !== 'on_pose_broadcast') continue;
      const sceneNodeId = this.behaviorNodeIds.get(behaviorId) ?? '';
      const priority =
        (nodeDef.defaultConfig?.priority as number | undefined) ?? 5;
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
    // The calibration node reads the live per-bone map straight off the behavior
    // config so user edits hot-apply without rebuilding the graph.
    if (nodeId === 'calib') return { calibrations: cfg.calibrations ?? {} };

    const descriptor = this.descriptors.get(behaviorId);
    const nodeDef = descriptor?.nodes.find((n) => n.id === nodeId);
    const defaults = nodeDef?.defaultConfig ?? {};
    const overrides = ((
      cfg.nodeConfig as Record<string, unknown> | undefined
    )?.[nodeId] ?? {}) as Record<string, unknown>;
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
    console.log(`[ManualCalibration] Started component ${behaviorId}`);
  }

  stop(behaviorId: string): void {
    if (!this.graphs.has(behaviorId)) return;
    for (const fn of this.cleanups.get(behaviorId) ?? []) fn();
    this.cleanups.delete(behaviorId);
    this.graphs.delete(behaviorId);
    broadcastBus.removeBehavior(behaviorId);
    console.log(`[ManualCalibration] Stopped component ${behaviorId}`);
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
      if (c.kind !== 'manual_calibration' || !c.enabled) continue;
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
    // Hot-apply config updates (per-bone calibration reads config live).
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
