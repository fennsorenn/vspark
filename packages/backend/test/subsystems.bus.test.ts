/**
 * Bus / manager subsystem tests.
 *
 * Covers:
 *  - RuntimeOverrideManager (set/clear round-trips through the mesh
 *    `runtime_override` collection, type coercion, registerTarget for DB-free
 *    scene resolution)
 *  - DataChannelManager (set merge, seed, clear field/scope, clearAll) through
 *    the mesh `data_field` collection
 *  - MediaControlManager (dispatch through the mesh `media_control` collection,
 *    empty targetId guard, nothing retained)
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
  dataFieldCollection,
  initMeshRuntime,
  mediaControlCollection,
  mediaControlParent,
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

  /** Live fields of a scope, as a plain object. The bus keeps no `_scopes` map
   *  any more — each field is its own retained document. */
  const fieldsOf = (scope: string) =>
    Object.fromEntries(
      (dataFieldCollection()?.all() ?? [])
        .filter((d) => d.scope === scope)
        .map((d) => [d.field, d.value])
    );
  const scopes = () =>
    new Set((dataFieldCollection()?.all() ?? []).map((d) => d.scope));

  beforeEach(() => {
    resetMeshRuntime();
    initMeshRuntime(
      createMeshPeer({ identity: { peerId: 'test-peer' }, transports: [] })
    );
    manager = new DataChannelManager();
  });

  describe('set', () => {
    it('publishes one document per field', () => {
      manager.set('scope-a', { foo: 'bar', n: 42 });
      expect(fieldsOf('scope-a')).toEqual({ foo: 'bar', n: 42 });
    });

    it('merges: a second set does not erase the first field', () => {
      manager.set('scope-b', { a: 1 });
      manager.set('scope-b', { b: 2 });
      // Structural, not defensive: different fields are different documents,
      // so two producers cannot clobber each other even under LWW.
      expect(fieldsOf('scope-b')).toEqual({ a: 1, b: 2 });
    });

    it('keeps a field label containing a dot intact', () => {
      // The reason a field is a document rather than a dotted path: labels come
      // from set_data's input ports and are arbitrary user text.
      manager.set('scope-dot', { 'user.name': 'ada' });
      expect(fieldsOf('scope-dot')).toEqual({ 'user.name': 'ada' });
    });

    it('set with empty fields is a no-op', () => {
      manager.set('scope-empty', {});
      expect(scopes().has('scope-empty')).toBe(false);
    });

    it('normalizes a whitespace scope to global', () => {
      manager.set('  ', { x: 1 });
      expect(fieldsOf('')).toEqual({ x: 1 });
    });
  });

  describe('seed', () => {
    it('seeds only fields not yet present', () => {
      manager.set('scope-seed', { a: 1 });
      manager.seed('scope-seed', { a: 99, b: 2 });
      expect(fieldsOf('scope-seed')).toEqual({ a: 1, b: 2 });
    });

    it('seed is a no-op when all fields are already present', () => {
      manager.set('scope-seed2', { x: 10 });
      manager.seed('scope-seed2', { x: 99 });
      expect(fieldsOf('scope-seed2')).toEqual({ x: 10 });
    });
  });

  describe('clear', () => {
    it('clear single field removes only that field', () => {
      manager.set('scope-c', { a: 1, b: 2 });
      manager.clear('scope-c', 'a');
      expect(fieldsOf('scope-c')).toEqual({ b: 2 });
    });

    it('clear without a field removes the whole scope', () => {
      manager.set('scope-drop', { x: 1, y: 2 });
      manager.clear('scope-drop');
      expect(scopes().has('scope-drop')).toBe(false);
    });

    it('clear leaves other scopes alone', () => {
      manager.set('s1', { a: 1 });
      manager.set('s2', { b: 2 });
      manager.clear('s1');
      expect(fieldsOf('s2')).toEqual({ b: 2 });
    });

    it('clear of an unknown scope is a no-op', () => {
      manager.clear('no-such-scope');
      expect(scopes().size).toBe(0);
    });

    it('clear of an unknown field within a known scope is a no-op', () => {
      manager.set('scope-nf', { a: 1 });
      manager.clear('scope-nf', 'z');
      expect(fieldsOf('scope-nf')).toEqual({ a: 1 });
    });
  });

  describe('clearAll', () => {
    it('clears every scope', () => {
      manager.set('s1', { a: 1 });
      manager.set('s2', { b: 2 });
      manager.clearAll();
      expect(scopes().size).toBe(0);
    });

    it('clearAll on an empty bus is a no-op', () => {
      expect(() => manager.clearAll()).not.toThrow();
      expect(scopes().size).toBe(0);
    });
  });

  describe('no store', () => {
    it('every method is inert when the mesh is not up', () => {
      resetMeshRuntime();
      const m = new DataChannelManager();
      expect(() => m.set('s', { a: 1 })).not.toThrow();
      expect(() => m.seed('s', { a: 1 })).not.toThrow();
      expect(() => m.clear('s')).not.toThrow();
      expect(() => m.clearAll()).not.toThrow();
    });
  });
});

describe('MediaControlManager', () => {
  /** Commands seen by a peer holding the target. The collection is UNRETAINED,
   *  so this observes rather than reads back a stored value — a command that is
   *  still readable an hour later would be a command a late joiner replays. */
  let seen: { targetId: string; command: unknown }[];

  beforeEach(() => {
    resetMeshRuntime();
    initMeshRuntime(
      createMeshPeer({ identity: { peerId: 'test-peer' }, transports: [] })
    );
    seen = [];
    mediaControlCollection()!.observe('**', (c) => {
      const d = c.doc as { targetId: string; command: unknown } | undefined;
      if (d) seen.push({ targetId: d.targetId, command: d.command });
    });
  });

  it('publishes a command addressed to its target', () => {
    const manager = new MediaControlManager();
    manager.dispatch('compose_layer', 'layer-123', {
      type: 'play',
    } as import('@vspark/shared').MediaCommand);

    expect(seen).toEqual([
      { targetId: 'layer-123', command: { type: 'play' } },
    ]);
  });

  it('parents the command to its target', () => {
    // So a subtree grant on the scene routes it, exactly like the override and
    // data-field documents on the same entity.
    const manager = new MediaControlManager();
    manager.dispatch('scene_node', 'node-9', {
      type: 'play',
    } as import('@vspark/shared').MediaCommand);
    expect(
      mediaControlParent({ targetKind: 'scene_node', targetId: 'node-9' })
    ).toEqual({ rtype: 'scene_node', id: 'node-9' });
  });

  it('is not replayed to a peer that subscribes later', () => {
    // The point of the UNRETAINED channel. A subscription snapshot carries
    // only a collection's retained channel, so `play` an hour ago cannot fire
    // on a tab that opens now — which is why media commands do NOT live on the
    // `runtime` channel the overrides and data fields use.
    expect(mediaControlCollection()!.retainedChannel).toBeUndefined();
  });

  it('dispatch is a no-op when targetId is an empty string', () => {
    const manager = new MediaControlManager();
    manager.dispatch('compose_layer', '', {
      type: 'stop',
    } as import('@vspark/shared').MediaCommand);
    expect(seen).toHaveLength(0);
  });

  it('dispatch without a store does not throw', () => {
    resetMeshRuntime();
    const manager = new MediaControlManager();
    expect(() =>
      manager.dispatch('compose_layer', 'x', {
        type: 'pause',
      } as import('@vspark/shared').MediaCommand)
    ).not.toThrow();
  });

  it('delivers every command type, in order', () => {
    const manager = new MediaControlManager();
    const commands = [
      { type: 'pause' },
      { type: 'stop' },
      { type: 'restart' },
      { type: 'setVolume', value: 0.5 },
      { type: 'mute', muted: true },
    ] as import('@vspark/shared').MediaCommand[];

    for (const cmd of commands) manager.dispatch('compose_layer', 'tgt', cmd);

    // Repeated commands to one target are a sequence, not an LWW collapse —
    // the key is the target, and the channel is unstamped.
    expect(seen.map((s) => s.command)).toEqual(commands);
  });
});

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
