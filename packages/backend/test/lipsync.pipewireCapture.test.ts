/**
 * The lipsync behavior's server-side PipeWire input: `parec` is replaced by a
 * fake child process, so these run with no audio stack.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { FFT_SIZE, type VisemeWeights } from '@vspark/shared/visemes';
import {
  PipeWireLipsyncCapture,
  canCapturePipeWire,
  type CaptureStatus,
  type SpawnFn,
} from '../src/behaviors/lipsync/pipewireCapture.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const c = new FakeChild();
    children.push(c);
    return c;
  }) as unknown as SpawnFn;
  return { spawn, children, calls };
}

function f32(samples: number[] | Float32Array): Buffer {
  const b = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) b.writeFloatLE(samples[i], i * 4);
  return b;
}

function tone(n: number, amp = 0.3, freq = 300, rate = 48000): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe('PipeWireLipsyncCapture', () => {
  let out: VisemeWeights[];
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    out = [];
    logs = [];
  });
  afterEach(() => vi.useRealTimers());

  function make(spawn: SpawnFn, extra = {}) {
    return new PipeWireLipsyncCapture({
      source: 'vmic.monitor',
      onVisemes: (w) => out.push(w),
      spawn,
      log: (m) => logs.push(m),
      ...extra,
    });
  }

  it('runs parec against the configured source as raw mono float32', () => {
    const { spawn, calls } = fakeSpawn();
    const cap = make(spawn);
    cap.start();
    expect(cap.running).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('parec');
    expect(calls[0].args).toEqual(
      expect.arrayContaining([
        '--device=vmic.monitor',
        '--format=float32le',
        '--rate=48000',
        '--channels=1',
        '--raw',
      ])
    );
    cap.start(); // idempotent
    expect(calls).toHaveLength(1);
    cap.stop();
  });

  it('opens the mouth on speech, one frame per hop', () => {
    const { spawn, children } = fakeSpawn();
    const cap = make(spawn, { fps: 30 });
    cap.start();
    // 48000 / 30 = 1600 samples per frame.
    children[0].stdout.emit('data', f32(tone(1600 * 6)));
    expect(out).toHaveLength(6);
    expect(out.at(-1)!.jawOpen).toBeGreaterThan(0.5);
    cap.stop();
  });

  it('reassembles a float split across chunks', () => {
    const { spawn, children } = fakeSpawn();
    const cap = make(spawn, { fps: 30 });
    cap.start();
    const bytes = f32(tone(1600 * 2));
    children[0].stdout.emit('data', bytes.subarray(0, 4 * 1000 + 2));
    children[0].stdout.emit('data', bytes.subarray(4 * 1000 + 2));
    expect(out).toHaveLength(2);
    cap.stop();
  });

  it('sends one closed frame when speech stops, then nothing', () => {
    const { spawn, children } = fakeSpawn();
    const cap = make(spawn, { fps: 30 });
    cap.start();
    children[0].stdout.emit('data', f32(tone(1600 * 4)));
    out = [];
    // Silence long enough for the EMA to fall under the quiet threshold.
    children[0].stdout.emit('data', f32(new Float32Array(1600 * 40)));
    const closed = out.filter((w) => w.jawOpen === 0 && w.Fcl_MTH_A === 0);
    expect(closed).toHaveLength(1);
    expect(out.at(-1)).toEqual(closed[0]);
    cap.stop();
  });

  it('sends nothing for silence it never left', () => {
    const { spawn, children } = fakeSpawn();
    const cap = make(spawn);
    cap.start();
    children[0].stdout.emit('data', f32(new Float32Array(FFT_SIZE * 4)));
    expect(out).toHaveLength(0);
    cap.stop();
  });

  it('closes the mouth when the source stops delivering', () => {
    // A suspended null-sink's monitor delivers no samples at all.
    const { spawn, children } = fakeSpawn();
    const cap = make(spawn, { fps: 30, staleMs: 100 });
    cap.start();
    children[0].stdout.emit('data', f32(tone(1600 * 3)));
    expect(out.at(-1)!.jawOpen).toBeGreaterThan(0);
    vi.advanceTimersByTime(250);
    expect(out.at(-1)!.jawOpen).toBe(0);
    cap.stop();
  });

  it('restarts parec with backoff when it exits', () => {
    const { spawn, children } = fakeSpawn();
    const cap = make(spawn);
    cap.start();
    children[0].emit('exit', 1);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(2);
    children[1].emit('exit', 1);
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(2); // backoff doubled to 2s
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(3);
    cap.stop();
  });

  it('retries when parec is missing', () => {
    const { spawn, children } = fakeSpawn();
    const cap = make(spawn);
    cap.start();
    children[0].emit('error', new Error('spawn parec ENOENT'));
    expect(logs.some((l) => l.includes('ENOENT'))).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(2);
    cap.stop();
  });

  it('retries when spawn itself throws', () => {
    let n = 0;
    const throwing = (() => {
      n++;
      throw new Error('boom');
    }) as unknown as SpawnFn;
    const cap = make(throwing);
    cap.start();
    expect(n).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(n).toBe(2);
    cap.stop();
  });

  it('logs parec stderr', () => {
    const { spawn, children } = fakeSpawn();
    const cap = make(spawn);
    cap.start();
    children[0].stderr.emit(
      'data',
      Buffer.from('Stream error: No such entity\n')
    );
    children[0].stderr.emit('data', Buffer.from('  \n'));
    expect(logs.filter((l) => l.includes('No such entity'))).toHaveLength(1);
    cap.stop();
  });

  it('stop kills parec, closes the mouth and does not restart', () => {
    const { spawn, children } = fakeSpawn();
    const cap = make(spawn, { fps: 30 });
    cap.start();
    children[0].stdout.emit('data', f32(tone(1600 * 3)));
    cap.stop();
    expect(cap.running).toBe(false);
    expect(children[0].kill).toHaveBeenCalled();
    expect(out.at(-1)!.jawOpen).toBe(0);
    children[0].emit('exit', null);
    // Late data from the dead child is ignored.
    const n = out.length;
    children[0].stdout.emit('data', f32(tone(1600 * 3)));
    expect(out).toHaveLength(n);
    vi.advanceTimersByTime(60000);
    expect(children).toHaveLength(1);
  });

  describe('status', () => {
    function withStatus(spawn: SpawnFn, extra = {}) {
      const seen: CaptureStatus[] = [];
      const cap = make(spawn, { onStatus: (st: CaptureStatus) => seen.push(st), ...extra });
      return { cap, seen, states: () => seen.map((x) => x.state) };
    }

    it('starting → capturing on samples → idle when they stop, once per change', () => {
      const { spawn, children } = fakeSpawn();
      const { cap, states } = withStatus(spawn, { staleMs: 100 });
      cap.start();
      expect(states()).toEqual(['starting']);
      children[0].stdout.emit('data', f32(tone(1600)));
      children[0].stdout.emit('data', f32(tone(1600)));
      expect(states()).toEqual(['starting', 'capturing']);
      vi.advanceTimersByTime(250);
      expect(states()).toEqual(['starting', 'capturing', 'idle']);
      expect(cap.current).toEqual({ state: 'idle' });
      cap.stop();
    });

    it('reports a missing parec as an error with its message', () => {
      const { spawn, children } = fakeSpawn();
      const { cap, seen } = withStatus(spawn);
      cap.start();
      children[0].emit('error', new Error('spawn parec ENOENT'));
      expect(seen.at(-1)).toEqual({
        state: 'error',
        message: 'spawn parec ENOENT',
      });
      cap.stop();
    });

    it("reports parec's last complaint when it exits (e.g. an unknown source)", () => {
      const { spawn, children } = fakeSpawn();
      const { cap, seen } = withStatus(spawn);
      cap.start();
      children[0].stderr.emit(
        'data',
        Buffer.from('Connecting\nStream error: No such entity\n')
      );
      children[0].emit('exit', 1);
      expect(seen.at(-1)).toEqual({
        state: 'error',
        message: 'Stream error: No such entity',
      });
      cap.stop();
    });

    it('a retry keeps the error until parec stays up, then reads idle', () => {
      const { spawn, children } = fakeSpawn();
      const { cap, states } = withStatus(spawn, { staleMs: 100 });
      cap.start();
      children[0].emit('exit', 1);
      vi.advanceTimersByTime(1000); // restarted
      expect(children).toHaveLength(2);
      vi.advanceTimersByTime(500); // up, but not long enough
      expect(states().at(-1)).toBe('error');
      vi.advanceTimersByTime(700);
      expect(states().at(-1)).toBe('idle');
      expect(states()).not.toContain('capturing');
      cap.stop();
    });
  });
});

describe('canCapturePipeWire', () => {
  const ok = () => ({ status: 0 });
  it('needs Linux and a working parec', () => {
    expect(canCapturePipeWire('linux', ok)).toBe(true);
    expect(canCapturePipeWire('win32', ok)).toBe(false);
    expect(canCapturePipeWire('darwin', ok)).toBe(false);
    expect(
      canCapturePipeWire('linux', () => ({
        status: null,
        error: new Error('ENOENT'),
      }))
    ).toBe(false);
    expect(canCapturePipeWire('linux', () => ({ status: 1 }))).toBe(false);
    expect(
      canCapturePipeWire('linux', () => {
        throw new Error('boom');
      })
    ).toBe(false);
  });
});
