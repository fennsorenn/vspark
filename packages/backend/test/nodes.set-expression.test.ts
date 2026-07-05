import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkEvent, Blendshapes } from '@vspark/shared/signal';
import { buildGraph } from './helpers/nodeHarness.js';
import { broadcastBus } from '../src/broadcast/bus.js';

let consoleMocks: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleMocks = [vi.spyOn(console, 'log').mockImplementation(() => {})];
});
afterEach(() => consoleMocks.forEach((m) => m.mockRestore()));

describe('set_expression node', () => {
  it('publishes a one-entry Blendshapes to the bus on fire', () => {
    const spy = vi.spyOn(broadcastBus, 'publishBlendshapes').mockImplementation(() => {});
    const { graph } = buildGraph(
      [{ id: 'se', kind: 'set_expression' }],
      [],
      { se: { nodeId: 'avatar-1', expression: 'Happy', weight: 0.75 } }
    );

    graph.deliverExternal('se', 'fire', mkEvent(undefined));

    expect(spy).toHaveBeenCalledTimes(1);
    const [nodeId, producerId, bs] = spy.mock.calls[0];
    expect(nodeId).toBe('avatar-1');
    expect(producerId).toBe('set_expression:se'); // derived from the node's graph id
    expect((bs as Blendshapes).toRecord()).toEqual({ Happy: 0.75 });
    spy.mockRestore();
  });

  it('defaults weight to 1 when absent / non-finite', () => {
    const spy = vi.spyOn(broadcastBus, 'publishBlendshapes').mockImplementation(() => {});
    const { graph } = buildGraph(
      [{ id: 'se', kind: 'set_expression' }],
      [],
      { se: { nodeId: 'a', expression: 'Blink' } } // no weight
    );
    graph.deliverExternal('se', 'fire', mkEvent(undefined));
    expect((spy.mock.calls[0][2] as Blendshapes).toRecord()).toEqual({ Blink: 1 });
    spy.mockRestore();
  });

  it('does nothing without a target node or expression', () => {
    const spy = vi.spyOn(broadcastBus, 'publishBlendshapes').mockImplementation(() => {});
    const noNode = buildGraph([{ id: 'se', kind: 'set_expression' }], [], {
      se: { expression: 'Happy' },
    });
    noNode.graph.deliverExternal('se', 'fire', mkEvent(undefined));
    const noExpr = buildGraph([{ id: 'se', kind: 'set_expression' }], [], {
      se: { nodeId: 'a' },
    });
    noExpr.graph.deliverExternal('se', 'fire', mkEvent(undefined));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('two nodes on the same avatar use distinct producer slots', () => {
    const spy = vi.spyOn(broadcastBus, 'publishBlendshapes').mockImplementation(() => {});
    const { graph } = buildGraph(
      [
        { id: 'a', kind: 'set_expression' },
        { id: 'b', kind: 'set_expression' },
      ],
      [],
      {
        a: { nodeId: 'av', expression: 'Happy', weight: 1 },
        b: { nodeId: 'av', expression: 'Angry', weight: 1 },
      }
    );
    graph.deliverExternal('a', 'fire', mkEvent(undefined));
    graph.deliverExternal('b', 'fire', mkEvent(undefined));
    expect(spy.mock.calls[0][1]).toBe('set_expression:a');
    expect(spy.mock.calls[1][1]).toBe('set_expression:b');
    expect(spy.mock.calls[0][1]).not.toBe(spy.mock.calls[1][1]);
    spy.mockRestore();
  });

  it('releases its producer slot on graph dispose', () => {
    const removeSpy = vi.spyOn(broadcastBus, 'removeBehavior').mockImplementation(() => {});
    const { graph } = buildGraph(
      [{ id: 'se', kind: 'set_expression' }],
      [],
      { se: { nodeId: 'a', expression: 'Happy' } }
    );
    graph.dispose();
    expect(removeSpy).toHaveBeenCalledWith('set_expression:se');
    removeSpy.mockRestore();
  });
});
