import { SignalNode, valuePort, Blendshapes } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'

type Landmark = { x: number; y: number; z: number; visibility?: number }

// MediaPipe FaceMesh 478-point indices used for expression estimation.
// See: https://github.com/google/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model_uv_visualization.png
const IDX = {
  // Lips
  upperLipTop:    13,
  lowerLipBot:    14,
  lipLeftCorner:  61,
  lipRightCorner: 291,
  upperLipLeft:   40,
  upperLipRight:  270,
  // Jaw / chin
  chin:           152,
  noseTip:        1,
  // Eyes
  leftEyeTop:     159,
  leftEyeBot:     145,
  leftEyeOuter:   33,
  leftEyeInner:   133,
  rightEyeTop:    386,
  rightEyeBot:    374,
  rightEyeOuter:  263,
  rightEyeInner:  362,
  // Eyebrows
  leftBrowInner:  107,
  leftBrowOuter:  70,
  rightBrowInner: 336,
  rightBrowOuter: 300,
  // Reference
  leftCheek:      234,
  rightCheek:     454,
}

function dist(a: Landmark, b: Landmark): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function estimateBlendshapes(pts: Landmark[]): Blendshapes {
  if (pts.length < 478) return new Blendshapes()

  const faceWidth = dist(pts[IDX.leftCheek], pts[IDX.rightCheek])
  if (faceWidth < 1e-6) return new Blendshapes()

  // Mouth openness: vertical lip gap / face width
  const lipGap   = dist(pts[IDX.upperLipTop], pts[IDX.lowerLipBot])
  const jawOpen   = clamp01((lipGap / faceWidth - 0.02) * 8)

  // Mouth width: horizontal lip span / face width
  const lipWidth  = dist(pts[IDX.lipLeftCorner], pts[IDX.lipRightCorner])
  const mouthWide = clamp01((lipWidth / faceWidth - 0.3) * 4)

  // Upper lip raise relative to lip-corner height
  const cornerY   = (pts[IDX.lipLeftCorner].y + pts[IDX.lipRightCorner].y) / 2
  const upperY    = pts[IDX.upperLipTop].y
  const lipRaise  = clamp01((cornerY - upperY) / faceWidth * 6)

  // Vowel shape estimation from jaw + lip geometry
  // A: open jaw, medium width
  const vowelA = clamp01(jawOpen * (1 - mouthWide * 0.5))
  // E: wide mouth, reduced jaw
  const vowelE = clamp01(mouthWide * (1 - jawOpen * 0.4))
  // I: narrow mouth, slight jaw, raised upper lip
  const vowelI = clamp01(lipRaise * (1 - mouthWide * 0.6))
  // O: round (jaw open, narrow)
  const vowelO = clamp01(jawOpen * (1 - mouthWide * 0.8) * 1.2)
  // U: pursed (narrow + low jaw)
  const vowelU = clamp01((1 - mouthWide) * jawOpen * 0.6)

  // Eye blink: vertical eye aperture / face width
  const leftEyeH  = dist(pts[IDX.leftEyeTop],  pts[IDX.leftEyeBot])
  const rightEyeH = dist(pts[IDX.rightEyeTop], pts[IDX.rightEyeBot])
  const leftBlink  = clamp01(1 - (leftEyeH  / faceWidth) * 8)
  const rightBlink = clamp01(1 - (rightEyeH / faceWidth) * 8)

  // Eyebrow raise: brow-to-eye distance relative to face
  const leftBrowH  = dist(pts[IDX.leftBrowInner],  pts[IDX.leftEyeTop])
  const rightBrowH = dist(pts[IDX.rightBrowInner], pts[IDX.rightEyeTop])
  const browRaise  = clamp01(((leftBrowH + rightBrowH) / 2 / faceWidth - 0.05) * 6)

  return Blendshapes.fromRecord({
    // Jaw
    jawOpen,
    // Vowel shapes → VRM Fcl morph targets
    Fcl_MTH_A: clamp01(vowelA * 1.2),
    Fcl_MTH_E: clamp01(vowelE * 1.2),
    Fcl_MTH_I: clamp01(vowelI * 1.2),
    Fcl_MTH_O: clamp01(vowelO * 1.2),
    Fcl_MTH_U: clamp01(vowelU * 1.2),
    // Eye blink
    Fcl_EYE_Close_L: leftBlink,
    Fcl_EYE_Close_R: rightBlink,
    eyeBlinkLeft:    leftBlink,
    eyeBlinkRight:   rightBlink,
    // Brow
    browInnerUp: browRaise,
  })
}

@SignalNode({
  label:       'Face Landmarks → Blendshapes',
  description: 'Converts MediaPipe 478-point face landmarks to VRM expression weights (mouth vowels, eye blink, brow raise).',
  tags:        ['tracking', 'mapping'],
  color:       '#4a5a8a',
})
export class FaceLandmarksToBlendshapes {
  static readonly kind        = 'face_landmarks_to_blendshapes'
  static readonly inputPorts  = [valuePort('face', 'LandmarkList')] as const
  static readonly outputPorts = [valuePort('blendshapes', 'Blendshapes')] as const

  static execute(
    inputs: InputsOf<typeof FaceLandmarksToBlendshapes>,
    _config: unknown,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof FaceLandmarksToBlendshapes> {
    const pts = inputs.face as Landmark[] | undefined
    if (!pts?.length) return {} as OutputsOf<typeof FaceLandmarksToBlendshapes>
    return { blendshapes: estimateBlendshapes(pts) }
  }
}
