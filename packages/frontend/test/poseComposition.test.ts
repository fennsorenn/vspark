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
  SourceFade,
  composeBonePose,
  composeHipsPositionBlended,
  TrackedPoseLatch,
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

// ── Source fade state machine ─────────────────────────────────────────────────
describe('SourceFade', () => {
  it('starts settled with nothing showing', () => {
    const f = new SourceFade<'idle' | 'base'>();
    expect(f.fading).toBe(false);
    expect(f.to).toBeNull();
    expect(f.progress).toBe(1);
  });

  it('the first source appears instantly (nothing to fade from)', () => {
    const f = new SourceFade<'idle' | 'base'>();
    expect(f.retarget('idle')).toBe(false); // no freeze needed
    expect(f.fading).toBe(false);
    expect(f.to).toBe('idle');
  });

  it('a change to a different source starts a fade and asks for a freeze', () => {
    const f = new SourceFade<'idle' | 'base'>();
    f.retarget('idle');
    expect(f.retarget('base')).toBe(true); // caller should freeze `idle`
    expect(f.fading).toBe(true);
    expect(f.from).toBe('idle');
    expect(f.to).toBe('base');
    expect(f.progress).toBe(0);
  });

  it('retargeting to the source already targeted is a no-op', () => {
    const f = new SourceFade<'idle' | 'base'>();
    f.retarget('idle');
    expect(f.retarget('idle')).toBe(false);
    expect(f.fading).toBe(false);
  });

  it('advance walks progress to 1 then settles', () => {
    const f = new SourceFade<'idle' | 'base'>();
    f.retarget('idle');
    f.retarget('base');
    f.advance(0.25, 0.5);
    expect(f.progress).toBeCloseTo(0.5, 5);
    expect(f.fading).toBe(true);
    f.advance(0.25, 0.5);
    expect(f.progress).toBe(1);
    expect(f.fading).toBe(false);
    expect(f.from).toBeNull(); // settled: no outgoing side left
    expect(f.to).toBe('base');
  });

  it('a zero-length fade completes immediately', () => {
    const f = new SourceFade<'idle' | 'base'>();
    f.retarget('idle');
    f.retarget('base');
    f.advance(0.016, 0);
    expect(f.progress).toBe(1);
  });

  // Reversing mid-fade must not snap: the outgoing side becomes whatever was
  // being *shown*, so the new fade starts from the current blended pose.
  it('reversing mid-fade fades from the source that was showing', () => {
    const f = new SourceFade<'idle' | 'base'>();
    f.retarget('idle');
    f.retarget('base');
    f.advance(0.1, 0.5); // part-way idle→base
    expect(f.retarget('idle')).toBe(true);
    expect(f.from).toBe('base'); // was heading to base, so base is now outgoing
    expect(f.to).toBe('idle');
    expect(f.progress).toBe(0);
  });

  it('fading to null (source retired, nothing to replace it) is a fade-out', () => {
    const f = new SourceFade<'idle' | 'scheduled'>();
    f.retarget('scheduled');
    expect(f.retarget(null)).toBe(true);
    expect(f.from).toBe('scheduled');
    expect(f.to).toBeNull();
  });

  it('instant retarget skips the fade', () => {
    const f = new SourceFade<'idle' | 'base'>();
    f.retarget('idle');
    expect(f.retarget('base', true)).toBe(false);
    expect(f.fading).toBe(false);
    expect(f.to).toBe('base');
  });

  it('settle() abandons an in-flight fade', () => {
    const f = new SourceFade<'idle' | 'base'>();
    f.retarget('idle');
    f.retarget('base');
    f.settle();
    expect(f.fading).toBe(false);
    expect(f.from).toBeNull();
    expect(f.to).toBe('base');
  });
});

// ── Unified tracked/untracked composition ─────────────────────────────────────
//
// The whole point of `mode` is that there is no longer a discontinuity to tune
// away: mode=0 must equal the old untracked branch EXACTLY, mode=1 the old tracked
// one, and everything between must be continuous. These tests pin that.
describe('composeBonePose (mode blend)', () => {
  const rest = q(0.1, -0.2, 0.3);
  const anim = q(0.8, 0.1, 0);
  const tracked = q(-0.3, 0.2, 0.6);

  it('mode=0 is identical to the untracked branch (anim straight, no tracking)', () => {
    for (const lever of [0, 0.3, 0.7, 1]) {
      const unified = composeBonePose(rest, anim, tracked, lever, 1, 0);
      const oldUntracked = stackBoneRotation(rest, anim, null, 1, 0);
      expectQuatClose(unified, oldUntracked);
    }
  });

  it('mode=1 is identical to the tracked branch (levers + tracking applied)', () => {
    for (const lever of [0, 0.3, 0.7, 1]) {
      const unified = composeBonePose(rest, anim, tracked, lever, 0.6, 1);
      const oldTracked = stackBoneRotation(rest, anim, tracked, lever, 0.6);
      expectQuatClose(unified, oldTracked);
    }
  });

  // The reported bug: at the switchover the branches differed by exactly the
  // lever, so any section below Anim 1 jumped and sections at 1 did not.
  it('is continuous across mode for a lever that used to snap', () => {
    const lever = 0; // legs Anim 0 — the worst case (was a full-strength jump)
    let prev = composeBonePose(rest, anim, tracked, lever, 0, 0);
    let maxStep = 0;
    for (let i = 1; i <= 50; i++) {
      const cur = composeBonePose(rest, anim, tracked, lever, 0, i / 50);
      maxStep = Math.max(maxStep, prev.angleTo(cur));
      prev = cur;
    }
    // No single step may approach the old jump (~0.8 rad for this pose).
    expect(maxStep).toBeLessThan(0.05);
  });

  it('sections at Anim 1 are unaffected by mode when nothing is tracked', () => {
    const a = composeBonePose(rest, anim, null, 1, 0, 0);
    const b = composeBonePose(rest, anim, null, 1, 0, 1);
    expectQuatClose(a, b);
  });

  it('clamps mode outside 0..1', () => {
    expectQuatClose(
      composeBonePose(rest, anim, tracked, 0.5, 1, -3),
      composeBonePose(rest, anim, tracked, 0.5, 1, 0)
    );
    expectQuatClose(
      composeBonePose(rest, anim, tracked, 0.5, 1, 7),
      composeBonePose(rest, anim, tracked, 0.5, 1, 1)
    );
  });
});

describe('composeHipsPositionBlended', () => {
  const animPos = new THREE.Vector3(0, 1.2, 0.3);
  const restPos = new THREE.Vector3(0, 1.0, 0);

  it('mode=0 → full root motion whatever the legs lever says', () => {
    for (const lever of [0, 0.5, 1]) {
      const out = composeHipsPositionBlended(
        animPos,
        restPos,
        lever,
        true,
        0,
        new THREE.Vector3()
      );
      expect(out.equals(animPos)).toBe(true);
    }
  });

  it('mode=1 → the legs lever applies', () => {
    const out = composeHipsPositionBlended(
      animPos,
      restPos,
      0,
      true,
      1,
      new THREE.Vector3()
    );
    expect(out.equals(restPos)).toBe(true);
  });
});

// ── Fade-out with the tracking data removed mid-ramp ──────────────────────────
//
// The existing `composeBonePose (mode blend)` continuity test passes while the app
// still snapped on exit, because it walks modeWeight 1→0 with the tracked pose
// PRESENT the whole way. The real failure was in the data, not the math: the bus
// emits a final empty-bones frame, so `tracked` went null and `tw` went 0 in one
// frame while modeWeight was still ~1. These tests model that.
describe('TrackedPoseLatch', () => {
  const mkPose = (x: number) => ({
    hips: { rotation: [x, 0, 0, Math.sqrt(1 - x * x)] as [number, number, number, number] },
  });

  it('starts empty', () => {
    expect(new TrackedPoseLatch().active).toBe(false);
    expect(new TrackedPoseLatch().names()).toEqual([]);
  });

  it('holds the last populated pose', () => {
    const l = new TrackedPoseLatch();
    l.update(mkPose(0.3));
    expect(l.active).toBe(true);
    expect(l.names()).toEqual(['hips']);
    expect(l.get('hips')!.x).toBeCloseTo(0.3, 6);
  });

  it('ignores an empty pose — the bus fallback must not erase the latch', () => {
    const l = new TrackedPoseLatch();
    l.update(mkPose(0.3));
    l.update({}); // the fallback frame
    expect(l.active).toBe(true);
    expect(l.get('hips')!.x).toBeCloseTo(0.3, 6);
  });

  it('clear() releases it so it cannot leak into a later session', () => {
    const l = new TrackedPoseLatch();
    l.update(mkPose(0.3));
    l.clear();
    expect(l.active).toBe(false);
    expect(l.get('hips')).toBeNull();
  });
});

describe('fade-out stays continuous when the pose empties mid-ramp', () => {
  const rest = q(0.1, -0.2, 0.3);
  const anim = q(0.8, 0.1, 0);
  const tracked = q(-0.4, 0.3, 0.5);

  // Walk modeWeight 1 → 0. At the FIRST step the incoming pose goes empty (the bus
  // fallback). Without the latch the tracking term vanishes instantly; with it the
  // held pose keeps feeding the ramp.
  const walk = (useLatch: boolean) => {
    const latch = new TrackedPoseLatch();
    latch.update({
      hips: {
        rotation: [tracked.x, tracked.y, tracked.z, tracked.w] as [
          number,
          number,
          number,
          number,
        ],
      },
    });
    const steps = 40;
    let prev: THREE.Quaternion | null = null;
    let maxStep = 0;
    for (let i = 0; i <= steps; i++) {
      const m = 1 - i / steps;
      // Frame 0 is live; every frame after it the bus has sent empty bones.
      const posePopulated = i === 0;
      const trackedQ = posePopulated
        ? tracked
        : useLatch
          ? latch.get('hips')
          : null; // the bug: no tracking data at all
      const out = composeBonePose(rest, anim, trackedQ, 0, 1, m);
      if (prev) maxStep = Math.max(maxStep, prev.angleTo(out));
      prev = out.clone();
    }
    return maxStep;
  };

  it('without the latch the exit jumps (reproduces the reported snap)', () => {
    expect(walk(false)).toBeGreaterThan(0.2);
  });

  it('with the latch every step is small', () => {
    expect(walk(true)).toBeLessThan(0.05);
  });
});
