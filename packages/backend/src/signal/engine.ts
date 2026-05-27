import type {
  SignalNodeClass,
  GraphDescriptor,
  PortDecl,
  NodeStateSnapshot,
  EdgeStateSnapshot,
  GraphStateSnapshot,
  NodeExecutionContext,
} from '@vspark/shared/signal';

type ErasedNode = {
  kind: string;
  inputPorts: ReadonlyArray<Pick<PortDecl, 'name' | 'kind'>>;
  execute(
    inputs: Record<string, unknown>,
    config: unknown,
    ctx: NodeExecutionContext
  ): Record<string, unknown>;
};

interface RuntimeNode {
  kind: string;
  def: ErasedNode;
  lastInputs: Map<string, unknown>;
  lastOutputs: Map<string, unknown>;
  lastExecutedAt: number | null;
}

export class SignalGraph {
  private readonly _defs = new Map<string, ErasedNode>();
  private readonly _nodes = new Map<string, RuntimeNode>();
  private readonly _fwdEdges = new Map<
    string,
    Array<{ toNodeId: string; toPort: string }>
  >();
  private readonly _valueEdges = new Map<
    string,
    { fromId: string; fromPort: string }
  >();
  private readonly _listEdges = new Map<
    string,
    Array<{ fromId: string; fromPort: string }>
  >();
  private readonly _edgeStates = new Map<string, EdgeStateSnapshot>();

  constructor(
    private readonly _getConfig: (nodeId: string) => unknown,
    private readonly _getState: (nodeId: string) => unknown,
    private readonly _onSetState: (nodeId: string, state: unknown) => void
  ) {}

  // ── construction ──────────────────────────────────────────────────────────

  register(cls: SignalNodeClass): this {
    this._defs.set(cls.kind, {
      kind: cls.kind,
      inputPorts: cls.inputPorts,
      execute: (inputs, config, ctx) => cls.execute(inputs, config, ctx),
    });
    return this;
  }

  addNode(id: string, kind: string): this {
    const def = this._defs.get(kind);
    if (!def) throw new Error(`[SignalGraph] Unknown node kind: "${kind}"`);
    this._nodes.set(id, {
      kind,
      def,
      lastInputs: new Map(),
      lastOutputs: new Map(),
      lastExecutedAt: null,
    });
    return this;
  }

  connect(
    fromId: string,
    fromPort: string,
    toId: string,
    toPort: string
  ): this {
    const key = `${fromId}\x00${fromPort}`;
    let targets = this._fwdEdges.get(key);
    if (!targets) {
      targets = [];
      this._fwdEdges.set(key, targets);
    }
    targets.push({ toNodeId: toId, toPort });
    return this;
  }

  connectValue(
    fromId: string,
    fromPort: string,
    toId: string,
    toPort: string
  ): this {
    this._valueEdges.set(`${toId}\x00${toPort}`, { fromId, fromPort });
    return this;
  }

  connectList(
    fromId: string,
    fromPort: string,
    toId: string,
    toPort: string
  ): this {
    const key = `${toId}\x00${toPort}`;
    let sources = this._listEdges.get(key);
    if (!sources) {
      sources = [];
      this._listEdges.set(key, sources);
    }
    sources.push({ fromId, fromPort });
    return this;
  }

  static fromDescriptor(
    descriptor: GraphDescriptor,
    registry: ReadonlyMap<string, SignalNodeClass>,
    getConfig: (nodeId: string) => unknown,
    getState: (nodeId: string) => unknown,
    onSetState: (nodeId: string, state: unknown) => void
  ): SignalGraph {
    const graph = new SignalGraph(getConfig, getState, onSetState);
    for (const n of descriptor.nodes) {
      const cls = registry.get(n.kind);
      if (!cls) throw new Error(`[SignalGraph] Unknown kind: "${n.kind}"`);
      graph.register(cls).addNode(n.id, n.kind);
    }
    for (const e of descriptor.edges) {
      if (e.kind === 'value')
        graph.connectValue(e.fromNodeId, e.fromPort, e.toNodeId, e.toPort);
      else if (e.kind === 'list')
        graph.connectList(e.fromNodeId, e.fromPort, e.toNodeId, e.toPort);
      else graph.connect(e.fromNodeId, e.fromPort, e.toNodeId, e.toPort);
    }
    return graph;
  }

  // ── execution ─────────────────────────────────────────────────────────────

  fire(fromId: string, fromPort: string, value: unknown): void {
    const key = `${fromId}\x00${fromPort}`;
    for (const { toNodeId, toPort } of this._fwdEdges.get(key) ?? []) {
      const edgeKey = `${fromId}:${fromPort}:${toNodeId}:${toPort}`;
      this._edgeStates.set(edgeKey, {
        lastFiredAt: Date.now(),
        lastValue: _summarise(value),
      });
      this._deliver(toNodeId, toPort, value);
    }
  }

  /**
   * Deliver a value directly to a node's input port from outside the graph
   * topology. Used by external event sources (e.g. OverliveManager) that
   * have no upstream edge but need to wake an event-receiving node.
   */
  deliverExternal(nodeId: string, portName: string, value: unknown): void {
    this._deliver(nodeId, portName, value);
  }

  // ── state access ──────────────────────────────────────────────────────────

  /** Set a node's persistent state from outside the graph (e.g. to inject source data). */
  setNodeState(nodeId: string, state: unknown): void {
    this._onSetState(nodeId, state);
  }

  /** Read a node's current persistent state. */
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
      for (const [k, v] of node.lastOutputs)
        portValues[`out:${k}`] = _summarise(v);
      for (const [k, v] of node.lastInputs)
        portValues[`in:${k}`] = _summarise(v);
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

  // ── internal ──────────────────────────────────────────────────────────────

  private _deliver(toNodeId: string, toPort: string, value: unknown): void {
    const triggeredPort = toPort;
    const node = this._nodes.get(toNodeId);
    if (!node) return;

    node.lastInputs.set(toPort, value);

    // Fetch config once — used for the enabled check and passed to execute.
    const config = this._getConfig(toNodeId);
    // Nodes with enabled: false are silently skipped.
    if ((config as Record<string, unknown> | null)?.enabled === false) return;

    const inputs: Record<string, unknown> = {};
    const cfgRec = (config ?? {}) as Record<string, unknown>;
    for (const p of node.def.inputPorts) {
      if (p.kind === 'value') {
        const pulled = this._pullValue(toNodeId, p.name);
        inputs[p.name] = pulled !== undefined ? pulled : cfgRec[p.name];
      } else if (p.kind === 'list')
        inputs[p.name] = this._pullList(toNodeId, p.name);
      else inputs[p.name] = node.lastInputs.get(p.name);
    }

    const ctx: NodeExecutionContext = {
      triggeredPort,
      getState: <T>() => this._getState(toNodeId) as T,
      setState: (s) => this._onSetState(toNodeId, s),
    };

    let outputs: Record<string, unknown>;
    try {
      outputs = node.def.execute(inputs, config, ctx);
    } catch (err) {
      console.error(`[SignalGraph] ${toNodeId} (${node.kind}):`, err);
      return;
    }

    node.lastExecutedAt = Date.now();
    for (const [portName, val] of Object.entries(outputs)) {
      node.lastOutputs.set(portName, val);
      this.fire(toNodeId, portName, val);
    }
  }

  /** Recursively execute a node and return the value of one of its output ports. */
  private _pullFrom(fromId: string, fromPort: string): unknown {
    const srcNode = this._nodes.get(fromId);
    if (!srcNode) return undefined;

    const ctx: NodeExecutionContext = {
      triggeredPort: '',
      getState: <T>() => this._getState(fromId) as T,
      setState: (s) => this._onSetState(fromId, s),
    };

    const inputs: Record<string, unknown> = {};
    const srcCfg = (this._getConfig(fromId) ?? {}) as Record<string, unknown>;
    for (const p of srcNode.def.inputPorts) {
      if (p.kind === 'value') {
        const pulled = this._pullValue(fromId, p.name);
        inputs[p.name] = pulled !== undefined ? pulled : srcCfg[p.name];
      } else if (p.kind === 'list')
        inputs[p.name] = this._pullList(fromId, p.name);
      else inputs[p.name] = srcNode.lastInputs.get(p.name);
    }

    let result: Record<string, unknown>;
    try {
      result = srcNode.def.execute(inputs, srcCfg, ctx);
    } catch (err) {
      console.error(`[SignalGraph pull] ${fromId} (${srcNode.kind}):`, err);
      return undefined;
    }

    const val = result[fromPort];
    srcNode.lastOutputs.set(fromPort, val);
    return val;
  }

  private _pullValue(toNodeId: string, toPort: string): unknown {
    const src = this._valueEdges.get(`${toNodeId}\x00${toPort}`);
    if (!src) return undefined;
    return this._pullFrom(src.fromId, src.fromPort);
  }

  private _pullList(toNodeId: string, toPort: string): unknown[] {
    const sources = this._listEdges.get(`${toNodeId}\x00${toPort}`) ?? [];
    return sources
      .map((src) => this._pullFrom(src.fromId, src.fromPort))
      .filter((v) => v !== undefined);
  }
}

function _summarise(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object' && 'payload' in (v as object)) {
    const ev = v as { payload: unknown; timestamp: number };
    return {
      _event: true,
      timestamp: ev.timestamp,
      kind: ev.payload?.constructor?.name ?? typeof ev.payload,
    };
  }
  if (typeof v === 'object')
    return { _object: true, keys: Object.keys(v as object).slice(0, 8) };
  return v;
}
