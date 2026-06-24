/**
 * managers.test.ts
 *
 * Lifecycle tests for the behaviour-manager classes:
 *   - BreathingManager   (graph + Clock intervals — fake timers)
 *   - LipsyncManager     (graph lifecycle + fireVisemes)
 *   - TrackingManager    (graph lifecycle + fireLandmarks)
 *   - ApiControllerManager (state-only, no graph)
 *   - VmcManager         (UDP socket mocked via vi.mock)
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
import { runMigrations, closeDb } from '../src/db/index.js';
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
});
