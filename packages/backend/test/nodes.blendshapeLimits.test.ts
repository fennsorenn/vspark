/**
 * nodes.blendshapeLimits.test.ts
 *
 * The blendshape interceptor half of the broadcast pipeline:
 *   - blendshape_limits node (rule application through the real engine)
 *   - on_blendshapes_broadcast / blendshapes_interceptor_broadcast
 *   - BlendshapeInterceptorRegistry (ordering, advance, unregister)
 *   - BlendshapeLimiterManager end-to-end: a frame handed to the registry comes
 *     out the far side limited and emitted through the bus.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Blendshapes, mkEvent } from '@vspark/shared/signal';
import { defaultBlendshapeLimits } from '@vspark/shared/blendshapeLimits';
import { buildGraph, loneNode, pullValue } from './helpers/nodeHarness.js';
import { blendshapeInterceptorRegistry } from '../src/signal/blendshape_interceptor_registry.js';
import { broadcastBus } from '../src/broadcast/bus.js';
import { OnBlendshapesBroadcast } from '../src/signal/nodes/on_blendshapes_broadcast.js';
import { BlendshapeLimiterManager } from '../src/behaviors/blendshape_limiter/manager.js';

let consoleMocks: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleMocks = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});
afterEach(() => {
  consoleMocks.forEach((m) => m.mockRestore());
  vi.restoreAllMocks();
});

const bs = (rec: Record<string, number>) => Blendshapes.fromRecord(rec);

// ─────────────────────────────────────────────────────────────────────────────
// blendshape_limits
// ─────────────────────────────────────────────────────────────────────────────
describe('blendshape_limits', () => {
  it('instantiates without error', () => {
    expect(() => loneNode('blendshape_limits')).not.toThrow();
  });

  it('returns undefined when no blendshapes are wired in', () => {
    expect(pullValue('blendshape_limits', 'blendshapes', {})).toBeUndefined();
  });

  it('passes the frame straight through when the rule set is empty', () => {
    const input = bs({ happy: 1, angry: 1 });
    const out = pullValue('blendshape_limits', 'blendshapes', {
      blendshapes: input,
      limits: {},
    }) as Blendshapes;
    expect(out.toRecord()).toEqual({ happy: 1, angry: 1 });
  });

  it('passes the frame through when the rule set is disabled', () => {
    const out = pullValue('blendshape_limits', 'blendshapes', {
      blendshapes: bs({ happy: 1, angry: 1 }),
      limits: { ...defaultBlendshapeLimits(), enabled: false },
    }) as Blendshapes;
    expect(out.toRecord()).toEqual({ happy: 1, angry: 1 });
  });

  it('applies exclusive groups from its limits input', () => {
    const out = pullValue('blendshape_limits', 'blendshapes', {
      blendshapes: bs({ happy: 1, angry: 0.9 }),
      limits: defaultBlendshapeLimits(),
    }) as Blendshapes;
    expect(out.get('happy')).toBe(1);
    expect(out.get('angry')).toBe(0);
  });

  it('applies clamp rules from its limits input', () => {
    const out = pullValue('blendshape_limits', 'blendshapes', {
      blendshapes: bs({ happy: 1, aa: 1, blink: 1 }),
      limits: defaultBlendshapeLimits(),
    }) as Blendshapes;
    expect(out.get('aa')).toBeCloseTo(0.6, 6);
    expect(out.get('blink')).toBeCloseTo(0.5, 6);
  });

  it('survives a malformed hand-edited rule set', () => {
    const out = pullValue('blendshape_limits', 'blendshapes', {
      blendshapes: bs({ happy: 1 }),
      limits: { groups: 'not an array', clamps: [{ nonsense: true }] },
    }) as Blendshapes;
    expect(out.get('happy')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// on_blendshapes_broadcast
// ─────────────────────────────────────────────────────────────────────────────
describe('on_blendshapes_broadcast', () => {
  it('instantiates without error', () => {
    expect(() => loneNode('on_blendshapes_broadcast')).not.toThrow();
  });

  it('frame and blendshapes outputs are undefined before any state is set', () => {
    expect(pullValue('on_blendshapes_broadcast', 'frame', {})).toBeUndefined();
    expect(
      pullValue('on_blendshapes_broadcast', 'blendshapes', {})
    ).toBeUndefined();
  });

  it('frame and blendshapes outputs read from injected state', () => {
    const frame = {
      nodeId: 'n1',
      blendshapes: bs({ happy: 0.5 }),
      priority: 5,
    };
    expect(pullValue('on_blendshapes_broadcast', 'frame', {}, { frame })).toBe(
      frame
    );
    const out = pullValue(
      'on_blendshapes_broadcast',
      'blendshapes',
      {},
      { frame }
    ) as Blendshapes;
    expect(out.get('happy')).toBe(0.5);
  });

  it('register() injects a frame and fires trigger, and unregisters cleanly', () => {
    const setNodeState = vi.fn();
    const fireEvent = vi.fn();
    const unregister = OnBlendshapesBroadcast.register(
      'node-1',
      'graph-node',
      5,
      setNodeState,
      fireEvent
    );

    expect(
      blendshapeInterceptorRegistry.start('node-1', bs({ happy: 1 }))
    ).toBe(true);
    expect(setNodeState).toHaveBeenCalledTimes(1);
    const [gNodeId, state] = setNodeState.mock.calls[0];
    expect(gNodeId).toBe('graph-node');
    expect((state as { frame: { nodeId: string } }).frame.nodeId).toBe(
      'node-1'
    );
    expect(fireEvent).toHaveBeenCalledWith(
      'graph-node',
      'trigger',
      expect.anything()
    );

    unregister();
    expect(
      blendshapeInterceptorRegistry.start('node-1', bs({ happy: 1 }))
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// blendshapes_interceptor_broadcast
// ─────────────────────────────────────────────────────────────────────────────
describe('blendshapes_interceptor_broadcast', () => {
  it('emits through the bus when it is the last link in the chain', () => {
    const emit = vi
      .spyOn(broadcastBus, 'emitMergedBlendshapes')
      .mockImplementation(() => {});

    const { graph } = buildGraph(
      [
        { id: 'trg', kind: 'component_trigger' },
        { id: 'send', kind: 'blendshapes_interceptor_broadcast' },
      ],
      [
        {
          fromNodeId: 'trg',
          fromPort: 'trigger',
          toNodeId: 'send',
          toPort: 'trigger',
        },
      ],
      {
        send: {
          frame: { nodeId: 'n1', blendshapes: bs({ happy: 1 }), priority: 5 },
          blendshapes: bs({ happy: 0.4 }),
        },
      }
    );
    graph.fire('trg', 'trigger', mkEvent(undefined));

    expect(emit).toHaveBeenCalledTimes(1);
    const [nodeId, out] = emit.mock.calls[0];
    expect(nodeId).toBe('n1');
    expect((out as Blendshapes).get('happy')).toBe(0.4);
  });

  it('does nothing without a frame', () => {
    const emit = vi
      .spyOn(broadcastBus, 'emitMergedBlendshapes')
      .mockImplementation(() => {});
    const { graph } = buildGraph(
      [
        { id: 'trg', kind: 'component_trigger' },
        { id: 'send', kind: 'blendshapes_interceptor_broadcast' },
      ],
      [
        {
          fromNodeId: 'trg',
          fromPort: 'trigger',
          toNodeId: 'send',
          toPort: 'trigger',
        },
      ],
      { send: { blendshapes: bs({ happy: 1 }) } }
    );
    graph.fire('trg', 'trigger', mkEvent(undefined));
    expect(emit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BlendshapeInterceptorRegistry
// ─────────────────────────────────────────────────────────────────────────────
describe('blendshapeInterceptorRegistry', () => {
  it('start() reports false when nothing is registered', () => {
    expect(blendshapeInterceptorRegistry.start('nobody', bs({}))).toBe(false);
  });

  it('fires the highest-priority entry first and advances downward', () => {
    const order: number[] = [];
    const un1 = blendshapeInterceptorRegistry.register('n', {
      priority: 1,
      fire: (_id, _b, p) => order.push(p),
    });
    const un9 = blendshapeInterceptorRegistry.register('n', {
      priority: 9,
      fire: (_id, _b, p) => order.push(p),
    });

    blendshapeInterceptorRegistry.start('n', bs({}));
    expect(order).toEqual([9]);

    const broadcast = vi.fn();
    blendshapeInterceptorRegistry.advance('n', 9, bs({}), broadcast);
    expect(order).toEqual([9, 1]);
    expect(broadcast).not.toHaveBeenCalled();

    // Past the lowest-priority entry, advance falls through to the broadcast.
    blendshapeInterceptorRegistry.advance('n', 1, bs({ happy: 1 }), broadcast);
    expect(broadcast).toHaveBeenCalledTimes(1);

    un1();
    un9();
  });

  it('breaks priority ties by registration order', () => {
    const order: string[] = [];
    const unA = blendshapeInterceptorRegistry.register('t', {
      priority: 5,
      fire: () => order.push('a'),
    });
    const unB = blendshapeInterceptorRegistry.register('t', {
      priority: 5,
      fire: () => order.push('b'),
    });
    blendshapeInterceptorRegistry.start('t', bs({}));
    expect(order).toEqual(['a']);
    unA();
    unB();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BlendshapeLimiterManager — the whole chain
// ─────────────────────────────────────────────────────────────────────────────
describe('BlendshapeLimiterManager', () => {
  let manager: BlendshapeLimiterManager;

  beforeEach(() => {
    manager = new BlendshapeLimiterManager();
  });
  afterEach(() => {
    manager.close();
  });

  const sync = (config: Record<string, unknown>) =>
    manager.syncBehaviors([
      {
        id: 'b1',
        nodeId: 'avatar-1',
        kind: 'blendshape_limiter',
        enabled: true,
        config,
      },
    ]);

  /** Run one frame through the registered chain and return what the bus got. */
  const runFrame = (frame: Record<string, number>) => {
    const emit = vi
      .spyOn(broadcastBus, 'emitMergedBlendshapes')
      .mockImplementation(() => {});
    const handled = blendshapeInterceptorRegistry.start('avatar-1', bs(frame));
    const result = emit.mock.calls[0]?.[1] as Blendshapes | undefined;
    emit.mockRestore();
    return { handled, result };
  };

  it('builds a graph and registers an interceptor on sync', () => {
    sync({ limits: defaultBlendshapeLimits() });
    expect(manager.getGraphDescriptor('b1')?.id).toBe('blendshape_limiter:b1');
    expect(runFrame({ happy: 1 }).handled).toBe(true);
  });

  it('limits a live frame end to end', () => {
    sync({ limits: defaultBlendshapeLimits() });
    const { result } = runFrame({ happy: 1, angry: 0.9, aa: 1, blink: 1 });
    expect(result).toBeDefined();
    expect(result!.get('happy')).toBe(1);
    expect(result!.get('angry')).toBe(0);
    expect(result!.get('aa')).toBeCloseTo(0.6, 6);
    expect(result!.get('blink')).toBeCloseTo(0.5, 6);
  });

  it('hot-applies a config change without a graph rebuild', () => {
    sync({ limits: defaultBlendshapeLimits() });
    expect(runFrame({ happy: 1, angry: 0.9 }).result!.get('angry')).toBe(0);

    // Same behavior id, new rule set — the graph instance is reused.
    const before = manager.getGraphDescriptor('b1');
    sync({ limits: { enabled: true, groups: [], clamps: [] } });
    expect(manager.getGraphDescriptor('b1')).toBe(before);
    expect(runFrame({ happy: 1, angry: 0.9 }).result!.get('angry')).toBe(0.9);
  });

  it('unregisters the interceptor when the behavior is disabled', () => {
    sync({ limits: defaultBlendshapeLimits() });
    manager.syncBehaviors([
      {
        id: 'b1',
        nodeId: 'avatar-1',
        kind: 'blendshape_limiter',
        enabled: false,
        config: {},
      },
    ]);
    expect(manager.getStates('b1')).toBeNull();
    expect(runFrame({ happy: 1 }).handled).toBe(false);
  });

  it('ignores behaviors of other kinds', () => {
    manager.syncBehaviors([
      {
        id: 'other',
        nodeId: 'avatar-1',
        kind: 'breathing',
        enabled: true,
        config: {},
      },
    ]);
    expect(manager.getGraphDescriptor('other')).toBeNull();
    expect(runFrame({ happy: 1 }).handled).toBe(false);
  });

  it('close() tears every graph down', () => {
    sync({ limits: defaultBlendshapeLimits() });
    manager.close();
    expect(runFrame({ happy: 1 }).handled).toBe(false);
  });
});
