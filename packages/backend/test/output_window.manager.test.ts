import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OutputWindowManager,
  desiredWindows,
  type ComposeSceneDoc,
  type OutputProcess,
} from '../src/output_window/manager.js';

const ORIGIN = 'http://localhost:5173';

function scene(id: string, over: Partial<ComposeSceneDoc> = {}): ComposeSceneDoc {
  return {
    id,
    projectId: 'p1',
    kind: 'compose_scene',
    name: `Scene ${id}`,
    width: 1920,
    height: 1080,
    config: { obsWindowCapture: true },
    ...over,
  };
}

class FakeProcess implements OutputProcess {
  lines: { windows: { id: string; title: string; width: number }[] }[] = [];
  killed = false;
  private exitCb: ((code: number | null) => void) | null = null;
  send(msg: { windows: { id: string; title: string; width: number }[] }) {
    this.lines.push(JSON.parse(JSON.stringify(msg)));
  }
  onExit(cb: (code: number | null) => void) {
    this.exitCb = cb;
  }
  kill() {
    this.killed = true;
  }
  crash(code = 1) {
    this.exitCb?.(code);
  }
  get last() {
    return this.lines[this.lines.length - 1];
  }
}

describe('desiredWindows', () => {
  it('opens a window only for compose scenes with obsWindowCapture enabled', () => {
    const wins = desiredWindows(
      [
        scene('a'),
        scene('b', { config: { obsWindowCapture: false } }),
        scene('c', { config: {} }),
        scene('l', { kind: 'image' }), // a layer, not a compose scene
      ],
      ORIGIN
    );
    expect(wins.map((w) => w.id)).toEqual(['a']);
    expect(wins[0]).toEqual({
      id: 'a',
      url: `${ORIGIN}/viewer/p1/compose/a?output=window`,
      width: 1920,
      height: 1080,
      title: 'vspark – Scene a',
    });
  });

  it('falls back to 1920x1080 for scenes without a resolution', () => {
    const [w] = desiredWindows([scene('a', { width: 0, height: 0 })], ORIGIN);
    expect([w.width, w.height]).toEqual([1920, 1080]);
  });
});

describe('OutputWindowManager', () => {
  let procs: FakeProcess[];
  let mgr: OutputWindowManager;
  const log = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    procs = [];
    log.mockReset();
    mgr = new OutputWindowManager({
      viewerOrigin: ORIGIN,
      launcher: () => {
        const p = new FakeProcess();
        procs.push(p);
        return p;
      },
      log,
      restartDelayMs: 100,
    });
  });
  afterEach(() => {
    mgr.stop();
    vi.useRealTimers();
  });

  it('does not start the output process while no scene has it enabled', () => {
    mgr.setScenes([scene('a', { config: {} })]);
    expect(procs).toHaveLength(0);
  });

  it('starts one process and sends the full window set', () => {
    mgr.setScenes([scene('a'), scene('b')]);
    expect(procs).toHaveLength(1);
    expect(procs[0].last.windows.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('sends updates on rename / resize and skips no-op resyncs', () => {
    mgr.setScenes([scene('a')]);
    mgr.setScenes([scene('a')]);
    expect(procs[0].lines).toHaveLength(1);
    mgr.setScenes([scene('a', { name: 'Renamed', width: 1280, height: 720 })]);
    expect(procs[0].lines).toHaveLength(2);
    expect(procs[0].last.windows[0]).toMatchObject({ title: 'vspark – Renamed', width: 1280 });
  });

  it('stops the process when the last scene is disabled, and restarts on re-enable', () => {
    mgr.setScenes([scene('a')]);
    mgr.setScenes([scene('a', { config: { obsWindowCapture: false } })]);
    expect(procs[0].killed).toBe(true);
    mgr.setScenes([scene('a')]);
    expect(procs).toHaveLength(2);
    expect(procs[1].last.windows.map((w) => w.id)).toEqual(['a']);
  });

  it('restarts a crashed process with backoff and resends the windows', () => {
    mgr.setScenes([scene('a')]);
    procs[0].crash();
    expect(procs).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(procs).toHaveLength(2);
    expect(procs[1].last.windows.map((w) => w.id)).toEqual(['a']);
    procs[1].crash();
    vi.advanceTimersByTime(100);
    expect(procs).toHaveLength(2); // backoff doubled to 200 ms
    vi.advanceTimersByTime(100);
    expect(procs).toHaveLength(3);
  });

  it('kills the process on stop and does not restart afterwards', () => {
    mgr.setScenes([scene('a')]);
    mgr.stop();
    expect(procs[0].killed).toBe(true);
    procs[0].crash();
    vi.advanceTimersByTime(60_000);
    expect(procs).toHaveLength(1);
    mgr.setScenes([scene('b')]);
    expect(procs).toHaveLength(1);
  });

  it('prepares the runtime on first need, reporting progress, then opens windows', async () => {
    const statuses: unknown[] = [];
    let finish!: () => void;
    let progress!: (f: number) => void;
    const prepared = new Promise<void>((r) => (finish = r));
    const lazy = new OutputWindowManager({
      viewerOrigin: ORIGIN,
      prepareLauncher: async (onProgress) => {
        progress = onProgress;
        await prepared;
        return () => {
          const p = new FakeProcess();
          procs.push(p);
          return p;
        };
      },
      onStatus: (s) => statuses.push(s),
      log,
    });
    expect(lazy.status).toEqual({ state: 'idle' });
    lazy.setScenes([scene('a', { config: {} })]);
    expect(statuses).toEqual([]); // nothing enabled → no download
    lazy.setScenes([scene('a')]);
    lazy.setScenes([scene('a'), scene('b')]); // no second download while preparing
    progress(0.5);
    expect(lazy.status).toEqual({ state: 'downloading', progress: 50 });
    expect(procs).toHaveLength(0);
    finish();
    await vi.waitFor(() => expect(procs).toHaveLength(1));
    expect(procs[0].last.windows.map((w) => w.id)).toEqual(['a', 'b']);
    expect(statuses).toEqual([{ state: 'downloading', progress: 50 }, { state: 'ready' }]);
    lazy.stop();
  });

  it('reports a failed preparation and retries on a later change after 30 s', async () => {
    let attempts = 0;
    const lazy = new OutputWindowManager({
      viewerOrigin: ORIGIN,
      prepareLauncher: async () => {
        attempts++;
        throw new Error('offline');
      },
      log,
    });
    lazy.setScenes([scene('a')]);
    await vi.waitFor(() => expect(lazy.status).toEqual({ state: 'error', message: 'offline' }));
    lazy.setScenes([scene('a', { name: 'x' })]);
    expect(attempts).toBe(1); // throttled
    vi.advanceTimersByTime(30_000);
    lazy.setScenes([scene('a', { name: 'y' })]);
    expect(attempts).toBe(2);
    lazy.stop();
  });

  it('logs once and stays inert when the Electron runtime is unavailable', () => {
    const inert = new OutputWindowManager({ viewerOrigin: ORIGIN, launcher: null, log });
    inert.setScenes([scene('a')]);
    inert.setScenes([scene('b')]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/not available/);
    expect(inert.status).toEqual({ state: 'unavailable' });
    inert.stop();
  });
});
