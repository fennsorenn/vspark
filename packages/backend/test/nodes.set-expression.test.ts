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
  it('publishes a one-entry Blendshapes keyed by (avatar, expression)', () => {
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
    // Slot key is (avatar, expression), NOT the node id.
    expect(producerId).toBe('set_expression:avatar-1:Happy');
    expect((bs as Blendshapes).toRecord()).toEqual({ Happy: 0.75 });
    spy.mockRestore();
  });

  it('defaults weight to 1 when absent / non-finite', () => {
    const spy = vi.spyOn(broadcastBus, 'publishBlendshapes').mockImplementation(() => {});
    const { graph } = buildGraph(
      [{ id: 'se', kind: 'set_expression' }],
      [],
      { se: { nodeId: 'a', expression: 'Blink' } }
    );
    graph.deliverExternal('se', 'fire', mkEvent(undefined));
    expect((spy.mock.calls[0][2] as Blendshapes).toRecord()).toEqual({ Blink: 1 });
    spy.mockRestore();
  });

  it('does nothing without a target node or expression', () => {
    const spy = vi.spyOn(broadcastBus, 'publishBlendshapes').mockImplementation(() => {});
    buildGraph([{ id: 'se', kind: 'set_expression' }], [], { se: { expression: 'Happy' } })
      .graph.deliverExternal('se', 'fire', mkEvent(undefined));
    buildGraph([{ id: 'se', kind: 'set_expression' }], [], { se: { nodeId: 'a' } })
      .graph.deliverExternal('se', 'fire', mkEvent(undefined));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('toggle: two nodes on the same (avatar, expression) share ONE slot (last wins)', () => {
    // This is the regression: previously each node had its own slot and the bus
    // SUMMED them, so "Happy=1" + "Happy=0" stuck at 1. Same producer id → the
    // 0 overwrites the 1.
    const spy = vi.spyOn(broadcastBus, 'publishBlendshapes').mockImplementation(() => {});
    const { graph } = buildGraph(
      [
        { id: 'on', kind: 'set_expression' },
        { id: 'off', kind: 'set_expression' },
      ],
      [],
      {
        on: { nodeId: 'av', expression: 'Happy', weight: 1 },
        off: { nodeId: 'av', expression: 'Happy', weight: 0 },
      }
    );
    graph.deliverExternal('on', 'fire', mkEvent(undefined));
    graph.deliverExternal('off', 'fire', mkEvent(undefined));
    expect(spy.mock.calls[0][1]).toBe('set_expression:av:Happy');
    expect(spy.mock.calls[1][1]).toBe('set_expression:av:Happy'); // same slot
    expect(spy.mock.calls[0][1]).toBe(spy.mock.calls[1][1]);
    spy.mockRestore();
  });

  it('different expressions on the same avatar use distinct slots (they coexist)', () => {
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
    expect(spy.mock.calls[0][1]).toBe('set_expression:av:Happy');
    expect(spy.mock.calls[1][1]).toBe('set_expression:av:Angry');
    spy.mockRestore();
  });

  it('releases exactly the slots it wrote on graph dispose', () => {
    const removeSpy = vi.spyOn(broadcastBus, 'removeBehavior').mockImplementation(() => {});
    vi.spyOn(broadcastBus, 'publishBlendshapes').mockImplementation(() => {});
    const { graph } = buildGraph(
      [{ id: 'se', kind: 'set_expression' }],
      [],
      { se: { nodeId: 'a', expression: 'Happy' } }
    );
    graph.deliverExternal('se', 'fire', mkEvent(undefined)); // publishes → tracks the slot
    graph.dispose();
    expect(removeSpy).toHaveBeenCalledWith('set_expression:a:Happy');
    removeSpy.mockRestore();
  });
});
