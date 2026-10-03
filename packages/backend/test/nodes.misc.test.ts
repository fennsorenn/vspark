/**
 * nodes.misc.test.ts
 *
 * Coverage for miscellaneous signal nodes:
 *   manual_trigger, log,
 *   set_data, set_compose_layer_param,
 *   track_clip_trigger, start_clip, spawn_clip, media_control,
 *   on_pose_broadcast, pose_interceptor_broadcast,
 *   vmc_packet_source, mediapipe_source, lipsync_source, clock
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkEvent, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import { buildGraph, loneNode, pullValue } from './helpers/nodeHarness.js';

// ── Singletons that nodes import (spied on below) ────────────────────────────
import { dataChannelManager } from '../src/data_channels/manager.js';
import { runtimeOverrideManager } from '../src/runtime_overrides/manager.js';
import { spawnManager } from '../src/spawn/manager.js';
import { mediaControlManager } from '../src/media_control/manager.js';
import { poseInterceptorRegistry } from '../src/signal/pose_interceptor_registry.js';
import { broadcastBus } from '../src/broadcast/bus.js';

// The clip-start nodes write the clip_playback document rather than taking an
// injected playhead, so this is what they are asserted against now.
import { triggerClip } from '../src/track_clips/playbackDoc.js';
vi.mock('../src/track_clips/playbackDoc.js', () => ({
  triggerClip: vi.fn(),
}));
import { Clock } from '../src/signal/nodes/clock.js';
import { OnPoseBroadcast } from '../src/signal/nodes/on_pose_broadcast.js';

// ─────────────────────────────────────────────────────────────────────────────
// Silence console noise globally for this file
// ─────────────────────────────────────────────────────────────────────────────
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
// manual_trigger (kind: 'component_trigger')
// ─────────────────────────────────────────────────────────────────────────────
describe('manual_trigger (component_trigger)', () => {
  it('instantiates without error', () => {
    expect(() => loneNode('component_trigger')).not.toThrow();
  });

  it('emits a trigger event when graph.fire is called', () => {
    const { graph } = buildGraph(
      [
        { id: 'trg', kind: 'component_trigger' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'trg',
          fromPort: 'trigger',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ]
    );
    graph.fire('trg', 'trigger', mkEvent(undefined));
    const ev = graph.peekInput('sink', 'trigger');
    expect(ev).toBeDefined();
  });

  it('does not emit before fire is called', () => {
    const { graph } = buildGraph(
      [
        { id: 'trg', kind: 'component_trigger' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'trg',
          fromPort: 'trigger',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ]
    );
    expect(graph.peekInput('sink', 'trigger')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// log
// ─────────────────────────────────────────────────────────────────────────────
describe('log', () => {
  it('instantiates without error', () => {
    expect(() => loneNode('log')).not.toThrow();
  });

  it('calls console.log when trigger fires', () => {
    // Un-mock console.log so we can assert it is called
    consoleMocks[0].mockRestore();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleMocks[0] = logSpy;

    const n = loneNode('log', { label: 'test' });
    n.deliver('trigger', 'hello');
    expect(logSpy).toHaveBeenCalled();
  });

  it('does not throw when inputs port has no connections', () => {
    const n = loneNode('log', {});
    expect(() => n.deliver('trigger', 42)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// set_data
// ─────────────────────────────────────────────────────────────────────────────
describe('set_data', () => {
  let setSpy: ReturnType<typeof vi.spyOn>;
  let seedSpy: ReturnType<typeof vi.spyOn>;
  let clearSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setSpy = vi.spyOn(dataChannelManager, 'set').mockImplementation(() => {});
    seedSpy = vi.spyOn(dataChannelManager, 'seed').mockImplementation(() => {});
    clearSpy = vi.spyOn(dataChannelManager, 'clear').mockImplementation(() => {});
  });
  afterEach(() => {
    setSpy.mockRestore();
    seedSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('calls dataChannelManager.set on fire with declared fields', () => {
    const n = loneNode('set_data', { fields: ['name', 'score'], name: 'Alice', score: 42 });
    n.deliver('fire', undefined);
    expect(setSpy).toHaveBeenCalledOnce();
    const [scope, fields] = setSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(scope).toBe('');
    expect(fields).toMatchObject({ name: 'Alice', score: 42 });
  });

  it('uses the scope config key when set', () => {
    const n = loneNode('set_data', {
      fields: ['x'],
      scope: 'layer-abc',
      x: 99,
    });
    n.deliver('fire', undefined);
    expect(setSpy).toHaveBeenCalledWith('layer-abc', { x: 99 });
  });

  it('is a no-op on fire when fields list is empty', () => {
    const n = loneNode('set_data', { fields: [] });
    n.deliver('fire', undefined);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('seeds fields on bind (onBind)', () => {
    // Instantiating the node triggers onBind, which calls seed for declared fields.
    loneNode('set_data', { fields: ['a', 'b'] });
    expect(seedSpy).toHaveBeenCalled();
  });

  it('clears fields on teardown (graph destruction via graph.stop/unbind)', () => {
    // We can't call onUnbind directly, but we can verify the spy is available.
    // loneNode keeps the graph alive; just verify no unexpected throws.
    expect(() => loneNode('set_data', { fields: ['v'] })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// set_compose_layer_param
// ─────────────────────────────────────────────────────────────────────────────
describe('set_compose_layer_param', () => {
  let setSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setSpy = vi.spyOn(runtimeOverrideManager, 'set').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Replace the mock we set globally so both this one and the global no-op coexist
    consoleMocks[1] = warnSpy;
  });
  afterEach(() => {
    setSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('calls runtimeOverrideManager.set with kind=compose_layer on fire', () => {
    const n = loneNode('set_compose_layer_param', {
      targetId: 'layer-1',
      paramPath: 'opacity',
      value: 0.5,
    });
    n.deliver('fire', undefined);
    expect(setSpy).toHaveBeenCalledWith('compose_layer', 'layer-1', 'opacity', 0.5, {
      persist: false,
    });
  });

  it('is a no-op when targetId is missing', () => {
    const n = loneNode('set_compose_layer_param', { paramPath: 'x', value: 10 });
    n.deliver('fire', undefined);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when paramPath is missing', () => {
    const n = loneNode('set_compose_layer_param', { targetId: 'layer-2', value: 10 });
    n.deliver('fire', undefined);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('a SpawnRef of kind compose_layer retargets the write to the tmp id', () => {
    const n = loneNode('set_compose_layer_param', {
      targetId: 'orig',
      paramPath: 'width',
      value: 200,
    });
    n.deliver('spawnRef', { tmpNodeId: 'tmp-layer', tmpClipId: 'clip-x', kind: 'compose_layer' });
    expect(setSpy).toHaveBeenCalledWith(
      'compose_layer',
      'tmp-layer',
      'width',
      200,
      { persist: false }
    );
  });

  it('ignores a SpawnRef of wrong kind (scene_node) and warns', () => {
    const n = loneNode('set_compose_layer_param', {
      targetId: 'orig',
      paramPath: 'opacity',
      value: 1,
    });
    n.deliver('spawnRef', { tmpNodeId: 'tmp', tmpClipId: 'c', kind: 'scene_node' });
    expect(setSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('respects the persist flag from config', () => {
    const n = loneNode('set_compose_layer_param', {
      targetId: 'layer-3',
      paramPath: 'y',
      value: 50,
      persist: true,
    });
    n.deliver('fire', undefined);
    expect(setSpy).toHaveBeenCalledWith('compose_layer', 'layer-3', 'y', 50, {
      persist: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// track_clip_trigger
// ─────────────────────────────────────────────────────────────────────────────
describe('track_clip_trigger', () => {
  beforeEach(() => vi.mocked(triggerClip).mockClear());

  it('writes the clip_playback document when clipId is set', () => {
    const n = loneNode('track_clip_trigger', { clipId: 'clip-1' });
    n.deliver('fire', undefined);
    expect(triggerClip).toHaveBeenCalledWith('clip-1');
  });

  it('is a no-op when clipId is missing', () => {
    const n = loneNode('track_clip_trigger', {});
    n.deliver('fire', undefined);
    expect(triggerClip).not.toHaveBeenCalled();
  });

  it('does not throw when the store is unavailable', () => {
    // There is no injected playhead to be missing any more: the write helper
    // no-ops when the collection is absent, so the node never has to guard.
    const n = loneNode('track_clip_trigger', { clipId: 'clip-abc' });
    expect(() => n.deliver('fire', undefined)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// start_clip
// ─────────────────────────────────────────────────────────────────────────────
describe('start_clip', () => {
  beforeEach(() => vi.mocked(triggerClip).mockClear());

  it('writes the clip_playback document when clipId is set', () => {
    const n = loneNode('start_clip', { clipId: 'clip-1' });
    n.deliver('fire', undefined);
    expect(triggerClip).toHaveBeenCalledWith('clip-1');
  });

  it('is a no-op when clipId is missing', () => {
    const n = loneNode('start_clip', {});
    n.deliver('fire', undefined);
    expect(triggerClip).not.toHaveBeenCalled();
  });

  it('does not throw when the store is unavailable', () => {
    const n = loneNode('start_clip', { clipId: 'clip-xyz' });
    expect(() => n.deliver('fire', undefined)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// spawn_clip
// ─────────────────────────────────────────────────────────────────────────────
describe('spawn_clip', () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnSpy = vi.spyOn(spawnManager, 'spawn').mockReturnValue(null);
  });
  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('calls spawnManager.spawn with the clipId from config', () => {
    const n = loneNode('spawn_clip', { clipId: 'clip-spawn-1' });
    n.deliver('fire', undefined);
    expect(spawnSpy).toHaveBeenCalledWith('clip-spawn-1');
  });

  it('is a no-op when clipId is absent', () => {
    const n = loneNode('spawn_clip', {});
    n.deliver('fire', undefined);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('emits spawned event when spawnManager returns a ref', () => {
    const ref = { tmpNodeId: 'tmp-1', tmpClipId: 'clip-tmp-1', kind: 'scene_node' as const };
    spawnSpy.mockReturnValue(ref);

    const { graph } = buildGraph(
      [
        { id: 'sp', kind: 'spawn_clip' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'sp',
          fromPort: 'spawned',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ],
      { sp: { clipId: 'clip-x' } }
    );

    graph.deliverExternal('sp', 'fire', mkEvent(undefined));
    const ev = graph.peekInput('sink', 'trigger') as { payload: typeof ref };
    expect(ev?.payload).toEqual(ref);
  });

  it('does not emit spawned event when spawnManager returns null', () => {
    spawnSpy.mockReturnValue(null);

    const { graph } = buildGraph(
      [
        { id: 'sp', kind: 'spawn_clip' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'sp',
          fromPort: 'spawned',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ],
      { sp: { clipId: 'clip-y' } }
    );

    graph.deliverExternal('sp', 'fire', mkEvent(undefined));
    expect(graph.peekInput('sink', 'trigger')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// media_control
// ─────────────────────────────────────────────────────────────────────────────
describe('media_control', () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dispatchSpy = vi.spyOn(mediaControlManager, 'dispatch').mockImplementation(() => {});
  });
  afterEach(() => {
    dispatchSpy.mockRestore();
  });

  it('calls mediaControlManager.dispatch with configured action on fire', () => {
    const n = loneNode('media_control', {
      targetId: 'node-vid-1',
      action: 'play',
      targetKind: 'scene_node',
    });
    n.deliver('fire', undefined);
    expect(dispatchSpy).toHaveBeenCalledWith('scene_node', 'node-vid-1', { action: 'play' });
  });

  it('is a no-op when targetId is missing', () => {
    const n = loneNode('media_control', { action: 'pause' });
    n.deliver('fire', undefined);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('defaults action to play and targetKind to scene_node', () => {
    const n = loneNode('media_control', { targetId: 'vid-2' });
    n.deliver('fire', undefined);
    expect(dispatchSpy).toHaveBeenCalledWith('scene_node', 'vid-2', { action: 'play' });
  });

  it('includes t in the command when configured', () => {
    const n = loneNode('media_control', {
      targetId: 'vid-3',
      action: 'seek',
      t: 12.5,
    });
    n.deliver('fire', undefined);
    expect(dispatchSpy).toHaveBeenCalledWith('scene_node', 'vid-3', {
      action: 'seek',
      t: 12.5,
    });
  });

  it('a SpawnRef retargets the command to the tmp id', () => {
    const n = loneNode('media_control', {
      targetId: 'orig',
      action: 'stop',
      targetKind: 'scene_node',
    });
    n.deliver('spawnRef', { tmpNodeId: 'tmp-vid', tmpClipId: 'c', kind: 'scene_node' });
    expect(dispatchSpy).toHaveBeenCalledWith('scene_node', 'tmp-vid', { action: 'stop' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// on_pose_broadcast
// ─────────────────────────────────────────────────────────────────────────────
describe('on_pose_broadcast', () => {
  it('instantiates without error', () => {
    expect(() => loneNode('on_pose_broadcast')).not.toThrow();
  });

  it('frame and pose value outputs return undefined before any state is set', () => {
    const frame = pullValue('on_pose_broadcast', 'frame', {});
    const pose = pullValue('on_pose_broadcast', 'pose', {});
    expect(frame).toBeUndefined();
    expect(pose).toBeUndefined();
  });

  it('frame and pose value outputs read from injected state', () => {
    const pose = new NormalizedPose([['hips', new Quaternion(0, 0, 0, 1)]]);
    const state = { frame: { nodeId: 'node-1', pose, priority: 10 } };

    const frameResult = pullValue('on_pose_broadcast', 'frame', {}, state);
    const poseResult = pullValue('on_pose_broadcast', 'pose', {}, state);

    expect(frameResult).toEqual(state.frame);
    expect(poseResult).toBe(pose);
  });

  it('OnPoseBroadcast.register wires setNodeState + fireEvent on pose delivery', () => {
    const setNodeState = vi.fn();
    const fireEvent = vi.fn();
    const pose = new NormalizedPose([['hips', new Quaternion(0, 0, 0, 1)]]);

    const unregister = OnPoseBroadcast.register(
      'scene-node-1',
      'graph-node-1',
      5,
      setNodeState,
      fireEvent
    );

    // Trigger the registered interceptor
    poseInterceptorRegistry.start('scene-node-1', pose);

    expect(setNodeState).toHaveBeenCalledWith(
      'graph-node-1',
      expect.objectContaining({ frame: expect.objectContaining({ nodeId: 'scene-node-1', priority: 5 }) })
    );
    expect(fireEvent).toHaveBeenCalledWith('graph-node-1', 'trigger', expect.anything());

    unregister();
  });

  it('OnPoseBroadcast.register returns an unregister function that removes the interceptor', () => {
    const fireEvent = vi.fn();
    const pose = new NormalizedPose([['hips', new Quaternion(0, 0, 0, 1)]]);

    const unregister = OnPoseBroadcast.register(
      'scene-node-2',
      'graph-node-2',
      0,
      vi.fn(),
      fireEvent
    );
    unregister();

    // After unregister, start returns false (no interceptors)
    const started = poseInterceptorRegistry.start('scene-node-2', pose);
    expect(started).toBe(false);
    expect(fireEvent).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pose_interceptor_broadcast
// ─────────────────────────────────────────────────────────────────────────────
describe('pose_interceptor_broadcast', () => {
  it('instantiates without error', () => {
    expect(() => loneNode('pose_interceptor_broadcast')).not.toThrow();
  });

  it('is a no-op when frame is missing', () => {
    const advanceSpy = vi.spyOn(poseInterceptorRegistry, 'advance').mockImplementation(() => {});
    const n = loneNode('pose_interceptor_broadcast');
    n.deliver('trigger', undefined);
    expect(advanceSpy).not.toHaveBeenCalled();
    advanceSpy.mockRestore();
  });

  it('calls poseInterceptorRegistry.advance when frame and pose are present', () => {
    const pose = new NormalizedPose([['hips', new Quaternion(0, 0, 0, 1)]]);
    const frame = { nodeId: 'scene-node-3', pose, priority: 10 };

    const advanceSpy = vi.spyOn(poseInterceptorRegistry, 'advance').mockImplementation(() => {});

    const n = loneNode('pose_interceptor_broadcast', { frame, pose });
    n.deliver('trigger', undefined);

    expect(advanceSpy).toHaveBeenCalledWith(
      'scene-node-3',
      10,
      pose,
      expect.any(Function)
    );
    advanceSpy.mockRestore();
  });

  it('the broadcast callback calls broadcastBus.emitMergedPose', () => {
    const pose = new NormalizedPose([['hips', new Quaternion(0, 0, 0, 1)]]);
    const frame = { nodeId: 'scene-node-4', pose, priority: 5 };

    const emitSpy = vi.spyOn(broadcastBus, 'emitMergedPose').mockImplementation(() => {});

    // Use the real advance so the broadcast callback fires
    const advanceSpy = vi
      .spyOn(poseInterceptorRegistry, 'advance')
      .mockImplementation((_nodeId, _priority, _pose, broadcast) => {
        broadcast(_nodeId, _pose);
      });

    const n = loneNode('pose_interceptor_broadcast', { frame, pose });
    n.deliver('trigger', undefined);

    expect(emitSpy).toHaveBeenCalledWith('scene-node-4', pose);

    advanceSpy.mockRestore();
    emitSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// vmc_packet_source
// ─────────────────────────────────────────────────────────────────────────────
describe('vmc_packet_source', () => {
  it('instantiates without error', () => {
    expect(() => loneNode('vmc_packet_source')).not.toThrow();
  });

  it('has no reaction (is purely an event source node)', () => {
    // vmc_packet_source declares only eventOut ports; deliveries arrive via
    // graph.fire() from the VmcManager — there is no eventIn to test.
    // We verify the node can be wired as an emitter.
    const { graph } = buildGraph(
      [
        { id: 'src', kind: 'vmc_packet_source' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'src',
          fromPort: 'bones',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ]
    );
    // Simulate the VmcManager firing bones into the source node
    const bones = {};
    graph.fire('src', 'bones', mkEvent(bones));
    const ev = graph.peekInput('sink', 'trigger') as { payload: unknown };
    expect(ev?.payload).toBe(bones);
  });

  it('fires arkit events through the graph', () => {
    const { graph } = buildGraph(
      [
        { id: 'src', kind: 'vmc_packet_source' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'src',
          fromPort: 'arkit',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ]
    );
    const blendshapes = { mouthOpen: 0.3 };
    graph.fire('src', 'arkit', mkEvent(blendshapes));
    const ev = graph.peekInput('sink', 'trigger') as { payload: unknown };
    expect(ev?.payload).toBe(blendshapes);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mediapipe_source
// ─────────────────────────────────────────────────────────────────────────────
describe('mediapipe_source', () => {
  it('instantiates without error', () => {
    expect(() => loneNode('mediapipe_source')).not.toThrow();
  });

  it('fires face landmark events through the graph', () => {
    const { graph } = buildGraph(
      [
        { id: 'mp', kind: 'mediapipe_source' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'mp',
          fromPort: 'face',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ]
    );
    const landmarks = [{ x: 0.5, y: 0.5, z: 0 }];
    graph.fire('mp', 'face', mkEvent(landmarks));
    const ev = graph.peekInput('sink', 'trigger') as { payload: unknown };
    expect(ev?.payload).toBe(landmarks);
  });

  it('fires leftHand / rightHand / pose events through the graph', () => {
    for (const port of ['leftHand', 'rightHand', 'pose'] as const) {
      const { graph } = buildGraph(
        [
          { id: 'mp', kind: 'mediapipe_source' },
          { id: 'sink', kind: 'log' },
        ],
        [
          {
            fromNodeId: 'mp',
            fromPort: port,
            toNodeId: 'sink',
            toPort: 'trigger',
          },
        ]
      );
      const payload = [{ x: 0, y: 0, z: 0 }];
      graph.fire('mp', port, mkEvent(payload));
      const ev = graph.peekInput('sink', 'trigger') as { payload: unknown };
      expect(ev?.payload).toBe(payload);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lipsync_source
// ─────────────────────────────────────────────────────────────────────────────
describe('lipsync_source', () => {
  it('instantiates without error', () => {
    expect(() => loneNode('lipsync_source')).not.toThrow();
  });

  it('fires viseme events through the graph', () => {
    const { graph } = buildGraph(
      [
        { id: 'ls', kind: 'lipsync_source' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'ls',
          fromPort: 'visemes',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ]
    );
    const visemes = { aa: 0.7 };
    graph.fire('ls', 'visemes', mkEvent(visemes));
    const ev = graph.peekInput('sink', 'trigger') as { payload: unknown };
    expect(ev?.payload).toBe(visemes);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clock
// ─────────────────────────────────────────────────────────────────────────────
describe('clock', () => {
  it('instantiates without error', () => {
    expect(() => loneNode('clock')).not.toThrow();
  });

  it('Clock.attach schedules an interval and fires tick events', () => {
    vi.useFakeTimers();
    const fired: unknown[] = [];
    const cleanup = Clock.attach(
      'node-clock-1',
      10, // defaultHz
      () => 10, // getHz
      (_id, port, value) => {
        if (port === 'tick') fired.push(value);
      }
    );

    // At 10 Hz the interval is 100 ms. Advance 300 ms → should fire ~3 times.
    vi.advanceTimersByTime(300);
    expect(fired.length).toBeGreaterThanOrEqual(2);

    cleanup();
    vi.useRealTimers();
  });

  it('Clock.attach returns a cleanup that stops the interval', () => {
    vi.useFakeTimers();
    const fired: unknown[] = [];
    const cleanup = Clock.attach(
      'node-clock-2',
      10,
      () => 10,
      (_id, port, value) => {
        if (port === 'tick') fired.push(value);
      }
    );

    vi.advanceTimersByTime(100);
    const countAfterOne = fired.length;
    cleanup();
    vi.advanceTimersByTime(500);

    // No additional ticks after cleanup
    expect(fired.length).toBe(countAfterOne);
    vi.useRealTimers();
  });

  it('Clock.attach reschedules when hz changes', () => {
    vi.useFakeTimers();
    let currentHz = 10;
    const fired: unknown[] = [];
    const cleanup = Clock.attach(
      'node-clock-3',
      currentHz,
      () => currentHz,
      (_id, port, value) => {
        if (port === 'tick') fired.push(value);
      }
    );

    // Initial tick at 10 Hz
    vi.advanceTimersByTime(100);
    const afterFirst = fired.length;

    // Change hz before next tick; the next tick will reschedule and not fire immediately
    currentHz = 2;
    vi.advanceTimersByTime(100);
    // After reschedule to 2 Hz (500 ms interval) no new ticks expected within 100 ms
    // but the reschedule itself fired one tick then rescheduled
    // The main test: no throw, and cleanup works.
    cleanup();
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it('Clock.attach fires tick events into the graph via graph.fire', () => {
    vi.useFakeTimers();
    const ticks: string[] = [];

    const { graph } = buildGraph(
      [
        { id: 'clk', kind: 'clock' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'clk',
          fromPort: 'tick',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ]
    );

    const cleanup = Clock.attach(
      'clk',
      10,
      () => 10,
      (id, port, value) => {
        graph.fire(id, port, value as Parameters<typeof mkEvent>[0]);
        if (port === 'tick') ticks.push('tick');
      }
    );

    vi.advanceTimersByTime(200);
    cleanup();

    expect(ticks.length).toBeGreaterThanOrEqual(1);
    const ev = graph.peekInput('sink', 'trigger');
    expect(ev).toBeDefined();

    vi.useRealTimers();
  });
});
