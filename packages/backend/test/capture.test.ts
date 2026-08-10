import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestApp } from './helpers/testApp.js';
import { getDb } from '../src/db/index.js';
import { CaptureManager } from '../src/capture/manager.js';
import { CaptureMetrics } from '../src/capture/metrics.js';
import type {
  CaptureDevice,
  CaptureKind,
  CaptureProvider,
  CaptureProviderId,
  CaptureProviderStatus,
  CaptureRequest,
  CaptureSink,
} from '../src/capture/types.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeProvider implements CaptureProvider {
  readonly kinds: CaptureKind[] = ['tracking', 'lipsync'];
  readonly started: CaptureRequest[] = [];
  readonly stopped: string[] = [];
  available = true;
  detail: string | null = null;
  failStart = false;

  constructor(
    public readonly id: CaptureProviderId,
    kinds?: CaptureKind[]
  ) {
    if (kinds) this.kinds = kinds;
  }

  async probe() {
    return { available: this.available, detail: this.detail };
  }
  async start(req: CaptureRequest) {
    if (this.failStart) throw new Error('boom');
    this.started.push(req);
  }
  async stop(behaviorId: string) {
    this.stopped.push(behaviorId);
  }
  async listDevices(): Promise<CaptureDevice[]> {
    return [{ id: 'cam0', label: 'Fake Cam', kind: 'videoinput' }];
  }
  status(): CaptureProviderStatus {
    return { id: this.id, available: this.available, detail: this.detail, running: [] };
  }
  async close() {}
  get running() {
    return this.started.filter((s) => !this.stopped.includes(s.behaviorId));
  }
}

function makeSink(): CaptureSink & { errors: string[] } {
  const errors: string[] = [];
  return {
    landmarks: () => {},
    visemes: () => {},
    error: (_id, err) => errors.push(err.message),
    errors,
  };
}

/**
 * Seed a project, its scene, and an avatar node under it. A scene is itself a
 * `scene_nodes` row (kind='scene') that roots to itself — migration 018.
 */
function seedNode(nodeId: string, projectId = 'proj-1'): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, 'p', 0, 0)"
  ).run(projectId);
  const sceneId = `${projectId}-scene`;
  db.prepare(
    `INSERT OR IGNORE INTO scene_nodes (id, project_id, root_scene_node_id, kind, name)
     VALUES (?, ?, ?, 'scene', 'Scene')`
  ).run(sceneId, projectId, sceneId);
  db.prepare(
    `INSERT INTO scene_nodes (id, project_id, root_scene_node_id, kind, name)
     VALUES (?, ?, ?, 'avatar', 'Avatar')`
  ).run(nodeId, projectId, sceneId);
}

function row(
  id: string,
  nodeId: string,
  kind: string,
  config: Record<string, unknown>
) {
  return { id, nodeId, kind, enabled: true, config };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

describe('CaptureMetrics', () => {
  it('reports no gaps until a second frame arrives', () => {
    const m = new CaptureMetrics();
    m.begin('b1', 'tracking', 'browser_agent');
    m.record('b1', 1000);
    const s = m.get('b1')!;
    expect(s.frames).toBe(1);
    expect(s.medianGapMs).toBe(0);
    expect(s.p95GapMs).toBe(0);
  });

  it('computes median, p95 and max inter-frame gaps', () => {
    const m = new CaptureMetrics();
    m.begin('b1', 'tracking', 'browser_agent');
    let t = 0;
    // Steady 10ms frames, then a single 500ms stall — the shape this experiment exists
    // to detect, and precisely what a mean would bury.
    for (let i = 0; i < 20; i++) {
      t += 10;
      m.record('b1', t);
    }
    t += 500;
    m.record('b1', t);

    const s = m.get('b1')!;
    expect(s.medianGapMs).toBe(10);
    expect(s.maxGapMs).toBe(500);
    expect(s.stalls).toBe(1);
    // One outlier in 20 samples sits *below* the 95th percentile by definition, so p95
    // alone would miss it. That is exactly why max and the stall count are reported
    // beside it — a rare freeze is still a visible freeze on stream.
    expect(s.p95GapMs).toBe(10);
  });

  it('p95 rises once stalls stop being rare', () => {
    const m = new CaptureMetrics();
    m.begin('b1', 'tracking', 'browser_agent');
    let t = 0;
    for (let i = 0; i < 20; i++) {
      t += i % 5 === 4 ? 400 : 10; // a stall every fifth frame
      m.record('b1', t);
    }
    const s = m.get('b1')!;
    expect(s.p95GapMs).toBe(400);
    expect(s.medianGapMs).toBe(10);
  });

  it('counts a stall only past the threshold', () => {
    const m = new CaptureMetrics();
    m.stallThresholdMs = 100;
    m.begin('b1', 'tracking', 'node_inference');
    m.record('b1', 0);
    m.record('b1', 50); // under
    m.record('b1', 250); // over
    expect(m.get('b1')!.stalls).toBe(1);
  });

  it('derives fps from retained gaps', () => {
    const m = new CaptureMetrics();
    m.begin('b1', 'tracking', 'browser_agent');
    for (let i = 0; i <= 10; i++) m.record('b1', i * 100);
    expect(m.get('b1')!.fps).toBeCloseTo(10, 5);
  });

  it('reset clears counters but keeps the stream registered', () => {
    const m = new CaptureMetrics();
    m.begin('b1', 'tracking', 'browser_agent');
    m.record('b1', 0);
    m.record('b1', 100);
    m.reset();
    const s = m.get('b1')!;
    expect(s.frames).toBe(0);
    expect(s.stalls).toBe(0);
    expect(s.maxGapMs).toBe(0);
  });

  it('ignores frames for unknown streams and drops ended ones', () => {
    const m = new CaptureMetrics();
    m.record('nope', 1);
    expect(m.get('nope')).toBeNull();
    m.begin('b1', 'lipsync', 'node_inference');
    m.end('b1');
    m.record('b1', 1);
    expect(m.get('b1')).toBeNull();
    expect(m.snapshot()).toEqual([]);
  });

  it('writes nothing to CSV when no path is configured', async () => {
    const m = new CaptureMetrics();
    m.begin('b1', 'tracking', 'browser_agent');
    expect(await m.writeCsvSample('idle')).toBe(0);
  });
});

// ── Manager ──────────────────────────────────────────────────────────────────

describe('CaptureManager', () => {
  let sink: ReturnType<typeof makeSink>;
  let browser: FakeProvider;
  let node: FakeProvider;
  let mgr: CaptureManager;

  beforeEach(async () => {
    await makeTestApp();
    seedNode('node-1');
    sink = makeSink();
    browser = new FakeProvider('browser_agent');
    node = new FakeProvider('node_inference');
    mgr = new CaptureManager(sink);
    mgr.register(browser);
    mgr.register(node);
  });

  it('ignores behaviours that are browser-sourced', async () => {
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'browser' }),
      row('b2', 'node-1', 'lipsync_processor', {}),
    ]);
    // Negative assertion, so give the async start path a tick to *not* happen rather
    // than waitFor-ing (which would burn its full timeout on every run).
    await new Promise((r) => setTimeout(r, 10));
    expect(browser.started).toHaveLength(0);
    expect(mgr.acceptsBrowserInput('b1')).toBe(true);
    expect(mgr.acceptsBrowserInput('b2')).toBe(true);
  });

  it('starts a server-sourced behaviour on the configured provider', async () => {
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', {
        source: 'server',
        provider: 'node_inference',
        deviceId: '/dev/video0',
      }),
    ]);
    await vi.waitFor(() => expect(node.started).toHaveLength(1));
    expect(node.started[0]).toMatchObject({
      behaviorId: 'b1',
      kind: 'tracking',
      projectId: 'proj-1',
      deviceId: '/dev/video0',
    });
    expect(browser.started).toHaveLength(0);
  });

  it('refuses browser input for a server-sourced behaviour', () => {
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'server' }),
    ]);
    // Two producers on one behaviorId would fight over a single broadcast-bus slot.
    expect(mgr.acceptsBrowserInput('b1')).toBe(false);
  });

  it('still refuses browser input when the provider failed to start', async () => {
    browser.failStart = true;
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'server' }),
    ]);
    await vi.waitFor(() => expect(sink.errors).toHaveLength(1));
    // Falling back to browser frames would make a broken server path look like it works.
    expect(mgr.acceptsBrowserInput('b1')).toBe(false);
  });

  it('defaults to the browser agent when no provider is configured', async () => {
    mgr.syncBehaviors([
      row('b1', 'node-1', 'lipsync_processor', { source: 'server' }),
    ]);
    await vi.waitFor(() => expect(browser.started).toHaveLength(1));
    expect(browser.started[0].kind).toBe('lipsync');
  });

  it('stops capture when the behaviour goes back to browser sourcing', async () => {
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'server' }),
    ]);
    await vi.waitFor(() => expect(browser.started).toHaveLength(1));
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'browser' }),
    ]);
    await vi.waitFor(() => expect(browser.stopped).toEqual(['b1']));
    expect(mgr.acceptsBrowserInput('b1')).toBe(true);
  });

  it('stops capture when the behaviour is disabled or removed', async () => {
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'server' }),
    ]);
    await vi.waitFor(() => expect(browser.started).toHaveLength(1));
    mgr.syncBehaviors([]);
    await vi.waitFor(() => expect(browser.stopped).toEqual(['b1']));
  });

  it('leaves an unchanged capture running rather than restarting it', async () => {
    const rows = [
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'server' }),
    ];
    mgr.syncBehaviors(rows);
    await vi.waitFor(() => expect(browser.started).toHaveLength(1));
    mgr.syncBehaviors(rows);
    mgr.syncBehaviors(rows);
    await new Promise((r) => setTimeout(r, 10));
    expect(browser.started).toHaveLength(1);
    expect(browser.stopped).toHaveLength(0);
  });

  it('restarts when the device changes', async () => {
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'server', deviceId: 'a' }),
    ]);
    await vi.waitFor(() => expect(browser.started).toHaveLength(1));
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'server', deviceId: 'b' }),
    ]);
    await vi.waitFor(() => expect(browser.started).toHaveLength(2));
    expect(browser.stopped).toEqual(['b1']);
    expect(browser.started[1].deviceId).toBe('b');
  });

  it('moves a running capture across providers when the override flips', async () => {
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'server' }),
    ]);
    await vi.waitFor(() => expect(browser.started).toHaveLength(1));

    // This is the A/B switch: same behaviour, other provider, no persisted state touched.
    mgr.setProviderOverride('node_inference');
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'server' }),
    ]);
    await vi.waitFor(() => expect(node.started).toHaveLength(1));
    expect(browser.stopped).toEqual(['b1']);
    expect(mgr.getProviderOverride()).toBe('node_inference');
  });

  it('records an error when the provider is unavailable', async () => {
    node.available = false;
    node.detail = 'tfjs-node not installed';
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', {
        source: 'server',
        provider: 'node_inference',
      }),
    ]);
    await vi.waitFor(() => expect(mgr.getErrors()['b1']).toBeTruthy());
    expect(mgr.getErrors()['b1']).toContain('tfjs-node not installed');
    expect(node.started).toHaveLength(0);
  });

  it('records an error when the provider cannot serve that kind', async () => {
    const trackingOnly = new FakeProvider('node_inference', ['tracking']);
    const m = new CaptureManager(sink);
    m.register(trackingOnly);
    m.syncBehaviors([
      row('b1', 'node-1', 'lipsync_processor', {
        source: 'server',
        provider: 'node_inference',
      }),
    ]);
    await vi.waitFor(() => expect(m.getErrors()['b1']).toBeTruthy());
    expect(m.getErrors()['b1']).toContain('cannot serve lipsync');
  });

  it('records an error when the scene node has no project', async () => {
    mgr.syncBehaviors([
      row('b1', 'ghost-node', 'mediapipe_tracker', { source: 'server' }),
    ]);
    expect(mgr.getErrors()['b1']).toContain('no project found');
    expect(browser.started).toHaveLength(0);
  });

  it('ignores behaviour kinds that cannot be captured', async () => {
    mgr.syncBehaviors([
      row('b1', 'node-1', 'vmc_receiver', { source: 'server' }),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    expect(browser.started).toHaveLength(0);
    expect(mgr.acceptsBrowserInput('b1')).toBe(true);
  });

  it('lists devices from the requested provider only', async () => {
    expect(await mgr.listDevices('browser_agent')).toEqual([
      { id: 'cam0', label: 'Fake Cam', kind: 'videoinput' },
    ]);
    node.available = false;
    expect(await mgr.listDevices('node_inference')).toEqual([]);
  });

  it('reports availability from the live probe, not the cached status', async () => {
    node.available = false;
    node.detail = 'missing';
    const statuses = await mgr.statuses();
    const nodeStatus = statuses.find((s) => s.id === 'node_inference')!;
    expect(nodeStatus.available).toBe(false);
    expect(nodeStatus.detail).toBe('missing');
  });

  it('close stops everything it started', async () => {
    mgr.syncBehaviors([
      row('b1', 'node-1', 'mediapipe_tracker', { source: 'server' }),
    ]);
    await vi.waitFor(() => expect(browser.started).toHaveLength(1));
    await mgr.close();
    expect(browser.stopped).toEqual(['b1']);
  });
});
