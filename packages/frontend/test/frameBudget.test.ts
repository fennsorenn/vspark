/**
 * The shared render loop keeps rendering to its share of the main thread
 * (components/frameBudget.tsx). A fake display refreshes every 16.7ms and a
 * fake clock lets each render "take" a set time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let clock = 0;
let pending: ((t: number) => void) | null = null;

async function fresh() {
  vi.resetModules();
  return import('../src/components/frameBudget');
}

/** Run the display for `ms`, returning the times at which a frame rendered. */
function run(
  register: typeof import('../src/components/frameBudget').registerFrame,
  costMs: number,
  share: number,
  ms: number
) {
  clock = 0;
  const rendered: number[] = [];
  const globals: boolean[] = [];
  const stop = register((t, runGlobalEffects) => {
    rendered.push(t);
    globals.push(runGlobalEffects);
    clock += costMs;
  }, share);
  for (let t = 0; t < ms; t += 1000 / 60) {
    clock = Math.max(clock, t);
    const cb = pending;
    pending = null;
    cb?.(t);
  }
  stop();
  return { rendered, globals };
}

describe('frame budget', () => {
  beforeEach(() => {
    clock = 0;
    pending = null;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      pending = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      pending = null;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a scene within budget renders on every refresh', async () => {
    const { registerFrame } = await fresh();
    const { rendered } = run(registerFrame, 8, 0.75, 1000);
    expect(rendered.length).toBeGreaterThanOrEqual(59);
  });

  it('an overloaded scene skips refreshes and leaves the rest of the thread free', async () => {
    const { registerFrame } = await fresh();
    const cost = 14; // more than 75% of a 16.7ms refresh
    const { rendered } = run(registerFrame, cost, 0.75, 1000);
    const busy = rendered.length * cost;
    expect(rendered.length).toBeLessThan(45);
    expect(busy / 1000).toBeLessThanOrEqual(0.75);
  });

  it('a higher share renders more of an expensive scene', async () => {
    const { registerFrame } = await fresh();
    const low = run(registerFrame, 14, 0.75, 1000).rendered.length;
    const high = run((await fresh()).registerFrame, 14, 0.9, 1000).rendered
      .length;
    expect(high).toBeGreaterThan(low);
  });

  it('several canvases share one budget, and global effects run once a frame', async () => {
    const { registerFrame } = await fresh();
    const calls: [number, boolean][] = [];
    const stopA = registerFrame((t, g) => {
      calls.push([t, g]);
      clock += 5;
    }, 0.75);
    const stopB = registerFrame((t, g) => {
      calls.push([t, g]);
      clock += 5;
    }, 0.75);
    for (let t = 0; t < 1000; t += 1000 / 60) {
      clock = Math.max(clock, t);
      const cb = pending;
      pending = null;
      cb?.(t);
    }
    stopA();
    stopB();
    const frames = new Map<number, boolean[]>();
    for (const [t, g] of calls) frames.set(t, [...(frames.get(t) ?? []), g]);
    for (const g of frames.values()) expect(g).toEqual([true, false]);
    expect(frames.size).toBeGreaterThanOrEqual(59); // 10ms together: fits
  });
});

describe('FrameBudget → R3F time', () => {
  it('hands advance() seconds, so useFrame deltas are seconds', async () => {
    const { toR3fTime } = await fresh();
    // R3F's frameloop="never" path: delta = value − previous value.
    const delta = toR3fTime(1016.7) - toR3fTime(1000);
    expect(delta).toBeCloseTo(1 / 60, 4);
  });
});
