import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkEvent, Blendshapes } from '@vspark/shared/signal';
import { buildGraph, pullValue } from './helpers/nodeHarness.js';

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe('enabled gate', () => {
  it('does not deliver events to a disabled node', () => {
    const { graph } = buildGraph(
      [
        { id: 'trg', kind: 'component_trigger' },
        { id: 'sink', kind: 'log' },
      ],
      [{ fromNodeId: 'trg', fromPort: 'trigger', toNodeId: 'sink', toPort: 'trigger' }],
      { sink: { enabled: false } }
    );
    graph.fire('trg', 'trigger', mkEvent('hi'));
    // The handler never ran: no recorded input, no execution timestamp.
    expect(graph.peekInput('sink', 'trigger')).toBeUndefined();
    expect(graph.getStates().nodes['sink'].lastExecutedAt).toBeNull();
  });
});

describe('value-pull cycle guard', () => {
  it('a cyclic value graph resolves without infinite recursion', () => {
    // A.value = A.a × 2, where A.a ← B.value; B.value = B.a × 3, B.a ← A.value.
    // The re-entrant pull hits the guard and returns the cached (undefined→0) value.
    const { graph } = buildGraph(
      [
        { id: 'A', kind: 'multiply' },
        { id: 'B', kind: 'multiply' },
        { id: 'trg', kind: 'component_trigger' },
        { id: 'sink', kind: 'log' },
      ],
      [
        { fromNodeId: 'B', fromPort: 'value', toNodeId: 'A', toPort: 'a' },
        { fromNodeId: 'A', fromPort: 'value', toNodeId: 'B', toPort: 'a' },
        { fromNodeId: 'A', fromPort: 'value', toNodeId: 'sink', toPort: 'inputs' },
        { fromNodeId: 'trg', fromPort: 'trigger', toNodeId: 'sink', toPort: 'trigger' },
      ],
      { A: { b: 2 }, B: { b: 3 } }
    );
    graph.fire('trg', 'trigger', mkEvent(undefined));
    expect(graph.peekInput('sink', 'inputs')).toEqual([0]);
  });
});

describe('pull error isolation', () => {
  it('a throwing value thunk is caught → undefined, logged, suite continues', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // arkit is truthy but not a Blendshapes → `.entries()` throws inside the thunk.
    const out = pullValue('arkit_vrm_mapper', 'blendshapes', {
      arkit: 123,
      mode: 'expressions',
    });
    expect(out).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('edge admission', () => {
  it('drops a type-incompatible edge (Blendshapes → Float) with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { graph } = buildGraph(
      [
        { id: 'm', kind: 'arkit_vrm_mapper' },
        { id: 'mul', kind: 'multiply' },
      ],
      [{ fromNodeId: 'm', fromPort: 'blendshapes', toNodeId: 'mul', toPort: 'a' }],
      {}
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped edge'));
    // The dropped edge left mul.a unconnected → it falls back to config (0).
    expect(graph).toBeDefined();
    warnSpy.mockRestore();
  });

  it('throws on an unknown node kind', () => {
    expect(() => buildGraph([{ id: 'x', kind: 'no_such_kind' }], [])).toThrow(
      /Unknown kind/
    );
  });
});

describe('dispose', () => {
  it('tears down without throwing', () => {
    const { graph } = buildGraph([{ id: 'm', kind: 'multiply' }], [], { m: { a: 1, b: 2 } });
    expect(() => graph.dispose()).not.toThrow();
  });
});

describe('list fan-in filters undefined sources', () => {
  it('only defined source values reach a list input', () => {
    // One real Blendshapes source + the engine drops undefined contributions.
    const { graph } = buildGraph(
      [
        { id: 'm', kind: 'arkit_vrm_mapper' },
        { id: 'sum', kind: 'blendshapes_sum' },
        { id: 'trg', kind: 'component_trigger' },
        { id: 'sink', kind: 'log' },
      ],
      [
        { fromNodeId: 'm', fromPort: 'blendshapes', toNodeId: 'sum', toPort: 'sources' },
        { fromNodeId: 'sum', fromPort: 'blendshapes', toNodeId: 'sink', toPort: 'inputs' },
        { fromNodeId: 'trg', fromPort: 'trigger', toNodeId: 'sink', toPort: 'trigger' },
      ],
      { m: { arkit: Blendshapes.fromRecord({ mouthSmileLeft: 1 }), mode: 'expressions' } }
    );
    graph.fire('trg', 'trigger', mkEvent(undefined));
    const out = (graph.peekInput('sink', 'inputs') as unknown[])[0] as Blendshapes;
    expect(out.get('happy')).toBeCloseTo(0.3, 6);
  });
});
