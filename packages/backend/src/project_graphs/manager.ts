/**
 * ProjectGraphManager — lifecycle owner for standalone, project-scoped signal
 * graphs. Unlike component-owned graphs (one per node_component row, hosted by
 * its component manager), these are user-authored: edits flow in via REST and
 * the manager re-instantiates the underlying SignalGraph.
 *
 * Project graphs do NOT participate in the component context system. They have
 * no scene_entity, no component_config, no component_id — those nodes throw if
 * placed inside one (see `forbidContextNode` below).
 *
 * Per-graph node state is persisted on the project_graphs row in a `node_state`
 * JSON column (mirroring the `_nodeState` convention used by component-owned
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

/** Node kinds that depend on the component-context system. Reject in project graphs. */
const COMPONENT_CONTEXT_KINDS = new Set([
  'component_config',
  'component_id',
  'scene_entity',
]);

export interface GraphRow {
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

export type ProjectGraphRow = GraphRow;

interface RunningGraph {
  graph: SignalGraph;
  descriptor: GraphDescriptor;
  nodeStates: Map<string, unknown>;
  cleanups: Array<() => void>;
}

export class ProjectGraphManager {
  private readonly running = new Map<string, RunningGraph>();

  // ── REST API entry points ─────────────────────────────────────────────────

  /** List all graphs for a project. */
  list(projectId: string): GraphRow[] {
    return getDb()
      .prepare(
        "SELECT * FROM graphs WHERE owner_kind = 'project' AND owner_id = ? ORDER BY created_at"
      )
      .all(projectId) as unknown as GraphRow[];
  }

  get(id: string): GraphRow | undefined {
    return getDb()
      .prepare('SELECT * FROM graphs WHERE id = ?')
      .get(id) as unknown as GraphRow | undefined;
  }

  create(input: { id: string; projectId: string; name: string }): GraphRow {
    const db = getDb();
    db.prepare(
      "INSERT INTO graphs (id, owner_kind, owner_id, name) VALUES (?, 'project', ?, ?)"
    ).run(input.id, input.projectId, input.name);
    return this.get(input.id)!;
  }

  update(
    id: string,
    patch: { name?: string; enabled?: boolean; descriptor?: GraphDescriptor }
  ): ProjectGraphRow | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const db = getDb();
    if (patch.name !== undefined) {
      db.prepare(
        "UPDATE graphs SET name = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(patch.name, id);
    }
    if (patch.enabled !== undefined) {
      db.prepare(
        "UPDATE graphs SET enabled = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(patch.enabled ? 1 : 0, id);
    }
    if (patch.descriptor !== undefined) {
      validateDescriptor(patch.descriptor);
      db.prepare(
        "UPDATE graphs SET descriptor = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(JSON.stringify(patch.descriptor), id);
    }
    // Reconcile the running instance with the new state.
    this.reconcile(id);
    return this.get(id);
  }

  remove(id: string): void {
    this.stop(id);
    getDb().prepare('DELETE FROM graphs WHERE id = ?').run(id);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Start any graphs that are persisted as enabled. Called at server boot. */
  startAllEnabled(): void {
    const rows = getDb()
      .prepare(
        "SELECT id FROM graphs WHERE owner_kind = 'project' AND enabled = 1"
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
      validateDescriptor(descriptor);

      const nodeStates = parseNodeStateMap(row.node_state);

      const graph = SignalGraph.fromDescriptor(
        descriptor,
        NODE_REGISTRY,
        (nodeId) => this._getNodeConfig(descriptor, nodeId),
        (nodeId) => nodeStates.get(nodeId) ?? {},
        (nodeId, state) => {
          nodeStates.set(nodeId, state);
          this._persistNodeState(id, nodeId, state);
        }
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
        `[ProjectGraph] Started ${row.name} (${id}) — ${descriptor.nodes.length} nodes, ${descriptor.edges.length} edges`
      );
    } catch (e) {
      console.error(`[ProjectGraph] Failed to start ${row.name} (${id}):`, e);
    }
  }

  private stop(id: string): void {
    const r = this.running.get(id);
    if (!r) return;
    for (const fn of r.cleanups) fn();
    this.running.delete(id);
    console.log(`[ProjectGraph] Stopped ${id}`);
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
      for (const node of r.descriptor.nodes) {
        yield { graphId, node, projectId: row.owner_id };
      }
    }
  }

  close(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private _getNodeConfig(descriptor: GraphDescriptor, nodeId: string): unknown {
    const nodeDef = descriptor.nodes.find((n) => n.id === nodeId);
    const defaults = (nodeDef?.defaultConfig ?? {}) as Record<string, unknown>;
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
          "UPDATE graphs SET node_state = ?, updated_at = datetime('now') WHERE id = ?"
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
 * Reject descriptors that reference component-context nodes — those can only
 * resolve when running inside a node_component manager, not a standalone graph.
 */
function validateDescriptor(d: GraphDescriptor): void {
  for (const n of d.nodes) {
    if (COMPONENT_CONTEXT_KINDS.has(n.kind)) {
      throw new Error(
        `Project graphs cannot use component-context node "${n.kind}". ` +
          `These nodes are only valid inside node_component graphs.`
      );
    }
  }
}

// Singleton — mounted by routes/shared.ts.
export const projectGraphManager = new ProjectGraphManager();
