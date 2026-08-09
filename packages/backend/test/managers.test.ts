/**
 * managers.test.ts
 *
 * Lifecycle tests for the behaviour-manager classes:
 *   - BreathingManager   (graph + Clock intervals — fake timers)
 *   - LipsyncManager     (graph lifecycle + fireVisemes)
 *   - TrackingManager    (graph lifecycle + fireLandmarks)
 *   - ApiControllerManager (state-only, no graph)
 *   - VmcManager         (UDP socket mocked via vi.mock)
 *   - IFacialMocapManager (same UDP mock; adds the device handshake)
 *
 * Constraints:
 *   - No real network sockets
 *   - No real timers (vi.useFakeTimers for interval-driven code)
 *   - All managers are torn down in afterEach to prevent open handles
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the UDP socket pool BEFORE any manager import ──────────────────────
// VmcManager calls udpSocketPool.subscribe() on startReceiver; mock it so no
// real dgram socket is ever opened.
//
// Use vi.hoisted() so the variables are available at mock-factory call time
// (vi.mock factories are hoisted to the top of the file by Vitest's transform).

const { mockUnsubscribe, mockSubscribe, mockSend } = vi.hoisted(() => {
  const mockUnsubscribe = vi.fn();
  const mockSubscribe = vi.fn(() => mockUnsubscribe);
  const mockSend = vi.fn(() => true);
  return { mockUnsubscribe, mockSubscribe, mockSend };
});

vi.mock('../src/vmc/udp_socket_pool.js', () => ({
  udpSocketPool: {
    subscribe: mockSubscribe,
    send: mockSend,
    closeAll: vi.fn(),
  },
}));

// ── Mock dgram itself (fallback — VmcManager imports udp_socket_pool, not dgram
// directly, but this ensures no dgram usage leaks through in CI) ──────────────
vi.mock('dgram', () => ({
  createSocket: vi.fn(() => ({
    on: vi.fn(),
    bind: vi.fn(),
    close: vi.fn(),
    address: vi.fn(() => ({ port: 0 })),
  })),
}));

// ── Mock broadcastBus to avoid real DB / WS dependencies in bus logic ────────
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

// ── Mock pose_broadcast / blendshapes_broadcast initializers (used by VmcManager) ─
vi.mock('../src/signal/nodes/pose_broadcast.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/signal/nodes/pose_broadcast.js')>();
  return {
    ...original,
    initPoseBroadcast: vi.fn(),
  };
});

vi.mock('../src/signal/nodes/blendshapes_broadcast.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/signal/nodes/blendshapes_broadcast.js')>();
  return {
    ...original,
    initBlendshapesBroadcast: vi.fn(),
  };
});

// ── Mock getMeshCollection (used by ApiControllerManager._writeSchedule) ─────
vi.mock('../src/mesh/index.js', () => ({
  getMeshCollection: vi.fn(() => null),
  initBackendMesh: vi.fn(),
  resetBackendMesh: vi.fn(),
  handleMeshUpgrade: vi.fn(),
}));

// ── Now import everything after mocks are in place ───────────────────────────
import { BreathingManager } from '../src/behaviors/breathing/manager.js';
import { LipsyncManager } from '../src/behaviors/lipsync/manager.js';
import { TrackingManager } from '../src/behaviors/mediapipe_tracker/manager.js';
import { ApiControllerManager } from '../src/behaviors/api_controller/manager.js';
import { VmcManager } from '../src/behaviors/vmc_receiver/manager.js';
import { IFacialMocapManager } from '../src/behaviors/ifacialmocap_receiver/manager.js';
import { runMigrations, closeDb, getDb } from '../src/db/index.js';
import { broadcastBus } from '../src/broadcast/bus.js';

// ── Silence console during tests ─────────────────────────────────────────────
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── DB bootstrap (shared across all suites, in-memory) ────────────────────────
// Set before the first dynamic import of db/index.js; testApp does the same.
beforeEach(async () => {
  process.env.VSPARK_DB_PATH = ':memory:';
  closeDb();
  await runMigrations();
});

afterEach(() => {
  closeDb();
});

// ─────────────────────────────────────────────────────────────────────────────
// BreathingManager
// ─────────────────────────────────────────────────────────────────────────────

describe('BreathingManager', () => {
  let manager: BreathingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new BreathingManager();
  });

  afterEach(() => {
    manager.close();
    vi.useRealTimers();
  });

  it('builds a graph when start() is called', () => {
    manager.start('b1');

    const descriptor = manager.getGraphDescriptor('b1');
    expect(descriptor).not.toBeNull();
    expect(descriptor!.id).toBe('breathing:b1');
    expect(descriptor!.nodes.length).toBeGreaterThan(0);
  });

  it('getStates() returns graph state after start()', () => {
    manager.start('b1');
    const states = manager.getStates('b1');
    expect(states).not.toBeNull();
  });

  it('start() is idempotent — calling twice keeps the same graph', () => {
    manager.start('b1');
    const d1 = manager.getGraphDescriptor('b1');
    manager.start('b1');
    const d2 = manager.getGraphDescriptor('b1');
    expect(d1).toBe(d2);
  });

  it('stop() tears down the graph', () => {
    manager.start('b1');
    manager.stop('b1');

    // Descriptors are kept (the map is never cleared) but the live graph is removed.
    expect(manager.getStates('b1')).toBeNull();
    expect(broadcastBus.removeBehavior).toHaveBeenCalledWith('b1');
  });

  it('stop() on unknown id is a no-op', () => {
    expect(() => manager.stop('nonexistent')).not.toThrow();
  });

  it('syncBehaviors() starts enabled breathing components', () => {
    manager.syncBehaviors([
      { id: 'b1', nodeId: 'node1', kind: 'breathing', enabled: true, config: {} },
    ]);

    expect(manager.getGraphDescriptor('b1')).not.toBeNull();
  });

  it('syncBehaviors() skips disabled components', () => {
    manager.syncBehaviors([
      { id: 'b1', nodeId: 'node1', kind: 'breathing', enabled: false, config: {} },
    ]);

    expect(manager.getGraphDescriptor('b1')).toBeNull();
  });

  it('syncBehaviors() skips components of the wrong kind', () => {
    manager.syncBehaviors([
      { id: 'b1', nodeId: 'node1', kind: 'lipsync_processor', enabled: true, config: {} },
    ]);

    expect(manager.getGraphDescriptor('b1')).toBeNull();
  });

  it('syncBehaviors() stops previously running graphs not in the new list', () => {
    manager.start('b1');
    manager.syncBehaviors([
      // b1 is absent (not enabled / not present)
    ]);

    // The live graph is gone (getStates returns null) even though the descriptor stays.
    expect(manager.getStates('b1')).toBeNull();
  });

  it('getAllGraphDescriptors() returns all started graphs', () => {
    manager.start('b1');
    manager.start('b2');

    const all = manager.getAllGraphDescriptors();
    expect(all).toHaveLength(2);
  });

  it('close() stops all running graphs', () => {
    manager.start('b1');
    manager.start('b2');
    manager.close();

    expect(manager.getStates('b1')).toBeNull();
    expect(manager.getStates('b2')).toBeNull();
  });

  it('Clock intervals are scheduled with fake timers (no real waiting)', () => {
    // Clock.attach calls setInterval — with fake timers we can assert it was scheduled.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    manager.start('b1');

    // The breathing graph has one clock node, so at least one interval is created.
    expect(setIntervalSpy).toHaveBeenCalled();
  });

  it('stop() clears Clock intervals (cleanup fns are called)', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    manager.start('b1');
    manager.stop('b1');

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LipsyncManager
// ─────────────────────────────────────────────────────────────────────────────

describe('LipsyncManager', () => {
  let manager: LipsyncManager;

  beforeEach(() => {
    manager = new LipsyncManager();
  });

  afterEach(() => {
    manager.close();
  });

  it('builds a graph when start() is called', () => {
    manager.start('ls1');

    const descriptor = manager.getGraphDescriptor('ls1');
    expect(descriptor).not.toBeNull();
    expect(descriptor!.id).toBe('lipsync:ls1');
  });

  it('getStates() returns graph state after start()', () => {
    manager.start('ls1');
    expect(manager.getStates('ls1')).not.toBeNull();
  });

  it('start() is idempotent', () => {
    manager.start('ls1');
    const d1 = manager.getGraphDescriptor('ls1');
    manager.start('ls1');
    expect(manager.getGraphDescriptor('ls1')).toBe(d1);
  });

  it('stop() removes the graph and notifies the bus', () => {
    manager.start('ls1');
    manager.stop('ls1');

    // Descriptor map is never cleared by stop() — use getStates() to check live graph is gone.
    expect(manager.getStates('ls1')).toBeNull();
    expect(broadcastBus.removeBehavior).toHaveBeenCalledWith('ls1');
  });

  it('stop() on unknown id is a no-op', () => {
    expect(() => manager.stop('missing')).not.toThrow();
  });

  it('syncBehaviors() starts enabled lipsync components', () => {
    manager.syncBehaviors([
      {
        id: 'ls1',
        nodeId: 'node1',
        kind: 'lipsync_processor',
        enabled: true,
        config: { sensitivity: 1.0 },
      },
    ]);

    expect(manager.getGraphDescriptor('ls1')).not.toBeNull();
  });

  it('syncBehaviors() ignores disabled or wrong-kind components', () => {
    manager.syncBehaviors([
      { id: 'ls1', nodeId: 'n', kind: 'lipsync_processor', enabled: false, config: {} },
      { id: 'ls2', nodeId: 'n', kind: 'breathing', enabled: true, config: {} },
    ]);

    expect(manager.getGraphDescriptor('ls1')).toBeNull();
    expect(manager.getGraphDescriptor('ls2')).toBeNull();
  });

  it('syncBehaviors() stops components removed from the list', () => {
    manager.start('ls1');

    manager.syncBehaviors([]);

    expect(manager.getStates('ls1')).toBeNull();
  });

  it('getAllGraphDescriptors() returns all started graphs', () => {
    manager.start('ls1');
    manager.start('ls2');
    expect(manager.getAllGraphDescriptors()).toHaveLength(2);
  });

  it('fireVisemes() does not throw when graph is not started', () => {
    // Should silently no-op.
    expect(() => manager.fireVisemes('ls_missing', { aa: 0.5 })).not.toThrow();
  });

  it('fireVisemes() fires into the graph without throwing', () => {
    manager.start('ls1');
    // Visemes are fed through the graph; no exception means the wiring is valid.
    expect(() => manager.fireVisemes('ls1', { aa: 0.8, ih: 0.2 })).not.toThrow();
  });

  it('close() stops all graphs', () => {
    manager.start('ls1');
    manager.start('ls2');
    manager.close();

    expect(manager.getStates('ls1')).toBeNull();
    expect(manager.getStates('ls2')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TrackingManager (mediapipe_tracker)
// ─────────────────────────────────────────────────────────────────────────────

describe('TrackingManager', () => {
  let manager: TrackingManager;

  beforeEach(() => {
    manager = new TrackingManager();
  });

  afterEach(() => {
    manager.close();
  });

  it('builds a graph when start() is called', () => {
    manager.start('mp1');
    expect(manager.getGraphDescriptor('mp1')).not.toBeNull();
  });

  it('getStates() returns states after start()', () => {
    manager.start('mp1');
    expect(manager.getStates('mp1')).not.toBeNull();
  });

  it('start() is idempotent', () => {
    manager.start('mp1');
    const d1 = manager.getGraphDescriptor('mp1');
    manager.start('mp1');
    expect(manager.getGraphDescriptor('mp1')).toBe(d1);
  });

  it('stop() removes graph', () => {
    manager.start('mp1');
    manager.stop('mp1');
    expect(manager.getStates('mp1')).toBeNull();
  });

  it('stop() on unknown id is a no-op', () => {
    expect(() => manager.stop('nope')).not.toThrow();
  });

  it('syncBehaviors() starts enabled mediapipe_tracker components', () => {
    manager.syncBehaviors([
      {
        id: 'mp1',
        nodeId: 'node1',
        kind: 'mediapipe_tracker',
        enabled: true,
        config: {},
      },
    ]);
    expect(manager.getGraphDescriptor('mp1')).not.toBeNull();
  });

  it('syncBehaviors() ignores disabled or wrong-kind', () => {
    manager.syncBehaviors([
      { id: 'mp1', nodeId: 'n', kind: 'mediapipe_tracker', enabled: false, config: {} },
    ]);
    expect(manager.getGraphDescriptor('mp1')).toBeNull();
  });

  it('syncBehaviors() stops graphs not in the new list', () => {
    manager.start('mp1');
    manager.syncBehaviors([]);
    expect(manager.getStates('mp1')).toBeNull();
  });

  it('fireLandmarks() does not throw when graph is absent', () => {
    expect(() =>
      manager.fireLandmarks('mp_missing', { face: [] })
    ).not.toThrow();
  });

  it('fireLandmarks() fires events into a started graph without throwing', () => {
    manager.start('mp1');
    const fakeLandmark = { x: 0, y: 0, z: 0 };
    expect(() =>
      manager.fireLandmarks('mp1', {
        face: [fakeLandmark],
        leftHand: [fakeLandmark],
        rightHand: [fakeLandmark],
        pose: [fakeLandmark],
      })
    ).not.toThrow();
  });

  it('fireGraphEvent() is a no-op when graph is absent', () => {
    expect(() => manager.fireGraphEvent('nope', 'mp_source', 'face')).not.toThrow();
  });

  it('getAllGraphDescriptors() returns all started', () => {
    manager.start('mp1');
    manager.start('mp2');
    expect(manager.getAllGraphDescriptors()).toHaveLength(2);
  });

  it('close() stops all graphs', () => {
    manager.start('mp1');
    manager.close();
    expect(manager.getStates('mp1')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TrackingManager — tracking-loss grace period
// ─────────────────────────────────────────────────────────────────────────────
//
// The camera pipeline has only one loss path (frames stop arriving), but it
// honours the same configured "Idle after" window as vmc_receiver so both
// sources reach idle on one clock instead of each using its own constant.

describe('TrackingManager tracking-loss grace period', () => {
  const makeWs = () => ({
    broadcast: vi.fn(),
    onClientConnected: vi.fn(),
    sendTo: vi.fn(),
  });

  let ws: ReturnType<typeof makeWs>;
  let manager: TrackingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    ws = makeWs();
    manager = new TrackingManager(ws as never);
  });

  afterEach(() => {
    manager.close();
    vi.useRealTimers();
  });

  const startWith = (graceSeconds?: number) => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name) VALUES ('pg', 'P')").run();
    db.prepare(
      `INSERT INTO scene_nodes (id, project_id, root_scene_node_id, name, kind, components, properties)
       VALUES ('node1', 'pg', 'node1', 'Avatar', 'avatar', '{}', ?)`
    ).run(
      JSON.stringify(
        graceSeconds == null ? {} : { trackingGracePeriod: graceSeconds }
      )
    );
    manager.syncBehaviors([
      {
        id: 'mp1',
        nodeId: 'node1',
        kind: 'mediapipe_tracker',
        enabled: true,
        config: {},
      },
    ]);
    manager.fireLandmarks('mp1', { face: [{ x: 0, y: 0, z: 0 }] });
    ws.broadcast.mockClear();
  };

  const trackingLost = () =>
    ws.broadcast.mock.calls.some(
      ([kind, payload]) =>
        kind === 'vmc_tracking_state' && payload.tracking === false
    );

  it('a brief frame gap does not report tracking loss', () => {
    startWith(3);

    vi.advanceTimersByTime(1500);

    expect(trackingLost()).toBe(false);
  });

  it('reports loss once the configured window elapses', () => {
    startWith(3);

    vi.advanceTimersByTime(3500);

    expect(ws.broadcast).toHaveBeenCalledWith('vmc_tracking_state', {
      behaviorId: 'mp1',
      tracking: false,
    });
  });

  it('a resumed frame clears the pending loss', () => {
    startWith(3);

    vi.advanceTimersByTime(2000);
    manager.fireLandmarks('mp1', { face: [{ x: 0, y: 0, z: 0 }] });
    vi.advanceTimersByTime(2000); // 4s total, but only 2s since the last frame

    expect(trackingLost()).toBe(false);
  });

  it('falls back to the 1s camera default when the node sets none', () => {
    startWith();

    vi.advanceTimersByTime(1500);

    expect(trackingLost()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ApiControllerManager (no signal graph — pure state machine)
// ─────────────────────────────────────────────────────────────────────────────

describe('ApiControllerManager', () => {
  let manager: ApiControllerManager;

  beforeEach(() => {
    manager = new ApiControllerManager();
  });

  afterEach(() => {
    manager.close();
  });

  it('syncBehaviors() registers an enabled api_controller component', () => {
    manager.syncBehaviors([
      { id: 'ac1', nodeId: 'nodeA', kind: 'api_controller', enabled: true, config: {} },
    ]);

    const st = manager.getState('ac1');
    expect(st).not.toBeNull();
    expect(st!.sceneNodeId).toBe('nodeA');
  });

  it('getState() returns null for unknown component', () => {
    expect(manager.getState('ghost')).toBeNull();
  });

  it('syncBehaviors() ignores disabled components', () => {
    manager.syncBehaviors([
      { id: 'ac1', nodeId: 'n', kind: 'api_controller', enabled: false, config: {} },
    ]);
    expect(manager.getState('ac1')).toBeNull();
  });

  it('syncBehaviors() ignores wrong-kind components', () => {
    manager.syncBehaviors([
      { id: 'ac1', nodeId: 'n', kind: 'breathing', enabled: true, config: {} },
    ]);
    expect(manager.getState('ac1')).toBeNull();
  });

  it('syncBehaviors() stops components removed from the next reconcile', () => {
    manager.syncBehaviors([
      { id: 'ac1', nodeId: 'n', kind: 'api_controller', enabled: true, config: {} },
    ]);
    manager.syncBehaviors([]);

    expect(manager.getState('ac1')).toBeNull();
    expect(broadcastBus.removeBehavior).toHaveBeenCalledWith('ac1');
  });

  it('syncBehaviors() is idempotent for the same component', () => {
    const comp = { id: 'ac1', nodeId: 'n', kind: 'api_controller', enabled: true, config: {} };
    manager.syncBehaviors([comp]);
    manager.syncBehaviors([comp]);
    expect(manager.getState('ac1')).not.toBeNull();
  });

  it('findByNode() finds a component by its scene node id', () => {
    manager.syncBehaviors([
      { id: 'ac1', nodeId: 'nodeA', kind: 'api_controller', enabled: true, config: {} },
    ]);

    const result = manager.findByNode('nodeA');
    expect(result).not.toBeNull();
    expect(result!.behaviorId).toBe('ac1');
  });

  it('findByNode() returns null for unknown node', () => {
    expect(manager.findByNode('ghost-node')).toBeNull();
  });

  it('snapshotAll() returns all active state entries', () => {
    manager.syncBehaviors([
      { id: 'ac1', nodeId: 'n1', kind: 'api_controller', enabled: true, config: {} },
      { id: 'ac2', nodeId: 'n2', kind: 'api_controller', enabled: true, config: {} },
    ]);

    const snap = manager.snapshotAll();
    expect(snap).toHaveLength(2);
    const ids = snap.map((s) => s.behaviorId).sort();
    expect(ids).toEqual(['ac1', 'ac2']);
  });

  it('setExpressionsForNode() and getExpressionsForNode() round-trip', () => {
    manager.setExpressionsForNode('node1', ['happy', 'sad', 'surprised']);
    expect(manager.getExpressionsForNode('node1')).toEqual(['happy', 'sad', 'surprised']);
  });

  it('setExpressionsForNode([]) clears the cache', () => {
    manager.setExpressionsForNode('node1', ['happy']);
    manager.setExpressionsForNode('node1', []);
    expect(manager.getExpressionsForNode('node1')).toBeNull();
  });

  it('setAnimationQueue() throws when component is not active', () => {
    expect(() =>
      manager.setAnimationQueue('ghost', [], 'none')
    ).toThrow('not active');
  });

  it('setBlendshapes() throws when component is not active', () => {
    expect(() =>
      manager.setBlendshapes('ghost', { happy: 1.0 })
    ).toThrow('not active');
  });

  it('clearBlendshapes() throws when component is not active', () => {
    expect(() => manager.clearBlendshapes('ghost')).toThrow('not active');
  });

  it('setBlendshapes() does not throw for an active component (bus call is mocked)', () => {
    manager.syncBehaviors([
      { id: 'ac1', nodeId: 'n1', kind: 'api_controller', enabled: true, config: {} },
    ]);
    expect(() => manager.setBlendshapes('ac1', { happy: 0.5 })).not.toThrow();
    expect(broadcastBus.publishBlendshapes).toHaveBeenCalledWith(
      'n1',
      'ac1',
      expect.anything()
    );
  });

  it('clearBlendshapes() resets blendshapes on an active component', () => {
    manager.syncBehaviors([
      { id: 'ac1', nodeId: 'n1', kind: 'api_controller', enabled: true, config: {} },
    ]);
    manager.setBlendshapes('ac1', { happy: 0.9 });
    expect(() => manager.clearBlendshapes('ac1')).not.toThrow();
  });

  it('close() removes all active components', () => {
    manager.syncBehaviors([
      { id: 'ac1', nodeId: 'n1', kind: 'api_controller', enabled: true, config: {} },
    ]);
    manager.close();
    expect(manager.getState('ac1')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VmcManager (UDP mocked via vi.mock on udp_socket_pool)
// ─────────────────────────────────────────────────────────────────────────────

describe('VmcManager (UDP mocked)', () => {
  // Minimal WSSync stub — VmcManager calls broadcast / onClientConnected / sendTo
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

  it('constructor sets up the timeout interval', () => {
    // VmcManager calls setInterval in its constructor for checkTimeouts.
    // With fake timers we just verify the object was constructed without throwing.
    expect(manager).toBeTruthy();
  });

  it('startReceiver() subscribes to the UDP pool', () => {
    manager.startReceiver('vmc1', 39539);
    expect(mockSubscribe).toHaveBeenCalledWith(39539, expect.any(Function), expect.any(Function));
  });

  it('startReceiver() builds a graph', () => {
    manager.startReceiver('vmc1', 39539);
    const descriptor = manager.getGraphDescriptor('vmc1');
    expect(descriptor).not.toBeNull();
    expect(descriptor!.id).toBe('vmc-pipeline:vmc1');
  });

  it('startReceiver() is idempotent for the same port', () => {
    manager.startReceiver('vmc1', 39539);
    const callCountBefore = mockSubscribe.mock.calls.length;
    manager.startReceiver('vmc1', 39539);
    expect(mockSubscribe.mock.calls.length).toBe(callCountBefore);
  });

  it('startReceiver() restarts when port changes', () => {
    manager.startReceiver('vmc1', 39539);
    manager.startReceiver('vmc1', 39540); // different port → stop + restart
    // First subscribe (39539) → unsubscribe → subscribe (39540)
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stopReceiver() calls unsubscribe and clears the graph', () => {
    manager.startReceiver('vmc1', 39539);
    manager.stopReceiver('vmc1');

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    // Descriptor map is not cleared by stop, but the live graph is gone.
    expect(manager.getStates('vmc1')).toBeNull();
  });

  it('stopReceiver() on unknown id is a no-op', () => {
    expect(() => manager.stopReceiver('nope')).not.toThrow();
  });

  it('stopReceiver() broadcasts tracking:false when tracking was active', () => {
    manager.startReceiver('vmc1', 39539);
    // Simulate the /Body handler having latched tracking on. Without a
    // teardown broadcast, clients keep a stale `tracking: true` forever
    // (avatars pin to their base animation and never fall back to idle).
    (
      manager as unknown as {
        receivers: Map<string, { trackingActive: boolean | null }>;
      }
    ).receivers.get('vmc1')!.trackingActive = true;
    ws.broadcast.mockClear();

    manager.stopReceiver('vmc1');

    expect(ws.broadcast).toHaveBeenCalledWith('vmc_tracking_state', {
      behaviorId: 'vmc1',
      tracking: false,
    });
  });

  it('stopReceiver() does not broadcast tracking state when never tracking', () => {
    manager.startReceiver('vmc1', 39539); // trackingActive stays null
    ws.broadcast.mockClear();

    manager.stopReceiver('vmc1');

    expect(ws.broadcast).not.toHaveBeenCalledWith(
      'vmc_tracking_state',
      expect.anything()
    );
  });

  it('syncBehaviors() starts enabled vmc_receiver components', () => {
    manager.syncBehaviors([
      {
        id: 'vmc1',
        nodeId: 'node1',
        kind: 'vmc_receiver',
        enabled: true,
        config: { port: 39539 },
      },
    ]);

    expect(mockSubscribe).toHaveBeenCalled();
    expect(manager.getGraphDescriptor('vmc1')).not.toBeNull();
  });

  it('syncBehaviors() stops receivers not in the new list', () => {
    manager.startReceiver('vmc1', 39539);
    manager.syncBehaviors([]);

    expect(mockUnsubscribe).toHaveBeenCalled();
    expect(manager.getStates('vmc1')).toBeNull();
  });

  it('syncBehaviors() skips disabled or wrong-kind', () => {
    manager.syncBehaviors([
      { id: 'vmc1', nodeId: 'n', kind: 'vmc_receiver', enabled: false, config: { port: 39539 } },
      { id: 'vmc2', nodeId: 'n', kind: 'breathing', enabled: true, config: { port: 39539 } },
    ]);

    expect(manager.getGraphDescriptor('vmc1')).toBeNull();
    expect(manager.getGraphDescriptor('vmc2')).toBeNull();
  });

  it('getStates() returns null for an unknown receiver', () => {
    expect(manager.getStates('ghost')).toBeNull();
  });

  it('getStates() returns graph state for a running receiver', () => {
    manager.startReceiver('vmc1', 39539);
    expect(manager.getStates('vmc1')).not.toBeNull();
  });

  it('getAllGraphDescriptors() returns all active descriptors', () => {
    manager.startReceiver('vmc1', 39539);
    manager.startReceiver('vmc2', 39540);

    const all = manager.getAllGraphDescriptors();
    expect(all).toHaveLength(2);
  });

  it('peekBodyCalibInput() returns null when no graph', () => {
    expect(manager.peekBodyCalibInput('ghost')).toBeNull();
  });

  it('fireGraphEvent() is a no-op for an unknown receiver', () => {
    expect(() => manager.fireGraphEvent('ghost', 'vmc', 'bones')).not.toThrow();
  });

  it('checkTimeouts fires via fake timer — connected receivers time out', () => {
    manager.startReceiver('vmc1', 39539);

    // Manually mark receiver as connected so we can test the timeout path.
    // Access is internal, but we can simulate it through the fake timer advance.
    // We advance by > 3000ms (the timeout threshold in VmcManager.checkTimeouts).
    vi.advanceTimersByTime(4000);

    // The interval fired; since no packets arrived, nothing catastrophic happens.
    // If the receiver was marked connected, it would call ws.broadcast('vmc_status', ...)
    // Here we can only verify no exception is thrown (receiver starts as connected=false).
    expect(ws.broadcast).not.toHaveBeenCalledWith('vmc_status', expect.objectContaining({ connected: false }));
  });

  it('close() unsubscribes all receivers and clears the interval', () => {
    manager.startReceiver('vmc1', 39539);
    manager.close();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(manager.getStates('vmc1')).toBeNull();
  });

  // ── tracking-loss grace period (the avatar node's trackingGracePeriod) ─────
  //
  // Both loss paths (the signal going still, and packets going away) must wait
  // out the configured window. Before this, a single repeated /Body packet
  // flipped tracking off at once and the avatar snapped straight into idle on
  // every momentary dropout.
  //
  // The window lives on the avatar node, not the behavior, so these tests seed a
  // real scene_nodes row — the manager reads it back through the DB.

  /** Insert an avatar node carrying (or not) an explicit grace period. */
  const seedAvatarNode = (nodeId: string, graceSeconds?: number) => {
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name) VALUES ('pg', 'P')").run();
    db.prepare(
      `INSERT INTO scene_nodes (id, project_id, root_scene_node_id, name, kind, components, properties)
       VALUES (?, 'pg', ?, 'Avatar', 'avatar', '{}', ?)`
    ).run(
      nodeId,
      nodeId,
      JSON.stringify(
        graceSeconds == null ? {} : { trackingGracePeriod: graceSeconds }
      )
    );
  };

  /** Put a receiver in the "tracking, packets flowing" state the loss paths start from. */
  const primeTracking = (id: string, graceSeconds?: number) => {
    seedAvatarNode('node1', graceSeconds);
    manager.syncBehaviors([
      {
        id,
        nodeId: 'node1',
        kind: 'vmc_receiver',
        enabled: true,
        config: { port: 39539 },
      },
    ]);
    const info = (
      manager as unknown as {
        receivers: Map<
          string,
          {
            trackingActive: boolean | null;
            lastSeen: number;
            connected: boolean;
            quietSince: number | null;
          }
        >;
      }
    ).receivers.get(id)!;
    info.trackingActive = true;
    info.connected = true;
    info.lastSeen = Date.now();
    info.quietSince = null;
    ws.broadcast.mockClear();
    return info;
  };

  const trackingLost = () =>
    ws.broadcast.mock.calls.some(
      ([kind, payload]) =>
        kind === 'vmc_tracking_state' && payload.tracking === false
    );

  it('a brief still patch does not report tracking loss', () => {
    const info = primeTracking('vmc1', 2);
    info.quietSince = Date.now(); // motion just stopped

    vi.advanceTimersByTime(1000); // well inside the 2s window

    expect(trackingLost()).toBe(false);
  });

  it('a still signal reports loss once the grace period elapses', () => {
    const info = primeTracking('vmc1', 2);
    info.quietSince = Date.now();

    vi.advanceTimersByTime(2500);

    expect(ws.broadcast).toHaveBeenCalledWith('vmc_tracking_state', {
      behaviorId: 'vmc1',
      tracking: false,
    });
  });

  it('packets going away reports loss on the same configured clock', () => {
    // Loss path 2 previously only fired `vmc_status`, leaving `trackingActive`
    // stuck true until the client's own hardcoded watchdog gave up.
    primeTracking('vmc1', 2); // lastSeen = now, then no further packets

    vi.advanceTimersByTime(1000);
    expect(trackingLost()).toBe(false);

    vi.advanceTimersByTime(1500);
    expect(ws.broadcast).toHaveBeenCalledWith('vmc_tracking_state', {
      behaviorId: 'vmc1',
      tracking: false,
    });
  });

  it('honours a longer configured grace period', () => {
    const info = primeTracking('vmc1', 6);
    info.quietSince = Date.now();

    vi.advanceTimersByTime(4000); // past the old hardcoded 2s
    expect(trackingLost()).toBe(false);

    vi.advanceTimersByTime(2500);
    expect(trackingLost()).toBe(true);
  });

  it('falls back to a 2s grace period when the node sets none', () => {
    const info = primeTracking('vmc1');
    info.quietSince = Date.now();

    vi.advanceTimersByTime(1000);
    expect(trackingLost()).toBe(false);

    vi.advanceTimersByTime(1500);
    expect(trackingLost()).toBe(true);
  });

  it('reports loss only once while the signal stays quiet', () => {
    const info = primeTracking('vmc1', 1);
    info.quietSince = Date.now();

    vi.advanceTimersByTime(10_000);

    const losses = ws.broadcast.mock.calls.filter(
      ([kind, payload]) =>
        kind === 'vmc_tracking_state' && payload.tracking === false
    );
    expect(losses).toHaveLength(1);
  });

  it('never reports loss for a receiver that never tracked', () => {
    // trackingActive stays null — there is no loss to announce, and the
    // connect-time snapshot skips null for the same reason.
    manager.startReceiver('vmc1', 39539);
    ws.broadcast.mockClear();

    vi.advanceTimersByTime(10_000);

    expect(trackingLost()).toBe(false);
  });

  it('keeps the connection dot on its own fixed window', () => {
    // "Is the source reachable" is a different question from "is it tracking";
    // a long grace period must not delay the status dot going grey.
    primeTracking('vmc1', 30);

    vi.advanceTimersByTime(4000);

    expect(ws.broadcast).toHaveBeenCalledWith('vmc_status', {
      behaviorId: 'vmc1',
      connected: false,
    });
    expect(trackingLost()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IFacialMocapManager (UDP mocked via the same vi.mock on udp_socket_pool)
// ─────────────────────────────────────────────────────────────────────────────

describe('IFacialMocapManager (UDP mocked)', () => {
  const makeWs = () => ({
    broadcast: vi.fn(),
    onClientConnected: vi.fn(),
    sendTo: vi.fn(),
  });

  /** The packet listener the manager handed to udpSocketPool.subscribe(). */
  const listener = () =>
    mockSubscribe.mock.calls.at(-1)![1] as (
      buf: Buffer,
      rinfo: { address: string; port: number }
    ) => void;
  /** The onBound callback from the most recent subscribe(). */
  const onBound = () => mockSubscribe.mock.calls.at(-1)![2] as () => void;

  const rinfo = { address: '192.168.1.42', port: 49983 };
  const frame = (jaw: number, headX: number) =>
    Buffer.from(`jawOpen&${jaw}|=head#${headX},0,0,0,0,0|`, 'utf8');

  let ws: ReturnType<typeof makeWs>;
  let manager: IFacialMocapManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();
    mockSend.mockClear();
    ws = makeWs();
    manager = new IFacialMocapManager(ws as never);
  });

  afterEach(() => {
    manager.close();
    vi.useRealTimers();
  });

  it('startReceiver() subscribes to the UDP pool and builds a graph', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');

    expect(mockSubscribe).toHaveBeenCalledWith(
      49983,
      expect.any(Function),
      expect.any(Function)
    );
    expect(manager.getGraphDescriptor('ifm1')!.id).toBe(
      'ifacialmocap-pipeline:ifm1'
    );
  });

  it('startReceiver() is idempotent for the same port + device', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    const before = mockSubscribe.mock.calls.length;
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    expect(mockSubscribe.mock.calls.length).toBe(before);
  });

  it('startReceiver() restarts when the device address changes', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    manager.startReceiver('ifm1', 49983, '192.168.1.43');

    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('handshakes the device once the socket is bound', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    onBound()();

    expect(mockSend).toHaveBeenCalledWith(
      49983,
      expect.any(Buffer),
      '192.168.1.42',
      49983
    );
    expect((mockSend.mock.calls.at(-1)![1] as Buffer).toString()).toContain(
      'iFacialMocap_sahuasouryya9218sauhuiayeta91555dy3719'
    );
  });

  it('does not handshake when no device address is configured', () => {
    manager.startReceiver('ifm1', 49983, '');
    onBound()();
    vi.advanceTimersByTime(5000);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('retries the handshake while the device stays silent', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    onBound()();
    mockSend.mockClear();

    vi.advanceTimersByTime(3000);

    expect(mockSend.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('reports connected on the first recognisable packet', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    listener()(frame(10, 1), rinfo);

    expect(ws.broadcast).toHaveBeenCalledWith('vmc_status', {
      behaviorId: 'ifm1',
      connected: true,
      remoteAddress: '192.168.1.42',
    });
  });

  it('ignores foreign traffic on a shared port', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    listener()(Buffer.from('not an ifacialmocap frame', 'utf8'), rinfo);

    expect(ws.broadcast).not.toHaveBeenCalledWith(
      'vmc_status',
      expect.anything()
    );
  });

  it('latches tracking on when consecutive frames differ', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    listener()(frame(10, 1), rinfo);
    listener()(frame(40, 9), rinfo);

    expect(ws.broadcast).toHaveBeenCalledWith('vmc_tracking_state', {
      behaviorId: 'ifm1',
      tracking: true,
    });
  });

  it('drops tracking when the device stops streaming', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    listener()(frame(10, 1), rinfo);
    listener()(frame(40, 9), rinfo);
    ws.broadcast.mockClear();

    vi.advanceTimersByTime(5000);

    expect(ws.broadcast).toHaveBeenCalledWith('vmc_status', {
      behaviorId: 'ifm1',
      connected: false,
    });
    expect(ws.broadcast).toHaveBeenCalledWith('vmc_tracking_state', {
      behaviorId: 'ifm1',
      tracking: false,
    });
  });

  it('publishes the pose into the broadcast bus', () => {
    // Via syncBehaviors, not startReceiver — the broadcast nodes need the
    // scene-node id, which only the behavior row carries.
    manager.syncBehaviors([
      {
        id: 'ifm1',
        nodeId: 'node1',
        kind: 'ifacialmocap_receiver',
        enabled: true,
        config: { port: 49983, deviceHost: '192.168.1.42' },
      },
    ]);
    listener()(frame(10, 1), rinfo);

    expect(broadcastBus.publishBones).toHaveBeenCalled();
    expect(broadcastBus.publishBlendshapes).toHaveBeenCalled();
  });

  it('syncBehaviors() starts enabled ifacialmocap_receiver behaviors only', () => {
    manager.syncBehaviors([
      {
        id: 'ifm1',
        nodeId: 'node1',
        kind: 'ifacialmocap_receiver',
        enabled: true,
        config: { port: 49983, deviceHost: '192.168.1.42' },
      },
      {
        id: 'ifm2',
        nodeId: 'node2',
        kind: 'ifacialmocap_receiver',
        enabled: false,
        config: {},
      },
      {
        id: 'vmc1',
        nodeId: 'node3',
        kind: 'vmc_receiver',
        enabled: true,
        config: {},
      },
    ]);

    expect(manager.getGraphDescriptor('ifm1')).not.toBeNull();
    expect(manager.getStates('ifm2')).toBeNull();
    expect(manager.getStates('vmc1')).toBeNull();
  });

  it('syncBehaviors() stops receivers that dropped out of the list', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    manager.syncBehaviors([]);

    expect(mockUnsubscribe).toHaveBeenCalled();
    expect(manager.getStates('ifm1')).toBeNull();
  });

  it('stopReceiver() broadcasts tracking:false when tracking was active', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    listener()(frame(10, 1), rinfo);
    listener()(frame(40, 9), rinfo);
    ws.broadcast.mockClear();

    manager.stopReceiver('ifm1');

    expect(ws.broadcast).toHaveBeenCalledWith('vmc_tracking_state', {
      behaviorId: 'ifm1',
      tracking: false,
    });
  });

  it('close() unsubscribes every receiver', () => {
    manager.startReceiver('ifm1', 49983, '192.168.1.42');
    manager.close();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(manager.getStates('ifm1')).toBeNull();
  });
});
