import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkEvent } from '@vspark/shared/signal';
import { buildGraph } from './helpers/nodeHarness.js';

let consoleMocks: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleMocks = [vi.spyOn(console, 'log').mockImplementation(() => {})];
});
afterEach(() => consoleMocks.forEach((m) => m.mockRestore()));

/** Wire cycle's out0..out{n-1} into one log sink each; return graph + sink ids. */
function buildCycleGraph(n: number, config: Record<string, unknown> = {}) {
  const sinks = Array.from({ length: n }, (_, i) => `sink${i}`);
  const { graph, states } = buildGraph(
    [
      { id: 'cyc', kind: 'cycle' },
      ...sinks.map((id) => ({ id, kind: 'log' })),
    ],
    sinks.map((id, i) => ({
      fromNodeId: 'cyc',
      fromPort: `out${i}`,
      toNodeId: id,
      toPort: 'trigger',
    })),
    { cyc: { count: n, ...config } }
  );
  const fired = () =>
    sinks.map(
      (id) => (graph.peekInput(id, 'trigger') as { payload?: unknown } | undefined)?.payload
    );
  return { graph, fired, states };
}

describe('cycle node', () => {
  it('routes successive events round-robin across outputs (N=2 toggle)', () => {
    const { graph, fired } = buildCycleGraph(2);

    graph.deliverExternal('cyc', 'in', mkEvent('a'));
    expect(fired()).toEqual(['a', undefined]); // out0

    graph.deliverExternal('cyc', 'in', mkEvent('b'));
    expect(fired()).toEqual(['a', 'b']); // out1

    graph.deliverExternal('cyc', 'in', mkEvent('c'));
    expect(fired()).toEqual(['c', 'b']); // wrapped back to out0
  });

  it('cycles across N=3 outputs', () => {
    const { graph, fired } = buildCycleGraph(3);
    for (const v of ['x', 'y', 'z']) graph.deliverExternal('cyc', 'in', mkEvent(v));
    expect(fired()).toEqual(['x', 'y', 'z']);
    graph.deliverExternal('cyc', 'in', mkEvent('w'));
    expect(fired()).toEqual(['w', 'y', 'z']); // back to out0
  });

  it('advances the persisted index (survives reconcile)', () => {
    const { graph, states } = buildCycleGraph(2);
    graph.deliverExternal('cyc', 'in', mkEvent(undefined));
    expect((states.get('cyc') as { index: number }).index).toBe(1);
    graph.deliverExternal('cyc', 'in', mkEvent(undefined));
    expect((states.get('cyc') as { index: number }).index).toBe(0);
  });

  it('resumes from a pre-seeded index', () => {
    // Seed index=1 so the first fire lands on out1.
    const { graph, states } = buildGraph(
      [
        { id: 'cyc', kind: 'cycle' },
        { id: 's0', kind: 'log' },
        { id: 's1', kind: 'log' },
      ],
      [
        { fromNodeId: 'cyc', fromPort: 'out0', toNodeId: 's0', toPort: 'trigger' },
        { fromNodeId: 'cyc', fromPort: 'out1', toNodeId: 's1', toPort: 'trigger' },
      ],
      { cyc: { count: 2 } },
      { cyc: { index: 1 } }
    );
    graph.deliverExternal('cyc', 'in', mkEvent('hi'));
    expect((graph.peekInput('s1', 'trigger') as { payload: unknown }).payload).toBe('hi');
    expect(graph.peekInput('s0', 'trigger')).toBeUndefined();
    expect((states.get('cyc') as { index: number }).index).toBe(0);
  });

  it('clamps a stale out-of-range index when count shrinks', () => {
    // State says index=5 but count is now 2 → should map into range, not throw.
    const { graph, fired } = (() => {
      const sinks = ['s0', 's1'];
      const { graph } = buildGraph(
        [{ id: 'cyc', kind: 'cycle' }, ...sinks.map((id) => ({ id, kind: 'log' }))],
        sinks.map((id, i) => ({ fromNodeId: 'cyc', fromPort: `out${i}`, toNodeId: id, toPort: 'trigger' })),
        { cyc: { count: 2 } },
        { cyc: { index: 5 } }
      );
      const fired = () => sinks.map((id) => (graph.peekInput(id, 'trigger') as { payload?: unknown } | undefined)?.payload);
      return { graph, fired };
    })();
    expect(() => graph.deliverExternal('cyc', 'in', mkEvent('ok'))).not.toThrow();
    // 5 % 2 = 1 → out1
    expect(fired()).toEqual([undefined, 'ok']);
  });

  it('defaults to a 2-way toggle when count is missing or invalid', () => {
    const { graph } = buildGraph(
      [
        { id: 'cyc', kind: 'cycle' },
        { id: 's0', kind: 'log' },
        { id: 's1', kind: 'log' },
      ],
      [
        { fromNodeId: 'cyc', fromPort: 'out0', toNodeId: 's0', toPort: 'trigger' },
        { fromNodeId: 'cyc', fromPort: 'out1', toNodeId: 's1', toPort: 'trigger' },
      ],
      { cyc: {} } // no count → default 2
    );
    graph.deliverExternal('cyc', 'in', mkEvent(1));
    graph.deliverExternal('cyc', 'in', mkEvent(2));
    graph.deliverExternal('cyc', 'in', mkEvent(3));
    expect((graph.peekInput('s0', 'trigger') as { payload: unknown }).payload).toBe(3);
    expect((graph.peekInput('s1', 'trigger') as { payload: unknown }).payload).toBe(2);
  });
});
