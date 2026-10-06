/**
 * nodes.mocap.landmarks.test.ts
 *
 * Geometry tests for the MediaPipe converters (pose_arms_to_bones, pose_torso_head_to_bones,
 * hand_landmarks_to_bones) and the body_calibration child-preserve option.
 *
 * The fixtures in test/fixtures/mediapipe are real MediaPipe output on MediaPipe's own test
 * images, mirrored exactly as CameraCapture mirrors the webcam. They pin the conventions the
 * converters depend on (axis signs, handedness, which way the palm normal points) to what
 * MediaPipe actually produces rather than to what the code assumes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Quaternion, NormalizedPose } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { pullValue } from './helpers/nodeHarness.js';
import { torsoWorldQuat } from '../src/signal/mocap_torso.js';

type L = { x: number; y: number; z: number; visibility?: number };
type V3 = [number, number, number];

let consoleMocks: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  consoleMocks = [vi.spyOn(console, 'log').mockImplementation(() => {})];
});
afterEach(() => consoleMocks.forEach((m) => m.mockRestore()));

const FIX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/mediapipe'
);
const load = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

// ── small vector helpers ─────────────────────────────────────────────────────
const sub = (a: L, b: L): V3 => [a.x - b.x, a.y - b.y, a.z - b.z];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
/** MediaPipe (+Y down, +Z away from camera) → avatar frame (+Y up, +Z toward camera). */
const flipYZ = (v: V3): V3 => [v[0], -v[1], -v[2]];
const rotate = (q: Quaternion, v: V3): V3 => {
  const p = q
    .multiply(new Quaternion(v[0], v[1], v[2], 0))
    .multiply(q.invert());
  return [p.x, p.y, p.z];
};
const angleDeg = (a: V3, b: V3): number => {
  const [x, y] = [norm(a), norm(b)];
  const d = Math.max(-1, Math.min(1, x[0] * y[0] + x[1] * y[1] + x[2] * y[2]));
  return (Math.acos(d) * 180) / Math.PI;
};
const quatAngleDeg = (q: Quaternion): number =>
  (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;
const bone = (pose: NormalizedPose, name: string): Quaternion =>
  pose.get(name as VRMBoneName) ?? Quaternion.IDENTITY;
const axisAngle = (axis: V3, a: number): Quaternion => {
  const n = norm(axis);
  const s = Math.sin(a / 2);
  return new Quaternion(n[0] * s, n[1] * s, n[2] * s, Math.cos(a / 2));
};

// ─────────────────────────────────────────────────────────────────────────────
// pose_arms_to_bones — wrist orientation on real Holistic output
// ─────────────────────────────────────────────────────────────────────────────

describe('pose_arms_to_bones on real Holistic landmarks', () => {
  const fx = load('holistic_hands.json');
  const P: L[] = fx.pose;
  const avatar = (p: L): L => ({
    x: p.x,
    y: -p.y,
    z: -p.z,
    visibility: p.visibility,
  });
  const torso = torsoWorldQuat(
    avatar(P[11]),
    avatar(P[12]),
    avatar(P[23]),
    avatar(P[24])
  );

  /** World orientation of the solved hand bone (chest · clavicle · upper · lower · hand). */
  function handWorld(out: NormalizedPose, side: 'left' | 'right'): Quaternion {
    return torso
      .multiply(bone(out, `${side}Shoulder`))
      .multiply(bone(out, `${side}UpperArm`))
      .multiply(bone(out, `${side}LowerArm`))
      .multiply(bone(out, `${side}Hand`));
  }

  /** Observed hand frame in the avatar frame: finger direction + back-of-hand normal. */
  function observed(hand: L[], side: 'left' | 'right') {
    const fingers = flipYZ(norm(sub(hand[9], hand[0])));
    // cross(wrist→index MCP, wrist→pinky MCP) is the back-of-hand normal on the left and the
    // palm normal on the right (established from hands whose facing is unambiguous in 2D).
    const n = flipYZ(
      norm(cross(sub(hand[5], hand[0]), sub(hand[17], hand[0])))
    );
    return { fingers, dorsal: side === 'left' ? n : neg(n) };
  }

  for (const [kind, maxErr] of [
    ['World', 30],
    ['Image', 40],
  ] as const) {
    it(`points the avatar's hand where the real hand points (${kind.toLowerCase()} hand landmarks)`, () => {
      const out = pullValue('pose_arms_to_bones', 'pose', {
        pose: P,
        leftHand: fx[`leftHand${kind}`],
        rightHand: fx[`rightHand${kind}`],
      }) as NormalizedPose;
      for (const side of ['left', 'right'] as const) {
        const hw = handWorld(out, side);
        const rest: V3 = side === 'left' ? [1, 0, 0] : [-1, 0, 0];
        const obs = observed(fx[`${side}HandWorld`], side);
        // Bounds leave room for the deliberate wrist-swing amplification (WRIST_SWING_GAIN).
        // Before the hand landmarks were put into the arm's frame these errors were 90–170°.
        expect(angleDeg(rotate(hw, rest), obs.fingers)).toBeLessThan(maxErr);
        expect(angleDeg(rotate(hw, [0, 1, 0]), obs.dorsal)).toBeLessThan(
          maxErr
        );
      }
    });
  }

  it('keeps the forearm on the elbow→wrist line while rolling it to the hand', () => {
    const out = pullValue('pose_arms_to_bones', 'pose', {
      pose: P,
      leftHand: fx.leftHandWorld,
      rightHand: fx.rightHandWorld,
    }) as NormalizedPose;
    for (const [side, e, w] of [
      ['left', 13, 15],
      ['right', 14, 16],
    ] as const) {
      const fw = torso
        .multiply(bone(out, `${side}Shoulder`))
        .multiply(bone(out, `${side}UpperArm`))
        .multiply(bone(out, `${side}LowerArm`));
      const rest: V3 = side === 'left' ? [1, 0, 0] : [-1, 0, 0];
      expect(angleDeg(rotate(fw, rest), flipYZ(sub(P[w], P[e])))).toBeLessThan(
        0.5
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Arms hang off the chest the torso node actually writes
// ─────────────────────────────────────────────────────────────────────────────

describe('pose_arms_to_bones + pose_torso_head_to_bones agreement', () => {
  /** Upright body turned `yaw` about the vertical, arms reaching forward-down (MediaPipe frame). */
  function turnedPose(yaw: number): L[] {
    const pts: L[] = Array.from({ length: 33 }, () => ({
      x: 0,
      y: 0,
      z: 0,
      visibility: 1,
    }));
    // Avatar-frame positions (+Y up, +Z toward camera), converted to MediaPipe at the end.
    const body: Record<number, V3> = {
      2: [0.03, 0.62, 0.08], // eyes
      5: [-0.03, 0.62, 0.08],
      11: [0.18, 0.5, 0], // shoulders
      12: [-0.18, 0.5, 0],
      13: [0.3, 0.3, 0.15], // elbows
      14: [-0.28, 0.25, 0.12],
      15: [0.25, 0.15, 0.38], // wrists
      16: [-0.2, 0.1, 0.35],
      23: [0.1, 0, 0], // hips
      24: [-0.1, 0, 0],
    };
    const turn = axisAngle([0, 1, 0], yaw);
    for (const [i, v] of Object.entries(body)) {
      const r = rotate(turn, v);
      pts[Number(i)] = { x: r[0], y: -r[1], z: -r[2], visibility: 1 };
    }
    return pts;
  }

  it('upper and lower arms point along the landmarks once applied under the solved chest', () => {
    for (const yaw of [0, 0.5, -0.7]) {
      const pose = turnedPose(yaw);
      const torsoOut = pullValue('pose_torso_head_to_bones', 'pose', {
        pose,
      }) as NormalizedPose;
      const armsOut = pullValue('pose_arms_to_bones', 'pose', {
        pose,
      }) as NormalizedPose;
      // hips stay identity; chest world = spine · chest.
      const chest = bone(torsoOut, 'hips')
        .multiply(bone(torsoOut, 'spine'))
        .multiply(bone(torsoOut, 'chest'));
      const a = (i: number): L => ({
        x: pose[i].x,
        y: -pose[i].y,
        z: -pose[i].z,
      });
      for (const [side, s, e, w] of [
        ['left', 11, 13, 15],
        ['right', 12, 14, 16],
      ] as const) {
        const rest: V3 = side === 'left' ? [1, 0, 0] : [-1, 0, 0];
        const upper = chest
          .multiply(bone(armsOut, `${side}Shoulder`))
          .multiply(bone(armsOut, `${side}UpperArm`));
        const lower = upper.multiply(bone(armsOut, `${side}LowerArm`));
        // Before the arms shared the torso's yaw damping this was off by ~30% of the body turn.
        expect(angleDeg(rotate(upper, rest), sub(a(e), a(s)))).toBeLessThan(
          0.5
        );
        expect(angleDeg(rotate(lower, rest), sub(a(w), a(e)))).toBeLessThan(
          0.5
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// body_calibration — preserveChildren
// ─────────────────────────────────────────────────────────────────────────────

describe('body_calibration preserveChildren', () => {
  const shoulderIn = axisAngle([0, 0, 1], 0.3);
  const armIn = axisAngle([0.2, 0.5, 1], 0.9);
  const pose = new NormalizedPose([
    ['leftShoulder', shoulderIn],
    ['leftUpperArm', armIn],
  ]);
  const offsets = { leftShoulder: axisAngle([0, 0, 1], 0.2).toArray() };

  function calibrated(preserve: boolean): NormalizedPose {
    return pullValue(
      'body_calibration',
      'pose',
      {
        pose,
        boneFilter: ['leftShoulder'],
        ...(preserve
          ? {
              preserveChildren: [
                { bone: 'leftUpperArm', parents: ['leftShoulder'] },
              ],
            }
          : {}),
      },
      { bodyOffsets: offsets }
    ) as NormalizedPose;
  }

  it('keeps parent · child unchanged while the parent is corrected', () => {
    const out = calibrated(true);
    expect(quatAngleDeg(bone(out, 'leftShoulder'))).toBeCloseTo(
      (0.1 * 180) / Math.PI,
      3
    );
    const before = shoulderIn.multiply(armIn);
    const after = bone(out, 'leftShoulder').multiply(bone(out, 'leftUpperArm'));
    expect(quatAngleDeg(after.invert().multiply(before))).toBeLessThan(1e-3);
  });

  it('without it, the child follows the parent correction', () => {
    const out = calibrated(false);
    const before = shoulderIn.multiply(armIn);
    const after = bone(out, 'leftShoulder').multiply(bone(out, 'leftUpperArm'));
    expect(quatAngleDeg(after.invert().multiply(before))).toBeCloseTo(
      (0.2 * 180) / Math.PI,
      3
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hand_landmarks_to_bones — real gestures
// ─────────────────────────────────────────────────────────────────────────────

describe('hand_landmarks_to_bones on real hand landmarks', () => {
  const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
  const SEGS = ['Proximal', 'Intermediate', 'Distal'] as const;
  const solve = (lm: L[], side: 'left' | 'right' = 'left') =>
    pullValue('hand_landmarks_to_bones', 'pose', {
      landmarks: lm,
      side,
    }) as NormalizedPose;
  const deg = (p: NormalizedPose, name: string) => quatAngleDeg(bone(p, name));
  const curl = (p: NormalizedPose, f: string) =>
    deg(p, `left${f}Proximal`) + deg(p, `left${f}Intermediate`);

  it('curls every finger and the thumb in a fist', () => {
    const p = solve(load('hand_fist.json').world);
    for (const f of FINGERS) expect(curl(p, f)).toBeGreaterThan(100);
    expect(
      deg(p, 'leftThumbProximal') + deg(p, 'leftThumbDistal')
    ).toBeGreaterThan(60);
  });

  it('keeps only the index straight when pointing', () => {
    const p = solve(load('hand_point.json').world);
    for (const s of SEGS) expect(deg(p, `leftIndex${s}`)).toBeLessThan(30);
    for (const f of ['Middle', 'Ring', 'Little'])
      expect(curl(p, f)).toBeGreaterThan(100);
  });

  it('keeps index and middle straight for a victory sign', () => {
    const p = solve(load('hand_victory.json').world);
    for (const f of ['Index', 'Middle'])
      for (const s of SEGS) expect(deg(p, `left${f}${s}`)).toBeLessThan(40);
    for (const f of ['Ring', 'Little']) expect(curl(p, f)).toBeGreaterThan(100);
  });

  it('curls toward the palm, not backward', () => {
    // Rotation axis of a curl is the hinge rest × palm = (+X) × (−Y) = −Z for the left hand.
    const p = solve(load('hand_fist.json').world);
    for (const f of FINGERS) {
      const q = bone(p, `left${f}Intermediate`);
      expect(-q.z * Math.sign(q.w)).toBeGreaterThan(0.3);
    }
  });

  it('reads an open, relaxed hand as far less curled than a fist', () => {
    // A relaxed hand keeps some natural bend, so this only asserts the gap to the fist (> 100°).
    const fx = load('holistic_hands.json');
    const p = solve(fx.rightHandWorld, 'right');
    for (const f of FINGERS)
      expect(
        deg(p, `right${f}Proximal`) + deg(p, `right${f}Intermediate`)
      ).toBeLessThan(70);
  });

  it('is unaffected by where the hand is pointing', () => {
    const lm: L[] = load('hand_fist.json').world;
    const turn = axisAngle([0.3, -0.8, 0.5], 1.7);
    const turned = lm.map((p) => {
      const r = rotate(turn, [p.x, p.y, p.z]);
      return { x: r[0], y: r[1], z: r[2] };
    });
    const a = solve(lm);
    const b = solve(turned);
    for (const [name, q] of a.entries())
      expect(quatAngleDeg(q.invert().multiply(bone(b, name)))).toBeLessThan(
        1e-3
      );
  });
});
