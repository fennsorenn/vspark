import { describe, it, expect } from 'vitest';
import {
  InferGraph,
  defaultInfer,
  type InferPortsFn,
} from '../src/inference.js';
import type { PortMeta } from '../src/node.js';
import { RT, typeTagToResolved } from '../src/signal_types.js';

const port = (
  name: string,
  direction: PortMeta['direction'],
  typeTag: PortMeta['typeTag']
): PortMeta => ({ name, direction, transport: 'value', typeTag, member: name });

const PORTS: Record<string, PortMeta[]> = {
  source_float: [port('out', 'out', 'Float')],
  source_string: [port('out', 'out', 'String')],
  sink_float: [port('in', 'in', 'Float')],
  passthrough: [port('in', 'in', 'Any'), port('out', 'out', 'Any')],
  retype: [port('out', 'out', 'Any')],
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

const retypeInfer: InferPortsFn = (ctx) => {
  const c = (ctx.config ?? {}) as { outType?: 'Float' | 'String' };
  return {
    inputPorts: [],
    outputPorts: [{ name: 'out', type: RT.primitive(c.outType ?? 'Float') }],
  };
};

const INFER: Record<string, InferPortsFn | undefined> = {
  passthrough: passthroughInfer,
  retype: retypeInfer,
};

const makeGraph = () =>
  new InferGraph(
    (k) => INFER[k],
    (k) => PORTS[k] ?? []
  );

describe('defaultInfer', () => {
  it('splits static ports into resolved in/out', () => {
    const r = defaultInfer([
      port('a', 'in', 'Float'),
      port('b', 'out', 'String'),
    ]);
    expect(r.inputPorts.map((p) => p.name)).toEqual(['a']);
    expect(r.outputPorts.map((p) => p.name)).toEqual(['b']);
  });
});

describe('InferGraph node/port queries', () => {
  it('addNode + portsOf + outputType/inputType, with unknown fallbacks', () => {
    const g = makeGraph();
    g.addNode('src', 'source_float', {});
    g.addNode('snk', 'sink_float', {});
    expect(g.portsOf('src').outputPorts.map((p) => p.name)).toEqual(['out']);
    expect(g.portsOf('ghost')).toEqual({ inputPorts: [], outputPorts: [] });
    expect(g.outputType('src', 'out')).toEqual(RT.primitive('Float'));
    expect(g.outputType('src', 'nope')).toBeUndefined();
    expect(g.inputType('snk', 'in')).toEqual(RT.primitive('Float'));
    expect(g.outputType('ghost', 'out')).toBeUndefined();
  });
});

describe('InferGraph.tryAddEdge error branches', () => {
  it('reports unknown nodes and missing ports and type mismatches', () => {
    const g = makeGraph();
    g.addNode('src', 'source_float', {});
    g.addNode('ss', 'source_string', {});
    g.addNode('snk', 'sink_float', {});

    const unknownSrc = g.tryAddEdge({
      fromNodeId: 'x',
      fromPort: 'out',
      toNodeId: 'snk',
      toPort: 'in',
    });
    expect(unknownSrc).toEqual({ ok: false, reason: 'unknown source node x' });

    expect(
      g.tryAddEdge({
        fromNodeId: 'src',
        fromPort: 'out',
        toNodeId: 'y',
        toPort: 'in',
      }).ok
    ).toBe(false);
    expect(
      g.tryAddEdge({
        fromNodeId: 'src',
        fromPort: 'bad',
        toNodeId: 'snk',
        toPort: 'in',
      }).ok
    ).toBe(false);
    expect(
      g.tryAddEdge({
        fromNodeId: 'src',
        fromPort: 'out',
        toNodeId: 'snk',
        toPort: 'bad',
      }).ok
    ).toBe(false);

    // String → Float is a mismatch.
    const mismatch = g.tryAddEdge({
      fromNodeId: 'ss',
      fromPort: 'out',
      toNodeId: 'snk',
      toPort: 'in',
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toMatch(/type mismatch/);

    // Float → Float succeeds and is recorded.
    const edge = {
      fromNodeId: 'src',
      fromPort: 'out',
      toNodeId: 'snk',
      toPort: 'in',
    };
    expect(g.tryAddEdge(edge).ok).toBe(true);
    expect(g.hasEdge(edge)).toBe(true);
    expect(g.edges()).toHaveLength(1);
  });
});

describe('InferGraph.removeEdge', () => {
  it('clears the input, or recomputes from a remaining feeder; no-op on unknown', () => {
    const g = makeGraph();
    g.addNode('a', 'source_float', {});
    g.addNode('b', 'source_float', {});
    g.addNode('p', 'passthrough', {});
    const ea = {
      fromNodeId: 'a',
      fromPort: 'out',
      toNodeId: 'p',
      toPort: 'in',
    };
    const eb = {
      fromNodeId: 'b',
      fromPort: 'out',
      toNodeId: 'p',
      toPort: 'in',
    };
    g.tryAddEdge(ea);
    g.tryAddEdge(eb);
    expect(g.outputType('p', 'out')).toEqual(RT.primitive('Float'));

    // Removing one feeder leaves the other → input still Float.
    g.removeEdge(ea);
    expect(g.outputType('p', 'out')).toEqual(RT.primitive('Float'));
    // Removing the last feeder clears the input → out goes unknown.
    g.removeEdge(eb);
    expect(g.outputType('p', 'out')).toEqual(RT.unknown());
    // Unknown edge → no-op.
    expect(() => g.removeEdge(ea)).not.toThrow();
  });
});

describe('InferGraph.setConfig', () => {
  it('rejects unknown nodes', () => {
    const g = makeGraph();
    expect(g.setConfig('ghost', {}).ok).toBe(false);
  });

  it('re-infers on success and rolls back on a downstream conflict (multi-hop)', () => {
    const g = makeGraph();
    g.addNode('rt', 'retype', { outType: 'Float' });
    g.addNode('p1', 'passthrough', {});
    g.addNode('p2', 'passthrough', {});
    g.addNode('snk', 'sink_float', {});
    expect(
      g.tryAddEdge({
        fromNodeId: 'rt',
        fromPort: 'out',
        toNodeId: 'p1',
        toPort: 'in',
      }).ok
    ).toBe(true);
    expect(
      g.tryAddEdge({
        fromNodeId: 'p1',
        fromPort: 'out',
        toNodeId: 'p2',
        toPort: 'in',
      }).ok
    ).toBe(true);
    expect(
      g.tryAddEdge({
        fromNodeId: 'p2',
        fromPort: 'out',
        toNodeId: 'snk',
        toPort: 'in',
      }).ok
    ).toBe(true);

    // Compatible reconfigure (still Float) succeeds.
    expect(g.setConfig('rt', { outType: 'Float' }).ok).toBe(true);

    // Switching the source to String breaks sink_float three hops down → rollback.
    const res = g.setConfig('rt', { outType: 'String' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/downstream conflict/);
    // Rolled back: the whole chain is Float again.
    expect(g.outputType('rt', 'out')).toEqual(RT.primitive('Float'));
    expect(g.outputType('p2', 'out')).toEqual(RT.primitive('Float'));
  });
});

describe('InferGraph.removeNode', () => {
  it('removes the node and any edges touching it', () => {
    const g = makeGraph();
    g.addNode('src', 'source_float', {});
    g.addNode('snk', 'sink_float', {});
    g.tryAddEdge({
      fromNodeId: 'src',
      fromPort: 'out',
      toNodeId: 'snk',
      toPort: 'in',
    });
    g.removeNode('src');
    expect(g.edges()).toHaveLength(0);
    expect(g.portsOf('src')).toEqual({ inputPorts: [], outputPorts: [] });
  });
});
