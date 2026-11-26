/**
 * LipsyncManager's input modes: `browser` (WS `lipsync_input`) and `pipewire`
 * (server-side capture). `parec` is replaced by a fake child process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { LipsyncManager } from '../src/behaviors/lipsync/manager.js';
import type { SpawnFn } from '../src/behaviors/lipsync/pipewireCapture.js';
import { runMigrations, closeDb } from '../src/db/index.js';

beforeEach(async () => {
  process.env.VSPARK_DB_PATH = ':memory:';
  closeDb();
  await runMigrations();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function withFakeParec() {
  const children: FakeChild[] = [];
  const sources: string[] = [];
  const spawn = ((_cmd: string, args: string[]) => {
    sources.push(args.find((a) => a.startsWith('--device='))!.slice(9));
    const c = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    children.push(c);
    return c;
  }) as unknown as SpawnFn;
  return { mgr: new LipsyncManager(spawn), children, sources };
}

const comp = (config: Record<string, unknown>, enabled = true) => ({
  id: 'ls1',
  nodeId: 'node1',
  kind: 'lipsync_processor',
  enabled,
  config,
});

function speech(frames: number): Buffer {
  const n = 1600 * frames;
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++)
    buf.writeFloatLE(0.3 * Math.sin((2 * Math.PI * 300 * i) / 48000), i * 4);
  return buf;
}

describe('LipsyncManager input modes', () => {
  it('defaults to browser input', () => {
    const { mgr, sources } = withFakeParec();
    mgr.syncBehaviors([comp({ sensitivity: 1 })]);
    expect(mgr.inputMode('ls1')).toBe('browser');
    expect(mgr.isCapturing('ls1')).toBe(false);
    expect(sources).toEqual([]);
    mgr.close();
  });

  it('captures the configured source server-side', () => {
    const { mgr, sources } = withFakeParec();
    mgr.syncBehaviors([
      comp({ inputMode: 'pipewire', pipewireSource: 'vmic.monitor' }),
    ]);
    expect(sources).toEqual(['vmic.monitor']);
    expect(mgr.isCapturing('ls1')).toBe(true);
    expect(mgr.inputMode('ls1')).toBe('pipewire');
    mgr.close();
    expect(mgr.isCapturing('ls1')).toBe(false);
  });

  it('does not capture without a source', () => {
    const { mgr, sources } = withFakeParec();
    mgr.syncBehaviors([comp({ inputMode: 'pipewire', pipewireSource: '  ' })]);
    mgr.syncBehaviors([comp({ inputMode: 'pipewire' })]);
    expect(sources).toEqual([]);
    mgr.close();
  });

  it('restarts only when the source or templates change', () => {
    const { mgr, sources, children } = withFakeParec();
    const cfg = {
      inputMode: 'pipewire',
      pipewireSource: 'a.monitor',
      sensitivity: 1,
    };
    mgr.syncBehaviors([comp(cfg)]);
    mgr.syncBehaviors([comp({ ...cfg, sensitivity: 2 })]);
    expect(sources).toEqual(['a.monitor']);

    mgr.syncBehaviors([comp({ ...cfg, pipewireSource: 'b.monitor' })]);
    expect(sources).toEqual(['a.monitor', 'b.monitor']);
    expect(children[0].kill).toHaveBeenCalled();

    // Malformed templates are ignored rather than counted as a change.
    mgr.syncBehaviors([
      comp({ ...cfg, pipewireSource: 'b.monitor', vowelTemplates: { A: [1] } }),
    ]);
    expect(sources).toHaveLength(2);

    mgr.syncBehaviors([comp({ inputMode: 'browser' })]);
    expect(mgr.isCapturing('ls1')).toBe(false);
    expect(children[1].kill).toHaveBeenCalled();
    mgr.close();
  });

  it('restarts when calibrated templates are saved', () => {
    const { mgr, sources } = withFakeParec();
    const cfg = { inputMode: 'pipewire', pipewireSource: 'a.monitor' };
    mgr.syncBehaviors([comp(cfg)]);
    const t = Array.from({ length: 12 }, (_, i) => i);
    mgr.syncBehaviors([
      comp({ ...cfg, vowelTemplates: { A: t, E: t, I: t, O: t, U: t } }),
    ]);
    expect(sources).toHaveLength(2);
    mgr.close();
  });

  it('stops capturing when the behavior is disabled', () => {
    const { mgr, children } = withFakeParec();
    mgr.syncBehaviors([
      comp({ inputMode: 'pipewire', pipewireSource: 'a.monitor' }),
    ]);
    mgr.syncBehaviors([comp({}, false)]);
    expect(children[0].kill).toHaveBeenCalled();
    expect(mgr.isCapturing('ls1')).toBe(false);
  });

  it('drives the graph from captured audio and ignores the browser', () => {
    const { mgr, children } = withFakeParec();
    mgr.syncBehaviors([
      comp({ inputMode: 'pipewire', pipewireSource: 'a.monitor' }),
    ]);
    const fire = vi.spyOn(
      mgr as unknown as {
        _fire: (id: string, v: Record<string, number>) => void;
      },
      '_fire'
    );
    // A media-input tab left open must not fight the capture over the mouth.
    mgr.fireVisemes('ls1', { Fcl_MTH_A: 1 });
    expect(fire).not.toHaveBeenCalled();

    children[0].stdout.emit('data', speech(3));
    expect(fire).toHaveBeenCalled();
    const [id, w] = fire.mock.calls.at(-1)!;
    expect(id).toBe('ls1');
    expect(w.jawOpen).toBeGreaterThan(0);
    mgr.close();
  });

  it('still takes browser visemes in browser mode', () => {
    const { mgr } = withFakeParec();
    mgr.syncBehaviors([comp({ inputMode: 'browser' })]);
    const fire = vi.spyOn(
      mgr as unknown as {
        _fire: (id: string, v: Record<string, number>) => void;
      },
      '_fire'
    );
    mgr.fireVisemes('ls1', { Fcl_MTH_A: 1 });
    expect(fire).toHaveBeenCalledWith('ls1', { Fcl_MTH_A: 1 });
    mgr.close();
  });
});
