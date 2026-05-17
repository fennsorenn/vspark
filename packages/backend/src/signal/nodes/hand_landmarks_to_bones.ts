import { SignalNode, eventPort, valuePort, mkEvent, Quaternion, NormalizedPose } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext, Event, VRMBoneName } from '@vspark/shared/signal'

type Landmark = { x: number; y: number; z: number; visibility?: number }

// MediaPipe Hand 21-point indices.
// https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
const HAND_IDX = {
  wrist:          0,
  thumbCmc:       1, thumbMcp:    2, thumbIp:     3, thumbTip:    4,
  indexMcp:       5, indexPip:    6, indexDip:    7, indexTip:    8,
  middleMcp:      9, middlePip:  10, middleDip:  11, middleTip:  12,
  ringMcp:       13, ringPip:    14, ringDip:    15, ringTip:    16,
  littleMcp:     17, littlePip: 18, littleDip:  19, littleTip:  20,
}

function vec(from: Landmark, to: Landmark): [number, number, number] {
  return [to.x - from.x, to.y - from.y, to.z - from.z]
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
  if (len < 1e-9) return [0, 0, 1]
  return [v[0] / len, v[1] / len, v[2] / len]
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function swingTo(target: [number, number, number]): Quaternion {
  const t = normalize(target)
  const ref: [number, number, number] = [0, 0, -1]
  const d = dot(ref, t)
  if (d > 0.9999) return Quaternion.IDENTITY
  if (d < -0.9999) return new Quaternion(1, 0, 0, 0)
  const axis = normalize(cross(ref, t))
  const angle = Math.acos(Math.max(-1, Math.min(1, d)))
  const s = Math.sin(angle / 2)
  return new Quaternion(axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2))
}

function segmentQuat(pts: Landmark[], from: number, to: number): Quaternion {
  return swingTo(normalize(vec(pts[from], pts[to])))
}

// Maps MediaPipe hand segments to VRM finger bone names for each side.
const SEGMENTS: Array<{ from: number; to: number; left: VRMBoneName; right: VRMBoneName }> = [
  { from: HAND_IDX.thumbCmc,   to: HAND_IDX.thumbMcp,    left: 'leftThumbMetacarpal',   right: 'rightThumbMetacarpal'   },
  { from: HAND_IDX.thumbMcp,   to: HAND_IDX.thumbIp,     left: 'leftThumbProximal',      right: 'rightThumbProximal'      },
  { from: HAND_IDX.thumbIp,    to: HAND_IDX.thumbTip,    left: 'leftThumbDistal',         right: 'rightThumbDistal'         },
  { from: HAND_IDX.indexMcp,   to: HAND_IDX.indexPip,    left: 'leftIndexProximal',       right: 'rightIndexProximal'       },
  { from: HAND_IDX.indexPip,   to: HAND_IDX.indexDip,    left: 'leftIndexIntermediate',   right: 'rightIndexIntermediate'   },
  { from: HAND_IDX.indexDip,   to: HAND_IDX.indexTip,    left: 'leftIndexDistal',          right: 'rightIndexDistal'          },
  { from: HAND_IDX.middleMcp,  to: HAND_IDX.middlePip,   left: 'leftMiddleProximal',       right: 'rightMiddleProximal'       },
  { from: HAND_IDX.middlePip,  to: HAND_IDX.middleDip,   left: 'leftMiddleIntermediate',   right: 'rightMiddleIntermediate'   },
  { from: HAND_IDX.middleDip,  to: HAND_IDX.middleTip,   left: 'leftMiddleDistal',          right: 'rightMiddleDistal'          },
  { from: HAND_IDX.ringMcp,    to: HAND_IDX.ringPip,     left: 'leftRingProximal',          right: 'rightRingProximal'          },
  { from: HAND_IDX.ringPip,    to: HAND_IDX.ringDip,     left: 'leftRingIntermediate',       right: 'rightRingIntermediate'       },
  { from: HAND_IDX.ringDip,    to: HAND_IDX.ringTip,     left: 'leftRingDistal',              right: 'rightRingDistal'              },
  { from: HAND_IDX.littleMcp,  to: HAND_IDX.littlePip,   left: 'leftLittleProximal',          right: 'rightLittleProximal'          },
  { from: HAND_IDX.littlePip,  to: HAND_IDX.littleDip,   left: 'leftLittleIntermediate',       right: 'rightLittleIntermediate'       },
  { from: HAND_IDX.littleDip,  to: HAND_IDX.littleTip,   left: 'leftLittleDistal',              right: 'rightLittleDistal'              },
]

function convertHand(pts: Landmark[], side: 'left' | 'right'): NormalizedPose {
  if (pts.length < 21) return new NormalizedPose()
  const entries: [VRMBoneName, Quaternion][] = SEGMENTS.map((seg) => [
    side === 'left' ? seg.left : seg.right,
    segmentQuat(pts, seg.from, seg.to),
  ])
  return new NormalizedPose(entries)
}

interface HandConfig {
  side?: 'left' | 'right'
  enabled?: boolean
}

@SignalNode({
  label:       'Hand Landmarks → Bones',
  description: 'Converts MediaPipe 21-point hand landmarks to VRM finger joint quaternions.',
  tags:        ['tracking', 'mapping'],
  color:       '#4a5a8a',
})
export class HandLandmarksToBones {
  static readonly kind        = 'hand_landmarks_to_bones'
  static readonly inputPorts  = [
    eventPort('landmarks', 'LandmarkList'),
    valuePort('side',      'String'),
  ] as const
  static readonly outputPorts = [
    eventPort('out',  'NormalizedPose'),
    valuePort('pose', 'NormalizedPose'),
  ] as const

  static execute(
    inputs: InputsOf<typeof HandLandmarksToBones>,
    config: unknown,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof HandLandmarksToBones> {
    const evt  = inputs.landmarks as Event<Landmark[]> | undefined
    if (!evt?.payload) return {} as OutputsOf<typeof HandLandmarksToBones>

    const cfg  = (config ?? {}) as HandConfig
    const side = (inputs.side as string | undefined) ?? cfg.side ?? 'left'
    const pose = convertHand(evt.payload, side as 'left' | 'right')
    ctx.setState(pose)
    return { out: mkEvent(pose, evt.timestamp), pose }
  }
}
