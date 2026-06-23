import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalGraph } from '../src/signal/engine.js';
import { NODE_REGISTRY } from '../src/signal/registry.js';
import { mkEvent, type GraphDescriptor } from '@vspark/shared/signal';

/**
 * Exemplar engine test. Builds a tiny three-node graph through the real
 * `fromDescriptor` path (instantiation + edge inference + transport routing),
 * fires an event into it, and asserts both push delivery (event) and lazy pull
 * (value + list fan-in) reach a downstream node. This exercises the engine's
 * core wiring in one shot without any DB, sockets, or managers.
 *
 *   component_trigger.trigger ──(event)──▶ log.trigger
 *           multiply.value ─────(list)───▶ log.inputs
 */
function buildGraph(config: Record<string, unknown> = {}) {
  const descriptor: GraphDescriptor = {
    id: 'test-graph',
    label: 'test',
    readonly: false,
    nodes: [
      { id: 'trig', kind: 'component_trigger', position: { x: 0, y: 0 } },
      { id: 'mul', kind: 'multiply', position: { x: 0, y: 100 } },
      { id: 'log', kind: 'log', position: { x: 200, y: 0 } },
    ],
    edges: [
      { fromNodeId: 'trig', fromPort: 'trigger', toNodeId: 'log', toPort: 'trigger' },
      { fromNodeId: 'mul', fromPort: 'value', toNodeId: 'log', toPort: 'inputs' },
    ],
  };

  // Per-node config: the multiply node's unconnected inputs fall back to config.<port>.
  const configByNode: Record<string, Record<string, unknown>> = {
    mul: { a: 6, b: 7 },
    ...config,
  };
  const state = new Map<string, unknown>();

  const graph = SignalGraph.fromDescriptor(
    descriptor,
    NODE_REGISTRY,
    (id) => configByNode[id] ?? {},
    (id) => state.get(id),
    (id, s) => state.set(id, s)
  );
  return graph;
}

describe('SignalGraph engine', () => {
  // The log node prints to console on fire; silence it for clean test output.
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('builds from a descriptor and delivers a fired event to a downstream handler', () => {
    const graph = buildGraph();
    const ev = mkEvent(undefined);

    graph.fire('trig', 'trigger', ev);

    // The downstream node's event-input received exactly the event we fired …
    expect(graph.peekInput('log', 'trigger')).toBe(ev);
    // … and its handler actually ran (recorded execution time).
    const states = graph.getStates();
    expect(states.nodes['log'].lastExecutedAt).toBeTypeOf('number');
    // The fired edge is recorded in the edge-state map for the editor's monitoring.
    expect(Object.keys(states.edges)).toContain('trig:trigger:log:trigger');
  });

  it('lazily pulls a wired value output (with config fallback) when the handler reads it', () => {
    const graph = buildGraph();

    graph.fire('trig', 'trigger', mkEvent(undefined));

    // log.onTrigger reads its `inputs` list port, which pulls multiply.value.
    // multiply has no wired inputs, so a/b resolve from config (6 × 7 = 42).
    expect(graph.peekInput('log', 'inputs')).toEqual([42]);
  });

  it('throws on an unknown node kind', () => {
    const descriptor: GraphDescriptor = {
      id: 'bad',
      label: 'bad',
      readonly: false,
      nodes: [{ id: 'x', kind: 'no_such_kind', position: { x: 0, y: 0 } }],
      edges: [],
    };
    expect(() =>
      SignalGraph.fromDescriptor(
        descriptor,
        NODE_REGISTRY,
        () => ({}),
        () => undefined,
        () => {}
      )
    ).toThrow(/Unknown kind/);
  });
});
