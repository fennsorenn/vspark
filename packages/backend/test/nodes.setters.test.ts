import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loneNode } from './helpers/nodeHarness.js';
import { runtimeOverrideManager } from '../src/runtime_overrides/manager.js';

/**
 * The runtime-mutation nodes (set_scene_node_param / set_compose_layer_param /
 * set_text) all route a write through `runtimeOverrideManager.set(...)` on fire.
 * Spy on it to assert routing without touching the real override bus.
 */
let setSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  setSpy = vi.spyOn(runtimeOverrideManager, 'set').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  setSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('set_scene_node_param', () => {
  it('writes target/path/value on fire', () => {
    const n = loneNode('set_scene_node_param', {
      targetId: 'node1',
      paramPath: 'position.x',
      value: 5,
    });
    n.deliver('fire', undefined);
    expect(setSpy).toHaveBeenCalledWith('scene_node', 'node1', 'position.x', 5, {
      persist: false,
    });
  });

  it('is a no-op when target or path is missing', () => {
    loneNode('set_scene_node_param', { paramPath: 'position.x' }).deliver('fire', undefined);
    loneNode('set_scene_node_param', { targetId: 'n' }).deliver('fire', undefined);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('a SpawnRef retargets the write to the spawned instance', () => {
    const n = loneNode('set_scene_node_param', {
      targetId: 'orig',
      paramPath: 'opacity',
      value: 0.5,
    });
    n.deliver('spawnRef', { tmpNodeId: 'tmp', tmpClipId: 'c', kind: 'scene_node' });
    expect(setSpy).toHaveBeenCalledWith('scene_node', 'tmp', 'opacity', 0.5, {
      persist: false,
    });
  });

  it('ignores a SpawnRef of the wrong kind', () => {
    const n = loneNode('set_scene_node_param', {
      targetId: 'orig',
      paramPath: 'opacity',
      value: 1,
    });
    n.deliver('spawnRef', { tmpNodeId: 'tmp', tmpClipId: 'c', kind: 'compose_layer' });
    expect(setSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('set_text', () => {
  it('writes text.content, honouring targetKind', () => {
    loneNode('set_text', { targetId: 't1', text: 'hello' }).deliver('fire', undefined);
    expect(setSpy).toHaveBeenCalledWith('scene_node', 't1', 'text.content', 'hello', {
      persist: false,
    });

    setSpy.mockClear();
    loneNode('set_text', {
      targetId: 'layer1',
      text: 'hi',
      targetKind: 'compose_layer',
    }).deliver('fire', undefined);
    expect(setSpy).toHaveBeenCalledWith(
      'compose_layer',
      'layer1',
      'text.content',
      'hi',
      { persist: false }
    );
  });

  it('a SpawnRef retargets text to the spawned instance', () => {
    const n = loneNode('set_text', { targetId: 'orig', text: 'x' });
    n.deliver('spawnRef', { tmpNodeId: 'tmp', tmpClipId: 'c', kind: 'compose_layer' });
    expect(setSpy).toHaveBeenCalledWith(
      'compose_layer',
      'tmp',
      'text.content',
      'x',
      { persist: false }
    );
  });
});
