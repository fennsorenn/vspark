import { SignalNode, Quaternion, NormalizedPose } from '@vspark/shared/signal';
import type { VRMBoneName, BoneConfidence } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';
import { frameToQuat, torsoWorldQuat } from '../mocap_torso.js';

type Landmark = { x: number; y: number; z: number; visibility?: number };
type V3 = [number, number, number];

const BP = {
  leftEye: 2,
  rightEye: 5,
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

const IDENTITY = new Quaternion(0, 0, 0, 1);

function neg(v: V3): V3 {
  return [-v[0], -v[1], -v[2]];
}

// Quaternion from a unit axis and angle (radians).
function axisAngle(axis: V3, angle: number): Quaternion {
  const s = Math.sin(angle / 2);
  return new Quaternion(axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2));
}

// ── Shoulder shrug ───────────────────────────────────────────────────────────
// Lives here (not in the torso node) so the shoulder lift can be folded into the arm's parent
// chain — rotating the clavicle alone would drag the whole arm up with it, so the upper/lower arm
// are recomputed relative to chest·shrug, cancelling that drag while the clavicle still visibly
// lifts. Elevation = eye-line→shoulder vertical gap / interocular distance (scale/distance
// invariant, always visible). NEUTRAL_DROP just sets the operating point; the head-neutral
// calibration removes each person's true rest offset.
const SHRUG_NEUTRAL_DROP = 5.0;
const SHRUG_GAIN = 0.6;
const SHRUG_MIN = -0.25;
const SHRUG_MAX = 0.6;
function shrugQuat(
  eyeY: number,
  eyeSpan: number,
  shoulderY: number,
  liftAxisZ: number
): Quaternion {
  const drop = (eyeY - shoulderY) / eyeSpan;
  const raw = (SHRUG_NEUTRAL_DROP - drop) * SHRUG_GAIN; // +ve = lift
  const angle = Math.max(SHRUG_MIN, Math.min(SHRUG_MAX, raw));
  return axisAngle([0, 0, liftAxisZ], angle);
}

// Wrist flex/deviation (the swing, i.e. non-roll part) reads weakly from Holistic hand landmarks
// because wrist→middle-MCP is short and the landmark depth is noisy, while roll (measured across
// the palm width) is robust. Amplify the swing modestly so the other two axes register without
// touching roll. Kept low: the hand's rest offset (also from noisy depth) is removed by the
// head-neutral calibration, but a high gain still magnifies pose-dependent residue.
const WRIST_SWING_GAIN = 1.5;

// Scale a rotation's angle by `gain` about its own axis. q and -q are the same rotation; use the
// short-way representation (w ≥ 0) or the scaled angle would be the long way round.
function scaleAngle(q: Quaternion, gain: number): Quaternion {
  if (q.w < 0) q = new Quaternion(-q.x, -q.y, -q.z, -q.w);
  const w = Math.min(1, q.w);
  const s = Math.sqrt(1 - w * w);
  if (s < 1e-6) return new Quaternion(0, 0, 0, 1); // ~identity
  const ang = 2 * Math.acos(w) * gain;
  const ns = Math.sin(ang / 2);
  return new Quaternion((q.x / s) * ns, (q.y / s) * ns, (q.z / s) * ns, Math.cos(ang / 2));
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
// MediaPipe world landmarks have +Y down (image-space). +Z is also flipped relative to a
// standard right-handed +Y-up VRM frame where -Z is "forward" (toward the viewer for an
// avatar facing the camera). Flip both at the boundary so downstream math works in the
// avatar's natural frame without per-axis ad-hoc corrections.
function flipYZ(lm: Landmark): Landmark {
  return { x: lm.x, y: -lm.y, z: -lm.z, visibility: lm.visibility };
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
// Hand-bone world orientation from the dense hand landmarks (finger axis + back-of-hand normal),
// or null when unavailable/degenerate. Used both to orient the hand and to read the forearm twist
// (see solveArm).
//
// VRM rest hand frame: fingers extend along +X (left) / -X (right); back-of-hand (dorsal) = +Y.
//
// Hand landmarks share the pose landmarks' axes (Holistic's hand world landmarks are even in the
// same hip-centred metric frame), so they take the same flipYZ into the avatar frame as the arm.
// Back-of-hand normal: cross(wrist→index MCP, wrist→pinky MCP) points out of the back of a left
// hand and out of the palm of a right hand — the same per-side sign hand_landmarks_to_bones uses
// for its hand frame. Verified against real Holistic output on hands whose facing is unambiguous
// (see test/fixtures/mediapipe).
function handWorldFrame(
  rawHand: Landmark[] | undefined,
  side: 'left' | 'right'
): Quaternion | null {
  if (!rawHand || rawHand.length < 21) return null;
  const w = flipYZ(rawHand[HAND.wrist]);
  const im = flipYZ(rawHand[HAND.indexMcp]);
  const mm = flipYZ(rawHand[HAND.middleMcp]);
  const pm = flipYZ(rawHand[HAND.pinkyMcp]);
  const fingerAxis = norm(sub(mm, w)); // wrist → middle MCP
  let dorsal = norm(cross(sub(im, w), sub(pm, w)));
  if (side === 'right') dorsal = neg(dorsal);
  if (Math.abs(dot(fingerAxis, dorsal)) > 0.95) return null; // degenerate
  // VRM rest finger axis: +X (left) / -X (right). frameToQuat maps +X → its first argument.
  const restRight = side === 'left' ? fingerAxis : neg(fingerAxis);
  return frameToQuat(restRight, dorsal);
}

function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

// Signed angle from `a` to `b` about `axis` (all unit; a and b perpendicular to axis).
function signedAngle(a: V3, b: V3, axis: V3): number {
  return Math.atan2(dot(cross(a, b), axis), dot(a, b));
}

// Twist of `q` about the unit `axis` (swing-twist split, twist applied first), in (-π, π]. The
// atan2 form is sign-agnostic: q and -q give the same angle.
function twistAngle(q: Quaternion, axis: V3): number {
  let a = 2 * Math.atan2(q.x * axis[0] + q.y * axis[1] + q.z * axis[2], q.w);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

// ── Arm solve: elbow hinge ───────────────────────────────────────────────────
// The elbow is a hinge, so the plane through shoulder, elbow and wrist fixes the upper arm's roll
// whenever the elbow is bent, and the hand only adds forearm twist (pronation/supination) on top.
// Rolling the whole arm to the hand instead needs some reference roll to split against, and a
// halfway split between two rolls flips sides once they disagree by more than half a turn.
//
// VRM rest (T-pose, palms down): flexing the elbow swings the forearm forward (+Z), so the hinge
// axis is cross(rest, +Z) — -Y for the left arm, +Y for the right.

// Below BEND_LO the shoulder–elbow–wrist plane is noise (it flips sign as the arm passes straight);
// above BEND_HI it is trusted fully. In between, the hinge axis blends from a reference to it.
const BEND_LO = (8 * Math.PI) / 180;
const BEND_HI = (25 * Math.PI) / 180;

// Forearm twist about its own axis, measured from the hand. 0 is the hinge frame's neutral (back of
// the hand facing along the hinge axis — a handshake with the elbow bent). Forearms turn roughly
// ±90° from there; beyond TWIST_SOFT the reading fades out, reaching 0 at TWIST_HARD, so a reading
// near the impossible ±180° (where the angle wraps) can't flip the forearm.
const TWIST_SOFT = (100 * Math.PI) / 180;
const TWIST_HARD = (150 * Math.PI) / 180;
// Same for the wrist's swing (flex/deviation, before WRIST_SWING_GAIN): a real wrist bends well
// under 90°.
const SWING_SOFT = (90 * Math.PI) / 180;
const SWING_HARD = (140 * Math.PI) / 180;

// Landmark visibility → bone confidence (see the `confidence` output). MediaPipe still estimates
// landmarks it can't see (out of frame, occluded); they are used, but flagged as unreliable.
const VIS_LO = 0.2;
const VIS_HI = 0.8;
function visConf(...lms: Landmark[]): number {
  return smoothstep(VIS_LO, VIS_HI, Math.min(...lms.map((l) => l.visibility ?? 1)));
}
// Forearm confidence without hand landmarks: its twist falls back to neutral, which is a guess.
const NO_HAND_CONF = 0.6;
// The hand frame's roll comes from the across-the-palm direction. With the palm edge-on to the
// camera that direction runs along the depth axis, MediaPipe's noisiest coordinate, and the twist
// reading jitters several times more than with the palm facing the camera (measured on recorded
// webcam frames). Confidence in the forearm twist and the wrist falls to EDGE_ON_CONF there.
const EDGE_ON_CONF = 0.4;
const FACING_LO = 0.15; // |back-of-hand normal · camera axis| at and below which the palm is edge-on
const FACING_HI = 0.6;

type ArmSolve = { pose: NormalizedPose; confidence: BoneConfidence };

// Solve one arm: upper + lower arm (+ hand when the hand frame is known).
function solveArm(
  side: 'left' | 'right',
  shoulder: Landmark,
  elbow: Landmark,
  wrist: Landmark,
  parentWorld: Quaternion, // chest · shrug
  handW: Quaternion | null,
  entries: [VRMBoneName, Quaternion][],
  confidence: BoneConfidence
): void {
  const L = side === 'left';
  const rest: V3 = L ? [1, 0, 0] : [-1, 0, 0];
  const hingeRest: V3 = L ? [0, -1, 0] : [0, 1, 0];
  const upperBone: VRMBoneName = L ? 'leftUpperArm' : 'rightUpperArm';
  const lowerBone: VRMBoneName = L ? 'leftLowerArm' : 'rightLowerArm';
  const handBone: VRMBoneName = L ? 'leftHand' : 'rightHand';
  const parentInv = qinv(parentWorld);

  const u = norm(sub(elbow, shoulder)); // shoulder → elbow, world
  const l = norm(sub(wrist, elbow)); // elbow → wrist, world
  const bend = Math.acos(Math.max(-1, Math.min(1, dot(u, l))));

  // Hinge axis. Reference for a (nearly) straight arm: the rest hinge carried along by the minimal
  // swing from rest to the upper arm's direction in the chest frame. It is perpendicular to u by
  // construction, as is the measured plane normal, so the blend is a rotation about u.
  const swing = qFromUnitVectors(rest, qapply(parentInv, u));
  const nRef = qapply(parentWorld, qapply(swing, hingeRest));
  // The plane is only as good as the wrist: an estimated (low-visibility) wrist landing on the other
  // side of the arm line would flip it, and the upper arm's roll with it.
  let n = nRef;
  const w = smoothstep(BEND_LO, BEND_HI, bend) * visConf(wrist);
  if (w > 0) {
    const nPlane = norm(cross(u, l));
    n = qapply(axisAngle(u, w * signedAngle(nRef, nPlane, u)), nRef);
  }

  // Upper arm: rest → u, rest hinge → n. frameToQuat maps +X and +Y to its two arguments.
  const upperWorld = L ? frameToQuat(u, neg(n)) : frameToQuat(neg(u), n);

  // Forearm: bend about the hinge. Where n leans on the reference it may miss the wrist slightly,
  // so swing the remainder — the forearm always points exactly along elbow → wrist.
  let forearmWorld = qmul(axisAngle(n, bend), upperWorld);
  forearmWorld = qmul(
    qFromUnitVectors(qapply(forearmWorld, rest), l),
    forearmWorld
  );

  // Forearm twist from the hand. The wrist can't twist, so the hand bone keeps only the swing
  // (flex/deviation) — any twist the forearm didn't take (a faded, implausible reading) is dropped
  // rather than left in the wrist, where it would flip as the reading wraps through ±180°.
  let wristLocal: Quaternion | null = null;
  if (handW) {
    const tw = twistAngle(qmul(qinv(forearmWorld), handW), rest);
    const fade = 1 - smoothstep(TWIST_SOFT, TWIST_HARD, Math.abs(tw));
    forearmWorld = qmul(forearmWorld, axisAngle(rest, tw * fade));
    const rel = qmul(qinv(forearmWorld), handW); // = swing · twist(residual)
    const swing = qmul(rel, axisAngle(rest, -twistAngle(rel, rest)));
    // A swing far beyond a wrist's range means the hand and pose landmarks disagree about where
    // the forearm points; near 180° its axis is undefined and flips. Fade it out like the twist.
    const swingAngle = 2 * Math.acos(Math.min(1, Math.abs(swing.w)));
    const swingFade = 1 - smoothstep(SWING_SOFT, SWING_HARD, swingAngle);
    wristLocal = scaleAngle(swing, WRIST_SWING_GAIN * swingFade);
  }

  // How well the hand frame's roll is measurable (see EDGE_ON_CONF).
  const rollConf = handW
    ? EDGE_ON_CONF +
      (1 - EDGE_ON_CONF) *
        smoothstep(FACING_LO, FACING_HI, Math.abs(qapply(handW, [0, 1, 0])[2]))
    : NO_HAND_CONF;

  entries.push([upperBone, qmul(parentInv, upperWorld)]);
  entries.push([lowerBone, qmul(qinv(upperWorld), forearmWorld)]);
  // The upper arm's roll comes from the plane, which needs the wrist (see w above).
  confidence[upperBone] = visConf(shoulder, elbow) * (1 - smoothstep(BEND_LO, BEND_HI, bend) * (1 - visConf(wrist)));
  confidence[lowerBone] = visConf(elbow, wrist) * rollConf;
  if (wristLocal) {
    entries.push([handBone, wristLocal]);
    confidence[handBone] = visConf(wrist) * rollConf;
  }
}

const EMPTY: ArmSolve = { pose: new NormalizedPose(), confidence: {} };

function convertArms(
  rawPts: Landmark[],
  leftHandRaw?: Landmark[],
  rightHandRaw?: Landmark[]
): ArmSolve {
  if (rawPts.length < 33) return EMPTY;
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
  const confidence: BoneConfidence = {};

  if (!ok(ls) || !ok(rs)) return EMPTY;

  // ── Torso quaternion — same computation as pose_torso_head_to_bones ───────
  // We need this to express arm rotations relative to the chest (the torso bone the upper arm hangs from).
  // Identical to the chest pose_torso_head_to_bones writes (yaw damping included) — the arms
  // are expressed relative to it, so any mismatch would rotate both arms by the difference.
  const torsoQ = torsoWorldQuat(ls, rs, lh, rh);

  // ── Shoulder shrug ─────────────────────────────────────────────────────────
  // Per-side clavicle lift, also used below as an extra parent rotation so the arm doesn't ride up
  // with the shoulder. Needs both eyes visible for the reference; identity (no shrug) otherwise.
  let leftShrug = IDENTITY;
  let rightShrug = IDENTITY;
  const lEye = pts[BP.leftEye],
    rEye = pts[BP.rightEye];
  if (ok(lEye) && ok(rEye)) {
    const eyeY = (lEye.y + rEye.y) / 2;
    const eyeSpan = lenV(sub(lEye, rEye));
    if (eyeSpan > 1e-3) {
      leftShrug = shrugQuat(eyeY, eyeSpan, ls.y, 1);
      rightShrug = shrugQuat(eyeY, eyeSpan, rs.y, -1);
      entries.push(['leftShoulder', leftShrug]);
      entries.push(['rightShoulder', rightShrug]);
    }
  }

  // ── Arms ───────────────────────────────────────────────────────────────────
  // Parent of each upper arm is chest · shoulder(shrug); folding the shrug in keeps the arm
  // pointing at the elbow regardless of clavicle lift.
  solveArm(
    'left',
    ls,
    le,
    lw,
    qmul(torsoQ, leftShrug),
    handWorldFrame(leftHandRaw, 'left'),
    entries,
    confidence
  );
  solveArm(
    'right',
    rs,
    re,
    rw,
    qmul(torsoQ, rightShrug),
    handWorldFrame(rightHandRaw, 'right'),
    entries,
    confidence
  );

  return { pose: new NormalizedPose(entries), confidence };
}

@SignalNode({
  label: 'Pose → Arm Bones',
  description:
    'Converts MediaPipe BlazePose world landmarks to VRM arm local rotations (upper+lower arm, both sides), solving the elbow as a hinge. When hand landmarks are connected, also sets the forearm twist and the wrist (hand bone) orientation. Emits a per-bone confidence from landmark visibility for pose_smooth. Use as an alternative to IK-driven arm tracking.',
  tags: ["mocap"],
  color: '#4a6a8a',
})
export class PoseArmsToBones extends Node {
  static readonly kind = 'pose_arms_to_bones';

  @valueIn('pose', 'LandmarkList') poseIn!: () => Landmark[] | undefined;
  // Optional hand landmarks — when present, the forearm twist and the wrist (hand bone)
  // orientation are derived from them, since pose tracking carries no hand roll/flex.
  @valueIn('leftHand', 'LandmarkList') leftHandIn!: () =>
    | Landmark[]
    | undefined;
  @valueIn('rightHand', 'LandmarkList') rightHandIn!: () =>
    | Landmark[]
    | undefined;
  @valueIn('enabled', 'Bool') enabledIn!: () => boolean | null | undefined;

  // Both outputs come from one solve; memoized on the input identities so pulling both costs one.
  private _memoKey: [unknown, unknown, unknown] | null = null;
  private _memo: ArmSolve | undefined;

  private _solve(): ArmSolve | undefined {
    const enabled = this.enabledIn() ?? true;
    if (!enabled) return EMPTY;
    const pts = this.poseIn();
    if (!pts?.length) return undefined;
    const lh = this.leftHandIn();
    const rh = this.rightHandIn();
    const k = this._memoKey;
    if (k && k[0] === pts && k[1] === lh && k[2] === rh) return this._memo;
    this._memoKey = [pts, lh, rh];
    this._memo = convertArms(pts, lh, rh);
    return this._memo;
  }

  @valueOut('pose', 'NormalizedPose')
  poseOut = (): NormalizedPose | undefined => this._solve()?.pose;

  @valueOut('confidence', 'BoneConfidence')
  confidenceOut = (): BoneConfidence | undefined => this._solve()?.confidence;
}
