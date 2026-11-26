/**
 * The viewport's motion filter for tracking poses (src/poseFilter.ts): presets,
 * the glide matched to the pose rate, smoothing, spring, the per-sample
 * velocity estimate, and the bank.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_POSE_FILTER,
  POSE_FILTER_PRESETS,
  PoseFilterBank,
  PoseFilterQuat,
  resolvePoseFilter,
  type PoseFilterParams,
} from '../src/poseFilter';

const DT = 1 / 60;
const X = new THREE.Vector3(1, 0, 0);
const rot = (deg: number) =>
  new THREE.Quaternion().setFromAxisAngle(X, (deg * Math.PI) / 180);
/** Signed angle (deg) about +X. */
const deg = (q: THREE.Quaternion) =>
  ((2 * Math.atan2(Math.hypot(q.x, q.y, q.z), q.w) * 180) / Math.PI) *
  Math.sign(q.x || 1);

/** 60 fps render loop over an input sampled at `hz`; output angle per frame. */
function run(
  p: PoseFilterParams,
  hz: number,
  frames: number,
  signal: (t: number) => number
): number[] {
  const f = new PoseFilterQuat();
  const out: number[] = [];
  let last = -1;
  for (let i = 0; i < frames; i++) {
    const s = Math.floor(i * DT * hz);
    const fresh = s !== last;
    last = s;
    out.push(deg(f.filter(rot(signal(s / hz)), DT, p, fresh)));
  }
  return out;
}

/** A 50° step at t = 2 s on a 10 Hz input: frames (after the step) to reach
 *  `level` of it, and the overshoot (deg). */
function step(p: PoseFilterParams) {
  const after = run(p, 10, 240, (t) => (t >= 2 ? 50 : 0)).slice(120);
  return {
    framesTo: (level: number) => after.findIndex((v) => v >= level * 50),
    overshoot: Math.max(...after) - 50,
  };
}

/** Deterministic 1° (sd) noise around a still pose; RMS of the output. */
function jitter(p: PoseFilterParams, hz: number): number {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const noise = Array.from(
    { length: 2000 },
    () =>
      Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
  );
  const o = run(p, hz, 1200, (t) => noise[Math.round(t * hz)]).slice(120);
  return Math.sqrt(o.reduce((a, v) => a + v * v, 0) / o.length);
}

describe('resolvePoseFilter', () => {
  it('defaults to Minimal', () => {
    expect(resolvePoseFilter(undefined)).toEqual(DEFAULT_POSE_FILTER);
    expect(DEFAULT_POSE_FILTER.preset).toBe('minimal');
  });

  it("uses a preset's own values, whatever numbers are stored", () => {
    expect(resolvePoseFilter({ preset: 'smooth', damping: 0.2 })).toEqual({
      preset: 'smooth',
      ...POSE_FILTER_PRESETS.smooth,
    });
  });

  it('uses the stored numbers with Custom, Minimal for missing ones', () => {
    expect(resolvePoseFilter({ preset: 'custom', damping: 0.4 })).toEqual({
      ...POSE_FILTER_PRESETS.minimal,
      preset: 'custom',
      damping: 0.4,
    });
  });
});

describe('PoseFilterQuat', () => {
  it('starts on the first sample and ignores dt <= 0', () => {
    const f = new PoseFilterQuat();
    const a = rot(30);
    expect(deg(f.filter(a, DT, POSE_FILTER_PRESETS.smooth))).toBeCloseTo(30);
    expect(deg(f.filter(rot(80), 0, POSE_FILTER_PRESETS.smooth))).toBeCloseTo(
      30
    );
  });

  it('Minimal glides onto a 10 Hz step within about one sample interval, without overshoot', () => {
    const s = step(POSE_FILTER_PRESETS.minimal);
    expect(s.framesTo(0.5)).toBeLessThanOrEqual(2);
    expect(s.framesTo(0.9)).toBeLessThanOrEqual(6); // 100 ms at 60 fps
    expect(s.overshoot).toBeLessThan(0.5);
  });

  it('keeps the glide after a pause: a held pose (no new samples) is not a slow pose rate', () => {
    // The viewport flags a sample as new only when its values change, so a
    // perfectly still pose looks like a long gap before the next movement.
    const f = new PoseFilterQuat();
    const p = POSE_FILTER_PRESETS.minimal;
    let i = 0;
    for (; i < 60; i++)
      f.filter(rot(i % 6 === 0 ? i : i - (i % 6)), DT, p, i % 6 === 0); // 10 Hz motion
    const before = f.glideHz;
    for (let k = 0; k < 120; k++, i++) f.filter(rot(54), DT, p, false); // 2 s held
    const out: number[] = [];
    out.push(deg(f.filter(rot(104), DT, p, true))); // 50° step
    for (let k = 0; k < 10; k++)
      out.push(deg(f.filter(rot(104), DT, p, false)));
    expect(f.glideHz).toBeCloseTo(before, 1);
    expect(out.findIndex((v) => v >= 54 + 0.9 * 50)).toBeLessThanOrEqual(6);
  });

  it('matches the glide to the pose rate', () => {
    const at = (hz: number) => {
      const f = new PoseFilterQuat();
      let last = -1;
      for (let i = 0; i < 300; i++) {
        const s = Math.floor(i * DT * hz);
        f.filter(rot(s % 2), DT, POSE_FILTER_PRESETS.minimal, s !== last);
        last = s;
      }
      return f.glideHz;
    };
    expect(at(10)).toBeGreaterThan(6);
    expect(at(10)).toBeLessThan(9);
    expect(at(30)).toBeGreaterThan(2 * at(10));
  });

  it('Smooth suppresses jitter at rest and stays as quick as Minimal on a step', () => {
    expect(jitter(POSE_FILTER_PRESETS.smooth, 30)).toBeLessThan(
      0.5 * jitter(POSE_FILTER_PRESETS.minimal, 30)
    );
    const s = step(POSE_FILTER_PRESETS.smooth);
    expect(s.framesTo(0.9)).toBeLessThanOrEqual(6);
    expect(s.overshoot).toBeLessThan(0.5);
  });

  it('Springy overshoots a step', () => {
    const s = step(POSE_FILTER_PRESETS.springy);
    expect(s.overshoot).toBeGreaterThan(3);
    expect(s.overshoot).toBeLessThan(15);
  });

  it('estimates velocity per sample: heavy damping with response stays smooth on a 30 Hz input', () => {
    // Regression from the former snappiness filter: a per-frame velocity of a
    // stepped input is a spike then zeros, and the bone jerked every frame.
    const p = { smoothing: 0, adaptation: 0, damping: 3, response: 1.1 };
    const out = run(p, 30, 1200, (t) => 30 * Math.sin(2 * t));
    let reversals = 0;
    for (let i = 202; i < out.length; i++) {
      const a = out[i] - out[i - 1];
      const b = out[i - 1] - out[i - 2];
      if (a * b < 0 && Math.abs(a) > 1e-4) reversals++;
    }
    expect(reversals).toBeLessThan(20);
  });

  it('reset() starts over from the next sample', () => {
    const f = new PoseFilterQuat();
    f.filter(rot(0), DT, POSE_FILTER_PRESETS.smooth);
    f.filter(rot(40), DT, POSE_FILTER_PRESETS.smooth);
    f.reset();
    expect(deg(f.filter(rot(70), DT, POSE_FILTER_PRESETS.smooth))).toBeCloseTo(
      70
    );
  });
});

describe('PoseFilterBank', () => {
  it('keeps one independent filter per bone, and resets them all', () => {
    const b = new PoseFilterBank();
    const p = POSE_FILTER_PRESETS.smooth;
    expect(deg(b.filter('a', rot(10), DT, p).clone())).toBeCloseTo(10);
    expect(deg(b.filter('b', rot(60), DT, p).clone())).toBeCloseTo(60);
    expect(deg(b.filter('a', rot(10), DT, p).clone())).toBeCloseTo(10);
    b.reset();
    expect(deg(b.filter('a', rot(-20), DT, p).clone())).toBeCloseTo(-20);
  });
});
