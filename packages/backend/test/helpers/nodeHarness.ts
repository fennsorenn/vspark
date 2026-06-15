import { SignalGraph } from '../../src/signal/engine.js';
import { NODE_REGISTRY } from '../../src/signal/registry.js';
import { mkEvent, type GraphDescriptor } from '@vspark/shared/signal';

/**
 * Lightweight harness for unit-testing individual signal nodes through the real
 * engine (`fromDescriptor` → bind → fire/pull), without DB, sockets, or managers.
 *
 * - `buildGraph` wires an arbitrary node/edge set with per-node config + state.
 * - `pullValue` resolves one value-output port of a node in isolation: it wires
 *   that output into a `log` sink's list input and fires a `component_trigger`
 *   into the sink, forcing a lazy pull. Unconnected value inputs fall back to
 *   `config.<port>` (the engine's config-fallback path).
 */
type Cfg = Record<string, unknown>;

export function buildGraph(
  nodes: { id: string; kind: string }[],
  edges: GraphDescriptor['edges'],
  configByNode: Record<string, Cfg> = {},
  stateByNode: Record<string, unknown> = {}
): { graph: SignalGraph; states: Map<string, unknown> } {
  const descriptor: GraphDescriptor = {
    id: 'h',
    label: 'h',
    readonly: false,
    nodes: nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })),
    edges,
  };
  const states = new Map<string, unknown>(Object.entries(stateByNode));
  const graph = SignalGraph.fromDescriptor(
    descriptor,
    NODE_REGISTRY,
    (id) => configByNode[id] ?? {},
    (id) => states.get(id),
    (id, s) => states.set(id, s)
  );
  return { graph, states };
}

/** Pull a single value-output port (`config` supplies unconnected value inputs). */
export function pullValue(
  kind: string,
  outPort: string,
  config: Cfg = {},
  state?: unknown
): unknown {
  const { graph } = buildGraph(
    [
      { id: 'n', kind },
      { id: 'trg', kind: 'component_trigger' },
      { id: 'sink', kind: 'log' },
    ],
    [
      { fromNodeId: 'n', fromPort: outPort, toNodeId: 'sink', toPort: 'inputs' },
      { fromNodeId: 'trg', fromPort: 'trigger', toNodeId: 'sink', toPort: 'trigger' },
    ],
    { n: config },
    state !== undefined ? { n: state } : {}
  );
  graph.fire('trg', 'trigger', mkEvent(undefined));
  return (graph.peekInput('sink', 'inputs') as unknown[])[0];
}

/** Build a lone node and return helpers to deliver events into it + read state. */
export function loneNode(kind: string, config: Cfg = {}, state?: unknown) {
  const { graph } = buildGraph(
    [{ id: 'n', kind }],
    [],
    { n: config },
    state !== undefined ? { n: state } : {}
  );
  return {
    graph,
    deliver: (port: string, payload: unknown) =>
      graph.deliverExternal('n', port, mkEvent(payload)),
    state: <T = unknown>() => graph.getNodeState('n') as T,
  };
}
