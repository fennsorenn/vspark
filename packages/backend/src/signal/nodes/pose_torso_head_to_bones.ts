import { SignalNode, valuePort, Quaternion, NormalizedPose } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext, VRMBoneName } from '@vspark/shared/signal'

type Landmark = { x: number; y: number; z: number; visibility?: number }
type V3 = [number, number, number]

const BP = {
  nose:          0,
  leftEar:       7,  rightEar:      8,
  leftShoulder:  11, rightShoulder: 12,
  leftHip:       23, rightHip:      24,
}

const VIS = 0.5
const ok = (lm: Landmark): boolean => (lm.visibility ?? 1) >= VIS

function sub(a: Landmark, b: Landmark): V3 { return [a.x-b.x, a.y-b.y, a.z-b.z] }
function lenV(v: V3): number { return Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]) }
function norm(v: V3): V3 { const l = lenV(v); return l < 1e-9 ? [0,1,0] : [v[0]/l,v[1]/l,v[2]/l] }
function dot(a: V3, b: V3): number { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2] }
function cross(a: V3, b: V3): V3 {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
}
function mid(a: Landmark, b: Landmark): Landmark {
  return { x:(a.x+b.x)/2, y:(a.y+b.y)/2, z:(a.z+b.z)/2 }
}

function qmul(a: Quaternion, b: Quaternion): Quaternion {
  return new Quaternion(
    a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
    a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,
    a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z,
  )
}
function qinv(q: Quaternion): Quaternion { return new Quaternion(-q.x,-q.y,-q.z,q.w) }

// Slerp from identity to q by factor t. Result q' satisfies q'^(1/t) = q (for small angles).
// Used to split a single body rotation across multiple spine bones so the bend distributes
// instead of concentrating in one joint.
function qSlerpFromIdentity(q: Quaternion, t: number): Quaternion {
  let w = q.w
  // Take the shorter arc — flip sign if w < 0 (q and -q represent the same rotation).
  const sign = w < 0 ? -1 : 1
  w *= sign
  if (w > 0.9999) return new Quaternion(0, 0, 0, 1)
  const angle = Math.acos(w)
  const sinA  = Math.sin(angle)
  const a = Math.sin((1 - t) * angle) / sinA   // weight on identity
  const b = Math.sin(t * angle) / sinA         // weight on q
  return new Quaternion(
    sign * b * q.x,
    sign * b * q.y,
    sign * b * q.z,
    a + sign * b * q.w,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// frameToQuat(rightTarget, upTarget):
//
// Builds the quaternion R such that:
//   R × [1,0,0] = rightTarget   (VRM +X axis, exact)
//   R × [0,1,0] ≈ upTarget      (VRM +Y axis, Gram-Schmidt orthogonalised)
//   R × [0,0,-1] = derived      (VRM forward = -Z, fully derived)
//
// Using rightTarget as primary (exact) is optimal for the head because
// ear-to-ear gives the most reliable lateral axis.
//
// Uses Shepperd's method on the column-major rotation matrix.
// Column 0 = rightTarget (image of [1,0,0])
// Column 1 = upOrtho     (image of [0,1,0])
// Column 2 = -forward    (image of [0,0,1] = back of head)
// ─────────────────────────────────────────────────────────────────────────────
function frameToQuat(rightTarget: V3, upTarget: V3): Quaternion {
  const X = norm(rightTarget)
  // Orthogonalise upTarget against X
  const d = dot(upTarget, X)
  const upOrtho: V3 = [upTarget[0]-X[0]*d, upTarget[1]-X[1]*d, upTarget[2]-X[2]*d]
  const Y = norm(upOrtho)
  // col2 = image of [0,0,1] (VRM back = away from camera in world = -Z world).
  // cross(Y, X) = up × right = -Z in right-hand convention.
  const col2 = norm(cross(X, Y))

  // Column-major matrix: col0=X, col1=Y, col2=col2
  // Shepperd for column-major:
  //   trace = X[0] + Y[1] + Zneg[2]
  //   qx = (Y[2]    - Zneg[1]) / 4qw
  //   qy = (Zneg[0] - X[2]   ) / 4qw
  //   qz = (X[1]    - Y[0]   ) / 4qw
  const trace = X[0] + Y[1] + col2[2]
  let qx: number, qy: number, qz: number, qw: number
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    qw = 0.25/s
    qx = (Y[2]     - col2[1]) * s
    qy = (col2[0]  - X[2]   ) * s
    qz = (X[1]     - Y[0]   ) * s
  } else if (X[0] > Y[1] && X[0] > col2[2]) {
    const s = 2 * Math.sqrt(1 + X[0] - Y[1] - col2[2])
    qw = (Y[2]     - col2[1]) / s
    qx = 0.25 * s
    qy = (Y[0]     + X[1]   ) / s
    qz = (col2[0]  + X[2]   ) / s
  } else if (Y[1] > col2[2]) {
    const s = 2 * Math.sqrt(1 + Y[1] - X[0] - col2[2])
    qw = (col2[0]  - X[2]   ) / s
    qx = (Y[0]     + X[1]   ) / s
    qy = 0.25 * s
    qz = (col2[1]  + Y[2]   ) / s
  } else {
    const s = 2 * Math.sqrt(1 + col2[2] - X[0] - Y[1])
    qw = (X[1]     - Y[0]   ) / s
    qx = (col2[0]  + X[2]   ) / s
    qy = (col2[1]  + Y[2]   ) / s
    qz = 0.25 * s
  }
  const l = Math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw)
  return new Quaternion(qx/l, qy/l, qz/l, qw/l)
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate conventions:
//
// MediaPipe poseWorldLandmarks:
//   Origin: hip midpoint. +Y=up, +Z=toward camera, +X=subject's right.
//
// VRM normalised pose T-pose (all bones at identity):
//   Spine/neck: +Y points up (toward crown), character faces -Z.
//
// For the spine: right = shoulder_right, up = spine_dir, forward derived.
// For the head:  right = ear-to-ear, up = derived from sagittal, forward derived.
//
// We use frameToQuat(right, up) which keeps rightTarget exact and orthogonalises up.
// ─────────────────────────────────────────────────────────────────────────────

// MediaPipe world landmarks: +Y down (image convention) and +Z away from camera. Flip both
// at the boundary so we work in the avatar's natural frame: +Y up, -Z = subject's front.
// Matches pose_arms_to_bones so arms and torso/head share one coordinate system.
function flipYZ(lm: Landmark): Landmark {
  return { x: lm.x, y: -lm.y, z: -lm.z, visibility: lm.visibility }
}

// Decompose a unit quaternion into XYZ Euler angles (intrinsic, applied in order X then Y then Z).
// Used to scale each head-rotation axis independently for gain calibration.
function quatToEulerXYZ(q: Quaternion): { x: number; y: number; z: number } {
  // Standard rotation-matrix-from-quaternion derivation, then extract XYZ Eulers.
  const x = q.x, y = q.y, z = q.z, w = q.w
  const m11 = 1 - 2*(y*y + z*z)
  const m12 = 2*(x*y - z*w)
  const m13 = 2*(x*z + y*w)
  const m23 = 2*(y*z - x*w)
  const m33 = 1 - 2*(x*x + y*y)
  // Y rotation comes from arcsin(m13). Clamp to avoid NaN at the gimbal-lock boundaries.
  const sy = Math.max(-1, Math.min(1, m13))
  const ey = Math.asin(sy)
  let ex: number, ez: number
  if (Math.abs(m13) < 0.9999) {
    ex = Math.atan2(-m23, m33)
    ez = Math.atan2(-m12, m11)
  } else {
    ex = Math.atan2(2*(y*z + x*w), 1 - 2*(x*x + z*z))
    ez = 0
  }
  return { x: ex, y: ey, z: ez }
}

function eulerXYZToQuat(ex: number, ey: number, ez: number): Quaternion {
  const cx = Math.cos(ex/2), sx = Math.sin(ex/2)
  const cy = Math.cos(ey/2), sy = Math.sin(ey/2)
  const cz = Math.cos(ez/2), sz = Math.sin(ez/2)
  // XYZ order: q = qz * qy * qx
  return new Quaternion(
    sx*cy*cz + cx*sy*sz,
    cx*sy*cz - sx*cy*sz,
    cx*cy*sz + sx*sy*cz,
    cx*cy*cz - sx*sy*sz,
  )
}

function convertPose(rawPts: Landmark[], calib: { pitchGain: number; yawGain: number; rollGain: number; restPitch: number }): NormalizedPose {
  if (rawPts.length < 33) return new NormalizedPose()
  const pts = rawPts.map(flipYZ)

  const ls   = pts[BP.leftShoulder],  rs   = pts[BP.rightShoulder]
  const lh   = pts[BP.leftHip],       rh   = pts[BP.rightHip]
  const nose = pts[BP.nose]
  const lEar = pts[BP.leftEar],       rEar = pts[BP.rightEar]

  const entries: [VRMBoneName, Quaternion][] = []

  if (!ok(ls) || !ok(rs)) return new NormalizedPose()

  const shdMid   = mid(ls, rs)
  // In MediaPipe world landmarks, rightShoulder.x < leftShoulder.x (mirrored convention).
  // sub(ls, rs) gives the vector pointing in +X (subject's right).
  const shdRight = norm(sub(ls, rs))

  // ── Torso ─────────────────────────────────────────────────────────────────
  let spineUp: V3
  if (ok(lh) && ok(rh)) {
    spineUp = norm(sub(shdMid, mid(lh, rh)))
  } else {
    // Project [0,1,0] onto plane perpendicular to shdRight
    const t = dot([0,1,0] as V3, shdRight)
    spineUp = norm([0-shdRight[0]*t, 1-shdRight[1]*t, 0-shdRight[2]*t])
  }
  const torsoQ = frameToQuat(shdRight, spineUp)

  // Hips are intentionally left at identity so the legs and root position stay anchored.
  // The torso rotation is split across spine + chest as two local rotations whose product
  // is torsoQ, so the upper body bends through the spine rather than the hips.
  //
  //   chest_world = spine_local * chest_local = torsoQ
  //
  // We give each bone the same "half" rotation. Since both rotations are around the same axis,
  // half * half = full. That gives a natural distribution of the bend across the spine.
  const halfQ = qSlerpFromIdentity(torsoQ, 0.5)
  entries.push(['spine', halfQ])
  entries.push(['chest', halfQ])

  // ── Head ─────────────────────────────────────────────────────────────────
  {
    let headRight: V3
    let headUp: V3

    if (ok(lEar) && ok(rEar) && ok(nose)) {
      // In unified +Y-up, -Z-forward frame:
      //   leftEar  → +X side of head; rightEar → -X side.
      //   sub(lEar, rEar) points in +X (head right).
      headRight = norm(sub(lEar, rEar))

      // earMid → nose at neutral pose ≈ [0, -anatomicalDrop, -1]. The nose sits ~9° below
      // the horizontal ear plane, which we correct by rotating the sagittal-plane projection
      // back up around headRight.
      const earMid = mid(lEar, rEar)
      const rawToNose = norm(sub(nose, earMid))
      const dNose = dot(rawToNose, headRight)
      const sagNose: V3 = norm([
        rawToNose[0]-headRight[0]*dNose,
        rawToNose[1]-headRight[1]*dNose,
        rawToNose[2]-headRight[2]*dNose,
      ])

      // Rodrigues rotation of sagNose around headRight by REST (radians). With sagNose pointing
      // down+forward at neutral gaze ([0, -y, +z], y,z > 0) and rotation axis = +X, a NEGATIVE
      // angle lifts the direction toward horizontal. Magnitude is anatomy-dependent; surfaced
      // as a calibration knob.
      const REST = calib.restPitch
      const cosR = Math.cos(REST), sinR = Math.sin(REST)
      const hx = headRight[0], hy = headRight[1], hz = headRight[2]
      const sx = sagNose[0],   sy = sagNose[1],   sz = sagNose[2]
      const crs = cross(headRight, sagNose)
      const dp  = dot(headRight, sagNose)
      const corrected: V3 = [
        sx*cosR + crs[0]*sinR + hx*dp*(1-cosR),
        sy*cosR + crs[1]*sinR + hy*dp*(1-cosR),
        sz*cosR + crs[2]*sinR + hz*dp*(1-cosR),
      ]
      const correctedNorm = norm(corrected)  // ≈ headForward at neutral (+Z in this frame)
      // headUp = cross(headForward, headRight). cross([0,0,1], [1,0,0]) = [0,1,0]. ✓
      headUp = norm(cross(correctedNorm, headRight))
    } else if (ok(nose)) {
      headRight = shdRight
      const t = dot([0,1,0] as V3, headRight)
      headUp = norm([0-headRight[0]*t, 1-headRight[1]*t, 0-headRight[2]*t])
    } else {
      return new NormalizedPose(entries)
    }

    const worldHeadQ = frameToQuat(headRight, headUp)
    // Express relative to chest so it compounds correctly
    const localHeadQ = qmul(qinv(torsoQ), worldHeadQ)

    // Decompose to XYZ Euler in chest-local space, apply per-axis gain, recompose.
    // This lets us amplify each rotation axis independently to compensate MediaPipe's damping.
    const e = quatToEulerXYZ(localHeadQ)
    const calibratedHeadQ = eulerXYZToQuat(
      e.x * calib.pitchGain,
      e.y * calib.yawGain,
      e.z * calib.rollGain,
    )

    // Only set neck — head is its child and inherits.
    entries.push(['neck', calibratedHeadQ])
  }

  return new NormalizedPose(entries)
}

interface HeadCalibration {
  pitchGain: number   // multiplier on nod angle (X-axis rotation)
  yawGain:   number   // multiplier on turn angle (Y)
  rollGain:  number   // multiplier on tilt angle (Z)
  restPitch: number   // radians added to the nod axis to compensate anatomical neutral offset
}

@SignalNode({
  label:       'Pose → Torso/Head Bones',
  description: 'Converts MediaPipe BlazePose 33-point world landmarks to VRM torso (spine+chest) + head (neck) local rotations. Hips are left at identity so legs stay anchored. Pitch/yaw/roll gain inputs amplify head rotation axes to compensate MediaPipe damping; `restPitch` shifts the nod neutral.',
  tags:        ['tracking', 'mapping'],
  color:       '#4a5a8a',
})
export class PoseTorsoHeadToBones {
  static readonly kind        = 'pose_torso_head_to_bones'
  static readonly inputPorts  = [
    valuePort('pose',      'LandmarkList'),
    valuePort('enabled',   'Bool'),
    valuePort('pitchGain', 'Float'),
    valuePort('yawGain',   'Float'),
    valuePort('rollGain',  'Float'),
    valuePort('restPitch', 'Float'),
  ] as const
  static readonly outputPorts = [valuePort('pose', 'NormalizedPose')] as const

  static execute(
    inputs: InputsOf<typeof PoseTorsoHeadToBones>,
    _config: unknown,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof PoseTorsoHeadToBones> {
    const enabledIn = inputs.enabled as boolean | null | undefined
    const enabled = enabledIn ?? true
    if (!enabled) return { pose: new NormalizedPose() }
    const pts = inputs.pose as Landmark[] | undefined
    if (!pts?.length) return {} as OutputsOf<typeof PoseTorsoHeadToBones>
    const numIn = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v)) ? v : d
    const calib: HeadCalibration = {
      pitchGain: numIn(inputs.pitchGain, 2.0),
      yawGain:   numIn(inputs.yawGain,   1.0),
      rollGain:  numIn(inputs.rollGain,  1.0),
      restPitch: numIn(inputs.restPitch, -0.43),
    }
    return { pose: convertPose(pts, calib) }
  }
}
