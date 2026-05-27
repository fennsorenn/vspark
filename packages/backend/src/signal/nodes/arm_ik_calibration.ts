import {
  SignalNode,
  eventPort,
  valuePort,
  NormalizedPose,
  Quaternion,
} from '@vspark/shared/signal';
import type {
  VRMBoneName,
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
import type { VrmSkeletonData } from '../../vrm/skeleton.js';

// ──────────────────────────────────────────────────────────────────────────────
// Inline vector / quaternion math (xyzw convention throughout)
// ──────────────────────────────────────────────────────────────────────────────

type V3 = [number, number, number];
type Q4 = [number, number, number, number]; // xyzw

const addV = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subV = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaleV = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s];
const dotV = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lenV = (v: V3): number => Math.sqrt(dotV(v, v));
const normV = (v: V3): V3 => {
  const l = lenV(v);
  return l < 1e-9 ? [0, 0, 0] : scaleV(v, 1 / l);
};
const crossV = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function rotByQ(q: Q4, v: V3): V3 {
  const [qx, qy, qz, qw] = q,
    [vx, vy, vz] = v;
  const cx = qy * vz - qz * vy,
    cy = qz * vx - qx * vz,
    cz = qx * vy - qy * vx;
  return [
    vx + 2 * (qw * cx + qy * cz - qz * cy),
    vy + 2 * (qw * cy + qz * cx - qx * cz),
    vz + 2 * (qw * cz + qx * cy - qy * cx),
  ];
}

function mulQ(a: Q4, b: Q4): Q4 {
  const [ax, ay, az, aw] = a,
    [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function normQ(q: Q4): Q4 {
  const l = Math.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2 + q[3] ** 2);
  return l < 1e-9 ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

const invQ = (q: Q4): Q4 => [-q[0], -q[1], -q[2], q[3]]; // unit quaternion inverse

function quatFromVecs(from: V3, to: V3): Q4 {
  const d = dotV(from, to);
  if (d >= 1 - 1e-9) return [0, 0, 0, 1];
  if (d <= -1 + 1e-9) {
    const ax = normV(
      Math.abs(from[0]) < 0.9 ? [0, -from[2], from[1]] : [-from[2], 0, from[0]]
    );
    return normQ([ax[0], ax[1], ax[2], 0]);
  }
  const c = crossV(from, to);
  return normQ([c[0], c[1], c[2], 1 + d]);
}

// ──────────────────────────────────────────────────────────────────────────────
// Forward kinematics
// ──────────────────────────────────────────────────────────────────────────────

interface BoneWorld {
  pos: V3;
  rot: Q4;
}

function computeFk(
  skeleton: VrmSkeletonData,
  poseRotations: Record<string, Q4>
): Map<string, BoneWorld> {
  const result = new Map<string, BoneWorld>();
  const bones = Object.keys(skeleton);
  const done = new Set<string>();

  for (
    let pass = 0;
    pass < bones.length + 1 && done.size < bones.length;
    pass++
  ) {
    for (const bone of bones) {
      if (done.has(bone)) continue;
      const entry = skeleton[bone];
      const parent = entry.parent;

      if (parent === null) {
        // Root bone (hips) — placed at world origin
        const pose: Q4 = poseRotations[bone] ?? [0, 0, 0, 1];
        result.set(bone, {
          pos: [0, 0, 0],
          rot: normQ(mulQ(entry.localRotation as Q4, pose)),
        });
        done.add(bone);
      } else if (done.has(parent)) {
        const p = result.get(parent)!;
        const pose: Q4 = poseRotations[bone] ?? [0, 0, 0, 1];
        const localRot = normQ(mulQ(entry.localRotation as Q4, pose));
        result.set(bone, {
          pos: addV(p.pos, rotByQ(p.rot, entry.localTranslation as V3)),
          rot: normQ(mulQ(p.rot, localRot)),
        });
        done.add(bone);
      }
    }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Two-bone IK (shoulder + elbow)
// ──────────────────────────────────────────────────────────────────────────────

interface IkResult {
  upperRot: Q4;
  lowerRot: Q4;
}

function twoBoneIk(
  shoulder: V3,
  target: V3,
  upperLen: number,
  lowerLen: number,
  elbowHint: V3, // preferred elbow direction (world space)
  parentRot: Q4, // world rotation of upper bone's parent
  upperRestRot: Q4, // upper bone rest local rotation (from GLTF)
  armAxisLocal: V3 // rest arm direction in bone local space (+X for left, -X for right)
): IkResult {
  const armVec = subV(target, shoulder);
  const d = lenV(armVec);
  const reach = Math.max(
    Math.abs(upperLen - lowerLen) + 1e-4,
    Math.min(upperLen + lowerLen - 1e-4, d)
  );
  const armDirN = d < 1e-9 ? armAxisLocal : normV(armVec);

  // Angle at shoulder via law of cosines
  const cosA =
    (upperLen * upperLen + reach * reach - lowerLen * lowerLen) /
    (2 * upperLen * reach);
  const angA = Math.acos(Math.max(-1, Math.min(1, cosA)));

  // Elbow hint perpendicular to arm direction
  const hd = dotV(elbowHint, armDirN);
  const hPerp = subV(elbowHint, scaleV(armDirN, hd));
  const hLen = lenV(hPerp);
  const elbowDir =
    hLen > 1e-4
      ? normV(
          addV(
            scaleV(armDirN, Math.cos(angA)),
            scaleV(scaleV(hPerp, 1 / hLen), Math.sin(angA))
          )
        )
      : armDirN;

  const elbowWorld = addV(shoulder, scaleV(elbowDir, upperLen));
  const wristDir = normV(subV(target, elbowWorld));

  // Upper arm: rotate from rest arm axis to elbow direction, in parent local space
  const parentRotInv = invQ(parentRot);
  const elbowDirLocal = normV(rotByQ(parentRotInv, elbowDir));
  const upperRot = quatFromVecs(armAxisLocal, elbowDirLocal);

  // Lower arm: world rotation after applying new upper arm rotation
  const upperWorldRot = normQ(
    mulQ(parentRot, normQ(mulQ(upperRestRot, upperRot)))
  );
  const wristDirLocal = normV(rotByQ(invQ(upperWorldRot), wristDir));
  const lowerRot = quatFromVecs(armAxisLocal, wristDirLocal);

  return { upperRot, lowerRot };
}

// ──────────────────────────────────────────────────────────────────────────────
// Calibration state and per-frame application
// ──────────────────────────────────────────────────────────────────────────────

interface ArmCalib {
  scale: number;
  offset: V3;
}

interface ArmIkState {
  left?: ArmCalib;
  right?: ArmCalib;
}

const ARMS: ReadonlyArray<'left' | 'right'> = ['left', 'right'];

const ARM_BONES = {
  left: {
    upper: 'leftUpperArm',
    lower: 'leftLowerArm',
    hand: 'leftHand',
    eye: 'leftEye',
    shoulder: 'leftShoulder',
  },
  right: {
    upper: 'rightUpperArm',
    lower: 'rightLowerArm',
    hand: 'rightHand',
    eye: 'rightEye',
    shoulder: 'rightShoulder',
  },
} as const;

function poseToRotMap(pose: NormalizedPose): Record<string, Q4> {
  const out: Record<string, Q4> = {};
  for (const [bone, q] of pose.entries())
    out[bone as string] = q.toArray() as Q4;
  return out;
}

function fitCalib(
  fk: Map<string, BoneWorld>,
  side: 'left' | 'right'
): ArmCalib | null {
  const b = ARM_BONES[side];
  const upper = fk.get(b.upper)?.pos;
  const hand = fk.get(b.hand)?.pos;
  const eye = fk.get(b.eye)?.pos;
  if (!upper || !hand || !eye) return null;

  // Fit scale+offset: shoulder-relative wrist_FK → eye_corner
  const wristRel = subV(hand, upper);
  const eyeRel = subV(eye, upper);
  const den = dotV(wristRel, wristRel);
  const scale =
    den < 1e-9 ? 1 : Math.max(0.1, Math.min(3, dotV(wristRel, eyeRel) / den));
  const offset = subV(eyeRel, scaleV(wristRel, scale));
  return { scale, offset };
}

function applyArm(
  side: 'left' | 'right',
  calib: ArmCalib,
  fk: Map<string, BoneWorld>,
  skeleton: VrmSkeletonData
): { upper: string; upperRot: Q4; lower: string; lowerRot: Q4 } | null {
  const b = ARM_BONES[side];

  const shoulder = fk.get(b.upper)?.pos;
  const lower = fk.get(b.lower)?.pos;
  const hand = fk.get(b.hand)?.pos;
  if (!shoulder || !lower || !hand) return null;

  const upperLen = lenV(subV(lower, shoulder));
  const lowerLen = lenV(subV(hand, lower));
  if (upperLen < 1e-4 || lowerLen < 1e-4) return null;

  // Corrected target wrist from calibration
  const wristRel = subV(hand, shoulder);
  const wristTarget = addV(
    shoulder,
    addV(scaleV(wristRel, calib.scale), calib.offset)
  );

  // Elbow hint: slightly behind and below (typical resting elbow direction)
  const elbowHint: V3 = [0, -1, 0];

  // VRM normalized T-pose: arm extends along local +X (left) or -X (right)
  const armAxisLocal: V3 = side === 'left' ? [1, 0, 0] : [-1, 0, 0];

  const parentEntry = skeleton[b.upper];
  const parentBone = parentEntry?.parent ?? b.shoulder;
  const parentRot = fk.get(parentBone)?.rot ?? ([0, 0, 0, 1] as Q4);
  const upperRestRot = (skeleton[b.upper]?.localRotation ?? [0, 0, 0, 1]) as Q4;

  const { upperRot, lowerRot } = twoBoneIk(
    shoulder,
    wristTarget,
    upperLen,
    lowerLen,
    elbowHint,
    parentRot,
    upperRestRot,
    armAxisLocal
  );

  return { upper: b.upper, upperRot, lower: b.lower, lowerRot };
}

// ──────────────────────────────────────────────────────────────────────────────
// Node
// ──────────────────────────────────────────────────────────────────────────────

export interface ArmIkConfig {
  /** VRM skeleton rest-pose data loaded from the GLB file. Absent = pass-through. */
  skeleton?: VrmSkeletonData;
}

@SignalNode({
  label: 'Arm IK Calibration',
  description:
    'Calibrates arm reach by touching index finger to eye corner. Uses two-bone IK to correct reach at runtime.',
  tags: ['calibration'],
  color: '#5a3a9f',
})
export class ArmIkCalibration {
  static readonly kind = 'arm_ik_calibration';
  static readonly inputPorts = [
    valuePort('pose', 'NormalizedPose'),
    eventPort('capture_left', 'Trigger'),
    eventPort('capture_right', 'Trigger'),
    eventPort('reset', 'Trigger'),
  ] as const;
  static readonly outputPorts = [valuePort('pose', 'NormalizedPose')] as const;

  static execute(
    inputs: InputsOf<typeof ArmIkCalibration>,
    config: ArmIkConfig,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof ArmIkCalibration> {
    const { triggeredPort } = ctx;
    const skeleton = config.skeleton;
    const pose = inputs.pose as NormalizedPose | undefined;

    // ── Capture ───────────────────────────────────────────────────────────────
    if (triggeredPort === 'capture_left' || triggeredPort === 'capture_right') {
      const side: 'left' | 'right' =
        triggeredPort === 'capture_left' ? 'left' : 'right';
      if (!pose || !skeleton) return {} as OutputsOf<typeof ArmIkCalibration>;

      const fk = computeFk(skeleton, poseToRotMap(pose));
      const calib = fitCalib(fk, side);
      if (!calib) {
        console.warn('[ArmIkCalibration] Missing bones for capture');
        return {} as OutputsOf<typeof ArmIkCalibration>;
      }

      const prev = ctx.getState<ArmIkState>() ?? {};
      ctx.setState({ ...prev, [side]: calib });
      console.log(
        `[ArmIkCalibration] Captured ${side}: scale=${calib.scale.toFixed(3)} offset=[${calib.offset.map((v) => v.toFixed(3)).join(', ')}]`
      );
      return {} as OutputsOf<typeof ArmIkCalibration>;
    }

    // ── Reset ─────────────────────────────────────────────────────────────────
    if (triggeredPort === 'reset') {
      ctx.setState({});
      return {} as OutputsOf<typeof ArmIkCalibration>;
    }

    // ── Normal pose (triggered or pulled) ────────────────────────────────────
    if (!pose) return {} as OutputsOf<typeof ArmIkCalibration>;
    const state = ctx.getState<ArmIkState>() ?? {};
    const hasCalib = ARMS.some((s) => state[s]);
    if (!hasCalib || !skeleton) return { pose };

    const fk = computeFk(skeleton, poseToRotMap(pose));
    const overrides: Record<string, Q4> = {};
    for (const side of ARMS) {
      const calib = state[side];
      if (!calib) continue;
      const result = applyArm(side, calib, fk, skeleton);
      if (!result) continue;
      overrides[result.upper] = result.upperRot;
      overrides[result.lower] = result.lowerRot;
    }
    const corrected = pose.map((q, bone: VRMBoneName) => {
      const ov = overrides[bone as string];
      return ov
        ? Quaternion.fromArray(ov as [number, number, number, number])
        : q;
    });
    return { pose: corrected };
  }
}
