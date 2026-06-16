/**
 * nodes.dynamic.test.ts
 *
 * Tests for dynamic / context / broadcast nodes:
 *   pack_event, unpack_event, queue_events,
 *   scene_entity, behavior_id, behavior_config,
 *   pose_broadcast, blendshapes_broadcast, ik_broadcast
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkEvent } from '@vspark/shared/signal';
import { Blendshapes, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import { buildGraph, pullValue, loneNode } from './helpers/nodeHarness.js';
import { broadcastBus } from '../src/broadcast/bus.js';
import { initIkBroadcast, setIkStreamForwarder } from '../src/signal/nodes/ik_broadcast.js';

// Silence console noise from the log sink and signal graph internals.
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
});

// ─────────────────────────────────────────────────────────────────────────────
// pack_event
// ─────────────────────────────────────────────────────────────────────────────
describe('pack_event', () => {
  /**
   * Wire two value sources ('a' and 'b') into pack_event's dynamic field inputs,
   * then fire 'fire' and capture the emitted Event<record> via a downstream log
   * sink's trigger input.
   */
  function buildPackGraph(fields: string[], fieldValues: Record<string, unknown>) {
    // We supply field values through config fallback (unconnected value inputs fall
    // back to config.<port> in the engine's value thunk).
    const { graph } = buildGraph(
      [
        { id: 'pack', kind: 'pack_event' },
        { id: 'src', kind: 'component_trigger' }, // fires the pack 'fire' port
        { id: 'sink', kind: 'log' },
      ],
      [
        // drive pack_event.fire from the trigger
        { fromNodeId: 'src', fromPort: 'trigger', toNodeId: 'pack', toPort: 'fire' },
        // capture pack_event.event at sink.trigger
        { fromNodeId: 'pack', fromPort: 'event', toNodeId: 'sink', toPort: 'trigger' },
      ],
      {
        pack: { fields, ...fieldValues },
      }
    );
    return graph;
  }

  it('packs named field values into an event payload record', () => {
    const graph = buildPackGraph(['a', 'b'], { a: 42, b: 'hello' });
    graph.fire('src', 'trigger', mkEvent(undefined));

    // The emitted Event arrives at sink.trigger
    const ev = graph.peekInput('sink', 'trigger') as { payload: Record<string, unknown> };
    expect(ev).toBeDefined();
    expect(ev.payload).toEqual({ a: 42, b: 'hello' });
  });

  it('omits fields with no value (config fallback also undefined)', () => {
    const graph = buildPackGraph(['a', 'b'], { a: 10 }); // 'b' has no config value
    graph.fire('src', 'trigger', mkEvent(undefined));

    const ev = graph.peekInput('sink', 'trigger') as { payload: Record<string, unknown> };
    expect(ev?.payload).toEqual({ a: 10 }); // 'b' is absent
  });

  it('emits an empty record when fields list is empty', () => {
    const graph = buildPackGraph([], {});
    graph.fire('src', 'trigger', mkEvent(undefined));

    const ev = graph.peekInput('sink', 'trigger') as { payload: Record<string, unknown> };
    expect(ev?.payload).toEqual({});
  });

  it('skips empty-string field names (trailing editor slot)', () => {
    const graph = buildPackGraph(['x', ''], { x: 99 });
    graph.fire('src', 'trigger', mkEvent(undefined));

    const ev = graph.peekInput('sink', 'trigger') as { payload: Record<string, unknown> };
    expect(Object.keys(ev?.payload ?? {})).toEqual(['x']);
  });

  it('does not fire when the fire event has not been delivered', () => {
    const graph = buildPackGraph(['a'], { a: 1 });
    // No fire delivered — sink should have seen nothing.
    expect(graph.peekInput('sink', 'trigger')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// unpack_event
// ─────────────────────────────────────────────────────────────────────────────
describe('unpack_event', () => {
  it('stores payload and fires trigger on event delivery', () => {
    const n = loneNode('unpack_event');
    n.deliver('event', { foo: 1, bar: 'baz' });
    // Trigger was emitted — state holds the payload.
    expect(n.state<{ payload: unknown }>()?.payload).toEqual({ foo: 1, bar: 'baz' });
  });

  it('exposes fields via dynamic value outputs after an event', () => {
    // Wire unpack_event into a log sink via a trigger → pull chain similar to
    // pullValue: we need to actually pull a dynamic output port.
    // Use buildGraph to wire: unpack.trigger → sink.trigger,
    // unpack.foo (dynamic) → log.inputs (pulled on trigger).
    const { graph } = buildGraph(
      [
        { id: 'unpack', kind: 'unpack_event' },
        { id: 'sink', kind: 'log' },
      ],
      [
        { fromNodeId: 'unpack', fromPort: 'trigger', toNodeId: 'sink', toPort: 'trigger' },
        { fromNodeId: 'unpack', fromPort: 'value', toNodeId: 'sink', toPort: 'inputs' },
      ],
      {}
    );

    // Deliver a non-record payload → reads out via 'value' port.
    graph.deliverExternal('unpack', 'event', mkEvent(123));

    // The pull happens as part of the trigger chain: sink.inputs is pulled when
    // sink.trigger fires, so peekInput captures it.
    const inputs = graph.peekInput('sink', 'inputs') as unknown[];
    expect(inputs?.[0]).toBe(123);
  });

  it('null payload from undefined event is handled gracefully', () => {
    const n = loneNode('unpack_event');
    // deliver undefined as payload (ev?.payload ?? null → null)
    n.deliver('event', undefined);
    expect(n.state<{ payload: unknown }>()?.payload).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// queue_events
// ─────────────────────────────────────────────────────────────────────────────
describe('queue_events', () => {
  it('enqueues items and pops them FIFO', () => {
    const n = loneNode('queue_events');

    // Enqueue two items
    n.deliver('enqueue', 'first');
    n.deliver('enqueue', 'second');

    // State has both items
    expect(n.state<{ items: unknown[] }>()?.items).toEqual(['first', 'second']);

    // Pop removes the oldest
    n.deliver('pop', undefined);
    expect(n.state<{ items: unknown[] }>()?.items).toEqual(['second']);
  });

  it('pop on empty queue is a no-op', () => {
    const n = loneNode('queue_events');
    expect(() => n.deliver('pop', undefined)).not.toThrow();
    expect(n.state()).toBeUndefined();
  });

  it('emits popped event on pop', () => {
    // Wire queue_events.popped → sink.trigger so we can inspect it.
    const { graph } = buildGraph(
      [
        { id: 'q', kind: 'queue_events' },
        { id: 'sink', kind: 'log' },
      ],
      [
        { fromNodeId: 'q', fromPort: 'popped', toNodeId: 'sink', toPort: 'trigger' },
      ],
      {}
    );

    graph.deliverExternal('q', 'enqueue', mkEvent('hello'));
    graph.deliverExternal('q', 'pop', mkEvent(undefined));

    // sink.trigger received the Event wrapping the popped payload
    const ev = graph.peekInput('sink', 'trigger') as { payload: unknown };
    expect(ev?.payload).toBe('hello');
  });

  it('size value output reflects queue depth', () => {
    // size is a pull output; pull it via pullValue using pre-seeded state.
    const preState = { items: ['a', 'b', 'c'] };
    const size = pullValue('queue_events', 'size', {}, preState);
    expect(size).toBe(3);
  });

  it('size is 0 when queue is empty', () => {
    expect(pullValue('queue_events', 'size', {}, { items: [] })).toBe(0);
  });

  it('draining the queue reduces size', () => {
    const n = loneNode('queue_events');
    n.deliver('enqueue', 'x');
    n.deliver('enqueue', 'y');
    n.deliver('pop', undefined);
    expect(n.state<{ items: unknown[] }>()?.items).toHaveLength(1);
  });

  it('FIFO ordering across multiple enqueues and pops', () => {
    const results: unknown[] = [];
    const { graph } = buildGraph(
      [
        { id: 'q', kind: 'queue_events' },
        { id: 'sink', kind: 'log' },
      ],
      [{ fromNodeId: 'q', fromPort: 'popped', toNodeId: 'sink', toPort: 'trigger' }],
      {}
    );

    for (const v of [10, 20, 30]) {
      graph.deliverExternal('q', 'enqueue', mkEvent(v));
    }
    for (let i = 0; i < 3; i++) {
      graph.deliverExternal('q', 'pop', mkEvent(undefined));
      const ev = graph.peekInput('sink', 'trigger') as { payload: unknown };
      results.push(ev?.payload);
    }
    expect(results).toEqual([10, 20, 30]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scene_entity
// ─────────────────────────────────────────────────────────────────────────────
describe('scene_entity', () => {
  it('outputs the nodeId from config', () => {
    expect(pullValue('scene_entity', 'nodeId', { nodeId: 'scene-node-abc' })).toBe(
      'scene-node-abc'
    );
  });

  it('outputs undefined when nodeId not in config', () => {
    expect(pullValue('scene_entity', 'nodeId', {})).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// behavior_id
// ─────────────────────────────────────────────────────────────────────────────
describe('behavior_id', () => {
  it('outputs the behaviorId from config', () => {
    expect(pullValue('behavior_id', 'id', { behaviorId: 'beh-xyz' })).toBe('beh-xyz');
  });

  it('outputs undefined when behaviorId not in config', () => {
    expect(pullValue('behavior_id', 'id', {})).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// behavior_config
// ─────────────────────────────────────────────────────────────────────────────
describe('behavior_config', () => {
  it('returns the whole _behaviorConfig object when field is empty', () => {
    const bCfg = { host: 'localhost', port: 8080 };
    const result = pullValue('behavior_config', 'value', {
      field: '',
      _behaviorConfig: bCfg,
    });
    expect(result).toEqual(bCfg);
  });

  it('resolves a dot-notation path within _behaviorConfig', () => {
    const bCfg = { nodeConfig: { arkit: { enabled: true } } };
    const result = pullValue('behavior_config', 'value', {
      field: 'nodeConfig.arkit.enabled',
      _behaviorConfig: bCfg,
    });
    expect(result).toBe(true);
  });

  it('returns defaultValue when resolved path is undefined', () => {
    const result = pullValue('behavior_config', 'value', {
      field: 'missing.path',
      defaultValue: 'fallback',
      _behaviorConfig: {},
    });
    expect(result).toBe('fallback');
  });

  it('returns null when path is undefined and no defaultValue', () => {
    const result = pullValue('behavior_config', 'value', {
      field: 'no_such',
      _behaviorConfig: {},
    });
    expect(result).toBeNull();
  });

  it('resolves a top-level key', () => {
    const result = pullValue('behavior_config', 'value', {
      field: 'host',
      _behaviorConfig: { host: '127.0.0.1' },
    });
    expect(result).toBe('127.0.0.1');
  });

  it('returns empty _behaviorConfig object when not provided and field is empty', () => {
    const result = pullValue('behavior_config', 'value', { field: '' });
    expect(result).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pose_broadcast
// ─────────────────────────────────────────────────────────────────────────────
describe('pose_broadcast', () => {
  it('calls broadcastBus.publishBones when all required inputs are present', () => {
    const publishSpy = vi.spyOn(broadcastBus, 'publishBones').mockImplementation(() => {});

    const pose = new NormalizedPose([[
      'hips',
      new Quaternion(0, 0, 0, 1),
    ]]);

    const { graph } = buildGraph(
      [{ id: 'pb', kind: 'pose_broadcast' }],
      [],
      {
        pb: {
          nodeId: 'node-1',
          behaviorId: 'beh-1',
          pose,
          priority: 0,
          animationBlendMode: 'override',
        },
      }
    );

    graph.deliverExternal('pb', 'trigger', mkEvent(undefined));

    expect(publishSpy).toHaveBeenCalledWith(
      'node-1',
      'beh-1',
      pose,
      0,
      'override'
    );

    publishSpy.mockRestore();
  });

  it('does not call publishBones when nodeId is missing', () => {
    const publishSpy = vi.spyOn(broadcastBus, 'publishBones').mockImplementation(() => {});

    const pose = new NormalizedPose([['hips', new Quaternion(0, 0, 0, 1)]]);
    const { graph } = buildGraph(
      [{ id: 'pb', kind: 'pose_broadcast' }],
      [],
      { pb: { behaviorId: 'beh-1', pose } }
    );

    graph.deliverExternal('pb', 'trigger', mkEvent(undefined));
    expect(publishSpy).not.toHaveBeenCalled();

    publishSpy.mockRestore();
  });

  it('does not call publishBones when pose is missing', () => {
    const publishSpy = vi.spyOn(broadcastBus, 'publishBones').mockImplementation(() => {});

    const { graph } = buildGraph(
      [{ id: 'pb', kind: 'pose_broadcast' }],
      [],
      { pb: { nodeId: 'node-1', behaviorId: 'beh-1' } }
    );

    graph.deliverExternal('pb', 'trigger', mkEvent(undefined));
    expect(publishSpy).not.toHaveBeenCalled();

    publishSpy.mockRestore();
  });

  it('defaults priority to 0 and mode to override for non-finite/absent inputs', () => {
    const publishSpy = vi.spyOn(broadcastBus, 'publishBones').mockImplementation(() => {});

    const pose = new NormalizedPose([['hips', new Quaternion(0, 0, 0, 1)]]);
    const { graph } = buildGraph(
      [{ id: 'pb', kind: 'pose_broadcast' }],
      [],
      { pb: { nodeId: 'n', behaviorId: 'b', pose } } // no priority or mode
    );

    graph.deliverExternal('pb', 'trigger', mkEvent(undefined));
    expect(publishSpy).toHaveBeenCalledWith('n', 'b', pose, 0, 'override');

    publishSpy.mockRestore();
  });

  it('passes additive blend mode through', () => {
    const publishSpy = vi.spyOn(broadcastBus, 'publishBones').mockImplementation(() => {});

    const pose = new NormalizedPose([['hips', new Quaternion(0, 0, 0, 1)]]);
    const { graph } = buildGraph(
      [{ id: 'pb', kind: 'pose_broadcast' }],
      [],
      { pb: { nodeId: 'n', behaviorId: 'b', pose, animationBlendMode: 'additive' } }
    );

    graph.deliverExternal('pb', 'trigger', mkEvent(undefined));
    expect(publishSpy).toHaveBeenCalledWith('n', 'b', pose, 0, 'additive');

    publishSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// blendshapes_broadcast
// ─────────────────────────────────────────────────────────────────────────────
describe('blendshapes_broadcast', () => {
  it('calls broadcastBus.publishBlendshapes when all required inputs are present', () => {
    const publishSpy = vi
      .spyOn(broadcastBus, 'publishBlendshapes')
      .mockImplementation(() => {});

    const bs = Blendshapes.fromRecord({ happy: 0.8 });
    const { graph } = buildGraph(
      [{ id: 'bb', kind: 'blendshapes_broadcast' }],
      [],
      { bb: { nodeId: 'node-2', behaviorId: 'beh-2', blendshapes: bs } }
    );

    graph.deliverExternal('bb', 'trigger', mkEvent(undefined));

    expect(publishSpy).toHaveBeenCalledWith('node-2', 'beh-2', bs);

    publishSpy.mockRestore();
  });

  it('does not call publishBlendshapes when blendshapes is missing', () => {
    const publishSpy = vi
      .spyOn(broadcastBus, 'publishBlendshapes')
      .mockImplementation(() => {});

    const { graph } = buildGraph(
      [{ id: 'bb', kind: 'blendshapes_broadcast' }],
      [],
      { bb: { nodeId: 'node-2', behaviorId: 'beh-2' } }
    );

    graph.deliverExternal('bb', 'trigger', mkEvent(undefined));
    expect(publishSpy).not.toHaveBeenCalled();

    publishSpy.mockRestore();
  });

  it('does not call publishBlendshapes when nodeId is missing', () => {
    const publishSpy = vi
      .spyOn(broadcastBus, 'publishBlendshapes')
      .mockImplementation(() => {});

    const bs = Blendshapes.fromRecord({ happy: 0.5 });
    const { graph } = buildGraph(
      [{ id: 'bb', kind: 'blendshapes_broadcast' }],
      [],
      { bb: { behaviorId: 'beh-2', blendshapes: bs } }
    );

    graph.deliverExternal('bb', 'trigger', mkEvent(undefined));
    expect(publishSpy).not.toHaveBeenCalled();

    publishSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ik_broadcast
//
// ik_broadcast uses a module-level `_ws` singleton and an optional forwarder.
// We cannot stand up a real WSSync, so we test via the forwarder tap and by
// asserting the node does not throw when _ws is null.
// ─────────────────────────────────────────────────────────────────────────────
describe('ik_broadcast', () => {
  it('forwards pose_ik_targets through the stream forwarder when enabled', () => {
    // Install a mock forwarder to capture the emitted frame.
    const forwarded: Array<{ kind: string; nodeId: string; payload: Record<string, unknown> }> = [];
    setIkStreamForwarder((kind, nodeId, payload) => {
      forwarded.push({ kind, nodeId, payload });
    });

    const targets = { leftHand: { x: 1, y: 2, z: 3 }, rightHand: null };
    const { graph } = buildGraph(
      [{ id: 'ik', kind: 'ik_broadcast' }],
      [],
      { ik: { nodeId: 'node-3', targets, enabled: true } }
    );

    graph.deliverExternal('ik', 'trigger', mkEvent(undefined));

    // The forwarder receives the merged payload (targets + nodeId).
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].kind).toBe('pose_ik_targets');
    expect(forwarded[0].nodeId).toBe('node-3');
    expect(forwarded[0].payload).toMatchObject({ nodeId: 'node-3', ...targets });

    // Clean up
    setIkStreamForwarder((_k, _n, _p) => {});
  });

  it('does not forward when enabled is false', () => {
    const forwarded: unknown[] = [];
    setIkStreamForwarder((_kind, _nid, payload) => forwarded.push(payload));

    const targets = { leftHand: { x: 0, y: 0, z: 0 } };
    const { graph } = buildGraph(
      [{ id: 'ik', kind: 'ik_broadcast' }],
      [],
      { ik: { nodeId: 'node-4', targets, enabled: false } }
    );

    graph.deliverExternal('ik', 'trigger', mkEvent(undefined));
    expect(forwarded).toHaveLength(0);

    setIkStreamForwarder((_k, _n, _p) => {});
  });

  it('does not forward when targets is missing', () => {
    const forwarded: unknown[] = [];
    setIkStreamForwarder((_kind, _nid, payload) => forwarded.push(payload));

    const { graph } = buildGraph(
      [{ id: 'ik', kind: 'ik_broadcast' }],
      [],
      { ik: { nodeId: 'node-5' } } // no targets
    );

    graph.deliverExternal('ik', 'trigger', mkEvent(undefined));
    expect(forwarded).toHaveLength(0);

    setIkStreamForwarder((_k, _n, _p) => {});
  });

  it('does not forward when nodeId is missing', () => {
    const forwarded: unknown[] = [];
    setIkStreamForwarder((_kind, _nid, payload) => forwarded.push(payload));

    const targets = { leftHand: { x: 0, y: 0, z: 0 } };
    const { graph } = buildGraph(
      [{ id: 'ik', kind: 'ik_broadcast' }],
      [],
      { ik: { targets } } // no nodeId
    );

    graph.deliverExternal('ik', 'trigger', mkEvent(undefined));
    expect(forwarded).toHaveLength(0);

    setIkStreamForwarder((_k, _n, _p) => {});
  });

  it('enabled defaults to true when not specified', () => {
    const forwarded: unknown[] = [];
    setIkStreamForwarder((_kind, _nid, payload) => forwarded.push(payload));

    const targets = { leftHand: { x: 0, y: 1, z: 0 } };
    const { graph } = buildGraph(
      [{ id: 'ik', kind: 'ik_broadcast' }],
      [],
      { ik: { nodeId: 'node-6', targets } } // enabled absent → defaults true
    );

    graph.deliverExternal('ik', 'trigger', mkEvent(undefined));
    expect(forwarded).toHaveLength(1);

    setIkStreamForwarder((_k, _n, _p) => {});
  });
});
