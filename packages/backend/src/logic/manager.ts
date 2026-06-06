/**
 * LogicManager — lifecycle owner for *all* user-authored standalone
 * graphs: project-scoped, scene-node-scoped, and compose-layer-scoped. Unlike
 * behavior-owned graphs (one per behaviors row, hosted by its behavior
 * manager), these are user-authored: edits flow in via REST and the manager
 * re-instantiates the underlying SignalGraph.
 *
 * Context-node availability depends on owner_kind:
 *   - 'project'        — no context nodes at all.
 *   - 'scene_node'     — `scene_entity` is auto-fed the attached node's id and
 *                        outputs a `SceneNode`; behavior_config / behavior_id
 *                        are still forbidden.
 *   - 'compose_layer'  — `scene_entity` is auto-fed the layer's id and outputs a
 *                        `ComposeLayer` (its output type follows the scope via
 *                        `inferSceneEntity`); behavior context still forbidden.
 *
 * Per-graph node state is persisted on the logic row in a `node_state` JSON
 * column (mirroring the `_nodeState` convention used by behavior-owned
 * managers).
 */
import { SignalGraph } from '../signal/engine.js';
import { NODE_REGISTRY } from '../signal/registry.js';
import { Clock } from '../signal/nodes/clock.js';
import { getDb } from '../db/index.js';
import type {
  GraphDescriptor,
  GraphStateSnapshot,
} from '@vspark/shared/signal';
import type { LogicOwnerKind } from '@vspark/shared/types';

/** Node kinds that depend on the behavior-context system. Always rejected
 *  in logic because there's no behavior to read config from. */
const ALWAYS_FORBIDDEN_CONTEXT_KINDS = new Set([
  'behavior_config',
  'behavior_id',
]);

export interface LogicRow {
  id: string;
  owner_kind: string;
  owner_id: string;
  name: string;
  enabled: 0 | 1;
  descriptor: string;
  node_state: string;
  created_at: string;
  updated_at: string;
}

export type ProjectLogicRow = LogicRow;

interface RunningGraph {
  graph: SignalGraph;
  descriptor: GraphDescriptor;
  nodeStates: Map<string, unknown>;
  cleanups: Array<() => void>;
}

export class LogicManager {
  private readonly running = new Map<string, RunningGraph>();

  // ── REST API entry points ─────────────────────────────────────────────────

  /** List all graphs for a project. */
  list(projectId: string): LogicRow[] {
    return getDb()
      .prepare(
        "SELECT * FROM logic WHERE owner_kind = 'project' AND owner_id = ? ORDER BY created_at"
      )
      .all(projectId) as unknown as LogicRow[];
  }

  get(id: string): LogicRow | undefined {
    return getDb()
      .prepare('SELECT * FROM logic WHERE id = ?')
      .get(id) as unknown as LogicRow | undefined;
  }

  create(input: { id: string; projectId: string; name: string }): LogicRow {
    const db = getDb();
    db.prepare(
      "INSERT INTO logic (id, owner_kind, owner_id, name) VALUES (?, 'project', ?, ?)"
    ).run(input.id, input.projectId, input.name);
    return this.get(input.id)!;
  }

  update(
    id: string,
    patch: { name?: string; enabled?: boolean; descriptor?: GraphDescriptor }
  ): ProjectLogicRow | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const db = getDb();
    if (patch.name !== undefined) {
      db.prepare(
        "UPDATE logic SET name = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(patch.name, id);
    }
    if (patch.enabled !== undefined) {
      db.prepare(
        "UPDATE logic SET enabled = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(patch.enabled ? 1 : 0, id);
    }
    if (patch.descriptor !== undefined) {
      validateDescriptor(patch.descriptor, existing.owner_kind);
      db.prepare(
        "UPDATE logic SET descriptor = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(JSON.stringify(patch.descriptor), id);
    }
    // Reconcile the running instance with the new state.
    this.reconcile(id);
    return this.get(id);
  }

  remove(id: string): void {
    this.stop(id);
    getDb().prepare('DELETE FROM logic WHERE id = ?').run(id);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Start any logic (project / scene_node / compose_layer) that
   *  are persisted as enabled. Called at server boot. Behavior-owned graphs
   *  are NOT in this set — those are started by their behavior managers. */
  startAllEnabled(): void {
    const rows = getDb()
      .prepare(
        "SELECT id FROM logic WHERE owner_kind IN ('project', 'scene_node', 'compose_layer') AND enabled = 1"
      )
      .all() as Array<{ id: string }>;
    for (const { id } of rows) this.start(id);
  }

  /** Reconcile a single graph: start if enabled, stop if not. */
  reconcile(id: string): void {
    const row = this.get(id);
    if (!row) {
      this.stop(id);
      return;
    }
    if (row.enabled === 1) {
      this.stop(id);
      this.start(id);
    } else {
      this.stop(id);
    }
  }

  private start(id: string): void {
    if (this.running.has(id)) return;
    const row = this.get(id);
    if (!row || row.enabled !== 1) return;
    try {
      const descriptor = JSON.parse(row.descriptor) as GraphDescriptor;
      validateDescriptor(descriptor, row.owner_kind);

      const nodeStates = parseNodeStateMap(row.node_state);

      const graph = SignalGraph.fromDescriptor(
        descriptor,
        NODE_REGISTRY,
        (nodeId) => this._getNodeConfig(descriptor, nodeId, row),
        (nodeId) => nodeStates.get(nodeId) ?? {},
        (nodeId, state) => {
          nodeStates.set(nodeId, state);
          this._persistNodeState(id, nodeId, state);
        },
        row.owner_kind as LogicOwnerKind
      );

      // Clock nodes self-tick.
      const cleanups: Array<() => void> = [];
      for (const nodeDef of descriptor.nodes) {
        if (nodeDef.kind === 'clock') {
          const defaultHz =
            (nodeDef.defaultConfig?.hz as number | undefined) ?? 30;
          cleanups.push(
            Clock.attach(
              nodeDef.id,
              defaultHz,
              (gId) => {
                const state = nodeStates.get(gId) as
                  | { hz?: number }
                  | undefined;
                return state?.hz ?? defaultHz;
              },
              (gId, port, value) => graph.fire(gId, port, value)
            )
          );
        }
      }

      this.running.set(id, { graph, descriptor, nodeStates, cleanups });
      console.log(
        `[Logic] Started ${row.name} (${id}) — ${descriptor.nodes.length} nodes, ${descriptor.edges.length} edges`
      );
    } catch (e) {
      console.error(`[Logic] Failed to start ${row.name} (${id}):`, e);
    }
  }

  private stop(id: string): void {
    const r = this.running.get(id);
    if (!r) return;
    for (const fn of r.cleanups) fn();
    // Tear down nodes so they release external resources (e.g. set_data clears
    // its data-channel entries — otherwise retired scoped data lingers and
    // shadows global on feed layers).
    r.graph.dispose();
    this.running.delete(id);
    console.log(`[Logic] Stopped ${id}`);
  }

  /**
   * Deliver an external event into a node's input port on the running graph.
   * Used by OverliveManager to inject Twitch/SE events into overlive_* nodes,
   * which have no upstream edges (they're sources, but driven from outside
   * the graph rather than from a clock/timer). No-op if the graph isn't
   * running.
   */
  fire(
    graphId: string,
    nodeId: string,
    portName: string,
    value: unknown
  ): void {
    const r = this.running.get(graphId);
    if (!r) return;
    r.graph.deliverExternal(nodeId, portName, value);
  }

  /** All currently running graph descriptors, for WS-driven editors. */
  getRunningDescriptors(): Array<{ id: string; descriptor: GraphDescriptor }> {
    return Array.from(this.running.entries()).map(([id, r]) => ({
      id,
      descriptor: r.descriptor,
    }));
  }

  getStates(graphId: string): GraphStateSnapshot | null {
    const r = this.running.get(graphId);
    if (r) return r.graph.getStates();
    // Graph exists in DB but isn't running (e.g. disabled, or just-created
    // and reconcile hasn't been called yet, or start() threw). Return an empty
    // snapshot rather than null so the canvas polling doesn't 404 every 500ms.
    const row = this.get(graphId);
    if (!row) return null;
    return { nodes: {}, edges: {} };
  }

  /**
   * Walk every running graph and yield its nodes. The OverliveManager uses
   * this to find which overlive_* nodes exist in which project's graphs.
   */
  *iterateNodes(): Iterable<{
    graphId: string;
    node: GraphDescriptor['nodes'][number];
    projectId: string;
  }> {
    for (const [graphId, r] of this.running) {
      const row = this.get(graphId);
      if (!row) continue;
      const projectId = this._resolveProjectId(row);
      if (!projectId) continue;
      for (const node of r.descriptor.nodes) {
        yield { graphId, node, projectId };
      }
    }
  }

  /** Find the project id this graph runs under, regardless of owner kind.
   *  Used by overlive routing so scoped graphs receive events for the
   *  right project. */
  private _resolveProjectId(row: LogicRow): string | null {
    if (row.owner_kind === 'project') return row.owner_id;
    if (row.owner_kind === 'scene_node') {
      const r = getDb()
        .prepare('SELECT project_id FROM scene_nodes WHERE id = ?')
        .get(row.owner_id) as { project_id?: string } | undefined;
      return r?.project_id ?? null;
    }
    if (row.owner_kind === 'compose_layer') {
      const r = getDb()
        .prepare('SELECT project_id FROM compose_layers WHERE id = ?')
        .get(row.owner_id) as { project_id?: string } | undefined;
      return r?.project_id ?? null;
    }
    return null;
  }

  close(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private _getNodeConfig(
    descriptor: GraphDescriptor,
    nodeId: string,
    row: LogicRow
  ): unknown {
    const nodeDef = descriptor.nodes.find((n) => n.id === nodeId);
    const defaults = (nodeDef?.defaultConfig ?? {}) as Record<string, unknown>;
    // For scene-node- and compose-layer-scoped graphs, auto-inject the owner
    // entity's id as the `nodeId` config of any `scene_entity` instance. The
    // node just reads config.nodeId — its OUTPUT TYPE follows the scope
    // (SceneNode vs ComposeLayer) via `inferSceneEntity`. No further plumbing.
    if (
      (row.owner_kind === 'scene_node' || row.owner_kind === 'compose_layer') &&
      nodeDef?.kind === 'scene_entity' &&
      defaults.nodeId == null
    ) {
      return { ...defaults, nodeId: row.owner_id };
    }
    return { ...defaults };
  }

  private _persistNodeState(
    graphId: string,
    nodeId: string,
    state: unknown
  ): void {
    try {
      const row = this.get(graphId);
      if (!row) return;
      const map = parseNodeStateMap(row.node_state);
      map.set(nodeId, state);
      const next = Object.fromEntries(map.entries());
      getDb()
        .prepare(
          "UPDATE logic SET node_state = ?, updated_at = datetime('now') WHERE id = ?"
        )
        .run(JSON.stringify(next), graphId);
    } catch {
      /* non-fatal */
    }
  }
}

function parseNodeStateMap(raw: string): Map<string, unknown> {
  try {
    const obj = JSON.parse(raw || '{}') as Record<string, unknown>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

/**
 * Reject descriptors that reference context nodes the owner kind can't
 * satisfy. behavior_config / behavior_id always need a behavior context
 * and so are forbidden in every logic; scene_entity is allowed in
 * scene-node- and compose-layer-scoped graphs (where the manager auto-feeds its
 * nodeId config and its output type follows the scope), but not in
 * project-scoped graphs, which have no owner entity.
 */
function validateDescriptor(d: GraphDescriptor, ownerKind: string): void {
  const sceneEntityAllowed =
    ownerKind === 'scene_node' || ownerKind === 'compose_layer';
  for (const n of d.nodes) {
    if (ALWAYS_FORBIDDEN_CONTEXT_KINDS.has(n.kind)) {
      throw new Error(
        `Logic cannot use behavior-context node "${n.kind}". ` +
          `These nodes are only valid inside behavior graphs.`
      );
    }
    if (n.kind === 'scene_entity' && !sceneEntityAllowed) {
      throw new Error(
        `scene_entity can only be used in scene-node- or compose-layer-scoped ` +
          `graphs, not '${ownerKind}'.`
      );
    }
  }
}

// Singleton — mounted by routes/shared.ts.
export const logicManager = new LogicManager();
