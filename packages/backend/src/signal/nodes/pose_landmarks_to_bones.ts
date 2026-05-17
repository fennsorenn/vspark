import { SignalNode, eventPort, valuePort, mkEvent, Quaternion, NormalizedPose } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext, Event, VRMBoneName } from '@vspark/shared/signal'

type Landmark = { x: number; y: number; z: number; visibility?: number }

// BlazePose 33-point landmark indices (world coordinates).
// https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
const BP = {
  nose:           0,
  leftShoulder:   11,
  rightShoulder:  12,
  leftElbow:      13,
  rightElbow:     14,
  leftWrist:      15,
  rightWrist:     16,
  leftHip:        23,
  rightHip:       24,
  leftKnee:       25,
  rightKnee:      26,
  leftAnkle:      27,
  rightAnkle:     28,
}

function vec(from: Landmark, to: Landmark): [number, number, number] {
  return [to.x - from.x, to.y - from.y, to.z - from.z]
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
  if (len < 1e-9) return [0, 0, 1]
  return [v[0] / len, v[1] / len, v[2] / len]
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// Build a quaternion that rotates reference direction [0,0,-1] onto target direction.
function swingTo(target: [number, number, number]): Quaternion {
  const t = normalize(target)
  const ref: [number, number, number] = [0, 0, -1]
  const d = dot(ref, t)
  if (d > 0.9999) return Quaternion.IDENTITY
  if (d < -0.9999) return new Quaternion(1, 0, 0, 0) // 180° flip
  const axis = normalize(cross(ref, t))
  const angle = Math.acos(Math.max(-1, Math.min(1, d)))
  const s = Math.sin(angle / 2)
  return new Quaternion(axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2))
}

// Rotate from parent space into child direction, yielding a local delta quaternion.
function limbRotation(
  from: Landmark,
  to:   Landmark,
  parentQuat: Quaternion,
): Quaternion {
  const worldDir = normalize(vec(from, to))
  // Express direction in parent local space.
  const invParent = parentQuat.invert()
  const rotated: [number, number, number] = [0, 0, 0]
  // Rotate worldDir by invParent (qvq*).
  const qx = invParent.x, qy = invParent.y, qz = invParent.z, qw = invParent.w
  const ix =  qw * worldDir[0] + qy * worldDir[2] - qz * worldDir[1]
  const iy =  qw * worldDir[1] + qz * worldDir[0] - qx * worldDir[2]
  const iz =  qw * worldDir[2] + qx * worldDir[1] - qy * worldDir[0]
  const iw = -qx * worldDir[0] - qy * worldDir[1] - qz * worldDir[2]
  rotated[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy
  rotated[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz
  rotated[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx
  return swingTo(rotated as [number, number, number])
}

function convertPose(pts: Landmark[]): NormalizedPose {
  if (pts.length < 33) return new NormalizedPose()

  const ls = pts[BP.leftShoulder]
  const rs = pts[BP.rightShoulder]
  const lh = pts[BP.leftHip]
  const rh = pts[BP.rightHip]

  // Spine direction: hips-mid to shoulders-mid.
  const hipMid  = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2, z: (lh.z + rh.z) / 2 }
  const shdMid  = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, z: (ls.z + rs.z) / 2 }
  const spineQ  = swingTo(normalize(vec(hipMid, shdMid)))

  // Upper arms relative to spine.
  const leftUpperArmQ  = limbRotation(ls, pts[BP.leftElbow],  spineQ)
  const rightUpperArmQ = limbRotation(rs, pts[BP.rightElbow], spineQ)

  // Forearms relative to upper arm world orientation.
  const leftWorldUpper  = spineQ.multiply(leftUpperArmQ)
  const rightWorldUpper = spineQ.multiply(rightUpperArmQ)
  const leftLowerArmQ   = limbRotation(pts[BP.leftElbow],  pts[BP.leftWrist],  leftWorldUpper)
  const rightLowerArmQ  = limbRotation(pts[BP.rightElbow], pts[BP.rightWrist], rightWorldUpper)

  const entries: [VRMBoneName, Quaternion][] = [
    ['spine',         spineQ],
    ['chest',         spineQ],
    ['leftUpperArm',  leftUpperArmQ],
    ['rightUpperArm', rightUpperArmQ],
    ['leftLowerArm',  leftLowerArmQ],
    ['rightLowerArm', rightLowerArmQ],
  ]

  return new NormalizedPose(entries)
}

@SignalNode({
  label:       'Pose Landmarks → Bones',
  description: 'Converts MediaPipe BlazePose 33-point world landmarks to VRM upper-body bone quaternions.',
  tags:        ['tracking', 'mapping'],
  color:       '#4a5a8a',
})
export class PoseLandmarksToBones {
  static readonly kind        = 'pose_landmarks_to_bones'
  static readonly inputPorts  = [eventPort('pose', 'LandmarkList')] as const
  static readonly outputPorts = [
    eventPort('out',  'NormalizedPose'),
    valuePort('pose', 'NormalizedPose'),
  ] as const

  static execute(
    inputs: InputsOf<typeof PoseLandmarksToBones>,
    _config: unknown,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof PoseLandmarksToBones> {
    const evt = inputs.pose as Event<Landmark[]> | undefined
    if (!evt?.payload) return {} as OutputsOf<typeof PoseLandmarksToBones>

    const pose = convertPose(evt.payload)
    ctx.setState(pose)
    return { out: mkEvent(pose, evt.timestamp), pose }
  }
}
