import { describe, it, expect } from 'vitest';
import { InferGraph, type InferPortsFn } from '../src/inference.js';
import type { PortMeta } from '../src/node.js';
import { RT, typeTagToResolved } from '../src/signal_types.js';

// ── Minimal node-kind fixtures ────────────────────────────────────────────────
// Each kind is a static set of declared ports. `passthrough` additionally carries
// an inferPorts fn whose OUTPUT type mirrors its connected input — this is what
// makes forward propagation (and thus rollback) observable with a tiny graph.

const port = (
  name: string,
  direction: PortMeta['direction'],
  typeTag: PortMeta['typeTag']
): PortMeta => ({ name, direction, transport: 'value', typeTag, member: name });

const PORTS: Record<string, PortMeta[]> = {
  source_float: [port('out', 'out', 'Float')],
  source_string: [port('out', 'out', 'String')],
  sink_float: [port('in', 'in', 'Float')],
  // `in` is `Any` so any source connects; `out` mirrors the resolved input.
  passthrough: [port('in', 'in', 'Any'), port('out', 'out', 'Any')],
};

const passthroughInfer: InferPortsFn = (ctx, staticPorts) => ({
  inputPorts: staticPorts
    .filter((p) => p.direction === 'in')
    .map((p) => ({
      name: p.name,
      type: typeTagToResolved(p.typeTag, p.transport),
    })),
  outputPorts: [
    { name: 'out', type: ctx.resolvedInputs['in'] ?? RT.unknown() },
  ],
});

function makeGraph(): InferGraph {
  return new InferGraph(
    (kind) => (kind === 'passthrough' ? passthroughInfer : undefined),
    (kind) => PORTS[kind] ?? []
  );
}

describe('InferGraph.tryAddEdge', () => {
  it('accepts a type-compatible edge', () => {
    const g = makeGraph();
    g.addNode('a', 'source_float', {});
    g.addNode('b', 'sink_float', {});

    const res = g.tryAddEdge({
      fromNodeId: 'a',
      fromPort: 'out',
      toNodeId: 'b',
      toPort: 'in',
    });

    expect(res.ok).toBe(true);
    expect(
      g.hasEdge({
        fromNodeId: 'a',
        fromPort: 'out',
        toNodeId: 'b',
        toPort: 'in',
      })
    ).toBe(true);
  });

  it('rejects a type-mismatched edge and does not record it', () => {
    const g = makeGraph();
    g.addNode('a', 'source_string', {});
    g.addNode('b', 'sink_float', {});

    const res = g.tryAddEdge({
      fromNodeId: 'a',
      fromPort: 'out',
      toNodeId: 'b',
      toPort: 'in',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/type mismatch/);
    expect(
      g.hasEdge({
        fromNodeId: 'a',
        fromPort: 'out',
        toNodeId: 'b',
        toPort: 'in',
      })
    ).toBe(false);
  });

  it('rolls the whole add back when it creates a downstream conflict', () => {
    const g = makeGraph();
    g.addNode('src', 'source_string', {});
    g.addNode('pass', 'passthrough', {});
    g.addNode('sink', 'sink_float', {});

    // pass.out is `unknown` while unconnected, so it flows into sink (Float).
    const e1 = g.tryAddEdge({
      fromNodeId: 'pass',
      fromPort: 'out',
      toNodeId: 'sink',
      toPort: 'in',
    });
    expect(e1.ok).toBe(true);
    expect(g.outputType('pass', 'out')).toEqual(RT.unknown());

    // Feeding a String into pass would re-infer pass.out → String, which is NOT
    // assignable to sink.in (Float). The add must be rejected and fully rolled back.
    const e2 = g.tryAddEdge({
      fromNodeId: 'src',
      fromPort: 'out',
      toNodeId: 'pass',
      toPort: 'in',
    });

    expect(e2.ok).toBe(false);
    if (!e2.ok) expect(e2.reason).toMatch(/downstream conflict/);
    // The offending edge was not recorded …
    expect(
      g.hasEdge({
        fromNodeId: 'src',
        fromPort: 'out',
        toNodeId: 'pass',
        toPort: 'in',
      })
    ).toBe(false);
    // … and pass.out was restored to its pre-attempt type.
    expect(g.outputType('pass', 'out')).toEqual(RT.unknown());
    // The pre-existing edge survives untouched.
    expect(
      g.hasEdge({
        fromNodeId: 'pass',
        fromPort: 'out',
        toNodeId: 'sink',
        toPort: 'in',
      })
    ).toBe(true);
  });
});
