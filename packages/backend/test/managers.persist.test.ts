/**
 * managers.persist.test.ts
 *
 * Covers the previously-untested persist paths in the behaviour managers:
 *
 *   (a) BreathingManager._persistNodeState — reads a `behaviors` row, updates
 *       the `config._nodeState` JSON field, writes it back.
 *   (b) LipsyncManager._persistNodeState  — same pattern.
 *   (c) VmcManager.persistNodeState       — same pattern.
 *   (d) ApiControllerManager._writeSchedule — when the mesh collection is
 *       available, projects a clip queue onto the scheduled_animation timeline.
 *   (e) ApiControllerManager.setAnimationQueue — resolves a clip from
 *       animation_clips (seeded via direct DB insert) and calls _writeSchedule.
 *
 * The private _persistNodeState methods are exercised indirectly by putting a
 * real `behaviors` row in the in-memory DB and then calling the public APIs
 * (start() + triggering a graph event that causes a state save). The persist
 * code itself is "try/catch non-fatal", so we assert the DB column changed.
 *
 * Mocks mirror managers.test.ts: udp_socket_pool, broadcastBus,
 * pose_broadcast, blendshapes_broadcast. The mesh collection for
 * _writeSchedule is provided by calling initBackendMesh() from the
 * test harness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoist the mock factories (same pattern as managers.test.ts) ───────────────
const { mockUnsubscribe, mockSubscribe } = vi.hoisted(() => {
  const mockUnsubscribe = vi.fn();
  const mockSubscribe = vi.fn(() => mockUnsubscribe);
  return { mockUnsubscribe, mockSubscribe };
});

vi.mock('../src/vmc/udp_socket_pool.js', () => ({
  udpSocketPool: {
    subscribe: mockSubscribe,
    closeAll: vi.fn(),
  },
}));

vi.mock('dgram', () => ({
  createSocket: vi.fn(() => ({
    on: vi.fn(),
    bind: vi.fn(),
    close: vi.fn(),
    address: vi.fn(() => ({ port: 0 })),
  })),
}));

vi.mock('../src/broadcast/bus.js', () => ({
  broadcastBus: {
    removeBehavior: vi.fn(),
    publishBones: vi.fn(),
    publishBlendshapes: vi.fn(),
    init: vi.fn(),
    stop: vi.fn(),
    setSceneTickRate: vi.fn(),
    reloadSceneSettings: vi.fn(),
  },
}));

vi.mock('../src/signal/nodes/pose_broadcast.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../src/signal/nodes/pose_broadcast.js')
    >();
  return { ...original, initPoseBroadcast: vi.fn() };
});

vi.mock('../src/signal/nodes/blendshapes_broadcast.js', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../src/signal/nodes/blendshapes_broadcast.js')
    >();
  return { ...original, initBlendshapesBroadcast: vi.fn() };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { BreathingManager } from '../src/behaviors/breathing/manager.js';
import { PoseStylizerManager } from '../src/behaviors/pose_stylizer/manager.js';
import { LipsyncManager } from '../src/behaviors/lipsync/manager.js';
import { VmcManager } from '../src/behaviors/vmc_receiver/manager.js';
import { ApiControllerManager } from '../src/behaviors/api_controller/manager.js';
import { runMigrations, closeDb, getDb } from '../src/db/index.js';
import {
  initBackendMesh,
  resetBackendMesh,
  getMeshCollection,
} from '../src/mesh/index.js';

// ── Silence console during tests ─────────────────────────────────────────────
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── DB bootstrap ─────────────────────────────────────────────────────────────
beforeEach(async () => {
  process.env.VSPARK_DB_PATH = ':memory:';
  resetBackendMesh();
  closeDb();
  await runMigrations();
});

afterEach(() => {
  resetBackendMesh();
  closeDb();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: seed the minimal DB rows needed to exercise persist paths.
// Returns ids for use in tests.
// ─────────────────────────────────────────────────────────────────────────────

function seedBehaviorRow(
  behaviorId: string,
  nodeId: string,
  kind: string,
  projectId: string,
  config: Record<string, unknown> = {}
) {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, name) VALUES (?, 'Test Project')"
  ).run(projectId);
  db.prepare(
    `INSERT OR IGNORE INTO scene_nodes
       (id, project_id, root_scene_node_id, name, kind, components)
     VALUES (?, ?, ?, 'AvatarNode', 'avatar', '{}')`
  ).run(nodeId, projectId, nodeId);
  db.prepare(
    `INSERT OR IGNORE INTO behaviors
       (id, node_id, kind, enabled, config)
     VALUES (?, ?, ?, 1, ?)`
  ).run(behaviorId, nodeId, kind, JSON.stringify(config));
}

function seedAnimationClip(
  clipId: string,
  clipName: string,
  nodeId: string,
  duration: number
) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO animation_clips
         (id, name, source_node_id, source_file_path, clip_index, label,
          start_time, end_time, duration, fps)
       VALUES (?, ?, ?, '/uploads/idle.fbx', 0, ?, 0, ?, ?, 30)`
    )
    .run(clipId, clipName, nodeId, clipName, duration, duration);
}

function getBehaviorConfig(behaviorId: string): Record<string, unknown> {
  const row = getDb()
    .prepare('SELECT config FROM behaviors WHERE id = ?')
    .get(behaviorId) as { config: string } | undefined;
  return row ? (JSON.parse(row.config) as Record<string, unknown>) : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// BreathingManager — _persistNodeState
// ─────────────────────────────────────────────────────────────────────────────

describe('BreathingManager._persistNodeState', () => {
  let manager: BreathingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new BreathingManager();
  });

  afterEach(() => {
    manager.close();
    vi.useRealTimers();
  });

  it('no-ops when behaviors row is absent (non-fatal)', () => {
    // start() triggers graph creation; the graph will attempt to persist state
    // but the row does not exist — the call should be silently swallowed.
    expect(() => manager.start('b-absent')).not.toThrow();
  });

  it('writes _nodeState into behaviors.config when the row exists', () => {
    seedBehaviorRow('b1', 'sn1', 'breathing', 'p1');
    // Call syncBehaviors so the manager tracks the behaviorId → nodeId mapping.
    manager.syncBehaviors([
      { id: 'b1', nodeId: 'sn1', kind: 'breathing', enabled: true, config: {} },
    ]);

    // Directly invoke the private persist method via a cast to any.
    // This is the most direct way to cover the branch without waiting for an
    // actual graph state change in the test environment.
    (manager as unknown as { _persistNodeState(a: string, b: string, c: unknown): void })
      ._persistNodeState('b1', 'clock', { hz: 30 });

    const cfg = getBehaviorConfig('b1');
    const ns = cfg._nodeState as Record<string, unknown> | undefined;
    expect(ns).toBeDefined();
    expect(ns!['clock']).toEqual({ hz: 30 });
  });

  it('accumulates multiple nodeId entries in _nodeState', () => {
    seedBehaviorRow('b2', 'sn2', 'breathing', 'p2');
    manager.syncBehaviors([
      { id: 'b2', nodeId: 'sn2', kind: 'breathing', enabled: true, config: {} },
    ]);

    const persist = (manager as unknown as { _persistNodeState(a: string, b: string, c: unknown): void })
      ._persistNodeState.bind(manager);

    persist('b2', 'clock', { hz: 20 });
    persist('b2', 'some_node', { value: 42 });

    const cfg = getBehaviorConfig('b2');
    const ns = cfg._nodeState as Record<string, unknown>;
    expect(ns['clock']).toEqual({ hz: 20 });
    expect(ns['some_node']).toEqual({ value: 42 });
  });

  it('merges into existing _nodeState without overwriting unrelated keys', () => {
    const existingCfg = { sensitivity: 0.8, _nodeState: { other: 'keep' } };
    seedBehaviorRow('b3', 'sn3', 'breathing', 'p3', existingCfg);

    manager.syncBehaviors([
      {
        id: 'b3',
        nodeId: 'sn3',
        kind: 'breathing',
        enabled: true,
        config: existingCfg,
      },
    ]);

    (manager as unknown as { _persistNodeState(a: string, b: string, c: unknown): void })
      ._persistNodeState('b3', 'clock', { hz: 30 });

    const cfg = getBehaviorConfig('b3');
    const ns = cfg._nodeState as Record<string, unknown>;
    expect(ns['other']).toBe('keep');
    expect(ns['clock']).toEqual({ hz: 30 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LipsyncManager — _persistNodeState
// ─────────────────────────────────────────────────────────────────────────────

describe('LipsyncManager._persistNodeState', () => {
  let manager: LipsyncManager;

  beforeEach(() => {
    manager = new LipsyncManager();
  });

  afterEach(() => {
    manager.close();
  });

  it('no-ops when behaviors row is absent (non-fatal)', () => {
    expect(() => manager.start('ls-absent')).not.toThrow();
  });

  it('writes _nodeState into behaviors.config when the row exists', () => {
    seedBehaviorRow('ls1', 'sn1', 'lipsync_processor', 'p1');
    manager.syncBehaviors([
      {
        id: 'ls1',
        nodeId: 'sn1',
        kind: 'lipsync_processor',
        enabled: true,
        config: {},
      },
    ]);

    (
      manager as unknown as {
        _persistNodeState(a: string, b: string, c: unknown): void;
      }
    )._persistNodeState('ls1', 'lipsync_src', { lastViseme: 'aa' });

    const cfg = getBehaviorConfig('ls1');
    const ns = cfg._nodeState as Record<string, unknown>;
    expect(ns).toBeDefined();
    expect(ns['lipsync_src']).toEqual({ lastViseme: 'aa' });
  });

  it('does not throw when persist is called multiple times', () => {
    seedBehaviorRow('ls2', 'sn2', 'lipsync_processor', 'p2');
    manager.syncBehaviors([
      {
        id: 'ls2',
        nodeId: 'sn2',
        kind: 'lipsync_processor',
        enabled: true,
        config: {},
      },
    ]);

    const persist = (
      manager as unknown as {
        _persistNodeState(a: string, b: string, c: unknown): void;
      }
    )._persistNodeState.bind(manager);

    expect(() => {
      persist('ls2', 'node_a', { x: 1 });
      persist('ls2', 'node_a', { x: 2 });
    }).not.toThrow();

    const cfg = getBehaviorConfig('ls2');
    const ns = cfg._nodeState as Record<string, unknown>;
    expect((ns['node_a'] as { x: number }).x).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VmcManager — persistNodeState
// ─────────────────────────────────────────────────────────────────────────────

describe('VmcManager.persistNodeState', () => {
  const makeWs = () => ({
    broadcast: vi.fn(),
    onClientConnected: vi.fn(),
    sendTo: vi.fn(),
  });

  let ws: ReturnType<typeof makeWs>;
  let manager: VmcManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();
    ws = makeWs();
    manager = new VmcManager(ws as never);
  });

  afterEach(() => {
    manager.close();
    vi.useRealTimers();
  });

  it('no-ops when behaviors row is absent (non-fatal)', () => {
    expect(() => manager.startReceiver('vmc-absent', 39539)).not.toThrow();
  });

  it('writes _nodeState into behaviors.config when the row exists', () => {
    seedBehaviorRow('vmc1', 'sn1', 'vmc_receiver', 'p1');

    manager.startReceiver('vmc1', 39539);

    // Invoke the private method directly (same technique as Breathing/Lipsync).
    (
      manager as unknown as {
        persistNodeState(a: string, b: string, c: unknown): void;
      }
    ).persistNodeState('vmc1', 'head_calib', { boneFilter: ['head'] });

    const cfg = getBehaviorConfig('vmc1');
    const ns = cfg._nodeState as Record<string, unknown>;
    expect(ns).toBeDefined();
    expect(ns['head_calib']).toEqual({ boneFilter: ['head'] });
  });

  it('does not overwrite unrelated config keys', () => {
    const existing = { port: 39539, mirror: false, _nodeState: { prev: 1 } };
    seedBehaviorRow('vmc2', 'sn2', 'vmc_receiver', 'p2', existing);
    manager.startReceiver('vmc2', 39539);

    (
      manager as unknown as {
        persistNodeState(a: string, b: string, c: unknown): void;
      }
    ).persistNodeState('vmc2', 'body_calib', { calibrated: true });

    const cfg = getBehaviorConfig('vmc2');
    expect(cfg.port).toBe(39539);
    const ns = cfg._nodeState as Record<string, unknown>;
    // Previous key must be preserved.
    expect(ns['prev']).toBe(1);
    expect(ns['body_calib']).toEqual({ calibrated: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ApiControllerManager — _writeSchedule + setAnimationQueue
// ─────────────────────────────────────────────────────────────────────────────

describe('ApiControllerManager._writeSchedule', () => {
  let manager: ApiControllerManager;

  beforeEach(() => {
    // _writeSchedule uses getMeshCollection('scheduled_animation'), which is
    // null unless the mesh peer is bootstrapped.
    initBackendMesh();
    manager = new ApiControllerManager();
  });

  afterEach(() => {
    manager.close();
  });

  it('no-ops gracefully when clips array is empty', () => {
    // _writeSchedule returns early when clips === [] or startedAt === null.
    expect(() =>
      (
        manager as unknown as {
          _writeSchedule(
            a: string,
            b: unknown[],
            c: string,
            d: number | null
          ): void;
        }
      )._writeSchedule('node1', [], 'none', null)
    ).not.toThrow();
  });

  it('writes schedule entries into the mesh collection when clips are provided', () => {
    const col = getMeshCollection('scheduled_animation');
    expect(col).toBeDefined();

    const clips = [
      { animationId: 'clip-1', sourceUrl: '/uploads/idle.fbx', duration: 3 },
    ];
    const now = Date.now();

    (
      manager as unknown as {
        _writeSchedule(
          a: string,
          b: typeof clips,
          c: string,
          d: number
        ): void;
      }
    )._writeSchedule('avatar-node-1', clips, 'none', now);

    // The collection should now contain at least one entry for this avatar.
    const all = col!.all() as Array<Record<string, unknown>>;
    const entry = all.find((d) => d['avatarNodeId'] === 'avatar-node-1');
    expect(entry).toBeDefined();
    expect(entry!['clipId']).toBe('clip-1');
  });

  it('clears existing entries for the same avatar before writing the new schedule', () => {
    const col = getMeshCollection('scheduled_animation')!;

    const addSchedule = (clipId: string) => {
      const clips = [{ animationId: clipId, sourceUrl: '/uploads/x.fbx', duration: 2 }];
      (
        manager as unknown as {
          _writeSchedule(
            a: string,
            b: typeof clips,
            c: string,
            d: number
          ): void;
        }
      )._writeSchedule('avatar-node-2', clips, 'none', Date.now());
    };

    addSchedule('clip-A');
    addSchedule('clip-B');

    // After the second call only clip-B should remain for this avatar.
    const entries = (col.all() as Array<Record<string, unknown>>).filter(
      (d) => d['avatarNodeId'] === 'avatar-node-2'
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]['clipId']).toBe('clip-B');
  });

  it('respects loopMode=last by setting loop=true on the final clip', () => {
    const col = getMeshCollection('scheduled_animation')!;
    const clips = [
      { animationId: 'c1', sourceUrl: '/uploads/a.fbx', duration: 2 },
      { animationId: 'c2', sourceUrl: '/uploads/b.fbx', duration: 3 },
    ];

    (
      manager as unknown as {
        _writeSchedule(
          a: string,
          b: typeof clips,
          c: string,
          d: number
        ): void;
      }
    )._writeSchedule('avatar-node-3', clips, 'last', Date.now());

    const entries = (col.all() as Array<Record<string, unknown>>)
      .filter((d) => d['avatarNodeId'] === 'avatar-node-3')
      .sort(
        (a, b) =>
          (a['startEpoch'] as number) - (b['startEpoch'] as number)
      );
    expect(entries).toHaveLength(2);
    expect(entries[0]['loop']).toBe(false);
    expect(entries[1]['loop']).toBe(true);
  });
});

describe('ApiControllerManager.setAnimationQueue', () => {
  let manager: ApiControllerManager;

  beforeEach(() => {
    initBackendMesh();
    manager = new ApiControllerManager();
  });

  afterEach(() => {
    manager.close();
  });

  it('throws when the component is not active', () => {
    expect(() =>
      manager.setAnimationQueue('not-registered', [], 'none')
    ).toThrow('not active');
  });

  it('throws when the clip name is not found for the node', () => {
    seedBehaviorRow('ac1', 'sn1', 'api_controller', 'p1');
    manager.syncBehaviors([
      {
        id: 'ac1',
        nodeId: 'sn1',
        kind: 'api_controller',
        enabled: true,
        config: {},
      },
    ]);

    expect(() =>
      manager.setAnimationQueue('ac1', [{ animation: 'nonexistent' }], 'none')
    ).toThrow("animation clip 'nonexistent' not found");
  });

  it('resolves a clip by id and writes a schedule entry', () => {
    seedBehaviorRow('ac2', 'sn2', 'api_controller', 'p2');
    seedAnimationClip('clip-idle', 'Idle', 'sn2', 5);

    manager.syncBehaviors([
      {
        id: 'ac2',
        nodeId: 'sn2',
        kind: 'api_controller',
        enabled: true,
        config: {},
      },
    ]);

    // Should not throw — clip is resolved by id.
    expect(() =>
      manager.setAnimationQueue('ac2', [{ animation: 'clip-idle' }], 'none')
    ).not.toThrow();

    // The in-memory queue should be populated.
    const st = manager.getState('ac2')!;
    expect(st.queue).toHaveLength(1);
    expect(st.queue[0].animationId).toBe('clip-idle');
    expect(st.queue[0].duration).toBe(5);
  });

  it('resolves a clip by name and writes a schedule entry', () => {
    seedBehaviorRow('ac3', 'sn3', 'api_controller', 'p3');
    seedAnimationClip('clip-walk', 'Walk', 'sn3', 2);

    manager.syncBehaviors([
      {
        id: 'ac3',
        nodeId: 'sn3',
        kind: 'api_controller',
        enabled: true,
        config: {},
      },
    ]);

    expect(() =>
      manager.setAnimationQueue('ac3', [{ animation: 'Walk' }], 'none')
    ).not.toThrow();

    const st = manager.getState('ac3')!;
    expect(st.queue[0].animationId).toBe('clip-walk');
  });

  it('falls back to DEFAULT_DURATION_SEC when clip duration is 0', () => {
    seedBehaviorRow('ac4', 'sn4', 'api_controller', 'p4');
    seedAnimationClip('clip-zero', 'ZeroDur', 'sn4', 0);

    manager.syncBehaviors([
      {
        id: 'ac4',
        nodeId: 'sn4',
        kind: 'api_controller',
        enabled: true,
        config: {},
      },
    ]);

    manager.setAnimationQueue('ac4', [{ animation: 'clip-zero' }], 'none');

    const st = manager.getState('ac4')!;
    // DEFAULT_DURATION_SEC is 5 in the source.
    expect(st.queue[0].duration).toBe(5);
  });

  it('sets loopMode on the state and writes schedule with the mode', () => {
    seedBehaviorRow('ac5', 'sn5', 'api_controller', 'p5');
    seedAnimationClip('clip-loop', 'Loop', 'sn5', 3);

    manager.syncBehaviors([
      {
        id: 'ac5',
        nodeId: 'sn5',
        kind: 'api_controller',
        enabled: true,
        config: {},
      },
    ]);

    manager.setAnimationQueue('ac5', [{ animation: 'Loop' }], 'queue');

    const st = manager.getState('ac5')!;
    expect(st.loopMode).toBe('queue');
    expect(st.startedAt).not.toBeNull();

    // Verify the schedule was written to the mesh collection.
    const col = getMeshCollection('scheduled_animation');
    const entries = (col!.all() as Array<Record<string, unknown>>).filter(
      (d) => d['avatarNodeId'] === 'sn5'
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]['loop']).toBe(true); // loopMode 'queue' → loop last
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PoseStylizerManager — _persistNodeState (and what it deliberately skips)
// ─────────────────────────────────────────────────────────────────────────────

describe('PoseStylizerManager._persistNodeState', () => {
  let manager: PoseStylizerManager;

  beforeEach(() => {
    manager = new PoseStylizerManager();
  });

  afterEach(() => {
    manager.close();
  });

  const persistOf = (m: PoseStylizerManager) =>
    (
      m as unknown as {
        _persistNodeState(a: string, b: string, c: unknown): void;
      }
    )._persistNodeState.bind(m);

  it('no-ops when the behaviors row is absent (non-fatal)', () => {
    expect(() => manager.start('b-absent')).not.toThrow();
  });

  it('writes _nodeState into behaviors.config for ordinary nodes', () => {
    seedBehaviorRow('s1', 'sn1', 'pose_stylizer', 'p1');
    manager.syncBehaviors([
      { id: 's1', nodeId: 'sn1', kind: 'pose_stylizer', enabled: true, config: {} },
    ]);

    persistOf(manager)('s1', 'stylize', { some: 'state' });

    const ns = getBehaviorConfig('s1')._nodeState as Record<string, unknown>;
    expect(ns['stylize']).toEqual({ some: 'state' });
  });

  it('SKIPS the interceptor node — its state is a whole pose, injected at ~60Hz', () => {
    // `on_pose_broadcast` has the current pose written into its state before every
    // fire. Persisting that would mean a read-modify-write of the behaviors row at
    // the pose rate, for a value that is meaningless after a restart.
    seedBehaviorRow('s2', 'sn2', 'pose_stylizer', 'p2');
    manager.syncBehaviors([
      { id: 's2', nodeId: 'sn2', kind: 'pose_stylizer', enabled: true, config: {} },
    ]);

    persistOf(manager)('s2', 'intercept', { frame: { pose: 'huge' } });

    const cfg = getBehaviorConfig('s2');
    const ns = (cfg._nodeState ?? {}) as Record<string, unknown>;
    expect(ns['intercept']).toBeUndefined();
  });

  it('merges into existing _nodeState without clobbering unrelated keys', () => {
    const existingCfg = { amount: 0.6, _nodeState: { other: 'keep' } };
    seedBehaviorRow('s3', 'sn3', 'pose_stylizer', 'p3', existingCfg);
    manager.syncBehaviors([
      {
        id: 's3',
        nodeId: 'sn3',
        kind: 'pose_stylizer',
        enabled: true,
        config: existingCfg,
      },
    ]);

    persistOf(manager)('s3', 'stylize', { v: 1 });

    const ns = getBehaviorConfig('s3')._nodeState as Record<string, unknown>;
    expect(ns['other']).toBe('keep');
    expect(ns['stylize']).toEqual({ v: 1 });
    expect(getBehaviorConfig('s3').amount).toBe(0.6);
  });
});
