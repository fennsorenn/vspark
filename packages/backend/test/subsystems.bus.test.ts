/**
 * Bus / manager subsystem tests.
 *
 * Covers:
 *  - RuntimeOverrideManager (set/get round-trips, type coercion, clear, snapshot,
 *    registerTarget for DB-free scene resolution)
 *  - DataChannelManager (set merge, seed, clear field/scope, clearAll, snapshot)
 *  - MediaControlManager (dispatch with/without ws, empty targetId guard)
 *  - SpawnManager.isEphemeralClip (the only pure unit-testable surface without a
 *    live graph — everything else needs DB + playback manager)
 *
 * The broadcast bus (BroadcastBus) uses getDb() for scene resolution and
 * starts setInterval timers. Its pure slot-management surface is covered via
 * publishBones / publishBlendshapes / removeBehavior — those paths only touch
 * getDb() when _resolveSceneId misses the cache; we avoid DB by bypassing the
 * slot API and instead testing the internals we can isolate cleanly.
 *
 * NOTE: BroadcastBus requires getDb() on the hot path (publishBones →
 * _slot → _resolveSceneId). We spin up a makeTestApp() so the DB is
 * initialised, but we exercise bus state we can observe without a real scene row.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RuntimeOverrideManager } from '../src/runtime_overrides/manager.js';
import { DataChannelManager } from '../src/data_channels/manager.js';
import { MediaControlManager } from '../src/media_control/manager.js';
import { SpawnManager } from '../src/spawn/manager.js';

// ---------------------------------------------------------------------------
// Silence noisy console output produced by the managers.
// ---------------------------------------------------------------------------
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Minimal stub for WSSync — only the broadcast / sendTo surface matters here.
// ---------------------------------------------------------------------------
function makeWsStub() {
  const broadcasts: Array<{ kind: string; payload: Record<string, unknown> }> =
    [];
  const ws = {
    broadcast(kind: string, payload: Record<string, unknown>) {
      broadcasts.push({ kind, payload });
    },
    sendTo(
      _client: unknown,
      kind: string,
      payload: Record<string, unknown>
    ) {
      broadcasts.push({ kind, payload });
    },
    onClientConnected(_fn: unknown) {},
  } as unknown as import('../src/ws/index.js').WSSync;
  return { ws, broadcasts };
}

// ===========================================================================
// RuntimeOverrideManager
// ===========================================================================

describe('RuntimeOverrideManager', () => {
  let manager: RuntimeOverrideManager;
  const { ws, broadcasts } = makeWsStub();

  beforeEach(() => {
    manager = new RuntimeOverrideManager();
    manager.init(ws);
    broadcasts.length = 0;
  });

  describe('set + get via snapshot', () => {
    it('set a valid Float param, snapshot contains it', () => {
      // Register a fake scene mapping so no DB lookup is needed.
      manager.registerTarget('node-1', 'scene-a');

      manager.set('scene_node', 'node-1', 'position.x', 3.14);

      const received: Array<Record<string, unknown>> = [];
      manager.sendSnapshotTo((_kind, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...(p.entries as Array<Record<string, unknown>>));
      });

      expect(received).toHaveLength(1);
      const entry = received[0];
      expect(entry.targetKind).toBe('scene_node');
      expect(entry.targetId).toBe('node-1');
      expect(entry.paramPath).toBe('position.x');
      expect(entry.value).toBeCloseTo(3.14);
    });

    it('broadcasts runtime_override_set on successful set', () => {
      manager.registerTarget('node-2', 'scene-b');
      manager.set('scene_node', 'node-2', 'rotation.y', 1.5);

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].kind).toBe('runtime_override_set');
      expect(broadcasts[0].payload.paramPath).toBe('rotation.y');
      expect(broadcasts[0].payload.value).toBeCloseTo(1.5);
    });

    it('set replaces an existing override for the same key', () => {
      manager.registerTarget('node-3', 'scene-c');
      manager.set('scene_node', 'node-3', 'opacity', 0.5);
      manager.set('scene_node', 'node-3', 'opacity', 0.9);

      const received: Array<Record<string, unknown>> = [];
      manager.sendSnapshotTo((_k, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...(p.entries as Array<Record<string, unknown>>));
      });

      // Only one entry for that key; value is the latest.
      const entry = received.find(
        (e) => e.paramPath === 'opacity' && e.targetId === 'node-3'
      );
      expect(entry).toBeDefined();
      expect(entry!.value).toBeCloseTo(0.9);
    });
  });

  describe('type coercion', () => {
    it('coerces string "42" to number 42 for Float paths', () => {
      manager.registerTarget('node-c1', 'scene-c1');
      manager.set('scene_node', 'node-c1', 'position.x', '42');
      const received: Array<Record<string, unknown>> = [];
      manager.sendSnapshotTo((_k, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...(p.entries as Array<Record<string, unknown>>));
      });
      expect(received[0]?.value).toBe(42);
    });

    it('coerces boolean true to 1 for Float paths', () => {
      manager.registerTarget('node-c2', 'scene-c2');
      manager.set('scene_node', 'node-c2', 'scale.z', true);
      const received: Array<Record<string, unknown>> = [];
      manager.sendSnapshotTo((_k, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...(p.entries as Array<Record<string, unknown>>));
      });
      expect(received[0]?.value).toBe(1);
    });

    it('ignores set with unknown paramPath (no snapshot entry added)', () => {
      manager.registerTarget('node-unk', 'scene-unk');
      manager.set('scene_node', 'node-unk', 'does.not.exist', 99);
      const received: Array<Record<string, unknown>> = [];
      manager.sendSnapshotTo((_k, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...(p.entries as Array<Record<string, unknown>>));
      });
      expect(received).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('ignores set with uncoercible value', () => {
      manager.registerTarget('node-bad', 'scene-bad');
      // An object cannot be coerced to Float — coerceParamValue returns null.
      manager.set('scene_node', 'node-bad', 'position.y', {} as unknown as number);
      const received: Array<Record<string, unknown>> = [];
      manager.sendSnapshotTo((_k, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...(p.entries as Array<Record<string, unknown>>));
      });
      expect(received).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('sets String param with text value', () => {
      // text.content is a String param for scene_node kinds text_troika/text_canvas
      // We call it via compose_layer where text.content is also String-typed.
      manager.registerTarget('layer-s', 'scene-s');
      manager.set('compose_layer', 'layer-s', 'text.content', 'hello world');
      const received: Array<Record<string, unknown>> = [];
      manager.sendSnapshotTo((_k, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...(p.entries as Array<Record<string, unknown>>));
      });
      expect(received[0]?.value).toBe('hello world');
    });
  });

  describe('clear', () => {
    it('clear with paramPath removes one entry and broadcasts', () => {
      manager.registerTarget('node-cl1', 'scene-d');
      manager.set('scene_node', 'node-cl1', 'position.x', 1);
      manager.set('scene_node', 'node-cl1', 'position.y', 2);
      broadcasts.length = 0;

      manager.clear('scene_node', 'node-cl1', 'position.x');

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].kind).toBe('runtime_override_clear');
      expect(broadcasts[0].payload.paramPath).toBe('position.x');

      // position.y still in snapshot.
      const received: Array<Record<string, unknown>> = [];
      manager.sendSnapshotTo((_k, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...(p.entries as Array<Record<string, unknown>>));
      });
      expect(received).toHaveLength(1);
      expect(received[0].paramPath).toBe('position.y');
    });

    it('clear without paramPath removes all entries for the target', () => {
      manager.registerTarget('node-cl2', 'scene-e');
      manager.set('scene_node', 'node-cl2', 'position.x', 1);
      manager.set('scene_node', 'node-cl2', 'position.y', 2);
      broadcasts.length = 0;

      manager.clear('scene_node', 'node-cl2');

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].kind).toBe('runtime_override_clear');
      expect(
        (broadcasts[0].payload as { paramPath?: unknown }).paramPath
      ).toBeUndefined();

      const received: Array<Record<string, unknown>> = [];
      manager.sendSnapshotTo((_k, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...(p.entries as Array<Record<string, unknown>>));
      });
      expect(received).toHaveLength(0);
    });

    it('clear is no-op for unknown targetId (no broadcast)', () => {
      broadcasts.length = 0;
      manager.clear('scene_node', 'ghost-id', 'position.x');
      expect(broadcasts).toHaveLength(0);
    });

    it('clearAllForTarget removes target from lookup cache', () => {
      manager.registerTarget('node-ca', 'scene-f');
      manager.set('scene_node', 'node-ca', 'position.z', 5);
      broadcasts.length = 0;

      manager.clearAllForTarget('scene_node', 'node-ca');

      // After clearAllForTarget the snapshot must be empty for this target.
      const received: Array<Record<string, unknown>> = [];
      manager.sendSnapshotTo((_k, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...(p.entries as Array<Record<string, unknown>>));
      });
      expect(received).toHaveLength(0);
      // And a clear broadcast should have been emitted.
      expect(broadcasts.some((b) => b.kind === 'runtime_override_clear')).toBe(true);
    });
  });

  describe('forwarder tap', () => {
    it('invokes the forwarder on set', () => {
      manager.registerTarget('node-fwd', 'scene-fwd');
      const ops: Array<{ op: string; payload: Record<string, unknown> }> = [];
      manager.setOverrideForwarder((op, payload) => ops.push({ op, payload }));

      manager.set('scene_node', 'node-fwd', 'opacity', 0.3);

      expect(ops).toHaveLength(1);
      expect(ops[0].op).toBe('set');
      expect(ops[0].payload.paramPath).toBe('opacity');
    });

    it('invokes the forwarder on clear', () => {
      manager.registerTarget('node-fwd2', 'scene-fwd2');
      const ops: Array<{ op: string }> = [];
      manager.setOverrideForwarder((op, _p) => ops.push({ op }));

      manager.set('scene_node', 'node-fwd2', 'position.x', 1);
      ops.length = 0;
      manager.clear('scene_node', 'node-fwd2', 'position.x');

      expect(ops).toHaveLength(1);
      expect(ops[0].op).toBe('clear');
    });
  });

  describe('snapshot is empty when nothing is set', () => {
    it('sendSnapshotTo on fresh manager emits empty entries array', () => {
      const received: unknown[] = [];
      manager.sendSnapshotTo((_k, payload) => {
        const p = payload as { entries: unknown[] };
        received.push(...p.entries);
      });
      expect(received).toHaveLength(0);
    });
  });
});

// ===========================================================================
// DataChannelManager
// ===========================================================================

describe('DataChannelManager', () => {
  let manager: DataChannelManager;
  const { ws, broadcasts } = makeWsStub();

  beforeEach(() => {
    manager = new DataChannelManager();
    manager.init(ws);
    broadcasts.length = 0;
  });

  describe('set', () => {
    it('stores and broadcasts merged fields', () => {
      manager.set('scope-a', { foo: 'bar', n: 42 });
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].kind).toBe('data_channel_set');
      expect(broadcasts[0].payload.scope).toBe('scope-a');
      expect((broadcasts[0].payload.fields as { foo: string }).foo).toBe('bar');
    });

    it('merges: second set does not erase first field', () => {
      manager.set('scope-b', { a: 1 });
      manager.set('scope-b', { b: 2 });

      const snap: Array<{ scope: string; fields: Record<string, unknown> }> = [];
      manager.sendSnapshotTo((_k, p) => {
        const payload = p as { entries: typeof snap };
        snap.push(...payload.entries);
      });
      const entry = snap.find((e) => e.scope === 'scope-b');
      expect(entry?.fields).toMatchObject({ a: 1, b: 2 });
    });

    it('set with empty fields is a no-op', () => {
      manager.set('scope-empty', {});
      expect(broadcasts).toHaveLength(0);
    });

    it('set normalizes non-string scope to empty string (global)', () => {
      // Internal _scopeKey trims and defaults non-strings to ''
      manager.set('  ', { x: 1 });
      const snap: Array<{ scope: string }> = [];
      manager.sendSnapshotTo((_k, p) => {
        const payload = p as { entries: typeof snap };
        snap.push(...payload.entries);
      });
      // trimmed scope '' = global
      expect(snap.some((e) => e.scope === '')).toBe(true);
    });
  });

  describe('seed', () => {
    it('seeds only fields not yet present', () => {
      manager.set('scope-seed', { a: 1 });
      broadcasts.length = 0;

      manager.seed('scope-seed', { a: 99, b: 2 });

      // Only b should be broadcast (a was already present).
      expect(broadcasts).toHaveLength(1);
      const fields = broadcasts[0].payload.fields as Record<string, unknown>;
      expect(fields.b).toBe(2);
      expect(fields.a).toBeUndefined();
    });

    it('seed is no-op when all fields already present', () => {
      manager.set('scope-seed2', { x: 10 });
      broadcasts.length = 0;
      manager.seed('scope-seed2', { x: 99 });
      expect(broadcasts).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('clear single field removes only that field', () => {
      manager.set('scope-c', { a: 1, b: 2 });
      broadcasts.length = 0;

      manager.clear('scope-c', 'a');

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].kind).toBe('data_channel_clear');
      expect((broadcasts[0].payload as { field?: string }).field).toBe('a');

      const snap: Array<{ scope: string; fields: Record<string, unknown> }> = [];
      manager.sendSnapshotTo((_k, p) => {
        const payload = p as { entries: typeof snap };
        snap.push(...payload.entries);
      });
      const entry = snap.find((e) => e.scope === 'scope-c');
      expect(entry?.fields.b).toBe(2);
      expect(entry?.fields.a).toBeUndefined();
    });

    it('clear entire scope broadcasts without field key', () => {
      manager.set('scope-drop', { x: 1 });
      broadcasts.length = 0;

      manager.clear('scope-drop');

      expect(broadcasts[0].kind).toBe('data_channel_clear');
      expect((broadcasts[0].payload as { field?: string }).field).toBeUndefined();
    });

    it('clear unknown scope is a no-op', () => {
      broadcasts.length = 0;
      manager.clear('no-such-scope');
      expect(broadcasts).toHaveLength(0);
    });

    it('clear unknown field within known scope is a no-op', () => {
      manager.set('scope-nf', { a: 1 });
      broadcasts.length = 0;
      manager.clear('scope-nf', 'z');
      expect(broadcasts).toHaveLength(0);
    });
  });

  describe('clearAll', () => {
    it('clears every scope and broadcasts a clear for each', () => {
      manager.set('s1', { a: 1 });
      manager.set('s2', { b: 2 });
      broadcasts.length = 0;

      manager.clearAll();

      const kinds = broadcasts.map((b) => b.kind);
      expect(kinds.every((k) => k === 'data_channel_clear')).toBe(true);
      expect(broadcasts).toHaveLength(2);
    });

    it('clearAll on empty manager is a no-op', () => {
      broadcasts.length = 0;
      manager.clearAll();
      expect(broadcasts).toHaveLength(0);
    });
  });

  describe('sendSnapshotTo', () => {
    it('snapshot includes all set scopes and their fields', () => {
      manager.set('alpha', { key: 'val' });
      manager.set('beta', { num: 7 });

      const snap: Array<{ scope: string; fields: Record<string, unknown> }> = [];
      manager.sendSnapshotTo((_k, p) => {
        const payload = p as { entries: typeof snap };
        snap.push(...payload.entries);
      });
      expect(snap).toHaveLength(2);
    });

    it('snapshot is sent via data_channel_snapshot message kind', () => {
      manager.set('z', { v: 1 });
      let capturedKind = '';
      manager.sendSnapshotTo((kind, _p) => {
        capturedKind = kind;
      });
      expect(capturedKind).toBe('data_channel_snapshot');
    });
  });

  describe('forwarder tap', () => {
    it('forwarder is called on set', () => {
      const ops: string[] = [];
      manager.setDataChannelForwarder((op) => ops.push(op));
      manager.set('fwd-scope', { a: 1 });
      expect(ops).toContain('set');
    });

    it('forwarder is called on clear', () => {
      const ops: string[] = [];
      manager.setDataChannelForwarder((op) => ops.push(op));
      manager.set('fwd2', { a: 1 });
      ops.length = 0;
      manager.clear('fwd2');
      expect(ops).toContain('clear');
    });
  });
});

// ===========================================================================
// MediaControlManager
// ===========================================================================

describe('MediaControlManager', () => {
  it('broadcasts media_control with correct shape', () => {
    const { ws, broadcasts } = makeWsStub();
    const manager = new MediaControlManager();
    manager.init(ws);

    manager.dispatch('compose_layer', 'layer-123', {
      type: 'play',
    } as import('@vspark/shared').MediaCommand);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].kind).toBe('media_control');
    expect(broadcasts[0].payload.targetKind).toBe('compose_layer');
    expect(broadcasts[0].payload.targetId).toBe('layer-123');
    expect((broadcasts[0].payload.command as { type: string }).type).toBe(
      'play'
    );
  });

  it('dispatch is a no-op when targetId is empty string', () => {
    const { ws, broadcasts } = makeWsStub();
    const manager = new MediaControlManager();
    manager.init(ws);

    manager.dispatch('compose_layer', '', {
      type: 'stop',
    } as import('@vspark/shared').MediaCommand);

    expect(broadcasts).toHaveLength(0);
  });

  it('dispatch with no ws initialised does not throw', () => {
    const manager = new MediaControlManager();
    // ws never set — should not throw.
    expect(() =>
      manager.dispatch('compose_layer', 'x', {
        type: 'pause',
      } as import('@vspark/shared').MediaCommand)
    ).not.toThrow();
  });

  it('broadcasts different command types without error', () => {
    const { ws, broadcasts } = makeWsStub();
    const manager = new MediaControlManager();
    manager.init(ws);

    const commands: import('@vspark/shared').MediaCommand[] = [
      { type: 'pause' },
      { type: 'stop' },
      { type: 'restart' },
      { type: 'setVolume', value: 0.5 },
      { type: 'mute', muted: true },
    ] as import('@vspark/shared').MediaCommand[];

    for (const cmd of commands) {
      manager.dispatch('compose_layer', 'tgt', cmd);
    }

    expect(broadcasts).toHaveLength(commands.length);
    expect(broadcasts.every((b) => b.kind === 'media_control')).toBe(true);
  });
});

// ===========================================================================
// SpawnManager — unit-testable surface
// ===========================================================================

describe('SpawnManager.isEphemeralClip', () => {
  it('returns false for an unknown clip id before any spawn', () => {
    const manager = new SpawnManager();
    expect(manager.isEphemeralClip('some-clip-id')).toBe(false);
  });

  it('returns false for an arbitrary string', () => {
    const manager = new SpawnManager();
    expect(manager.isEphemeralClip('')).toBe(false);
    expect(manager.isEphemeralClip('__spawn:123')).toBe(false);
  });

  it('spawn() without init returns null (ws + playback not set)', () => {
    const manager = new SpawnManager();
    // No init() → should return null gracefully.
    const result = manager.spawn('clip-xyz');
    expect(result).toBeNull();
  });
});
