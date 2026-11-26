import { Blendshapes, mkEvent } from '@vspark/shared/signal';
import type {
  GraphDescriptor,
  GraphStateSnapshot,
} from '@vspark/shared/signal';
import type {
  ApiAnimationLoopMode,
  ApiAnimationQueueEntry,
} from '@vspark/shared';
import { randomUUID } from 'crypto';
import { BehaviorKind } from '../decorator.js';
import { broadcastBus } from '../../broadcast/bus.js';
import { getDb } from '../../db/index.js';
import { getMeshCollection } from '../../mesh/index.js';
import { SignalGraph } from '../../signal/engine.js';
import { NODE_REGISTRY } from '../../signal/registry.js';
import {
  behaviorContextConfig,
  behaviorDescriptorToRun,
  programChanged,
} from '../storedGraph.js';

/** The template's entry node (graph.ts). A user-edited graph without it
 *  simply receives nothing. */
const SOURCE_NODE = 'api_src';

interface BehaviorState {
  sceneNodeId: string;
  queue: ApiAnimationQueueEntry[];
  loopMode: ApiAnimationLoopMode;
  startedAt: number | null;
  blendshapes: Blendshapes;
}

interface ClipRow {
  id: string;
  name: string;
  source_node_id: string;
  source_file_path: string;
  duration: number;
}

const DEFAULT_DURATION_SEC = 5;

@BehaviorKind({
  kind: 'api_controller',
  label: 'API Controller',
  icon: '🎛',
  description:
    'Drives the avatar via REST: set/queue animations and blendshape expressions.',
  applicableTo: ['avatar'],
  defaultConfig: {},
})
export class ApiControllerManager {
  private readonly _state = new Map<string, BehaviorState>();
  private readonly _expressionsByNode = new Map<string, string[]>();
  // The behavior's signal graph: blendshapes reach the bus through its
  // `blendshapes_broadcast` node, never from this manager directly.
  private readonly graphs = new Map<string, SignalGraph>();
  private readonly descriptors = new Map<string, GraphDescriptor>();
  private readonly nodeStates = new Map<string, Map<string, unknown>>();
  private readonly configs = new Map<string, Record<string, unknown>>();

  // ── expressions cache (populated by frontend reports over WS) ──────────────

  setExpressionsForNode(nodeId: string, expressions: string[]): void {
    if (expressions.length === 0) this._expressionsByNode.delete(nodeId);
    else this._expressionsByNode.set(nodeId, expressions);
  }

  getExpressionsForNode(nodeId: string): string[] | null {
    return this._expressionsByNode.get(nodeId) ?? null;
  }

  // ── graph ──────────────────────────────────────────────────────────────────

  private _createGraph(behaviorId: string): SignalGraph {
    // The behavior's stored (editable) graph; the template if none is stored.
    const descriptor = behaviorDescriptorToRun(
      'api_controller',
      behaviorId,
      this.configs.get(behaviorId)
    );
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
      },
      // Behavior graphs are always attached to a scene node.
      'scene_node'
    );
  }

  private _getNodeConfig(behaviorId: string, nodeId: string): unknown {
    const cfg = this.configs.get(behaviorId) ?? {};
    const nodeDef = this.descriptors
      .get(behaviorId)
      ?.nodes.find((n) => n.id === nodeId);
    const overrides = ((
      cfg.nodeConfig as Record<string, unknown> | undefined
    )?.[nodeId] ?? {}) as Record<string, unknown>;
    return {
      ...(nodeDef?.defaultConfig ?? {}),
      ...overrides,
      ...behaviorContextConfig(nodeDef?.kind, {
        behaviorId,
        sceneNodeId: this._state.get(behaviorId)?.sceneNodeId ?? '',
        settings: cfg,
      }),
    };
  }

  /** Push the behavior's current blendshapes into its graph. */
  private _fireBlendshapes(behaviorId: string): void {
    const graph = this.graphs.get(behaviorId);
    const st = this._state.get(behaviorId);
    if (!graph || !st) return;
    graph.fire(SOURCE_NODE, 'blendshapes', mkEvent(st.blendshapes));
  }

  // ── component lifecycle ────────────────────────────────────────────────────

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
      if (c.kind !== 'api_controller' || !c.enabled) continue;
      this.configs.set(c.id, c.config);
      if (!this._state.has(c.id)) {
        this._state.set(c.id, {
          sceneNodeId: c.nodeId,
          queue: [],
          loopMode: 'none',
          startedAt: null,
          blendshapes: new Blendshapes(),
        });
        console.log(`[ApiController] Started component ${c.id}`);
      } else {
        // Hot-update node id in case it ever changes.
        this._state.get(c.id)!.sceneNodeId = c.nodeId;
      }
      // Its stored graph was edited (or reset): rebuild the running one and
      // re-send the current weights through it (the old graph's bus slot is
      // released with it).
      const running = this.graphs.get(c.id);
      if (
        running &&
        programChanged(
          this.descriptors.get(c.id),
          behaviorDescriptorToRun('api_controller', c.id, c.config)
        )
      ) {
        running.dispose();
        this.graphs.delete(c.id);
        broadcastBus.removeBehavior(c.id);
      }
      if (!this.graphs.has(c.id)) {
        this.graphs.set(c.id, this._createGraph(c.id));
        if (this._state.get(c.id)!.blendshapes.size > 0)
          this._fireBlendshapes(c.id);
      }
      active.add(c.id);
    }
    for (const id of [...this._state.keys()]) {
      if (!active.has(id)) this._stop(id);
    }
  }

  private _stop(id: string): void {
    this._state.delete(id);
    this.graphs.get(id)?.dispose();
    this.graphs.delete(id);
    this.descriptors.delete(id);
    this.nodeStates.delete(id);
    this.configs.delete(id);
    broadcastBus.removeBehavior(id);
    console.log(`[ApiController] Stopped component ${id}`);
  }

  close(): void {
    for (const id of [...this._state.keys()]) this._stop(id);
  }

  getStates(behaviorId: string): GraphStateSnapshot | null {
    return this.graphs.get(behaviorId)?.getStates() ?? null;
  }

  getGraphDescriptor(behaviorId: string): GraphDescriptor | null {
    return this.descriptors.get(behaviorId) ?? null;
  }

  getAllGraphDescriptors(): GraphDescriptor[] {
    return [...this.descriptors.values()];
  }

  // ── lookup ─────────────────────────────────────────────────────────────────

  /** Find the api_controller component on a node, or null. */
  findByNode(
    nodeId: string
  ): { behaviorId: string; state: BehaviorState } | null {
    for (const [id, st] of this._state) {
      if (st.sceneNodeId === nodeId) return { behaviorId: id, state: st };
    }
    return null;
  }

  getState(behaviorId: string): BehaviorState | null {
    return this._state.get(behaviorId) ?? null;
  }

  /** All active state snapshots — used to rebroadcast on WS reconnect. */
  snapshotAll(): Array<{ behaviorId: string; state: BehaviorState }> {
    return [...this._state.entries()].map(([behaviorId, state]) => ({
      behaviorId,
      state,
    }));
  }

  // ── animation ──────────────────────────────────────────────────────────────

  /** Replace the queue, optionally resolving by clip id or name. Throws if a name doesn't resolve. */
  setAnimationQueue(
    behaviorId: string,
    queueInput: Array<{ animation: string }>,
    loopMode: ApiAnimationLoopMode
  ): void {
    const st = this._state.get(behaviorId);
    if (!st)
      throw new Error(`api_controller component ${behaviorId} not active`);

    const resolved: ApiAnimationQueueEntry[] = queueInput.map((entry) =>
      this._resolveClip(st.sceneNodeId, entry.animation)
    );
    st.queue = resolved;
    st.loopMode = loopMode;
    st.startedAt = resolved.length > 0 ? Date.now() : null;

    this._writeSchedule(st.sceneNodeId, resolved, loopMode, st.startedAt);
  }

  /** Project the resolved queue onto the avatar's scheduled_animation timeline
   *  (the synced, clock-anchored playback model that drives playback). Replaces
   *  this avatar's entries: each clip gets a startEpoch from the running
   *  duration sum, and the final clip loops when loopMode holds/loops it. The
   *  in-memory queue/startedAt on BehaviorState is kept only for the REST
   *  `/state` status read. See dev-notes/plans/avatar-animation.md. */
  private _writeSchedule(
    avatarNodeId: string,
    clips: ApiAnimationQueueEntry[],
    loopMode: ApiAnimationLoopMode,
    startedAt: number | null
  ): void {
    const col = getMeshCollection('scheduled_animation');
    if (!col) return;
    // Clear this avatar's existing timeline.
    for (const doc of col.all())
      if ((doc as { avatarNodeId?: string }).avatarNodeId === avatarNodeId)
        void col.remove((doc as { id: string }).id).ack;
    if (clips.length === 0 || startedAt == null) return;
    let epoch = startedAt;
    clips.forEach((c, i) => {
      const isLast = i === clips.length - 1;
      const loop = isLast && (loopMode === 'last' || loopMode === 'queue');
      const id = randomUUID();
      void col.set(id, '', {
        id,
        avatarNodeId,
        clipId: c.animationId,
        startEpoch: Math.round(epoch),
        speed: 1,
        loop,
      }).ack;
      epoch += Math.max(0.001, c.duration) * 1000;
    });
  }

  // ── blendshapes ────────────────────────────────────────────────────────────

  setBlendshapes(behaviorId: string, weights: Record<string, number>): void {
    const st = this._state.get(behaviorId);
    if (!st)
      throw new Error(`api_controller component ${behaviorId} not active`);
    const full: Record<string, number> = {};
    const known = this._expressionsByNode.get(st.sceneNodeId);
    if (known) for (const name of known) full[name] = 0;
    for (const [name, value] of Object.entries(weights)) full[name] = value;
    st.blendshapes = Blendshapes.fromRecord(full);
    this._fireBlendshapes(behaviorId);
  }

  clearBlendshapes(behaviorId: string): void {
    const st = this._state.get(behaviorId);
    if (!st)
      throw new Error(`api_controller component ${behaviorId} not active`);
    st.blendshapes = new Blendshapes();
    this._fireBlendshapes(behaviorId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private _resolveClip(
    sceneNodeId: string,
    idOrName: string
  ): ApiAnimationQueueEntry {
    const db = getDb();
    // Try id first, scoped to this node so the queue can only reference clips owned by this avatar.
    let row = db
      .prepare(
        'SELECT id, name, source_node_id, source_file_path, duration FROM animation_clips WHERE id = ? AND source_node_id = ?'
      )
      .get(idOrName, sceneNodeId) as ClipRow | undefined;
    if (!row) {
      row = db
        .prepare(
          'SELECT id, name, source_node_id, source_file_path, duration FROM animation_clips WHERE name = ? AND source_node_id = ?'
        )
        .get(idOrName, sceneNodeId) as ClipRow | undefined;
    }
    if (!row)
      throw new Error(
        `animation clip '${idOrName}' not found for node ${sceneNodeId}`
      );
    const duration = row.duration > 0 ? row.duration : DEFAULT_DURATION_SEC;
    if (!(row.duration > 0)) {
      console.warn(
        `[ApiController] clip ${row.id} has no duration; defaulting to ${DEFAULT_DURATION_SEC}s`
      );
    }
    return {
      animationId: row.id,
      sourceUrl: row.source_file_path,
      duration,
    };
  }
}
