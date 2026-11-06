/**
 * managers.storedGraph.test.ts — see the block comment below the mocks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Receiver status is a mesh document now (mesh/status.ts). Report each
// publish into a spy under the kind the old WS broadcast used, so the
// assertions below keep checking the same behavior.
const { statusEvents } = vi.hoisted(() => ({ statusEvents: vi.fn() }));
vi.mock('../src/mesh/status.js', () => ({
  publishTracking: (s: { behaviorId: string; tracking?: boolean }) =>
    statusEvents(
      s.tracking !== undefined ? 'vmc_tracking_state' : 'vmc_status',
      s
    ),
}));

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
    emitMergedPose: vi.fn(),
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
  const original =
    await importOriginal<
      typeof import('../src/signal/nodes/pose_broadcast.js')
    >();
  return {
    ...original,
    initPoseBroadcast: vi.fn(),
  };
});

vi.mock(
  '../src/signal/nodes/blendshapes_broadcast.js',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('../src/signal/nodes/blendshapes_broadcast.js')
      >();
    return {
      ...original,
      initBlendshapesBroadcast: vi.fn(),
    };
  }
);

// ── Mock getMeshCollection (used by ApiControllerManager._writeSchedule) ─────
vi.mock('../src/mesh/index.js', () => ({
  getMeshCollection: vi.fn(() => null),
  initBackendMesh: vi.fn(),
  resetBackendMesh: vi.fn(),
  handleMeshUpgrade: vi.fn(),
}));

// ── Now import everything after mocks are in place ───────────────────────────
import { BreathingManager } from '../src/behaviors/breathing/manager.js';
import { PoseStylizerManager } from '../src/behaviors/pose_stylizer/manager.js';
import { LipsyncManager } from '../src/behaviors/lipsync/manager.js';
import { TrackingManager } from '../src/behaviors/mediapipe_tracker/manager.js';
import { ManualCalibrationManager } from '../src/behaviors/manual_calibration/manager.js';
import { BlendshapeLimiterManager } from '../src/behaviors/blendshape_limiter/manager.js';
import { VmcManager } from '../src/behaviors/vmc_receiver/manager.js';
import { IFacialMocapManager } from '../src/behaviors/ifacialmocap_receiver/manager.js';
import { runMigrations, closeDb, getDb } from '../src/db/index.js';
import { broadcastBus } from '../src/broadcast/bus.js';
import { SignalGraph } from '../src/signal/engine.js';
import { behaviorTemplateGraph } from '../src/behaviors/templates.js';
import {
  toDescriptorDoc,
  type GraphDescriptor,
  type GraphNodeDescriptor,
} from '@vspark/shared/signal';

/**
 * Behavior managers run the behavior's STORED graph (a `logic` row with
 * owner_kind 'behavior', migration 047), rebuild it when the stored graph
 * changes structurally, and dispose graphs they tear down
 * (dev-notes/modules/component-managers.md → "Stored, editable graphs").
 */

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  process.env.VSPARK_DB_PATH = ':memory:';
  closeDb();
  await runMigrations();
});

afterEach(() => {
  closeDb();
});

/** Store a behavior graph: the kind's template, changed by `edit`. */
function storeGraph(
  kind: string,
  behaviorId: string,
  edit: (g: GraphDescriptor) => GraphDescriptor = (g) => g
): GraphDescriptor {
  const g = edit(behaviorTemplateGraph(kind, behaviorId, {})!);
  getDb()
    .prepare(
      `INSERT INTO logic (id, owner_kind, owner_id, name, enabled, descriptor)
       VALUES (?, 'behavior', ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET descriptor = excluded.descriptor`
    )
    .run(g.id, behaviorId, g.label, JSON.stringify(toDescriptorDoc(g)));
  return g;
}

/** A harmless extra node: marks the stored graph as the one that runs. */
const MARKER: GraphNodeDescriptor = {
  id: 'extra_marker',
  kind: 'behavior_id',
  position: { x: 0, y: 0 },
};
const withMarker = (g: GraphDescriptor): GraphDescriptor => ({
  ...g,
  nodes: [...g.nodes, MARKER],
});

const makeWs = () => ({
  broadcast: vi.fn(),
  onClientConnected: vi.fn(),
  sendTo: vi.fn(),
});

interface AnyManager {
  syncBehaviors(
    rows: Array<{
      id: string;
      nodeId: string;
      kind: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }>
  ): void;
  getGraphDescriptor(id: string): GraphDescriptor | null;
  getStates(id: string): unknown;
  close(): void;
}

const CASES: Array<[string, () => AnyManager]> = [
  ['breathing', () => new BreathingManager()],
  ['lipsync_processor', () => new LipsyncManager()],
  ['manual_calibration', () => new ManualCalibrationManager()],
  ['pose_stylizer', () => new PoseStylizerManager()],
  ['blendshape_limiter', () => new BlendshapeLimiterManager()],
  ['mediapipe_tracker', () => new TrackingManager()],
  ['vmc_receiver', () => new VmcManager(makeWs() as never)],
  ['vmc_receiver_2d', () => new VmcManager(makeWs() as never)],
  ['ifacialmocap_receiver', () => new IFacialMocapManager(makeWs() as never)],
];

describe.each(CASES)('%s manager runs the stored graph', (kind, make) => {
  let manager: AnyManager;
  const row = (config: Record<string, unknown> = {}) => ({
    id: 'b1',
    nodeId: 'n1',
    kind,
    enabled: true,
    config,
  });
  const nodeIds = () =>
    (manager.getGraphDescriptor('b1')?.nodes ?? []).map((n) => n.id);

  beforeEach(() => {
    vi.useFakeTimers();
    manager = make();
  });
  afterEach(() => {
    manager.close();
    vi.useRealTimers();
  });

  it('runs a modified stored graph, not the template', () => {
    storeGraph(kind, 'b1', withMarker);
    manager.syncBehaviors([row()]);
    expect(nodeIds()).toContain('extra_marker');
    // Same runtime id as before, so the signal routes keep finding it.
    expect(manager.getGraphDescriptor('b1')!.id).toBe(
      behaviorTemplateGraph(kind, 'b1', {})!.id
    );
  });

  it('falls back to the template when no graph is stored', () => {
    manager.syncBehaviors([row()]);
    expect(nodeIds().sort()).toEqual(
      behaviorTemplateGraph(kind, 'b1', {})!
        .nodes.map((n) => n.id)
        .sort()
    );
  });

  it('rebuilds (and disposes) the running graph when the stored one changes', () => {
    storeGraph(kind, 'b1');
    manager.syncBehaviors([row()]);
    expect(nodeIds()).not.toContain('extra_marker');
    const dispose = vi.spyOn(SignalGraph.prototype, 'dispose');

    storeGraph(kind, 'b1', withMarker);
    manager.syncBehaviors([row()]);
    expect(nodeIds()).toContain('extra_marker');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild when only node positions changed', () => {
    storeGraph(kind, 'b1');
    manager.syncBehaviors([row()]);
    const before = manager.getGraphDescriptor('b1');
    const dispose = vi.spyOn(SignalGraph.prototype, 'dispose');

    storeGraph(kind, 'b1', (g) => ({
      ...g,
      nodes: g.nodes.map((n) => ({
        ...n,
        position: { x: n.position.x + 50, y: n.position.y },
      })),
    }));
    manager.syncBehaviors([row()]);
    expect(manager.getGraphDescriptor('b1')).toBe(before);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('disposes the graph when the behavior is torn down', () => {
    manager.syncBehaviors([row()]);
    const dispose = vi.spyOn(SignalGraph.prototype, 'dispose');
    manager.syncBehaviors([]);
    expect(manager.getStates('b1')).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back to the template when the stored graph cannot run', () => {
    storeGraph(kind, 'b1', (g) => ({
      ...g,
      nodes: [
        ...g.nodes,
        { id: 'bad', kind: 'no_such_kind', position: { x: 0, y: 0 } },
      ],
    }));
    manager.syncBehaviors([row()]);
    expect(nodeIds()).not.toContain('bad');
    expect(nodeIds().length).toBeGreaterThan(0);
  });
});

describe('behavior context is injected by node kind', () => {
  it('a behavior_id node added on the canvas reads its behavior', () => {
    const manager = new ManualCalibrationManager();
    storeGraph('manual_calibration', 'b1', withMarker);
    manager.syncBehaviors([
      {
        id: 'b1',
        nodeId: 'n1',
        kind: 'manual_calibration',
        enabled: true,
        config: {},
      },
    ]);
    // The config the engine hands the marker node (by kind, not by id).
    const cfg = (
      manager as unknown as {
        _getNodeConfig(b: string, n: string): Record<string, unknown>;
      }
    )._getNodeConfig('b1', 'extra_marker');
    expect(cfg.behaviorId).toBe('b1');
    manager.close();
  });
});

describe('dispose releases node timers', () => {
  it('a combo node fed by the breathing clock leaves no timer behind', () => {
    vi.useFakeTimers();
    const manager = new BreathingManager();
    storeGraph('breathing', 'b1', (g) => ({
      ...g,
      nodes: [
        ...g.nodes,
        {
          id: 'combo',
          kind: 'combo_timeout',
          position: { x: 0, y: 0 },
          defaultConfig: { timeout: 60 },
        },
      ],
      edges: [
        ...g.edges,
        {
          fromNodeId: 'clock',
          fromPort: 'tick',
          toNodeId: 'combo',
          toPort: 'in',
        },
      ],
    }));
    manager.syncBehaviors([
      { id: 'b1', nodeId: 'n1', kind: 'breathing', enabled: true, config: {} },
    ]);
    vi.advanceTimersByTime(100); // the clock ticks; the combo arms its 60 s timer
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2); // clock + combo
    manager.syncBehaviors([]);
    // Clock interval cleared by the manager, combo timer by dispose().
    expect(vi.getTimerCount()).toBe(0);
    manager.close();
    vi.useRealTimers();
  });
});

describe('LipsyncManager sensitivity', () => {
  const run = (config: Record<string, unknown>) => {
    const manager = new LipsyncManager();
    storeGraph('lipsync_processor', 'ls1');
    manager.syncBehaviors([
      {
        id: 'ls1',
        nodeId: 'n1',
        kind: 'lipsync_processor',
        enabled: true,
        config,
      },
    ]);
    vi.mocked(broadcastBus.publishBlendshapes).mockClear();
    manager.fireVisemes('ls1', { Fcl_MTH_A: 0.3 });
    const calls = vi.mocked(broadcastBus.publishBlendshapes).mock.calls;
    manager.close();
    const bs = calls.at(-1)?.[2] as { get(k: string): number } | undefined;
    return bs?.get('Fcl_MTH_A');
  };

  it("scales visemes by the behavior's sensitivity setting", () => {
    expect(run({ sensitivity: 2 })).toBeCloseTo(0.6, 6);
  });

  it('follows a changed setting without a rebuild', () => {
    const manager = new LipsyncManager();
    storeGraph('lipsync_processor', 'ls1');
    const sync = (sensitivity: number) =>
      manager.syncBehaviors([
        {
          id: 'ls1',
          nodeId: 'n1',
          kind: 'lipsync_processor',
          enabled: true,
          config: { sensitivity },
        },
      ]);
    sync(1);
    const before = manager.getGraphDescriptor('ls1');
    sync(0.5);
    expect(manager.getGraphDescriptor('ls1')).toBe(before);
    vi.mocked(broadcastBus.publishBlendshapes).mockClear();
    manager.fireVisemes('ls1', { Fcl_MTH_A: 0.8 });
    const bs = vi
      .mocked(broadcastBus.publishBlendshapes)
      .mock.calls.at(-1)?.[2] as { get(k: string): number } | undefined;
    expect(bs?.get('Fcl_MTH_A')).toBeCloseTo(0.4, 6);
    manager.close();
  });

  it('defaults to 1 when unset', () => {
    expect(run({})).toBeCloseTo(0.3, 6);
  });
});
