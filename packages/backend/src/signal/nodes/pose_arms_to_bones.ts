import { SignalNode, Quaternion, NormalizedPose } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

type Landmark = { x: number; y: number; z: number; visibility?: number };
type V3 = [number, number, number];

const BP = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
};

// MediaPipe Hand landmark indices used to build the wrist orientation frame.
const HAND = { wrist: 0, indexMcp: 5, middleMcp: 9, pinkyMcp: 17 };

const VIS = 0.5;
const ok = (lm: Landmark): boolean => (lm.visibility ?? 1) >= VIS;

function neg(v: V3): V3 {
  return [-v[0], -v[1], -v[2]];
}

function sub(a: Landmark, b: Landmark): V3 {
  return [a.x - b.x, a.y - b.y, a.z - b.z];
}
function lenV(v: V3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}
function norm(v: V3): V3 {
  const l = lenV(v);
  return l < 1e-9 ? [0, 1, 0] : [v[0] / l, v[1] / l, v[2] / l];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function mid(a: Landmark, b: Landmark): Landmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}
// MediaPipe world landmarks have +Y down (image-space). +Z is also flipped relative to a
// standard right-handed +Y-up VRM frame where -Z is "forward" (toward the viewer for an
// avatar facing the camera). Flip both at the boundary so downstream math works in the
// avatar's natural frame without per-axis ad-hoc corrections.
function flipYZ(lm: Landmark): Landmark {
  return { x: lm.x, y: -lm.y, z: -lm.z, visibility: lm.visibility };
}

// Hand landmarks are in image space (not pose-world space): +x = right of the mirrored selfie
// frame = performer's RIGHT, whereas pose-world +x (after flipYZ) = performer's LEFT. So the hand
// frame needs X and Y negated (Z kept). Using flipYZ here instead would apply a 180° turn about
// the vertical axis — the hand comes out rotated 180° and rolling the wrong way.
function flipHand(lm: Landmark): Landmark {
  return { x: -lm.x, y: -lm.y, z: lm.z, visibility: lm.visibility };
}

function qmul(a: Quaternion, b: Quaternion): Quaternion {
  return new Quaternion(
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  );
}
function qinv(q: Quaternion): Quaternion {
  return new Quaternion(-q.x, -q.y, -q.z, q.w);
}
function qapply(q: Quaternion, v: V3): V3 {
  // v' = q * (0,v) * q⁻¹
  const qx = q.x,
    qy = q.y,
    qz = q.z,
    qw = q.w;
  const vx = v[0],
    vy = v[1],
    vz = v[2];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

// Returns the minimum-rotation quaternion that takes `from` to `to` (both unit vectors).
function qFromUnitVectors(from: V3, to: V3): Quaternion {
  const d = dot(from, to);
  if (d > 0.999999) return new Quaternion(0, 0, 0, 1);
  if (d < -0.999999) {
    // 180° rotation — pick any perpendicular axis
    let axis: V3 = cross([1, 0, 0], from);
    if (lenV(axis) < 1e-6) axis = cross([0, 1, 0], from);
    axis = norm(axis);
    return new Quaternion(axis[0], axis[1], axis[2], 0);
  }
  const axis = cross(from, to);
  const w = 1 + d;
  const l = Math.sqrt(
    axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2] + w * w
  );
  return new Quaternion(axis[0] / l, axis[1] / l, axis[2] / l, w / l);
}

// frameToQuat: maps VRM +X to rightTarget exactly, +Y to upTarget (Gram-Schmidt orthogonalized).
// Same construction as in pose_torso_head_to_bones — kept inlined to avoid cross-node coupling.
function frameToQuat(rightTarget: V3, upTarget: V3): Quaternion {
  const X = norm(rightTarget);
  const d = dot(upTarget, X);
  const Y = norm([
    upTarget[0] - X[0] * d,
    upTarget[1] - X[1] * d,
    upTarget[2] - X[2] * d,
  ]);
  const col2 = norm(cross(X, Y));
  const trace = X[0] + Y[1] + col2[2];
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s;
    qx = (Y[2] - col2[1]) * s;
    qy = (col2[0] - X[2]) * s;
    qz = (X[1] - Y[0]) * s;
  } else if (X[0] > Y[1] && X[0] > col2[2]) {
    const s = 2 * Math.sqrt(1 + X[0] - Y[1] - col2[2]);
    qw = (Y[2] - col2[1]) / s;
    qx = 0.25 * s;
    qy = (Y[0] + X[1]) / s;
    qz = (col2[0] + X[2]) / s;
  } else if (Y[1] > col2[2]) {
    const s = 2 * Math.sqrt(1 + Y[1] - X[0] - col2[2]);
    qw = (col2[0] - X[2]) / s;
    qx = (Y[0] + X[1]) / s;
    qy = 0.25 * s;
    qz = (col2[1] + Y[2]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + col2[2] - X[0] - Y[1]);
    qw = (X[1] - Y[0]) / s;
    qx = (col2[0] + X[2]) / s;
    qy = (col2[1] + Y[2]) / s;
    qz = 0.25 * s;
  }
  const l = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  return new Quaternion(qx / l, qy / l, qz / l, qw / l);
}

// ─────────────────────────────────────────────────────────────────────────────
// VRM normalised T-pose arm rest directions:
//   leftUpperArm:  points in +X (subject's left, outward).
//   leftLowerArm:  inherits +X — at rest the forearm continues the upper arm direction.
//   rightUpperArm: points in -X.
//   rightLowerArm: inherits -X.
//
// To set an arm bone's local rotation so that its world direction matches a measured
// vector `worldDir`, we need:
//   bone_local_q * rest_dir = qinv(parent_world_q) * worldDir
// Then bone_local_q = qFromUnitVectors(rest_dir, qinv(parent_world_q) * worldDir).
//
// The parent_world_q for upperArm is the torso world rotation (hips → spine → chest, but
// in this pipeline we only set `hips`, so chest world ≈ torsoQ).
// The parent_world_q for lowerArm is torsoQ * upperArmLocalQ.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Wrist (hand bone) orientation from the dense hand landmarks.
//
// Pose tracking gives only the forearm direction (elbow→wrist) — it carries no information
// about hand roll or wrist flex, which is why hand orientation looked dead. The 21-point hand
// landmarks do. We build a hand frame (finger axis + back-of-hand normal), turn it into the
// desired hand-bone world orientation, then express it relative to the forearm so it composes
// as the hand bone's local rotation. Finger curls (set in hand_landmarks_to_bones, relative to
// the hand bone) layer on top unchanged.
//
// VRM rest hand frame: fingers extend along +X (left) / -X (right); back-of-hand (dorsal) = +Y.
// Dorsal sign follows the same per-side convention as hand_landmarks_to_bones' palm normal.
function wristLocal(
  rawHand: Landmark[] | undefined,
  side: 'left' | 'right',
  lowerArmWorld: Quaternion
): Quaternion | null {
  if (!rawHand || rawHand.length < 21) return null;
  const w = flipHand(rawHand[HAND.wrist]);
  const im = flipHand(rawHand[HAND.indexMcp]);
  const mm = flipHand(rawHand[HAND.middleMcp]);
  const pm = flipHand(rawHand[HAND.pinkyMcp]);
  const fingerAxis = norm(sub(mm, w)); // wrist → middle MCP
  // Back-of-hand normal. cross(toIndex, toPinky) negated on the left mirrors the palm-normal
  // convention in hand_landmarks_to_bones (left flips, right keeps).
  let dorsal = norm(cross(sub(im, w), sub(pm, w)));
  if (side === 'left') dorsal = neg(dorsal);
  if (Math.abs(dot(fingerAxis, dorsal)) > 0.95) return null; // degenerate
  // VRM rest finger axis: +X (left) / -X (right). frameToQuat maps +X → its first argument.
  const restRight = side === 'left' ? fingerAxis : neg(fingerAxis);
  const handWorld = frameToQuat(restRight, dorsal);
  // hand-bone local = inv(forearm world) · hand world
  return qmul(qinv(lowerArmWorld), handWorld);
}

function convertArms(
  rawPts: Landmark[],
  leftHandRaw?: Landmark[],
  rightHandRaw?: Landmark[]
): NormalizedPose {
  if (rawPts.length < 33) return new NormalizedPose();
  const pts = rawPts.map(flipYZ);

  const ls = pts[BP.leftShoulder],
    rs = pts[BP.rightShoulder];
  const le = pts[BP.leftElbow],
    re = pts[BP.rightElbow];
  const lw = pts[BP.leftWrist],
    rw = pts[BP.rightWrist];
  const lh = pts[BP.leftHip],
    rh = pts[BP.rightHip];

  const entries: [VRMBoneName, Quaternion][] = [];

  if (!ok(ls) || !ok(rs)) return new NormalizedPose();

  // ── Torso quaternion — same computation as pose_torso_head_to_bones ───────
  // We need this to express arm rotations relative to the chest (the torso bone the upper arm hangs from).
  const shdRight = norm(sub(ls, rs));
  let spineUp: V3;
  if (ok(lh) && ok(rh)) {
    spineUp = norm(sub(mid(ls, rs), mid(lh, rh)));
  } else {
    const t = dot([0, 1, 0] as V3, shdRight);
    spineUp = norm([
      0 - shdRight[0] * t,
      1 - shdRight[1] * t,
      0 - shdRight[2] * t,
    ]);
  }
  const torsoQ = frameToQuat(shdRight, spineUp);
  const torsoQinv = qinv(torsoQ);

  // ── Left arm ─────────────────────────────────────────────────────────────
  if (ok(le)) {
    const dirWorld = norm(sub(le, ls)); // shoulder → elbow in MP world
    const dirChest = qapply(torsoQinv, dirWorld); // in chest-local space
    const leftUpperLocal = qFromUnitVectors([1, 0, 0], dirChest); // rest dir = +X
    entries.push(['leftUpperArm', leftUpperLocal]);

    if (ok(lw)) {
      const fwWorld = norm(sub(lw, le)); // elbow → wrist
      // Parent of leftLowerArm world rotation = torsoQ * leftUpperLocal
      const parentInv = qmul(qinv(leftUpperLocal), torsoQinv);
      const fwParent = qapply(parentInv, fwWorld);
      const leftLowerLocal = qFromUnitVectors([1, 0, 0], fwParent);
      entries.push(['leftLowerArm', leftLowerLocal]);

      // Wrist orientation from hand landmarks, relative to the forearm world rotation.
      const leftLowerWorld = qmul(torsoQ, qmul(leftUpperLocal, leftLowerLocal));
      const leftWrist = wristLocal(leftHandRaw, 'left', leftLowerWorld);
      if (leftWrist) entries.push(['leftHand', leftWrist]);
    }
  }

  // ── Right arm ────────────────────────────────────────────────────────────
  if (ok(re)) {
    const dirWorld = norm(sub(re, rs));
    const dirChest = qapply(torsoQinv, dirWorld);
    const rightUpperLocal = qFromUnitVectors([-1, 0, 0], dirChest); // rest dir = -X for right arm
    entries.push(['rightUpperArm', rightUpperLocal]);

    if (ok(rw)) {
      const fwWorld = norm(sub(rw, re));
      const parentInv = qmul(qinv(rightUpperLocal), torsoQinv);
      const fwParent = qapply(parentInv, fwWorld);
      const rightLowerLocal = qFromUnitVectors([-1, 0, 0], fwParent);
      entries.push(['rightLowerArm', rightLowerLocal]);

      // Wrist orientation from hand landmarks, relative to the forearm world rotation.
      const rightLowerWorld = qmul(torsoQ, qmul(rightUpperLocal, rightLowerLocal));
      const rightWrist = wristLocal(rightHandRaw, 'right', rightLowerWorld);
      if (rightWrist) entries.push(['rightHand', rightWrist]);
    }
  }

  return new NormalizedPose(entries);
}

@SignalNode({
  label: 'Pose → Arm Bones',
  description:
    'Converts MediaPipe BlazePose world landmarks to VRM arm local rotations (upper+lower arm, both sides). When hand landmarks are connected, also sets the wrist (hand bone) orientation. Use as an alternative to IK-driven arm tracking.',
  tags: ["mocap"],
  color: '#4a6a8a',
})
export class PoseArmsToBones extends Node {
  static readonly kind = 'pose_arms_to_bones';

  @valueIn('pose', 'LandmarkList') poseIn!: () => Landmark[] | undefined;
  // Optional hand landmarks — when present, the wrist (hand bone) orientation is derived from
  // them, since pose tracking carries no hand roll/flex.
  @valueIn('leftHand', 'LandmarkList') leftHandIn!: () =>
    | Landmark[]
    | undefined;
  @valueIn('rightHand', 'LandmarkList') rightHandIn!: () =>
    | Landmark[]
    | undefined;
  @valueIn('enabled', 'Bool') enabledIn!: () => boolean | null | undefined;

  @valueOut('pose', 'NormalizedPose')
  poseOut = (): NormalizedPose | undefined => {
    const enabled = this.enabledIn() ?? true;
    if (!enabled) return new NormalizedPose();
    const pts = this.poseIn();
    if (!pts?.length) return undefined;
    return convertArms(pts, this.leftHandIn(), this.rightHandIn());
  };
}
