/**
 * Phase 7 — frontend non-visual coverage
 *
 * Covers pure math/signal utilities:
 *   - src/oneEuroFilter.ts   (OneEuroFilterQuat, BoneFilterBank)
 *   - src/calibration.ts     (applyArmCalib, elbowAngleForReach, fitArmCalib,
 *                             upperArmNormRotFromTarget, DEFAULT_* constants)
 *
 * src/previewSmoother.ts is excluded: its public functions are tightly coupled
 * to useEditorStore (Zustand) and requestAnimationFrame. All internal smoothing
 * math is private.  Testing it without a full store + RAF environment would only
 * verify mock wiring, not logic.  Limitation noted in report.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';

import { OneEuroFilterQuat, BoneFilterBank } from '../src/oneEuroFilter';
import {
  applyArmCalib,
  elbowAngleForReach,
  fitArmCalib,
  upperArmNormRotFromTarget,
  DEFAULT_ARM_CALIB,
  DEFAULT_CALIBRATION,
} from '../src/calibration';

// ─── OneEuroFilterQuat ────────────────────────────────────────────────────────

describe('OneEuroFilterQuat', () => {
  it('returns the same reference every time', () => {
    const f = new OneEuroFilterQuat();
    const q = new THREE.Quaternion();
    const r1 = f.filter(q, 0.016);
    const r2 = f.filter(q, 0.016);
    expect(r1).toBe(r2); // same internal quaternion object
  });

  it('first sample initialises the filter to the input exactly', () => {
    const f = new OneEuroFilterQuat();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0.3, 0.1));
    const out = f.filter(q, 0.016);
    expect(out.x).toBeCloseTo(q.x, 6);
    expect(out.y).toBeCloseTo(q.y, 6);
    expect(out.z).toBeCloseTo(q.z, 6);
    expect(out.w).toBeCloseTo(q.w, 6);
  });

  it('skips update when dt <= 0, returning current filtered value', () => {
    const f = new OneEuroFilterQuat();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, 0));
    // Initialise
    const after1 = f.filter(q, 0.016);
    const x1 = after1.x;
    // Feed zero dt — should return the same filtered value without advancing
    const other = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.5, 0, 0));
    const after2 = f.filter(other, 0);
    expect(after2.x).toBeCloseTo(x1, 6);
  });

  it('converges to constant input over many frames', () => {
    const f = new OneEuroFilterQuat();
    const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 4, 0));
    const dt = 1 / 60;
    // First call initialises
    f.filter(target, dt);
    // Feed the same quaternion 500 times
    let out!: THREE.Quaternion;
    for (let i = 0; i < 500; i++) {
      out = f.filter(target, dt);
    }
    // After convergence the filter should be very close to the constant input
    expect(out.x).toBeCloseTo(target.x, 3);
    expect(out.y).toBeCloseTo(target.y, 3);
    expect(out.z).toBeCloseTo(target.z, 3);
    expect(out.w).toBeCloseTo(target.w, 3);
  });

  it('damps a step input — output is between previous and target (not an instant jump)', () => {
    const f = new OneEuroFilterQuat();
    const identity = new THREE.Quaternion(); // (0,0,0,1)
    const dt = 1 / 60;
    // Initialise to identity
    f.filter(identity, dt);
    const initial = f.filter(identity, dt);
    const prevW = initial.w; // should be ~1

    // Step to 180° rotation
    const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.8, 0));
    const out = f.filter(target, dt);
    // The filtered output must be strictly between identity and target (damped)
    // i.e. w must have moved from prevW toward target.w but not arrived
    expect(out.w).toBeLessThan(prevW);
    expect(out.w).toBeGreaterThan(target.w);
  });

  it('lower minCutoff produces more smoothing (less change per step)', () => {
    const dtFixed = 1 / 60;
    const targetQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1.0, 0));

    function singleStepChange(minCutoff: number): number {
      const f = new OneEuroFilterQuat(minCutoff, 0);
      const start = new THREE.Quaternion(); // identity
      f.filter(start, dtFixed); // initialise
      const out = f.filter(targetQ, dtFixed);
      // How far did the w component move toward target?
      return Math.abs(out.w - start.w);
    }

    const changeLoMC = singleStepChange(0.1);
    const changeHiMC = singleStepChange(10.0);
    // Higher minCutoff → higher alpha → more change per step (less lag)
    expect(changeLoMC).toBeLessThan(changeHiMC);
  });

  it('higher beta produces more change per step when velocity is high', () => {
    // beta makes cutoff rise with velocity, reducing lag on fast moves
    const dtFixed = 1 / 60;
    const targetQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1.5, 0));

    function singleStepChange(beta: number): number {
      const f = new OneEuroFilterQuat(1.0, beta);
      const start = new THREE.Quaternion();
      f.filter(start, dtFixed);
      const out = f.filter(targetQ, dtFixed);
      return Math.abs(out.w - start.w);
    }

    const changeNoBeta = singleStepChange(0);
    const changeBeta = singleStepChange(5.0);
    expect(changeBeta).toBeGreaterThan(changeNoBeta);
  });

  it('reset() causes the next call to re-initialise (first-sample semantics)', () => {
    const f = new OneEuroFilterQuat();
    const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0, 0));
    const q2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.5, 0));
    f.filter(q1, 0.016);
    f.reset();
    // After reset the first sample should again be copied verbatim
    const out = f.filter(q2, 0.016);
    expect(out.x).toBeCloseTo(q2.x, 6);
    expect(out.y).toBeCloseTo(q2.y, 6);
    expect(out.z).toBeCloseTo(q2.z, 6);
    expect(out.w).toBeCloseTo(q2.w, 6);
  });

  it('handles the shortest-arc (dot<0) case without discontinuity', () => {
    const f = new OneEuroFilterQuat();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.9, 0));
    f.filter(q, 0.016); // initialise near q
    // Feed the antipodal quaternion (represents the same rotation, opposite sign)
    const qFlipped = new THREE.Quaternion(-q.x, -q.y, -q.z, -q.w);
    const out = f.filter(qFlipped, 0.016);
    // Output should stay close to q (not jump to the opposite hemisphere)
    const angleDiff = 2 * Math.acos(Math.min(1, Math.abs(out.dot(q))));
    expect(angleDiff).toBeLessThan(0.1); // < ~6°
  });
});

// ─── BoneFilterBank ───────────────────────────────────────────────────────────

describe('BoneFilterBank', () => {
  let bank: BoneFilterBank;

  beforeEach(() => {
    bank = new BoneFilterBank(1.0, 0.3);
  });

  it('lazily creates per-bone filters and initialises on first sample', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0, 0));
    const out = bank.filter('Head', q, 0.016);
    // First sample — must equal the input exactly
    expect(out.x).toBeCloseTo(q.x, 6);
    expect(out.y).toBeCloseTo(q.y, 6);
    expect(out.z).toBeCloseTo(q.z, 6);
    expect(out.w).toBeCloseTo(q.w, 6);
  });

  it('independent filters per bone name', () => {
    const qHead = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0, 0));
    const qSpine = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.5, 0));
    bank.filter('Head', qHead, 0.016);
    bank.filter('Spine', qSpine, 0.016);

    // Feed identity to both after initialisation — they should diverge correctly
    const identity = new THREE.Quaternion();
    const outHead = bank.filter('Head', identity, 0.016);
    const outSpine = bank.filter('Spine', identity, 0.016);

    // Head was tilted along X; Spine along Y — they were independently tracked
    // so after one step toward identity their filtered x and y should differ
    expect(Math.abs(outHead.x)).toBeGreaterThan(Math.abs(outHead.y));
    expect(Math.abs(outSpine.y)).toBeGreaterThan(Math.abs(outSpine.x));
  });

  it('reset() causes every bone filter to re-initialise', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.3, 0));
    bank.filter('Head', q, 0.016);
    bank.filter('Spine', q, 0.016);
    bank.reset();

    const qNew = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.9));
    const out = bank.filter('Head', qNew, 0.016);
    // Re-initialised, so output = qNew exactly
    expect(out.z).toBeCloseTo(qNew.z, 6);
    expect(out.w).toBeCloseTo(qNew.w, 6);
  });
});

// ─── calibration.ts — constants ───────────────────────────────────────────────

describe('DEFAULT_ARM_CALIB', () => {
  it('has scale=1 and zero offset', () => {
    expect(DEFAULT_ARM_CALIB.scale).toBe(1);
    expect(DEFAULT_ARM_CALIB.offset).toEqual([0, 0, 0]);
  });
});

describe('DEFAULT_CALIBRATION', () => {
  it('has empty bodyOffsets and identity arm calibs', () => {
    expect(DEFAULT_CALIBRATION.bodyOffsets).toEqual({});
    expect(DEFAULT_CALIBRATION.left.scale).toBe(1);
    expect(DEFAULT_CALIBRATION.right.scale).toBe(1);
  });
});

// ─── applyArmCalib ────────────────────────────────────────────────────────────

describe('applyArmCalib', () => {
  it('identity calibration (scale=1, offset=0) leaves position unchanged', () => {
    const wrist = new THREE.Vector3(2, 1, 0);
    const shoulder = new THREE.Vector3(0, 1, 0);
    const out = new THREE.Vector3();
    applyArmCalib(wrist, shoulder, { scale: 1, offset: [0, 0, 0] }, out);
    expect(out.x).toBeCloseTo(2, 6);
    expect(out.y).toBeCloseTo(1, 6);
    expect(out.z).toBeCloseTo(0, 6);
  });

  it('scale > 1 extends the reach proportionally', () => {
    // shoulder at origin, wrist at (1,0,0) — scale=2 should put result at (2,0,0)
    const wrist = new THREE.Vector3(1, 0, 0);
    const shoulder = new THREE.Vector3(0, 0, 0);
    const out = new THREE.Vector3();
    applyArmCalib(wrist, shoulder, { scale: 2, offset: [0, 0, 0] }, out);
    expect(out.x).toBeCloseTo(2, 6);
    expect(out.y).toBeCloseTo(0, 6);
  });

  it('scale < 1 compresses the reach', () => {
    const wrist = new THREE.Vector3(4, 0, 0);
    const shoulder = new THREE.Vector3(0, 0, 0);
    const out = new THREE.Vector3();
    applyArmCalib(wrist, shoulder, { scale: 0.5, offset: [0, 0, 0] }, out);
    expect(out.x).toBeCloseTo(2, 6);
  });

  it('offset translates the result after scaling', () => {
    const wrist = new THREE.Vector3(1, 0, 0);
    const shoulder = new THREE.Vector3(0, 0, 0);
    const out = new THREE.Vector3();
    applyArmCalib(wrist, shoulder, { scale: 1, offset: [0, 0.5, 0] }, out);
    expect(out.x).toBeCloseTo(1, 6);
    expect(out.y).toBeCloseTo(0.5, 6);
  });

  it('shoulder offset is preserved in the result', () => {
    // shoulder at (5,5,5), wrist at (6,5,5) → rel=(1,0,0)×scale + shoulder + offset
    const shoulder = new THREE.Vector3(5, 5, 5);
    const wrist = new THREE.Vector3(6, 5, 5);
    const out = new THREE.Vector3();
    applyArmCalib(wrist, shoulder, { scale: 2, offset: [0, 0, 0] }, out);
    // shoulder + 2*(1,0,0) = (7,5,5)
    expect(out.x).toBeCloseTo(7, 6);
    expect(out.y).toBeCloseTo(5, 6);
    expect(out.z).toBeCloseTo(5, 6);
  });
});

// ─── elbowAngleForReach ───────────────────────────────────────────────────────

describe('elbowAngleForReach', () => {
  const upper = 0.3;
  const lower = 0.3;

  it('fully extended arm gives normalised angle close to 0', () => {
    // reach ≈ upper+lower means arm is nearly straight → elbowAngle near 0
    const result = elbowAngleForReach(upper, lower, upper + lower - 0.001);
    expect(result).toBeCloseTo(0, 1);
  });

  it('very short reach (folded arm) gives normalised angle close to 1', () => {
    // reach ≈ |upper-lower| means arm is nearly fully bent → elbowAngle near 1
    const result = elbowAngleForReach(upper, lower, Math.abs(upper - lower) + 0.001);
    expect(result).toBeCloseTo(1, 1);
  });

  it('mid-range reach gives angle between 0 and 1', () => {
    // reach = sqrt(upper^2 + lower^2) → 90° elbow interior angle
    const reach = Math.sqrt(upper * upper + lower * lower);
    const result = elbowAngleForReach(upper, lower, reach);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
    // Interior angle at elbow is 90° → elbowAngle = 1 - 90/180 = 0.5
    expect(result).toBeCloseTo(0.5, 1);
  });

  it('clamps over-extended reach (reach > arm length)', () => {
    // reach much larger than arm — clamps to nearly straight (0)
    const result = elbowAngleForReach(upper, lower, 10);
    expect(result).toBeCloseTo(0, 1);
  });

  it('clamps under-extended reach (reach < min arm length)', () => {
    // reach near 0 — clamps to nearly fully bent (1)
    const result = elbowAngleForReach(upper, lower, 0);
    expect(result).toBeCloseTo(1, 1);
  });

  it('is monotonically decreasing: longer reach → smaller angle', () => {
    const reaches = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55];
    const angles = reaches.map((r) => elbowAngleForReach(upper, lower, r));
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i]).toBeLessThanOrEqual(angles[i - 1]);
    }
  });
});

// ─── fitArmCalib ─────────────────────────────────────────────────────────────

describe('fitArmCalib', () => {
  it('empty samples returns default calibration', () => {
    const result = fitArmCalib([]);
    expect(result.scale).toBe(1);
    expect(result.offset).toEqual([0, 0, 0]);
  });

  it('single sample where fkWrist === targetWrist → scale≈1, offset≈0', () => {
    const result = fitArmCalib([
      {
        fkWrist: [1, 0, 0],
        targetWrist: [1, 0, 0],
        shoulder: [0, 0, 0],
      },
    ]);
    expect(result.scale).toBeCloseTo(1, 4);
    expect(result.offset[0]).toBeCloseTo(0, 4);
    expect(result.offset[1]).toBeCloseTo(0, 4);
    expect(result.offset[2]).toBeCloseTo(0, 4);
  });

  it('target is exactly 2× the fk reach → scale fits to 2', () => {
    // fkRel = (1,0,0), tgtRel = (2,0,0) → scale = 2/1 = 2
    const result = fitArmCalib([
      {
        fkWrist: [1, 0, 0],
        targetWrist: [2, 0, 0],
        shoulder: [0, 0, 0],
      },
    ]);
    expect(result.scale).toBeCloseTo(2, 4);
    expect(result.offset[0]).toBeCloseTo(0, 4);
  });

  it('target is 0.5× the fk reach → scale fits to 0.5', () => {
    const result = fitArmCalib([
      {
        fkWrist: [2, 0, 0],
        targetWrist: [1, 0, 0],
        shoulder: [0, 0, 0],
      },
    ]);
    expect(result.scale).toBeCloseTo(0.5, 4);
  });

  it('residual offset after perfect scale fit is zero', () => {
    // Two samples: fkRel = (1,0,0) and (0,1,0); tgt = 2×fk — pure scaling
    const result = fitArmCalib([
      { fkWrist: [1, 0, 0], targetWrist: [2, 0, 0], shoulder: [0, 0, 0] },
      { fkWrist: [0, 1, 0], targetWrist: [0, 2, 0], shoulder: [0, 0, 0] },
    ]);
    expect(result.scale).toBeCloseTo(2, 4);
    expect(result.offset[0]).toBeCloseTo(0, 4);
    expect(result.offset[1]).toBeCloseTo(0, 4);
    expect(result.offset[2]).toBeCloseTo(0, 4);
  });

  it('pure offset (scale=1, residual shift) recovers offset', () => {
    // fkRel = (1,0,0), tgtRel = (1,0,0) + (0,0.5,0) → should fit offset
    const result = fitArmCalib([
      {
        fkWrist: [1, 0, 0],
        targetWrist: [1, 0.5, 0],
        shoulder: [0, 0, 0],
      },
    ]);
    // scale ~1 (numerator = 1, denominator = 1)
    expect(result.scale).toBeCloseTo(1, 4);
    // offset = tgtRel - scale*fkRel = (0, 0.5, 0)
    expect(result.offset[0]).toBeCloseTo(0, 4);
    expect(result.offset[1]).toBeCloseTo(0.5, 4);
    expect(result.offset[2]).toBeCloseTo(0, 4);
  });

  it('clamps scale to [0.1, 3] range', () => {
    // fkRel very small, tgtRel very large → unclamped scale >> 3
    const result = fitArmCalib([
      {
        fkWrist: [0.001, 0, 0],
        targetWrist: [100, 0, 0],
        shoulder: [0, 0, 0],
      },
    ]);
    expect(result.scale).toBeLessThanOrEqual(3);

    // fkRel large, tgtRel tiny → unclamped scale << 0.1
    const result2 = fitArmCalib([
      {
        fkWrist: [100, 0, 0],
        targetWrist: [0.001, 0, 0],
        shoulder: [0, 0, 0],
      },
    ]);
    expect(result2.scale).toBeGreaterThanOrEqual(0.1);
  });

  it('shoulder offset is factored out — calibration is shoulder-relative', () => {
    // Same geometry as the scale=2 test but with shoulder at (5,5,5)
    const result = fitArmCalib([
      {
        fkWrist: [6, 5, 5],    // fkRel = (1,0,0)
        targetWrist: [7, 5, 5], // tgtRel = (2,0,0)
        shoulder: [5, 5, 5],
      },
    ]);
    expect(result.scale).toBeCloseTo(2, 4);
    expect(result.offset[0]).toBeCloseTo(0, 4);
  });
});

// ─── upperArmNormRotFromTarget ────────────────────────────────────────────────

describe('upperArmNormRotFromTarget', () => {
  /**
   * Build a minimal THREE.Object3D tree: parent at origin with identity world
   * quaternion, upperArm as child also at origin.
   */
  function makeUpperArmBone(
    boneWorldPos: THREE.Vector3 = new THREE.Vector3(0, 0, 0)
  ): THREE.Object3D {
    const parent = new THREE.Object3D();
    const bone = new THREE.Object3D();
    parent.add(bone);
    // Place bone at world position by setting parent position
    parent.position.copy(boneWorldPos);
    parent.updateWorldMatrix(false, true);
    return bone;
  }

  it('returns a valid unit quaternion', () => {
    const bone = makeUpperArmBone();
    const target = new THREE.Vector3(1, 0, 0);
    const q = upperArmNormRotFromTarget(target, bone, false);
    const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    expect(len).toBeCloseTo(1, 5);
  });

  it('pointing left arm along rest direction (+X) returns near-identity rotation', () => {
    // Left arm rest dir is +X. If correctedWrist is at (1,0,0) from bone origin,
    // target dir == rest dir → rotation from rest to target should be identity.
    const bone = makeUpperArmBone(new THREE.Vector3(0, 0, 0));
    const correctedWrist = new THREE.Vector3(1, 0, 0);
    const q = upperArmNormRotFromTarget(correctedWrist, bone, false /* isRight = false */);
    // Identity quaternion: x=0, y=0, z=0, w=1 (±)
    expect(Math.abs(q.w)).toBeCloseTo(1, 4);
    expect(Math.abs(q.x)).toBeCloseTo(0, 4);
    expect(Math.abs(q.y)).toBeCloseTo(0, 4);
    expect(Math.abs(q.z)).toBeCloseTo(0, 4);
  });

  it('pointing right arm along rest direction (-X) returns near-identity rotation', () => {
    const bone = makeUpperArmBone(new THREE.Vector3(0, 0, 0));
    const correctedWrist = new THREE.Vector3(-1, 0, 0);
    const q = upperArmNormRotFromTarget(correctedWrist, bone, true /* isRight = true */);
    expect(Math.abs(q.w)).toBeCloseTo(1, 4);
    expect(Math.abs(q.x)).toBeCloseTo(0, 4);
    expect(Math.abs(q.y)).toBeCloseTo(0, 4);
    expect(Math.abs(q.z)).toBeCloseTo(0, 4);
  });

  it('returns a different quaternion for each target direction', () => {
    const bone = makeUpperArmBone();
    const q1 = upperArmNormRotFromTarget(new THREE.Vector3(1, 0, 0), bone, false);
    const q2 = upperArmNormRotFromTarget(new THREE.Vector3(0, 1, 0), bone, false);
    // They should not be the same rotation
    const dot = q1.dot(q2);
    expect(Math.abs(dot)).toBeLessThan(0.999);
  });
});
