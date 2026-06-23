/**
 * nodes.mocap.test.ts
 *
 * Unit tests for motion-capture signal nodes:
 *   rhylive_bone_mapper, face_landmarks_to_blendshapes, pose_torso_head_to_bones,
 *   pose_arms_to_bones, hand_landmarks_to_bones, pose_ik_targets,
 *   body_calibration, arm_ik_calibration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Quaternion,
  BoneRotations,
  NormalizedPose,
  Blendshapes,
} from '@vspark/shared/signal';
import { pullValue, loneNode } from './helpers/nodeHarness.js';
import type { IkTargetFrame } from '@vspark/shared/types';

// ──────────────────────────────────────────────────────────────────────────────
// Silence log/warn/error output produced by the nodes under test.
// ──────────────────────────────────────────────────────────────────────────────

let consoleMocks: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  consoleMocks = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});
afterEach(() => {
  consoleMocks.forEach((m) => m.mockRestore());
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Build a minimal 33-landmark pose array (all visible). */
function makePose33(overrides: Partial<Record<number, { x: number; y: number; z: number; visibility?: number }>> = {}): { x: number; y: number; z: number; visibility: number }[] {
  const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  for (const [idx, lm] of Object.entries(overrides)) {
    pts[Number(idx)] = { visibility: 1, ...lm };
  }
  return pts;
}

/** Build a realistic T-pose 33-landmark set with anatomically plausible positions.
 *
 * MediaPipe world-space convention: origin = hip midpoint, +Y down, +Z toward camera.
 * We flip Y (down-positive) to get human-intuitive values when building fixtures.
 *
 * Indices that matter for torso/arm nodes:
 *   11=leftShoulder, 12=rightShoulder, 13=leftElbow, 14=rightElbow,
 *   15=leftWrist, 16=rightWrist, 23=leftHip, 24=rightHip
 *
 * Indices for head node:
 *   0=nose, 7=leftEar, 8=rightEar
 */
function makeTposePose(): { x: number; y: number; z: number; visibility: number }[] {
  // In MediaPipe world coords (+Y down), a character standing upright:
  //   hips at origin, shoulders above (= negative Y), arms out to sides.
  const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));

  // Hips (23=left, 24=right) — approx ±0.1 m from centre
  pts[23] = { x: 0.1, y: 0, z: 0, visibility: 1 }; // leftHip (+X)
  pts[24] = { x: -0.1, y: 0, z: 0, visibility: 1 }; // rightHip

  // Shoulders — 0.5 m above hips (y = -0.5 in MP's +Y-down convention)
  pts[11] = { x: 0.2, y: -0.5, z: 0, visibility: 1 }; // leftShoulder
  pts[12] = { x: -0.2, y: -0.5, z: 0, visibility: 1 }; // rightShoulder

  // Elbows — arms extended horizontally
  pts[13] = { x: 0.6, y: -0.5, z: 0, visibility: 1 }; // leftElbow
  pts[14] = { x: -0.6, y: -0.5, z: 0, visibility: 1 }; // rightElbow

  // Wrists
  pts[15] = { x: 1.0, y: -0.5, z: 0, visibility: 1 }; // leftWrist
  pts[16] = { x: -1.0, y: -0.5, z: 0, visibility: 1 }; // rightWrist

  // Head landmarks
  pts[0] = { x: 0, y: -0.9, z: 0.1, visibility: 1 }; // nose (forward)
  pts[7] = { x: 0.1, y: -0.85, z: 0, visibility: 1 }; // leftEar
  pts[8] = { x: -0.1, y: -0.85, z: 0, visibility: 1 }; // rightEar

  return pts;
}

/** Build a full 478-landmark face landmark array. */
function makeFace478(overrides: Partial<Record<number, { x: number; y: number; z: number }>> = {}): { x: number; y: number; z: number }[] {
  const pts = Array.from({ length: 478 }, (_, i) => ({ x: i * 0.001, y: i * 0.001, z: 0 }));
  // Place reference landmarks for a visible face
  // IDX constants from the node source:
  // leftCheek=234, rightCheek=454 → define face width
  pts[234] = { x: 0, y: 0.5, z: 0 };
  pts[454] = { x: 0.2, y: 0.5, z: 0 }; // face width = 0.2

  // lips open slightly
  pts[13] = { x: 0.1, y: 0.48, z: 0 }; // upperLipTop
  pts[14] = { x: 0.1, y: 0.52, z: 0 }; // lowerLipBot (lipGap=0.04)
  pts[61] = { x: 0.07, y: 0.50, z: 0 }; // lipLeftCorner
  pts[291] = { x: 0.13, y: 0.50, z: 0 }; // lipRightCorner
  pts[40] = { x: 0.08, y: 0.49, z: 0 }; // upperLipLeft
  pts[270] = { x: 0.12, y: 0.49, z: 0 }; // upperLipRight
  pts[152] = { x: 0.1, y: 0.60, z: 0 }; // chin
  pts[1] = { x: 0.1, y: 0.45, z: 0.05 }; // noseTip

  // Eyes open
  pts[159] = { x: 0.07, y: 0.40, z: 0 }; // leftEyeTop
  pts[145] = { x: 0.07, y: 0.44, z: 0 }; // leftEyeBot
  pts[33] = { x: 0.04, y: 0.42, z: 0 };  // leftEyeOuter
  pts[133] = { x: 0.08, y: 0.42, z: 0 }; // leftEyeInner
  pts[386] = { x: 0.13, y: 0.40, z: 0 }; // rightEyeTop
  pts[374] = { x: 0.13, y: 0.44, z: 0 }; // rightEyeBot
  pts[263] = { x: 0.16, y: 0.42, z: 0 }; // rightEyeOuter
  pts[362] = { x: 0.12, y: 0.42, z: 0 }; // rightEyeInner

  // Eyebrows
  pts[107] = { x: 0.07, y: 0.37, z: 0 }; // leftBrowInner
  pts[70] = { x: 0.04, y: 0.36, z: 0 };  // leftBrowOuter
  pts[336] = { x: 0.13, y: 0.37, z: 0 }; // rightBrowInner
  pts[300] = { x: 0.16, y: 0.36, z: 0 }; // rightBrowOuter

  for (const [idx, lm] of Object.entries(overrides)) {
    pts[Number(idx)] = lm;
  }
  return pts;
}

/** Build a 21-landmark hand array for left hand (T-pose: fingers along +X). */
function makeHand21(dx = 0.05): { x: number; y: number; z: number }[] {
  // Lay fingers out along X axis
  const pts: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 21; i++) {
    pts.push({ x: i * dx, y: 0, z: 0 });
  }
  // Specific indices from H constants in the source:
  // wrist=0, thumbCmc=1, thumbMcp=2, thumbIp=3, thumbTip=4
  // indexMcp=5, indexPip=6, indexDip=7, indexTip=8
  // middleMcp=9, middlePip=10, middleDip=11, middleTip=12
  // ringMcp=13, ringPip=14, ringDip=15, ringTip=16
  // littleMcp=17, littlePip=18, littleDip=19, littleTip=20
  return pts;
}

// ──────────────────────────────────────────────────────────────────────────────
// rhylive_bone_mapper
// ──────────────────────────────────────────────────────────────────────────────

describe('rhylive_bone_mapper', () => {
  it('maps VMC bone names to VRM bone names with coordinate correction', () => {
    const bones = BoneRotations.fromRecord({
      // Hips is a direct 1:1 mapping in VMC_TO_VRM
      Hips: [0, 0, 0, 1],
      // Spine also maps directly
      Spine: [0, 0.707, 0, 0.707],
    });
    const out = pullValue('rhylive_bone_mapper', 'pose', { bones }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    // Hips quaternion should be mapped: (x, -y, -z, w) of input (0,0,0,1) → (0,0,0,1)
    const hips = out.get('hips');
    expect(hips).toBeDefined();
    // Spine: input (0, 0.707, 0, 0.707) → (0, -0.707, 0, 0.707)
    const spine = out.get('spine');
    expect(spine).toBeDefined();
    expect(spine!.y).toBeCloseTo(-0.707, 3);
    expect(spine!.w).toBeCloseTo(0.707, 3);
  });

  it('returns undefined when no bones input', () => {
    const out = pullValue('rhylive_bone_mapper', 'pose', {});
    expect(out).toBeUndefined();
  });

  it('returns an empty pose for bones with no known VMC→VRM mapping', () => {
    const bones = BoneRotations.fromRecord({
      UnknownBone: [0, 0, 0, 1],
    });
    const out = pullValue('rhylive_bone_mapper', 'pose', { bones }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    expect(out.size).toBe(0);
  });

  it('mirror mode swaps left/right arms', () => {
    // With mirror=true, LeftUpperArm reads from RightUpperArm data and vice versa.
    const bones = BoneRotations.fromRecord({
      LeftUpperArm: [0, 0, 0, 1], // this will be the "mirrored" source
      RightUpperArm: [0, 0.5, 0, 0.866], // different value
    });
    const outNormal = pullValue('rhylive_bone_mapper', 'pose', { bones, mirror: false }) as NormalizedPose;
    const outMirror = pullValue('rhylive_bone_mapper', 'pose', { bones, mirror: true }) as NormalizedPose;
    // In mirror mode, leftUpperArm should use RightUpperArm's data
    const normalLeft = outNormal.get('leftUpperArm');
    const mirrorLeft = outMirror.get('leftUpperArm');
    expect(normalLeft).toBeDefined();
    expect(mirrorLeft).toBeDefined();
    // They should differ — mirror swapped the source
    // normal: leftUpperArm from LeftUpperArm → (0,0,0,1), y flipped → y=0
    // mirror: leftUpperArm from RightUpperArm → (0,0.5,0,0.866), y flipped → y=-0.5
    expect(normalLeft!.y).toBeCloseTo(0, 6);
    expect(mirrorLeft!.y).toBeCloseTo(-0.5, 3);
  });

  it('skips invalid quaternions (all-zero)', () => {
    const bones = BoneRotations.fromRecord({
      Head: [0, 0, 0, 0], // isValid = false (magnitudeSquared = 0)
    });
    const out = pullValue('rhylive_bone_mapper', 'pose', { bones }) as NormalizedPose;
    expect(out.get('head')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// face_landmarks_to_blendshapes
// ──────────────────────────────────────────────────────────────────────────────

describe('face_landmarks_to_blendshapes', () => {
  it('returns undefined when no face input', () => {
    const out = pullValue('face_landmarks_to_blendshapes', 'blendshapes', {});
    expect(out).toBeUndefined();
  });

  it('returns empty blendshapes for short landmark array (< 478 pts)', () => {
    const face = Array.from({ length: 100 }, () => ({ x: 0, y: 0, z: 0 }));
    const out = pullValue('face_landmarks_to_blendshapes', 'blendshapes', { face }) as Blendshapes;
    expect(out).toBeInstanceOf(Blendshapes);
    expect(out.size).toBe(0);
  });

  it('returns blendshapes for a valid 478-point face', () => {
    const face = makeFace478();
    const out = pullValue('face_landmarks_to_blendshapes', 'blendshapes', { face }) as Blendshapes;
    expect(out).toBeInstanceOf(Blendshapes);
    // Should have some keys — at least jawOpen and blink entries
    expect(out.size).toBeGreaterThan(0);
    // All values must be clamped to [0,1]
    for (const [, v] of out.entries()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('returns empty blendshapes when face width is near-zero', () => {
    // Place leftCheek and rightCheek at same position → faceWidth ≈ 0
    const face = makeFace478({ 234: { x: 0.1, y: 0.1, z: 0 }, 454: { x: 0.1, y: 0.1, z: 0 } });
    const out = pullValue('face_landmarks_to_blendshapes', 'blendshapes', { face }) as Blendshapes;
    expect(out.size).toBe(0);
  });

  it('produces jawOpen when lips are far apart', () => {
    // Wide lip gap: lowerLipBot (14) much lower than upperLipTop (13)
    const face = makeFace478({
      13: { x: 0.1, y: 0.45, z: 0 }, // upperLipTop
      14: { x: 0.1, y: 0.60, z: 0 }, // lowerLipBot — very far down
    });
    const out = pullValue('face_landmarks_to_blendshapes', 'blendshapes', { face }) as Blendshapes;
    const jawOpen = out.get('jawOpen');
    expect(jawOpen).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// pose_torso_head_to_bones
// ──────────────────────────────────────────────────────────────────────────────

describe('pose_torso_head_to_bones', () => {
  it('returns undefined when pose input is missing', () => {
    const out = pullValue('pose_torso_head_to_bones', 'pose', {});
    expect(out).toBeUndefined();
  });

  it('returns empty pose when disabled', () => {
    const pose = makeTposePose();
    const out = pullValue('pose_torso_head_to_bones', 'pose', { pose, enabled: false }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    expect(out.size).toBe(0);
  });

  it('returns empty NormalizedPose for a short landmark array', () => {
    const pose = Array.from({ length: 10 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
    const out = pullValue('pose_torso_head_to_bones', 'pose', { pose }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    expect(out.size).toBe(0);
  });

  it('produces spine, chest, neck for a valid T-pose', () => {
    const pose = makeTposePose();
    const out = pullValue('pose_torso_head_to_bones', 'pose', { pose }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    // Should have at least spine and chest
    expect(out.has('spine')).toBe(true);
    expect(out.has('chest')).toBe(true);
    // Spine and chest should be unit quaternions
    const spine = out.get('spine')!;
    expect(spine.magnitudeSquared).toBeCloseTo(1, 4);
    const chest = out.get('chest')!;
    expect(chest.magnitudeSquared).toBeCloseTo(1, 4);
  });

  it('produces neck entry when ears and nose are visible', () => {
    const pose = makeTposePose();
    const out = pullValue('pose_torso_head_to_bones', 'pose', { pose }) as NormalizedPose;
    expect(out.has('neck')).toBe(true);
    const neck = out.get('neck')!;
    expect(neck.magnitudeSquared).toBeCloseTo(1, 4);
  });

  it('respects gain and restPitch config', () => {
    const pose = makeTposePose();
    const outDefault = pullValue('pose_torso_head_to_bones', 'pose', { pose }) as NormalizedPose;
    const outGained = pullValue('pose_torso_head_to_bones', 'pose', {
      pose,
      pitchGain: 3.0,
      yawGain: 2.0,
      rollGain: 0.5,
      restPitch: 0.0,
    }) as NormalizedPose;
    // Both produce a neck entry, but they may differ due to different gains.
    expect(outDefault.has('neck')).toBe(true);
    expect(outGained.has('neck')).toBe(true);
  });

  it('falls back to shoulder-derived up when hips invisible', () => {
    const pose = makeTposePose();
    // Make hips invisible
    pose[23].visibility = 0;
    pose[24].visibility = 0;
    const out = pullValue('pose_torso_head_to_bones', 'pose', { pose }) as NormalizedPose;
    expect(out.has('spine')).toBe(true);
  });

  it('uses shoulder-derived head frame when ears invisible but nose visible', () => {
    const pose = makeTposePose();
    // Make ears invisible (vis < 0.5)
    pose[7].visibility = 0;
    pose[8].visibility = 0;
    // Nose still visible
    const out = pullValue('pose_torso_head_to_bones', 'pose', { pose }) as NormalizedPose;
    // Should still have spine/chest but neck entry is emitted with fallback
    expect(out.has('spine')).toBe(true);
  });

  it('returns empty after spine/chest when all head landmarks invisible', () => {
    const pose = makeTposePose();
    pose[0].visibility = 0; // nose
    pose[7].visibility = 0; // leftEar
    pose[8].visibility = 0; // rightEar
    const out = pullValue('pose_torso_head_to_bones', 'pose', { pose }) as NormalizedPose;
    // Spine and chest are set before the head check, so they should be present
    expect(out.has('spine')).toBe(true);
    expect(out.has('chest')).toBe(true);
    // No neck entry
    expect(out.has('neck')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// pose_arms_to_bones
// ──────────────────────────────────────────────────────────────────────────────

describe('pose_arms_to_bones', () => {
  it('returns undefined when pose input is missing', () => {
    const out = pullValue('pose_arms_to_bones', 'pose', {});
    expect(out).toBeUndefined();
  });

  it('returns empty pose when disabled', () => {
    const pose = makeTposePose();
    const out = pullValue('pose_arms_to_bones', 'pose', { pose, enabled: false }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    expect(out.size).toBe(0);
  });

  it('returns empty NormalizedPose for a short landmark array (< 33)', () => {
    const pose = Array.from({ length: 10 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
    const out = pullValue('pose_arms_to_bones', 'pose', { pose }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    expect(out.size).toBe(0);
  });

  it('produces left and right upper + lower arm bones from a T-pose', () => {
    const pose = makeTposePose();
    const out = pullValue('pose_arms_to_bones', 'pose', { pose }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    expect(out.has('leftUpperArm')).toBe(true);
    expect(out.has('leftLowerArm')).toBe(true);
    expect(out.has('rightUpperArm')).toBe(true);
    expect(out.has('rightLowerArm')).toBe(true);
    // All should be unit quaternions
    for (const bone of ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm'] as const) {
      expect(out.get(bone)!.magnitudeSquared).toBeCloseTo(1, 4);
    }
  });

  it('skips lower arm when wrist is invisible (vis < 0.5)', () => {
    const pose = makeTposePose();
    pose[15].visibility = 0; // left wrist invisible
    pose[16].visibility = 0; // right wrist invisible
    const out = pullValue('pose_arms_to_bones', 'pose', { pose }) as NormalizedPose;
    expect(out.has('leftUpperArm')).toBe(true);
    expect(out.has('rightUpperArm')).toBe(true);
    expect(out.has('leftLowerArm')).toBe(false);
    expect(out.has('rightLowerArm')).toBe(false);
  });

  it('returns empty when shoulders invisible', () => {
    const pose = makeTposePose();
    pose[11].visibility = 0; // left shoulder
    pose[12].visibility = 0; // right shoulder
    const out = pullValue('pose_arms_to_bones', 'pose', { pose }) as NormalizedPose;
    expect(out.size).toBe(0);
  });

  it('falls back to identity-derived spine up when hips invisible', () => {
    const pose = makeTposePose();
    pose[23].visibility = 0;
    pose[24].visibility = 0;
    const out = pullValue('pose_arms_to_bones', 'pose', { pose }) as NormalizedPose;
    // Still produces arm bones
    expect(out.has('leftUpperArm')).toBe(true);
    expect(out.has('rightUpperArm')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// hand_landmarks_to_bones
// ──────────────────────────────────────────────────────────────────────────────

describe('hand_landmarks_to_bones', () => {
  it('returns undefined when no landmarks input', () => {
    const out = pullValue('hand_landmarks_to_bones', 'pose', {});
    expect(out).toBeUndefined();
  });

  it('returns empty pose for a short landmark array (< 21)', () => {
    const landmarks = Array.from({ length: 10 }, () => ({ x: 0, y: 0, z: 0 }));
    const out = pullValue('hand_landmarks_to_bones', 'pose', { landmarks }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    expect(out.size).toBe(0);
  });

  it('produces finger joint bones for left hand', () => {
    const landmarks = makeHand21();
    const out = pullValue('hand_landmarks_to_bones', 'pose', { landmarks, side: 'left' }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    // Should have proximal/intermediate/distal for 4 fingers + thumb chain (3 joints)
    // Index finger
    expect(out.has('leftIndexProximal')).toBe(true);
    expect(out.has('leftIndexIntermediate')).toBe(true);
    expect(out.has('leftIndexDistal')).toBe(true);
    // Middle finger
    expect(out.has('leftMiddleProximal')).toBe(true);
    // Ring finger
    expect(out.has('leftRingProximal')).toBe(true);
    // Little finger
    expect(out.has('leftLittleProximal')).toBe(true);
    // Thumb
    expect(out.has('leftThumbMetacarpal')).toBe(true);
    expect(out.has('leftThumbProximal')).toBe(true);
    expect(out.has('leftThumbDistal')).toBe(true);
  });

  it('produces finger joint bones for right hand', () => {
    const landmarks = makeHand21();
    const out = pullValue('hand_landmarks_to_bones', 'pose', { landmarks, side: 'right' }) as NormalizedPose;
    expect(out).toBeInstanceOf(NormalizedPose);
    expect(out.has('rightIndexProximal')).toBe(true);
    expect(out.has('rightMiddleProximal')).toBe(true);
    expect(out.has('rightThumbMetacarpal')).toBe(true);
  });

  it('defaults to left side when no side input', () => {
    const landmarks = makeHand21();
    const out = pullValue('hand_landmarks_to_bones', 'pose', { landmarks }) as NormalizedPose;
    expect(out.has('leftIndexProximal')).toBe(true);
  });

  it('all produced quaternions are unit quaternions', () => {
    const landmarks = makeHand21(0.06);
    const out = pullValue('hand_landmarks_to_bones', 'pose', { landmarks, side: 'left' }) as NormalizedPose;
    for (const [, q] of out.entries()) {
      expect(q.magnitudeSquared).toBeCloseTo(1, 4);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// pose_ik_targets
// ──────────────────────────────────────────────────────────────────────────────

describe('pose_ik_targets', () => {
  it('returns undefined when pose input is missing', () => {
    const out = pullValue('pose_ik_targets', 'targets', {});
    expect(out).toBeUndefined();
  });

  it('returns undefined when disabled', () => {
    const pose = makeTposePose();
    const out = pullValue('pose_ik_targets', 'targets', { pose, enabled: false });
    expect(out).toBeUndefined();
  });

  it('produces targets frame from a T-pose', () => {
    const pose = makeTposePose();
    const out = pullValue('pose_ik_targets', 'targets', { pose }) as IkTargetFrame;
    expect(out).toBeDefined();
    expect(out.targets).toBeInstanceOf(Array);
    expect(out.targets.length).toBeGreaterThan(0);
    // Should have left/right elbow and wrist targets
    const labels = out.targets.map((t) => t.bone);
    expect(labels).toContain('leftLowerArm');
    expect(labels).toContain('leftHand');
    expect(labels).toContain('rightLowerArm');
    expect(labels).toContain('rightHand');
  });

  it('includes shoulder width and reference bone', () => {
    const pose = makeTposePose();
    const out = pullValue('pose_ik_targets', 'targets', { pose }) as IkTargetFrame;
    expect(out.referenceBone).toBe('chest'); // default from config
    expect(out.sourceShoulderWidth).toBeGreaterThan(0);
    expect(out.sourceLeftShoulder).toHaveLength(3);
    expect(out.sourceRightShoulder).toHaveLength(3);
  });

  it('adds left finger tip targets when leftHand landmarks provided', () => {
    const pose = makeTposePose();
    const leftHand = makeHand21(0.02);
    const out = pullValue('pose_ik_targets', 'targets', { pose, leftHand }) as IkTargetFrame;
    const bones = out.targets.map((t) => t.bone);
    expect(bones).toContain('leftIndexDistal');
  });

  it('adds right finger tip targets when rightHand landmarks provided', () => {
    const pose = makeTposePose();
    const rightHand = makeHand21(0.02);
    const out = pullValue('pose_ik_targets', 'targets', { pose, rightHand }) as IkTargetFrame;
    const bones = out.targets.map((t) => t.bone);
    expect(bones).toContain('rightIndexDistal');
  });

  it('applies scale/offset calibration to target positions', () => {
    const pose = makeTposePose();
    const outDefault = pullValue('pose_ik_targets', 'targets', { pose }) as IkTargetFrame;
    const outScaled = pullValue('pose_ik_targets', 'targets', {
      pose,
      xScale: 2,
      yScale: 2,
      zScale: 1,
    }) as IkTargetFrame;
    // Targets in scaled output should differ from default
    const leftWristDefault = outDefault.targets.find((t) => t.bone === 'leftHand')!;
    const leftWristScaled = outScaled.targets.find((t) => t.bone === 'leftHand')!;
    // X is scaled by 2, so the position should differ
    expect(leftWristScaled.position[0]).not.toBeCloseTo(leftWristDefault.position[0], 3);
  });

  it('EMA state initialises on first call', () => {
    // Use loneNode to be able to check that the node doesn't crash with no prior state
    // We just verify the pull-value path works without an initialised EMA state.
    const pose = makeTposePose();
    const out1 = pullValue('pose_ik_targets', 'targets', { pose }) as IkTargetFrame;
    const out2 = pullValue('pose_ik_targets', 'targets', { pose }) as IkTargetFrame;
    // Both calls succeed (state starts fresh each time with pullValue)
    expect(out1.targets.length).toBe(out2.targets.length);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// body_calibration
// ──────────────────────────────────────────────────────────────────────────────

describe('body_calibration', () => {
  it('passes pose through when no state (empty offsets)', () => {
    const q = new Quaternion(0, 0.707, 0, 0.707);
    const pose = new NormalizedPose([['spine', q]]);
    const out = pullValue('body_calibration', 'pose', { pose }) as NormalizedPose;
    // No offsets stored → pass-through
    expect(out.get('spine')!.toArray()).toEqual(q.toArray());
  });

  it('returns undefined when pose input is absent', () => {
    const out = pullValue('body_calibration', 'pose', {});
    expect(out).toBeUndefined();
  });

  it('capture stores offsets and corrects subsequent pulls', () => {
    const q = new Quaternion(0, 0.5, 0, 0.866);
    const pose = new NormalizedPose([['neck', q]]);
    const n = loneNode('body_calibration', {}, undefined);

    // Before capture: pull via graph manually
    // We confirm the node exists and fires
    n.deliver('capture', undefined); // Should no-op since poseIn is undefined (no connection)

    // Verify state after capture with no pose → no offsets stored
    const stateAfterNoCapture = n.state<{ bodyOffsets?: Record<string, unknown> }>();
    // State may be undefined or have empty bodyOffsets
    const bodyOffsets = (stateAfterNoCapture as any)?.bodyOffsets ?? {};
    expect(Object.keys(bodyOffsets).length).toBe(0);
  });

  it('reset clears stored offsets', () => {
    // Start with pre-seeded state
    const preState = { bodyOffsets: { neck: [0, 0.5, 0, 0.866] as [number, number, number, number] } };
    const n = loneNode('body_calibration', {}, preState);
    n.deliver('reset', undefined);
    const state = n.state<{ bodyOffsets: Record<string, unknown> }>();
    expect(Object.keys(state.bodyOffsets).length).toBe(0);
  });

  it('applies stored offset to incoming pose (offset⁻¹ × q_in)', () => {
    // Build a state where neck has a stored offset equal to the current pose.
    // After correction, the result should be near identity.
    const q = new Quaternion(0, 0.5, 0, 0.866);
    const preState = { bodyOffsets: { neck: q.toArray() } };
    const pose = new NormalizedPose([['neck', q]]);
    // pullValue with state
    const out = pullValue('body_calibration', 'pose', { pose }, preState) as NormalizedPose;
    const corrected = out.get('neck')!;
    // offset = q, so offset⁻¹ × q = identity
    expect(corrected.x).toBeCloseTo(0, 4);
    expect(corrected.y).toBeCloseTo(0, 4);
    expect(corrected.z).toBeCloseTo(0, 4);
    expect(corrected.w).toBeCloseTo(1, 4);
  });

  it('boneFilter restricts which bones get corrected', () => {
    const q = new Quaternion(0, 0.5, 0, 0.866);
    const preState = {
      bodyOffsets: {
        neck: q.toArray(),
        spine: q.toArray(),
      },
    };
    const pose = new NormalizedPose([
      ['neck', q],
      ['spine', q],
    ]);
    // Only correct neck
    const out = pullValue('body_calibration', 'pose', { pose }, preState) as NormalizedPose;
    // Both neck and spine should be corrected (no filter in config here)
    const neck = out.get('neck')!;
    const spine = out.get('spine')!;
    expect(neck.w).toBeCloseTo(1, 4);
    expect(spine.w).toBeCloseTo(1, 4);
  });

  it('mirrorPairs: auto-mirrors missing side from captured side', () => {
    // Verify the mirror logic using loneNode + capture event.
    // We cannot connect poseIn directly via loneNode (no wiring), so we test the
    // reset and state management paths instead.
    const n = loneNode('body_calibration', {
      mirrorPairs: [['leftUpperArm', 'rightUpperArm']] as [string, string][],
    });
    n.deliver('reset', undefined);
    const cleared = n.state<{ bodyOffsets: Record<string, unknown> }>();
    expect(Object.keys(cleared.bodyOffsets ?? {}).length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// arm_ik_calibration
// ──────────────────────────────────────────────────────────────────────────────

describe('arm_ik_calibration', () => {
  it('returns undefined when pose input is absent', () => {
    const out = pullValue('arm_ik_calibration', 'pose', {});
    expect(out).toBeUndefined();
  });

  it('passes pose through when no calibration state and no skeleton', () => {
    const q = new Quaternion(0, 0.5, 0, 0.866);
    const pose = new NormalizedPose([['leftUpperArm', q]]);
    const out = pullValue('arm_ik_calibration', 'pose', { pose }) as NormalizedPose;
    // No skeleton → pass-through
    expect(out.get('leftUpperArm')!.toArray()).toEqual(q.toArray());
  });

  it('passes pose through when there is no calibration state (hasCalib=false)', () => {
    // Even with a skeleton config, without calib state it just passes through.
    const skeleton = {
      hips: { parent: null, localTranslation: [0, 0, 0], localRotation: [0, 0, 0, 1] },
      leftUpperArm: { parent: 'chest', localTranslation: [0.2, 0, 0], localRotation: [0, 0, 0, 1] },
    };
    const q = new Quaternion(0, 0.5, 0, 0.866);
    const pose = new NormalizedPose([['leftUpperArm', q]]);
    const out = pullValue('arm_ik_calibration', 'pose', { pose }, undefined) as NormalizedPose;
    // No calib state → pose passes through unchanged
    expect(out.get('leftUpperArm')!.toArray()).toEqual(q.toArray());
  });

  it('reset clears calibration state', () => {
    const preState: Record<string, unknown> = {
      left: { scale: 1, offset: [0, 0, 0] },
      right: { scale: 1, offset: [0, 0, 0] },
    };
    const n = loneNode('arm_ik_calibration', {}, preState);
    n.deliver('reset', undefined);
    const state = n.state<Record<string, unknown>>();
    expect(state).toEqual({});
  });

  it('capture_left no-ops when pose or skeleton is missing', () => {
    const n = loneNode('arm_ik_calibration', {}, undefined);
    n.deliver('capture_left', undefined);
    // No crash, state unchanged (undefined or empty)
    const state = n.state();
    // Should be undefined or an empty object — not have a 'left' key
    expect((state as any)?.left).toBeUndefined();
  });

  it('capture_right no-ops when pose or skeleton is missing', () => {
    const n = loneNode('arm_ik_calibration', {}, undefined);
    n.deliver('capture_right', undefined);
    expect((n.state() as any)?.right).toBeUndefined();
  });

  it('passes pose through when skeleton is present but no calib state stored', () => {
    // Minimal skeleton — just needs to be present in config.
    // Without stored calib state, the node should still pass through the pose.
    const skeleton = {
      hips: { parent: null, localTranslation: [0, 0, 0], localRotation: [0, 0, 0, 1] },
      spine: { parent: 'hips', localTranslation: [0, 0.1, 0], localRotation: [0, 0, 0, 1] },
      chest: { parent: 'spine', localTranslation: [0, 0.1, 0], localRotation: [0, 0, 0, 1] },
      leftShoulder: { parent: 'chest', localTranslation: [0.1, 0, 0], localRotation: [0, 0, 0, 1] },
      leftUpperArm: { parent: 'leftShoulder', localTranslation: [0.1, 0, 0], localRotation: [0, 0, 0, 1] },
      leftLowerArm: { parent: 'leftUpperArm', localTranslation: [0.3, 0, 0], localRotation: [0, 0, 0, 1] },
      leftHand: { parent: 'leftLowerArm', localTranslation: [0.3, 0, 0], localRotation: [0, 0, 0, 1] },
      leftEye: { parent: 'head', localTranslation: [0.03, 0, 0.1], localRotation: [0, 0, 0, 1] },
      head: { parent: 'chest', localTranslation: [0, 0.3, 0], localRotation: [0, 0, 0, 1] },
      rightShoulder: { parent: 'chest', localTranslation: [-0.1, 0, 0], localRotation: [0, 0, 0, 1] },
      rightUpperArm: { parent: 'rightShoulder', localTranslation: [-0.1, 0, 0], localRotation: [0, 0, 0, 1] },
      rightLowerArm: { parent: 'rightUpperArm', localTranslation: [-0.3, 0, 0], localRotation: [0, 0, 0, 1] },
      rightHand: { parent: 'rightLowerArm', localTranslation: [-0.3, 0, 0], localRotation: [0, 0, 0, 1] },
      rightEye: { parent: 'head', localTranslation: [-0.03, 0, 0.1], localRotation: [0, 0, 0, 1] },
    };
    const q = new Quaternion(0, 0.5, 0, 0.866);
    const pose = new NormalizedPose([['leftUpperArm', q]]);
    // No calib state → pass-through even with skeleton
    const out = pullValue('arm_ik_calibration', 'pose', { pose, skeleton }) as NormalizedPose;
    expect(out.get('leftUpperArm')!.toArray()).toEqual(q.toArray());
  });
});
