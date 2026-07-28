/**
 * poseComposition.test.ts — unit tests for the "tracking stacks on animation"
 * per-bone quaternion composition (stackBoneRotation).
 *
 * This is the un-verifiable-in-jsdom 3D math extracted into a pure function so
 * its corners can be pinned down without a live VRM.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  stackBoneRotation,
  composeHipsPosition,
  trackedComposeActive,
} from '../src/components/editor/poseComposition';

const q = (x: number, y: number, z: number) =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));

const expectQuatClose = (a: THREE.Quaternion, b: THREE.Quaternion) => {
  // Quaternions q and -q represent the same rotation; compare via angle.
  const angle = a.angleTo(b);
  expect(angle).toBeLessThan(1e-4);
};

describe('stackBoneRotation', () => {
  const rest = q(0.1, -0.2, 0.3);
  const anim = q(0.5, 0.4, -0.1);
  const tracked = q(-0.3, 0.2, 0.6);

  it('Anim=1, Track=0 → base animation only', () => {
    const out = stackBoneRotation(rest, anim, tracked, 1, 0);
    expectQuatClose(out, anim);
  });

  it('Anim=0, Track=1 → tracking only', () => {
    const out = stackBoneRotation(rest, anim, tracked, 0, 1);
    expectQuatClose(out, tracked);
  });

  it('Anim=0, Track=0 → rest', () => {
    const out = stackBoneRotation(rest, anim, tracked, 0, 0);
    expectQuatClose(out, rest);
  });

  it('untracked bone (trackedQ null) → scaled base animation, ignores Track', () => {
    const out = stackBoneRotation(rest, anim, null, 1, 1);
    expectQuatClose(out, anim);
    const half = stackBoneRotation(rest, anim, null, 0.5, 1);
    expectQuatClose(half, rest.clone().slerp(anim, 0.5));
  });

  it('Anim=1, Track=1 → base animation with the tracking delta stacked on top', () => {
    const out = stackBoneRotation(rest, anim, tracked, 1, 1);
    // Expected: anim · (rest⁻¹ · tracked)
    const delta = rest.clone().invert().multiply(tracked);
    const expected = anim.clone().multiply(delta);
    expectQuatClose(out, expected);
    // And it is NOT simply tracking (proves animation still contributes).
    expect(out.angleTo(tracked)).toBeGreaterThan(1e-3);
  });

  it('is monotonic in Track: larger Track moves further from pure animation', () => {
    const a0 = stackBoneRotation(rest, anim, tracked, 1, 0).angleTo(anim);
    const a5 = stackBoneRotation(rest, anim, tracked, 1, 0.5).angleTo(anim);
    const a10 = stackBoneRotation(rest, anim, tracked, 1, 1).angleTo(anim);
    expect(a5).toBeGreaterThan(a0);
    expect(a10).toBeGreaterThan(a5);
  });

  it('is monotonic in Anim: larger Anim moves further from rest (no tracking)', () => {
    const a0 = stackBoneRotation(rest, anim, null, 0, 0).angleTo(rest);
    const a5 = stackBoneRotation(rest, anim, null, 0.5, 0).angleTo(rest);
    const a10 = stackBoneRotation(rest, anim, null, 1, 0).angleTo(rest);
    expect(a5).toBeGreaterThan(a0);
    expect(a10).toBeGreaterThan(a5);
  });
});

describe('composeHipsPosition', () => {
  const anim = new THREE.Vector3(0, 1.2, 0.3); // hips lifted + shifted by the clip
  const rest = new THREE.Vector3(0, 1.0, 0); // bind-pose hips

  it('legsAnim=1 → full animated root motion', () => {
    const out = composeHipsPosition(anim, rest, 1, true, new THREE.Vector3());
    expect(out.equals(anim)).toBe(true);
  });

  it('legsAnim=0 → hips planted at rest (no translation)', () => {
    const out = composeHipsPosition(anim, rest, 0, true, new THREE.Vector3());
    expect(out.equals(rest)).toBe(true);
  });

  it('legsAnim=0.5 → halfway between rest and the animated position', () => {
    const out = composeHipsPosition(anim, rest, 0.5, true, new THREE.Vector3());
    expect(out.y).toBeCloseTo(1.1, 5);
    expect(out.z).toBeCloseTo(0.15, 5);
  });

  it('no active clip → rest regardless of legsAnim (no animated pos to honour)', () => {
    const out = composeHipsPosition(anim, rest, 1, false, new THREE.Vector3());
    expect(out.equals(rest)).toBe(true);
  });

  it('writes into (and returns) the out vector', () => {
    const out = new THREE.Vector3(99, 99, 99);
    const ret = composeHipsPosition(anim, rest, 1, true, out);
    expect(ret).toBe(out);
    expect(out.equals(anim)).toBe(true);
  });
});

// ── Untracked idle contract ───────────────────────────────────────────────────
//
// Spec: with no tracking signal (or no enabled tracking source), the idle plays
// **straight** — never routed through the partial-tracking levers. The Viewport's
// untracked branch encodes that as animInf=1 / trackWeight=0, so these pin the
// values that branch relies on. Regression guard: the branch previously passed
// the section's Anim weight here, which drooped the idle toward rest (and erased
// it entirely at Anim=0) whenever a lever was off-default.
describe('untracked idle plays straight (animInf=1, trackWeight=0)', () => {
  const rest = q(0.1, -0.2, 0.3);
  const idle = q(0.5, 0.4, -0.1);

  it('returns the idle pose exactly, whatever the levers would have said', () => {
    const out = stackBoneRotation(rest, idle, null, 1, 0);
    expectQuatClose(out, idle);
  });

  it('a null tracked pose contributes nothing even at full track weight', () => {
    const out = stackBoneRotation(rest, idle, null, 1, 1);
    expectQuatClose(out, idle);
  });

  it('scaling anim (the old behaviour) does NOT equal the idle — the bug', () => {
    const drooped = stackBoneRotation(rest, idle, null, 0.5, 0);
    expect(drooped.angleTo(idle)).toBeGreaterThan(1e-3);
    // Anim=0 erased the idle back to rest entirely.
    const erased = stackBoneRotation(rest, idle, null, 0, 0);
    expectQuatClose(erased, rest);
  });

  it('an ambient pose on the bus does not select the weighted path', () => {
    // Breathing publishes additively and forever, so poseActive stays true after
    // tracking drops. Selecting on pose presence alone kept the weighted tracked
    // path running permanently and made a straight idle unreachable — the
    // originally-reported "idle still goes through the weights".
    expect(trackedComposeActive(false, true)).toBe(false);
  });

  it('selects the weighted path only when tracking is live', () => {
    expect(trackedComposeActive(true, true)).toBe(true);
    expect(trackedComposeActive(true, false)).toBe(false);
    expect(trackedComposeActive(false, false)).toBe(false);
  });

  it('hips root motion plays at full strength (legsAnim=1)', () => {
    const animPos = new THREE.Vector3(0, 1.2, 0.3);
    const restPos = new THREE.Vector3(0, 1.0, 0);
    const out = composeHipsPosition(
      animPos,
      restPos,
      1,
      true,
      new THREE.Vector3()
    );
    expect(out.equals(animPos)).toBe(true);
  });
});
