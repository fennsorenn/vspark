import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Quaternion, Blendshapes } from '@vspark/shared/signal';
import { pullValue, loneNode } from './helpers/nodeHarness.js';

// The `log` sink prints on every pull; silence it for clean output.
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe('multiply', () => {
  it('outputs a × b, defaulting unconnected inputs to 0', () => {
    expect(pullValue('multiply', 'value', { a: 6, b: 7 })).toBe(42);
    expect(pullValue('multiply', 'value', {})).toBe(0);
    expect(pullValue('multiply', 'value', { a: -3, b: 4 })).toBe(-12);
  });
});

describe('not_bool', () => {
  it('negates, treating null/undefined as false', () => {
    expect(pullValue('not_bool', 'result', { value: true })).toBe(false);
    expect(pullValue('not_bool', 'result', { value: false })).toBe(true);
    expect(pullValue('not_bool', 'result', {})).toBe(true);
  });
});

describe('euler_to_quaternion', () => {
  it('zero angles → identity quaternion', () => {
    const q = pullValue('euler_to_quaternion', 'quaternion', {
      pitch: 0,
      yaw: 0,
      roll: 0,
    }) as Quaternion;
    expect(q).toBeInstanceOf(Quaternion);
    expect(q.toArray().map((n) => Math.round(n))).toEqual([0, 0, 0, 1]);
  });

  it('produces a unit quaternion for arbitrary angles', () => {
    const q = pullValue('euler_to_quaternion', 'quaternion', {
      pitch: 0.5,
      yaw: -0.3,
      roll: 1.2,
    }) as Quaternion;
    expect(q.magnitudeSquared).toBeCloseTo(1, 6);
  });
});

describe('time', () => {
  it('outputs current time in seconds', () => {
    const t = pullValue('time', 'seconds') as number;
    expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe('sine_wave', () => {
  it('evaluates sin(time·freq·2π + phase)·amplitude', () => {
    expect(
      pullValue('sine_wave', 'value', { time: 0, frequency: 1, amplitude: 2, phase: 0 })
    ).toBe(0);
    // quarter period → sin(π/2) = 1
    expect(
      pullValue('sine_wave', 'value', {
        time: 0.25,
        frequency: 1,
        amplitude: 1,
        phase: 0,
      }) as number
    ).toBeCloseTo(1, 6);
  });

  it('uses defaults when inputs are unconnected', () => {
    expect(pullValue('sine_wave', 'value', {})).toBe(0); // sin(0)·0.05
  });
});

describe('random', () => {
  it('fires → caches a value within [min,max]; pulls the midpoint before any fire', () => {
    // Before firing, value() returns the midpoint of min/max.
    expect(pullValue('random', 'value', { min: 0, max: 10 })).toBe(5);

    // Deterministic when min === max.
    const n = loneNode('random', { min: 5, max: 5 });
    n.deliver('fire', undefined);
    expect(n.state<{ lastValue: number }>().lastValue).toBe(5);

    // int mode with equal bounds is also deterministic.
    const i = loneNode('random', { min: 2, max: 2, mode: 'int' });
    i.deliver('fire', undefined);
    expect(i.state<{ lastValue: number }>().lastValue).toBe(2);

    // A fired float value pulls back out of state.
    expect(pullValue('random', 'value', { min: 3, max: 3 }, { lastValue: 3 })).toBe(3);
  });
});

describe('hand_height_compare', () => {
  const pose = (leftY: number, rightY: number, vis = 1) => {
    const pts = Array.from({ length: 17 }, () => ({ x: 0, y: 0, z: 0, visibility: vis }));
    pts[15] = { x: 0, y: leftY, z: 0, visibility: vis };
    pts[16] = { x: 0, y: rightY, z: 0, visibility: vis };
    return pts;
  };

  it('reports the higher wrist (smaller raw Y)', () => {
    expect(pullValue('hand_height_compare', 'side', { pose: pose(0.1, 0.9) })).toBe('left');
    expect(pullValue('hand_height_compare', 'side', { pose: pose(0.9, 0.1) })).toBe('right');
  });

  it('returns null when the pose is missing/short or both wrists are invisible', () => {
    expect(pullValue('hand_height_compare', 'side', {})).toBeNull();
    expect(pullValue('hand_height_compare', 'side', { pose: pose(0.1, 0.9, 0) })).toBeNull();
  });

  it('falls back to the only visible wrist', () => {
    const pts = pose(0.5, 0.5);
    pts[16].visibility = 0; // right invisible
    expect(pullValue('hand_height_compare', 'side', { pose: pts })).toBe('left');
  });
});

describe('viseme_passthrough', () => {
  it('scales incoming viseme weights by sensitivity, clamped to [0,1]', () => {
    const n = loneNode('viseme_passthrough', { sensitivity: 2 });
    n.deliver('visemes', Blendshapes.fromRecord({ aa: 0.5, ih: 0.1 }));
    const scaled = n.state<{ scaled: Blendshapes }>().scaled;
    expect(scaled.get('aa')).toBe(1); // 0.5×2 clamped to 1
    expect(scaled.get('ih')).toBeCloseTo(0.2, 6);
  });

  it('ignores an empty payload', () => {
    const n = loneNode('viseme_passthrough', {});
    n.deliver('visemes', undefined);
    expect(n.state()).toBeUndefined();
  });
});
