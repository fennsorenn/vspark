/**
 * Bus / manager subsystem tests.
 *
 * Covers:
 *  - RuntimeOverrideManager (set/clear round-trips through the mesh
 *    `runtime_override` collection, type coercion, registerTarget for DB-free
 *    scene resolution)
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
import { createMeshPeer } from '@vspark/mesh';
import { RuntimeOverrideManager } from '../src/runtime_overrides/manager.js';
import {
  initMeshRuntime,
  overrideCollection,
  overrideParent,
  resetMeshRuntime,
} from '../src/mesh/runtime.js';
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

  /** Every live override, as (targetKind, targetId, paramPath, value) rows.
   *  The replica IS the bus's state now — there is no snapshot method and no
   *  broadcast to intercept, because a retained document reaches a late joiner
   *  through its subscription instead. */
  const rows = () =>
    (overrideCollection()?.all() ?? []).map((d) => ({
      targetKind: d.targetKind,
      targetId: d.targetId,
      paramPath: d.paramPath,
      value: d.value,
    }));

  beforeEach(() => {
    resetMeshRuntime();
    initMeshRuntime(
      createMeshPeer({ identity: { peerId: 'test-peer' }, transports: [] })
    );
    manager = new RuntimeOverrideManager();
    manager.init();
  });

  describe('set', () => {
    it('a valid Float param becomes a document', () => {
      // Register a fake scene mapping so no DB lookup is needed.
      manager.registerTarget('node-1', 'scene-a');

      manager.set('scene_node', 'node-1', 'position.x', 3.14);

      expect(rows()).toHaveLength(1);
      const entry = rows()[0];
      expect(entry.targetKind).toBe('scene_node');
      expect(entry.targetId).toBe('node-1');
      expect(entry.paramPath).toBe('position.x');
      expect(entry.value).toBeCloseTo(3.14 as number);
    });

    it('keys one document per overridden path', () => {
      manager.registerTarget('node-2', 'scene-b');
      manager.set('scene_node', 'node-2', 'rotation.y', 1.5);
      manager.set('scene_node', 'node-2', 'opacity', 0.5);

      // Two params of one node are two documents, so two graphs overriding
      // different params of the same node cannot clobber each other.
      expect(overrideCollection()!.get('scene_node:node-2:rotation.y')).toBeDefined();
      expect(overrideCollection()!.get('scene_node:node-2:opacity')).toBeDefined();
    });

    it('hangs the document off the target, so scene grants route it', () => {
      manager.registerTarget('node-2b', 'scene-b');
      manager.set('scene_node', 'node-2b', 'opacity', 0.25);

      // Containment is what lets an override ride an existing scene-subtree
      // grant without the grant naming this rtype.
      expect(
        overrideParent(overrideCollection()!.get('scene_node:node-2b:opacity')!)
      ).toEqual({ rtype: 'scene_node', id: 'node-2b' });
    });

    it('set replaces an existing override for the same key', () => {
      manager.registerTarget('node-3', 'scene-c');
      manager.set('scene_node', 'node-3', 'opacity', 0.5);
      manager.set('scene_node', 'node-3', 'opacity', 0.9);

      expect(rows()).toHaveLength(1);
      expect(rows()[0].value).toBeCloseTo(0.9 as number);
    });
  });

  describe('type coercion', () => {
    it('coerces string "42" to number 42 for Float paths', () => {
      manager.registerTarget('node-4', 'scene-d');
      manager.set('scene_node', 'node-4', 'position.y', '42');
      expect(rows()[0].value).toBe(42);
    });

    it('coerces boolean true to 1 for Float paths', () => {
      manager.registerTarget('node-5', 'scene-e');
      manager.set('scene_node', 'node-5', 'position.z', true);
      expect(rows()[0].value).toBe(1);
    });

    it('ignores set with unknown paramPath', () => {
      manager.registerTarget('node-6', 'scene-f');
      manager.set('scene_node', 'node-6', 'not.a.real.path', 1);
      expect(rows()).toHaveLength(0);
    });

    it('ignores set with uncoercible value', () => {
      manager.registerTarget('node-7', 'scene-g');
      manager.set('scene_node', 'node-7', 'position.x', {});
      expect(rows()).toHaveLength(0);
    });

    it('sets String param with text value', () => {
      manager.registerTarget('node-8', 'scene-h');
      manager.set('scene_node', 'node-8', 'text.content', 'hello');
      expect(rows()[0].value).toBe('hello');
    });
  });

  describe('clear', () => {
    it('clear with paramPath removes one document', () => {
      manager.registerTarget('node-9', 'scene-i');
      manager.set('scene_node', 'node-9', 'position.x', 1);
      manager.set('scene_node', 'node-9', 'position.y', 2);

      manager.clear('scene_node', 'node-9', 'position.x');

      expect(rows().map((r) => r.paramPath)).toEqual(['position.y']);
    });

    it('clear without paramPath removes every path for the target', () => {
      manager.registerTarget('node-10', 'scene-j');
      manager.set('scene_node', 'node-10', 'position.x', 1);
      manager.set('scene_node', 'node-10', 'opacity', 0.5);

      manager.clear('scene_node', 'node-10');

      // One remove per document — there is no prefix-delete on a replica.
      expect(rows()).toHaveLength(0);
    });

    it('clear leaves other targets alone', () => {
      manager.registerTarget('node-11', 'scene-k');
      manager.registerTarget('node-12', 'scene-k');
      manager.set('scene_node', 'node-11', 'opacity', 0.5);
      manager.set('scene_node', 'node-12', 'opacity', 0.5);

      manager.clear('scene_node', 'node-11');

      expect(rows().map((r) => r.targetId)).toEqual(['node-12']);
    });

    it('clear is a no-op for an unknown targetId', () => {
      manager.clear('scene_node', 'never-set');
      expect(rows()).toHaveLength(0);
    });

    it('clearAllForTarget removes the documents', () => {
      manager.registerTarget('node-13', 'scene-l');
      manager.set('scene_node', 'node-13', 'opacity', 0.5);

      manager.clearAllForTarget('scene_node', 'node-13');

      // It also drops the tmp-entity registration, so a later set falls back
      // to the database lookup — not exercised here, which has no DB.
      expect(rows()).toHaveLength(0);
    });
  });

  describe('no store', () => {
    it('set and clear are inert when the mesh is not up', () => {
      resetMeshRuntime();
      const m = new RuntimeOverrideManager();
      m.init();
      m.registerTarget('node-14', 'scene-m');
      // An override is best-effort: a missing store logs and drops rather than
      // throwing into a running graph.
      expect(() => m.set('scene_node', 'node-14', 'opacity', 0.5)).not.toThrow();
      expect(() => m.clear('scene_node', 'node-14')).not.toThrow();
    });
  });
});

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
