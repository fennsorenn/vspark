/**
 * animBuffer.test.ts — the animation pose must live in a buffer nothing else
 * writes to.
 *
 * Regression cover for the "static pose shows the tracked pose" bug. The
 * composition step used to read its animation baseline off `bone.quaternion` —
 * the same field it writes its own output into. That aliasing is invisible while
 * the clip mixer overwrites the bones every frame, but `THREE.PropertyMixer` is
 * change-driven: it caches the value it last wrote and skips the write when the
 * interpolated value is unchanged, comparing against its own cache rather than
 * the bone. A clip whose playhead never moves (a static single-keyframe pose)
 * therefore stops writing after frame 1, and the baseline reads back the previous
 * frame's composed pose — so tracking compounds into the animation channel.
 *
 * These tests pin the three facts that make the shadow-skeleton fix necessary and
 * sufficient. They use plain three.js objects (no VRM, no R3F) so they run in
 * jsdom.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

const BONE = 'J_Bip_hips';

const buildSkeleton = () => {
  const root = new THREE.Object3D();
  const bone = new THREE.Bone();
  bone.name = BONE;
  root.add(bone);
  return { root, bone };
};

const poseQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, 0, 0));
const trackQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0.4, 0));

/** A static pose: one rotation keyframe, so the playhead is pinned at t=0. */
const staticPoseClip = () =>
  new THREE.AnimationClip('sitting', 0, [
    new THREE.QuaternionKeyframeTrack(
      `${BONE}.quaternion`,
      [0],
      [...poseQ.toArray()]
    ),
  ]);

/** A normal animation: the playhead advances, so the mixer writes every frame. */
const movingClip = () =>
  new THREE.AnimationClip('idle', 2, [
    new THREE.QuaternionKeyframeTrack(
      `${BONE}.quaternion`,
      [0, 1, 2],
      [
        ...poseQ.toArray(),
        ...new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0, 0)).toArray(),
        ...poseQ.toArray(),
      ]
    ),
  ]);

describe('PropertyMixer is change-driven (the underlying hazard)', () => {
  it('skips the write when the playhead has not moved', () => {
    const { root, bone } = buildSkeleton();
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(staticPoseClip());
    action.reset().play();

    action.time = 0;
    mixer.update(0);
    expect(bone.quaternion.angleTo(poseQ)).toBeLessThan(1e-3);

    // Something else stomps the bone (this is what the composition does).
    bone.quaternion.copy(trackQ);
    action.time = 0;
    mixer.update(0);

    // The mixer does NOT restore the clip pose: it compares against its own
    // cache, not the bone, so it believes nothing changed.
    expect(bone.quaternion.angleTo(trackQ)).toBeLessThan(1e-3);
  });

  it('does re-apply when the playhead moves (why long clips hid the bug)', () => {
    const { root, bone } = buildSkeleton();
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(movingClip());
    action.reset().play();

    action.time = 0;
    mixer.update(0);
    bone.quaternion.copy(trackQ);
    action.time = 0.5; // playhead advanced ⇒ interpolated value differs
    mixer.update(0);

    expect(bone.quaternion.angleTo(trackQ)).toBeGreaterThan(1e-2);
  });
});

describe('animation buffer must be separate from the composition output', () => {
  /**
   * Compose with Anim 1 / Track 0 — the user-reported test case. The result is
   * just the animation pose, so any tracking visible in the output means the
   * animation baseline was contaminated.
   */
  const runFrames = (mixerTarget: 'real' | 'shadow', frames = 5) => {
    const real = buildSkeleton();
    const shadow = buildSkeleton();
    const target = mixerTarget === 'real' ? real : shadow;
    const mixer = new THREE.AnimationMixer(target.root);
    const action = mixer.clipAction(staticPoseClip());
    action.reset().play();

    let correct = 0;
    for (let f = 0; f < frames; f++) {
      action.time = 0; // pinned: _anchoredTime returns 0 for a 1-key clip
      mixer.update(0);
      const animQ = target.bone.quaternion; // the baseline read
      const out = animQ.clone(); // Anim 1 / Track 0 ⇒ out = animQ
      real.bone.quaternion.copy(out); // flush to the real skeleton
      if (out.angleTo(poseQ) < 1e-3) correct++;
      // A tracking producer writes the real skeleton too.
      if (f === 0) real.bone.quaternion.copy(trackQ);
    }
    return correct;
  };

  it('mixer on the real skeleton loses the pose after frame 1 (the bug)', () => {
    expect(runFrames('real', 5)).toBe(1);
  });

  it('mixer on a shadow skeleton holds the pose every frame (the fix)', () => {
    expect(runFrames('shadow', 5)).toBe(5);
  });
});

describe('shadow hierarchy reproduces the real skeleton', () => {
  it('matches local and world rotations after identical local writes', () => {
    // Mirrors ShadowSkeleton's construction: same names, same parentage, rest
    // transforms copied. A mismatch here would silently skew every clip.
    const spec: Array<[string, string | null]> = [
      ['hips', null],
      ['spine', 'hips'],
      ['chest', 'spine'],
      ['leftUpperArm', 'chest'],
      ['leftLowerArm', 'leftUpperArm'],
    ];
    const realRoot = new THREE.Object3D();
    const real: Record<string, THREE.Bone> = {};
    for (const [n, p] of spec) {
      const b = new THREE.Bone();
      b.name = `J_Bip_${n}`;
      b.position.set(0.05, 0.15, 0.02);
      b.quaternion.setFromEuler(new THREE.Euler(0.1, 0.2, 0.3));
      real[n] = b;
      (p ? real[p] : realRoot).add(b);
    }

    const shadowRoot = new THREE.Object3D();
    const made: Record<string, THREE.Bone> = {};
    for (const [n] of spec) {
      const r = real[n];
      const b = new THREE.Bone();
      b.name = r.name;
      b.position.copy(r.position);
      b.quaternion.copy(r.quaternion);
      b.scale.copy(r.scale);
      made[n] = b;
    }
    for (const [n, p] of spec) (p ? made[p] : shadowRoot).add(made[n]);

    const rot = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.4, -0.2, 0.1)
    );
    for (const [n] of spec) {
      real[n].quaternion.multiply(rot);
      made[n].quaternion.multiply(rot);
    }
    realRoot.updateMatrixWorld(true);
    shadowRoot.updateMatrixWorld(true);

    for (const [n] of spec) {
      const a = new THREE.Quaternion();
      const b = new THREE.Quaternion();
      real[n].getWorldQuaternion(a);
      made[n].getWorldQuaternion(b);
      expect(a.angleTo(b)).toBeLessThan(1e-6);
      expect(real[n].quaternion.angleTo(made[n].quaternion)).toBeLessThan(1e-6);
    }
  });
});
