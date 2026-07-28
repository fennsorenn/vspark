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
  crossfadeAnimPose,
  crossfadeHipsPosition,
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

// ── Animation-source cross-fade ───────────────────────────────────────────────
//
// Blending between animation sources (idle ⇄ base ⇄ scheduled) happens BEFORE
// tracking is stacked: the result is what stackBoneRotation receives as animQ.
// Each source lives in its own buffer (a ClipSlot's shadow skeleton), which is
// what makes reading two of them in the same frame possible at all.
describe('crossfadeAnimPose', () => {
  const rest = q(0.1, -0.2, 0.3);
  const from = q(0.5, 0.4, -0.1);
  const to = q(-0.3, 0.2, 0.6);

  it('t=0 is fully the outgoing pose, t=1 fully the incoming', () => {
    expectQuatClose(crossfadeAnimPose(rest, from, to, 0), from);
    expectQuatClose(crossfadeAnimPose(rest, from, to, 1), to);
  });

  it('t=0.5 lands between the two', () => {
    const mid = crossfadeAnimPose(rest, from, to, 0.5);
    expect(mid.angleTo(from)).toBeGreaterThan(1e-3);
    expect(mid.angleTo(to)).toBeGreaterThan(1e-3);
    // Equidistant along the arc.
    expect(Math.abs(mid.angleTo(from) - mid.angleTo(to))).toBeLessThan(1e-3);
  });

  it('clamps t outside 0..1', () => {
    expectQuatClose(crossfadeAnimPose(rest, from, to, -5), from);
    expectQuatClose(crossfadeAnimPose(rest, from, to, 5), to);
  });

  // A null side means "this source contributes nothing", so a fade in/out runs
  // against rest rather than needing a synthetic pose.
  it('fades in from rest when there is no outgoing source', () => {
    expectQuatClose(crossfadeAnimPose(rest, null, to, 0), rest);
    expectQuatClose(crossfadeAnimPose(rest, null, to, 1), to);
  });

  it('fades out to rest when there is no incoming source', () => {
    expectQuatClose(crossfadeAnimPose(rest, from, null, 0), from);
    expectQuatClose(crossfadeAnimPose(rest, from, null, 1), rest);
  });

  it('both sides absent → rest', () => {
    expectQuatClose(crossfadeAnimPose(rest, null, null, 0.5), rest);
  });
});

describe('crossfadeHipsPosition', () => {
  const restPos = new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3(0, 1.2, 0.3);
  const b = new THREE.Vector3(0, 0.7, -0.2);

  it('interpolates between two root motions', () => {
    expect(
      crossfadeHipsPosition(restPos, a, b, 0, new THREE.Vector3()).equals(a)
    ).toBe(true);
    expect(
      crossfadeHipsPosition(restPos, a, b, 1, new THREE.Vector3()).equals(b)
    ).toBe(true);
    const mid = crossfadeHipsPosition(restPos, a, b, 0.5, new THREE.Vector3());
    expect(mid.y).toBeCloseTo(0.95, 5);
  });

  it('a missing side means rest, not the origin', () => {
    const out = crossfadeHipsPosition(restPos, null, b, 0, new THREE.Vector3());
    expect(out.equals(restPos)).toBe(true);
    const out2 = crossfadeHipsPosition(restPos, a, null, 1, new THREE.Vector3());
    expect(out2.equals(restPos)).toBe(true);
  });
});
