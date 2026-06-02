/**
 * Signal graph runtime (Phase 2 — class-instance node model).
 *
 * The engine no longer dispatches a central `execute()`. Instead it WIRES live `Node`
 * instances: it provisions instrumented emitters for `@eventOut` ports, lazily-resolving
 * pull-thunks for `@valueIn`/`@listIn` ports, registers `@valueOut` thunks and `@eventIn`
 * handlers, and routes edges by their derived transport. The instrumented emitters/thunks
 * carry all the cross-cutting behaviour the old dispatcher provided: per-edge fire history
 * (`_edgeStates`) for the editor's live monitoring, the `enabled` gate, and per-node
 * try/catch error isolation.
 *
 * Topology is built by replaying a `GraphDescriptor`'s edges through an embedded
 * `InferGraph.tryAddEdge` (structural type validation). A rejected edge is skipped with a
 * warning (schema drift / hand-edited JSON). Cycles need no special handling — the
 * loop-closing edge is just another `tryAddEdge`, and runtime delivery is push/pull with
 * a re-entrancy guard on pulls.
 */

import type {
  SignalNodeClass,
  GraphDescriptor,
  NodeStateSnapshot,
  EdgeStateSnapshot,
  GraphStateSnapshot,
  Event,
} from '@vspark/shared/signal';
import { mkEvent } from '@vspark/shared/signal';
import {
  Node,
  getPortMeta,
  type NodeBindContext,
  type Emitter,
  type Thunk,
  type PortMeta,
} from '@vspark/shared/node';
import { InferGraph } from '@vspark/shared/inference';
import { INFER_BY_KIND } from '@vspark/shared/infer_nodes';

interface RuntimeNode {
  id: string;
  kind: string;
  instance: Node;
  staticPorts: PortMeta[];
  /** @eventIn handlers by port name (set during bind). */
  handlers: Map<string, (payload: unknown) => void>;
  /** @valueOut / dynamic value-out thunks by port name (set during bind). */
  outputThunks: Map<string, Thunk<unknown>>;
  lastInputs: Map<string, unknown>;
  lastOutputs: Map<string, unknown>;
  lastExecutedAt: number | null;
}

export class SignalGraph {
  private _registry: ReadonlyMap<string, SignalNodeClass> = new Map();
  private readonly _nodes = new Map<string, RuntimeNode>();
  private readonly _infer: InferGraph;

  /** Event edges: `${fromId}\x00${fromPort}` → [{toNodeId, toPort}]. */
  private readonly _eventEdges = new Map<
    string,
    Array<{ toNodeId: string; toPort: string }>
  >();
  /** Value edges: `${toId}\x00${toPort}` → {fromId, fromPort} (single source). */
  private readonly _valueEdges = new Map<
    string,
    { fromId: string; fromPort: string }
  >();
  /** List edges: `${toId}\x00${toPort}` → [{fromId, fromPort}] (fan-in). */
  private readonly _listEdges = new Map<
    string,
    Array<{ fromId: string; fromPort: string }>
  >();
  private readonly _edgeStates = new Map<string, EdgeStateSnapshot>();

  /** Guard against infinite pull recursion (value cycles). */
  private readonly _pulling = new Set<string>();

  constructor(
    private readonly _getConfig: (nodeId: string) => unknown,
    private readonly _getState: (nodeId: string) => unknown,
    private readonly _onSetState: (nodeId: string, state: unknown) => void
  ) {
    this._infer = new InferGraph(
      (kind) => INFER_BY_KIND[kind],
      (kind) => this._portsForKind(kind)
    );
  }

  private _portsForKind(kind: string): PortMeta[] {
    const cls = this._registry.get(kind);
    return cls ? getPortMeta(cls) : [];
  }

  // ── construction ──────────────────────────────────────────────────────────

  static fromDescriptor(
    descriptor: GraphDescriptor,
    registry: ReadonlyMap<string, SignalNodeClass>,
    getConfig: (nodeId: string) => unknown,
    getState: (nodeId: string) => unknown,
    onSetState: (nodeId: string, state: unknown) => void
  ): SignalGraph {
    const graph = new SignalGraph(getConfig, getState, onSetState);
    graph._registry = registry;

    // 1. Instantiate + bind every node.
    for (const n of descriptor.nodes) {
      const cls = registry.get(n.kind);
      if (!cls) throw new Error(`[SignalGraph] Unknown kind: "${n.kind}"`);
      graph._addNode(n.id, n.kind, cls);
    }

    // 2. Replay edges through inference; route accepted edges by derived transport.
    for (const e of descriptor.edges) {
      const res = graph._infer.tryAddEdge({
        fromNodeId: e.fromNodeId,
        fromPort: e.fromPort,
        toNodeId: e.toNodeId,
        toPort: e.toPort,
      });
      if (!res.ok) {
        console.warn(
          `[SignalGraph] dropped edge ${e.fromNodeId}.${e.fromPort} → ${e.toNodeId}.${e.toPort}: ${res.reason}`
        );
        continue;
      }
      graph._routeEdge(e.fromNodeId, e.fromPort, e.toNodeId, e.toPort);
    }
    return graph;
  }

  private _addNode(id: string, kind: string, cls: SignalNodeClass): void {
    const instance = new cls();
    const rt: RuntimeNode = {
      id,
      kind,
      instance,
      staticPorts: getPortMeta(cls),
      handlers: new Map(),
      outputThunks: new Map(),
      lastInputs: new Map(),
      lastOutputs: new Map(),
      lastExecutedAt: null,
    };
    this._nodes.set(id, rt);
    this._infer.addNode(id, kind, this._getConfig(id) ?? {});
    instance.bind(this._makeBindContext(rt));
  }

  /** Record an accepted edge in the transport-specific routing map. */
  private _routeEdge(
    fromId: string,
    fromPort: string,
    toId: string,
    toPort: string
  ): void {
    const transport = this._inputTransport(toId, toPort);
    if (transport === 'event') {
      const key = `${fromId}\x00${fromPort}`;
      let arr = this._eventEdges.get(key);
      if (!arr) this._eventEdges.set(key, (arr = []));
      arr.push({ toNodeId: toId, toPort });
    } else if (transport === 'list') {
      const key = `${toId}\x00${toPort}`;
      let arr = this._listEdges.get(key);
      if (!arr) this._listEdges.set(key, (arr = []));
      arr.push({ fromId, fromPort });
    } else {
      this._valueEdges.set(`${toId}\x00${toPort}`, { fromId, fromPort });
    }
  }

  /** Transport of a target input port, from the resolved inference graph. */
  private _inputTransport(nodeId: string, port: string): 'event' | 'value' | 'list' {
    const t = this._infer.inputType(nodeId, port);
    if (t?.kind === 'event') return 'event';
    if (t?.kind === 'list') return 'list';
    return 'value';
  }

  // ── bind context (per node) ──────────────────────────────────────────────

  private _makeBindContext(rt: RuntimeNode): NodeBindContext {
    const self = this;
    return {
      config: (self._getConfig(rt.id) ?? {}) as Record<string, unknown>,
      getState: <T>() => self._getState(rt.id) as T,
      setState: (s) => self._onSetState(rt.id, s),
      isEnabled: () =>
        (self._getConfig(rt.id) as Record<string, unknown> | null)?.enabled !==
        false,
      makeEmitter: (portName) => self._makeEmitter(rt, portName),
      makeDynamicEmitter: (portName) => self._makeEmitter(rt, portName),
      valueThunk: (portName) => self._valueThunk(rt.id, portName),
      listThunk: (portName) => self._listThunk(rt.id, portName),
      dynamicValueThunk: (portName) => self._valueThunk(rt.id, portName),
      registerOutputThunk: (portName, fn) => {
        rt.outputThunks.set(portName, fn);
      },
      registerHandler: (portName, fn) => {
        rt.handlers.set(portName, fn);
      },
    };
  }

  /**
   * Instrumented emitter for an @eventOut port. Wraps the raw payload in an
   * `Event<T>` (the single wrapping point for node-produced events; external
   * producers/managers pass a pre-wrapped Event straight to `fire`). Then records
   * the output and pushes downstream. A node author writes `this.out.emit(payload)`;
   * downstream @eventIn handlers receive the `Event<T>`.
   */
  private _makeEmitter(rt: RuntimeNode, portName: string): Emitter<unknown> {
    return {
      emit: (value: unknown) => {
        const ev: Event<unknown> = _isEvent(value) ? value : mkEvent(value);
        rt.lastOutputs.set(portName, ev);
        this.fire(rt.id, portName, ev);
      },
    };
  }

  /** Pull thunk for a value input: lazily resolves the wired source (or config fallback). */
  private _valueThunk(toId: string, toPort: string): Thunk<unknown> {
    return () => {
      const src = this._valueEdges.get(`${toId}\x00${toPort}`);
      let v: unknown;
      if (src) v = this._pullFrom(src.fromId, src.fromPort);
      // Auto-fallback to config.<port> when unconnected or the source yields undefined.
      if (v === undefined) {
        const cfg = (this._getConfig(toId) ?? {}) as Record<string, unknown>;
        v = cfg[toPort];
      }
      const rt = this._nodes.get(toId);
      rt?.lastInputs.set(toPort, v);
      return v;
    };
  }

  /** Gather thunk for a list input: pulls every connected source into an array. */
  private _listThunk(toId: string, toPort: string): Thunk<unknown[]> {
    return () => {
      const sources = this._listEdges.get(`${toId}\x00${toPort}`) ?? [];
      const out = sources
        .map((s) => this._pullFrom(s.fromId, s.fromPort))
        .filter((v) => v !== undefined);
      const rt = this._nodes.get(toId);
      rt?.lastInputs.set(toPort, out);
      return out;
    };
  }

  /** Resolve one output value of a source node (its registered @valueOut thunk). */
  private _pullFrom(fromId: string, fromPort: string): unknown {
    const rt = this._nodes.get(fromId);
    if (!rt) return undefined;
    const thunk = rt.outputThunks.get(fromPort);
    if (!thunk) return undefined;
    const guardKey = `${fromId}\x00${fromPort}`;
    if (this._pulling.has(guardKey)) return rt.lastOutputs.get(fromPort);
    this._pulling.add(guardKey);
    try {
      const v = thunk();
      rt.lastOutputs.set(fromPort, v);
      return v;
    } catch (err) {
      console.error(`[SignalGraph pull] ${fromId}.${fromPort} (${rt.kind}):`, err);
      return undefined;
    } finally {
      this._pulling.delete(guardKey);
    }
  }

  // ── execution ─────────────────────────────────────────────────────────────

  /** Push an event from `fromId.fromPort` to every subscribed @eventIn handler. */
  fire(fromId: string, fromPort: string, value: unknown): void {
    const key = `${fromId}\x00${fromPort}`;
    for (const { toNodeId, toPort } of this._eventEdges.get(key) ?? []) {
      const edgeKey = `${fromId}:${fromPort}:${toNodeId}:${toPort}`;
      this._edgeStates.set(edgeKey, {
        lastFiredAt: Date.now(),
        lastValue: _summarise(value),
      });
      this._deliverEvent(toNodeId, toPort, value);
    }
  }

  /**
   * Deliver a value directly to a node's event-input port from outside the topology
   * (external sources like OverliveManager that have no upstream edge).
   */
  deliverExternal(nodeId: string, portName: string, value: unknown): void {
    this._deliverEvent(nodeId, portName, value);
  }

  private _deliverEvent(toNodeId: string, toPort: string, value: unknown): void {
    const rt = this._nodes.get(toNodeId);
    if (!rt) return;
    // Enabled gate (mirrors the old dispatcher's skip).
    const cfg = this._getConfig(toNodeId) as Record<string, unknown> | null;
    if (cfg?.enabled === false) return;

    rt.lastInputs.set(toPort, value);
    const handler = rt.handlers.get(toPort);
    if (!handler) return;
    try {
      handler(value);
      rt.lastExecutedAt = Date.now();
    } catch (err) {
      console.error(`[SignalGraph] ${toNodeId}.${toPort} (${rt.kind}):`, err);
    }
  }

  // ── state access ──────────────────────────────────────────────────────────

  setNodeState(nodeId: string, state: unknown): void {
    this._onSetState(nodeId, state);
  }

  getNodeState(nodeId: string): unknown {
    return this._getState(nodeId);
  }

  // ── inspection ────────────────────────────────────────────────────────────

  peekInput(nodeId: string, portName: string): unknown {
    return this._nodes.get(nodeId)?.lastInputs.get(portName);
  }

  peekOutput(nodeId: string, portName: string): unknown {
    return this._nodes.get(nodeId)?.lastOutputs.get(portName);
  }

  getStates(): GraphStateSnapshot {
    const nodes: Record<string, NodeStateSnapshot> = {};
    for (const [id, node] of this._nodes) {
      const portValues: Record<string, unknown> = {};
      for (const [k, v] of node.lastOutputs) portValues[`out:${k}`] = _summarise(v);
      for (const [k, v] of node.lastInputs) portValues[`in:${k}`] = _summarise(v);
      nodes[id] = {
        lastExecutedAt: node.lastExecutedAt,
        portValues,
        config: this._getConfig(id),
      };
    }
    const edges: Record<string, EdgeStateSnapshot> = Object.fromEntries(
      this._edgeStates
    );
    return { nodes, edges };
  }
}

function _isEvent(v: unknown): v is Event<unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    'payload' in v &&
    'timestamp' in v
  );
}

function _summarise(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object' && 'payload' in (v as object)) {
    const ev = v as { payload: unknown; timestamp: number };
    return {
      _event: true,
      timestamp: ev.timestamp,
      kind: (ev.payload as { constructor?: { name?: string } })?.constructor?.name ?? typeof ev.payload,
    };
  }
  if (typeof v === 'object')
    return { _object: true, keys: Object.keys(v as object).slice(0, 8) };
  return v;
}
