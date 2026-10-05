/**
 * Motion Snappiness (second-order dynamics) under input that updates less often
 * than the display renders.
 *
 * Regression: the target velocity used to be estimated per rendered frame, so a
 * tracker slower than the render loop produced a velocity spike on update frames
 * and zero in between. With heavy damping (a user's 1.3 Hz / ζ 3.75 / r 1.1) the
 * bone jerked back and forth every frame. The velocity is now estimated per
 * input sample (`newSample`) and held in between.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SecondOrderDynamicsQuat } from '../src/secondOrderDynamics';

const HEAVY = { f: 1.3, z: 3.75, r: 1.1 };

/** Yaw angle (rad) of a quaternion rotating about +Y. */
const yawOf = (q: THREE.Quaternion) =>
  new THREE.Euler().setFromQuaternion(q, 'YXZ').y;

/** Run a 60 fps render loop against a sine target that only updates every
 *  `hold` frames; count direction reversals of the output after settling. */
function run(hold: number, flagSamples: boolean) {
  const d = new SecondOrderDynamicsQuat();
  const dt = 1 / 60;
  const target = new THREE.Quaternion();
  let held = 0;
  let prevYaw = 0;
  let prevStep = 0;
  let reversals = 0;
  for (let i = 0; i < 1200; i++) {
    const isSample = i % hold === 0;
    if (isSample) held = 0.5 * Math.sin(i * dt * 2);
    target.setFromAxisAngle(new THREE.Vector3(0, 1, 0), held);
    const y = d.filter(
      target,
      dt,
      HEAVY.f,
      HEAVY.z,
      HEAVY.r,
      flagSamples ? isSample : true
    );
    const yaw = yawOf(y);
    if (i > 200) {
      const step = yaw - prevYaw;
      if (step * prevStep < 0 && Math.abs(step) > 1e-5) reversals++;
      prevStep = step;
    }
    prevYaw = yaw;
  }
  return reversals;
}

describe('SecondOrderDynamicsQuat with a slower input', () => {
  it('per-frame velocity (old behaviour) jitters on a 30 Hz input', () => {
    // Documents the failure mode the sample flag exists for.
    expect(run(2, false)).toBeGreaterThan(200);
  });

  it('per-sample velocity stays smooth on a 30 Hz input', () => {
    // A 2 rad/s sine changes direction ~12 times in 1000 frames; nothing more.
    expect(run(2, true)).toBeLessThan(20);
  });

  it('matches a per-frame input when every frame is a sample', () => {
    expect(run(1, true)).toBe(run(1, false));
  });

  it('drops a held target velocity once the input stalls', () => {
    // Moving input, then the tracker freezes at its last value. Holding the
    // last velocity forever would keep pushing the output past the target; the
    // stall cut-off brings it to rest like a filter fed the frozen value as
    // fresh samples (whose velocity is zero at once).
    const settle = (flagSamples: boolean) => {
      const d = new SecondOrderDynamicsQuat();
      const q = new THREE.Quaternion();
      const axis = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < 30; i++) {
        q.setFromAxisAngle(axis, i * 0.02);
        d.filter(q, 1 / 60, HEAVY.f, HEAVY.z, HEAVY.r, true);
      }
      let y = new THREE.Quaternion();
      for (let i = 0; i < 240; i++)
        y = d
          .filter(q, 1 / 60, HEAVY.f, HEAVY.z, HEAVY.r, !flagSamples)
          .clone();
      return yawOf(y);
    };
    const target = 29 * 0.02;
    const stalled = settle(true);
    // Within a hair of the reference, and closing on the target.
    expect(Math.abs(stalled - settle(false))).toBeLessThan(0.02);
    expect(Math.abs(stalled - target)).toBeLessThan(0.005);
  });
});
