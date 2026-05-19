import { SignalNode, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { IkTarget, IkTargetFrame } from '@vspark/shared/types'

type Landmark = { x: number; y: number; z: number; visibility?: number }
type Vec3 = [number, number, number]

// Minimum alpha fraction applied when visibility → 0 (prevents the EMA from freezing).
const MIN_ALPHA_FRACTION = 0.05

// BlazePose 33-point world landmark indices.
const BP = {
  leftShoulder:  11, rightShoulder: 12,
  leftElbow:     13, rightElbow:    14,
  leftWrist:     15, rightWrist:    16,
  leftHip:       23, rightHip:      24,
  // Hand landmarks (within hand arrays, index 0 = wrist, 8 = index tip)
}

// Per-node EMA state stored via NodeExecutionContext.getState/setState.
type SmoothedVec = { x: number; y: number; z: number; initialised: boolean }
type EmaState = Map<string, SmoothedVec>

function getOrCreateVec(state: EmaState, label: string): SmoothedVec {
  if (!state.has(label)) state.set(label, { x: 0, y: 0, z: 0, initialised: false })
  return state.get(label)!
}

function emaUpdate(state: SmoothedVec, x: number, y: number, z: number, alpha: number): Vec3 {
  if (!state.initialised) {
    state.x = x; state.y = y; state.z = z; state.initialised = true
  } else {
    state.x += alpha * (x - state.x)
    state.y += alpha * (y - state.y)
    state.z += alpha * (z - state.z)
  }
  return [state.x, state.y, state.z]
}

function vis(lm: Landmark): number { return lm.visibility ?? 1 }


// Hand landmarks are in image-normalized space (0–1 x/y, z relative to wrist).
// We approximate hand-local finger tip positions from the hand landmark array
// by taking the vector from wrist (index 0) to index tip (index 8).
// These are relative to the wrist so we tack them onto the wrist IK position.
const HAND_WRIST_IDX = 0
const INDEX_TIP_IDX  = 8

// Outstretched-ness heuristic: largest distance from wrist to any fingertip.
// Finger tip indices: thumb=4, index=8, middle=12, ring=16, little=20.
const FINGER_TIPS = [4, 8, 12, 16, 20]

function mostOutstretchedTip(hand: Landmark[]): { idx: number; dist: number } {
  const wrist = hand[HAND_WRIST_IDX]
  let best = { idx: INDEX_TIP_IDX, dist: 0 }
  for (const idx of FINGER_TIPS) {
    if (!hand[idx]) continue
    const dx = hand[idx].x - wrist.x
    const dy = hand[idx].y - wrist.y
    const dz = hand[idx].z - wrist.z
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d > best.dist) best = { idx, dist: d }
  }
  return best
}

interface PoseIkConfig {
  /** EMA smoothing alpha at full visibility: 0 = frozen, 1 = no smoothing. Default 0.25. */
  smoothing?: number
  /** VRM bone used as coordinate origin for all targets. Default 'chest'. */
  referenceBone?: string
}

@SignalNode({
  label:       'Pose IK Targets',
  description: 'Converts MediaPipe world-space pose landmarks into IK target positions (relative to a reference bone) with per-target chain definitions. Includes EMA smoothing to reduce jitter. Calibration (per-axis scale/offset/invert) arrives via input ports — wire `component_config` nodes for each.',
  tags:        ['tracking', 'mapping'],
  color:       '#6a4a9a',
})
export class PoseIkTargets {
  static readonly kind        = 'pose_ik_targets'
  static readonly inputPorts  = [
    valuePort('pose',      'LandmarkList'),
    valuePort('leftHand',  'LandmarkList'),
    valuePort('rightHand', 'LandmarkList'),
    valuePort('enabled',   'Bool'),
    valuePort('xScale',    'Float'), valuePort('yScale',  'Float'), valuePort('zScale',  'Float'),
    valuePort('xOffset',   'Float'), valuePort('yOffset', 'Float'), valuePort('zOffset', 'Float'),
    valuePort('invertX',   'Bool'), valuePort('invertY', 'Bool'), valuePort('invertZ', 'Bool'),
  ] as const
  static readonly outputPorts = [valuePort('targets', 'IkTargets')] as const

  static execute(
    inputs: InputsOf<typeof PoseIkTargets>,
    config: unknown,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof PoseIkTargets> {
    const enabled = (inputs.enabled as boolean | null | undefined) ?? true
    if (!enabled) return {} as OutputsOf<typeof PoseIkTargets>

    const rawPose      = inputs.pose      as Landmark[] | undefined
    const rawLeftHand  = inputs.leftHand  as Landmark[] | undefined
    const rawRightHand = inputs.rightHand as Landmark[] | undefined

    if (!rawPose?.length) return {} as OutputsOf<typeof PoseIkTargets>

    // MediaPipe world landmarks have +Y down; flip to +Y up so chest-relative offsets are in standard frame.
    const flipY = (lm: Landmark): Landmark => ({ x: lm.x, y: -lm.y, z: lm.z, visibility: lm.visibility })
    const pose      = rawPose.map(flipY)
    const leftHand  = rawLeftHand?.map(flipY)
    const rightHand = rawRightHand?.map(flipY)

    const cfg     = (config ?? {}) as PoseIkConfig
    const alpha   = Math.max(0, Math.min(1, cfg.smoothing ?? 0.25))
    const refBone = cfg.referenceBone ?? 'chest'

    // Calibration values arrive via input ports (each wired to a component_config node).
    // Falsy/null inputs fall back to sensible defaults — z=3 to compensate MediaPipe's compressed depth.
    const numIn = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v)) ? v : d
    const boolIn = (v: unknown): boolean => v === true
    const sx = numIn(inputs.xScale, 1) * (boolIn(inputs.invertX) ? -1 : 1)
    const sy = numIn(inputs.yScale, 1) * (boolIn(inputs.invertY) ? -1 : 1)
    const sz = numIn(inputs.zScale, 3) * (boolIn(inputs.invertZ) ? -1 : 1)
    const ox = numIn(inputs.xOffset, 0)
    const oy = numIn(inputs.yOffset, 0)
    const oz = numIn(inputs.zOffset, 0)
    const prev = ctx.getState<EmaState>()
    const emaState: EmaState = prev instanceof Map ? prev : new Map()
    ctx.setState(emaState)

    const targets: IkTarget[] = []

    const ls  = pose[BP.leftShoulder]
    const rs  = pose[BP.rightShoulder]
    const le  = pose[BP.leftElbow]
    const re  = pose[BP.rightElbow]
    const lw  = pose[BP.leftWrist]
    const rw  = pose[BP.rightWrist]
    const lhp = pose[BP.leftHip]
    const rhp = pose[BP.rightHip]

    // Chest position approximation: midpoint of shoulders (same calculation as
    // pose_landmarks_to_bones, consistent with the reference bone used on the frontend).
    const chestX = (ls.x + rs.x) / 2
    const chestY = (ls.y + rs.y) / 2
    const chestZ = (ls.z + rs.z) / 2
    // Hip midpoint for hip-relative mode
    const hipX = (lhp.x + rhp.x) / 2
    const hipY = (lhp.y + rhp.y) / 2
    const hipZ = (lhp.z + rhp.z) / 2

    // Origin for position offsets
    const originX = refBone === 'hips' ? hipX : chestX
    const originY = refBone === 'hips' ? hipY : chestY
    const originZ = refBone === 'hips' ? hipZ : chestZ

    // side: 'left' | 'right' | 'center' — controls X offset symmetry.
    // Symmetric X means left-side targets are pushed +ox and right-side targets -ox,
    // so a positive xOffset spreads hands outward.
    function toRefSpace(lm: Landmark, side: 'left' | 'right' | 'center'): Vec3 {
      const sideSign = side === 'left' ? 1 : side === 'right' ? -1 : 0
      return [
        (lm.x - originX) * sx + ox * sideSign,
        (lm.y - originY) * sy + oy,
        (lm.z - originZ) * sz + oz,
      ]
    }

    function addTarget(
      label: string,
      lm: Landmark,
      confidence: number,
      bone: string,
      chain: string[],
      side: 'left' | 'right' | 'center',
    ) {
      // Visibility-weighted alpha: low-confidence landmarks get much heavier smoothing.
      const effectiveAlpha = alpha * Math.max(MIN_ALPHA_FRACTION, confidence)
      const raw = toRefSpace(lm, side)
      const state = getOrCreateVec(emaState, label)
      const pos = emaUpdate(state, raw[0], raw[1], raw[2], effectiveAlpha)
      targets.push({ bone, chain, position: pos, confidence })
    }

    // ── Arms — always emit, no visibility gate ────────────────────────────────
    addTarget('left_elbow',  le, vis(le), 'leftLowerArm',  ['leftUpperArm', 'leftLowerArm'], 'left')
    addTarget('left_wrist',  lw, vis(lw), 'leftHand',      ['leftUpperArm', 'leftLowerArm', 'leftHand'], 'left')
    addTarget('right_elbow', re, vis(re), 'rightLowerArm', ['rightUpperArm', 'rightLowerArm'], 'right')
    addTarget('right_wrist', rw, vis(rw), 'rightHand',     ['rightUpperArm', 'rightLowerArm', 'rightHand'], 'right')

    // ── Left finger tip (index tip + most outstretched) ──────────────────────
    if (leftHand && leftHand.length >= 21) {
      const { idx } = mostOutstretchedTip(leftHand)
      const tipLm = leftHand[idx]
      // Hand landmarks are wrist-relative in image space — approximate world
      // position by adding scaled hand-local offset to the wrist world position.
      // The scale factor is approximate (hand ≈ 0.18 m across).
      const HAND_SCALE = 0.18
      const tipWorld: Landmark = {
        x: lw.x + tipLm.x * HAND_SCALE,
        y: lw.y - tipLm.y * HAND_SCALE, // image Y is inverted vs world Y
        z: lw.z - tipLm.z * HAND_SCALE,
      }
      // Always emit index tip as a separate guaranteed target
      addTarget('left_index_tip', leftHand[INDEX_TIP_IDX] === tipLm ? tipLm : leftHand[INDEX_TIP_IDX],
        vis(lw), 'leftIndexDistal',
        ['leftUpperArm', 'leftLowerArm', 'leftHand', 'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal'], 'left')
      if (idx !== INDEX_TIP_IDX) {
        // Also emit the most outstretched finger tip
        const boneMap: Record<number, [string, string[]]> = {
          4:  ['leftThumbDistal',  ['leftUpperArm','leftLowerArm','leftHand','leftThumbMetacarpal','leftThumbProximal','leftThumbDistal']],
          12: ['leftMiddleDistal', ['leftUpperArm','leftLowerArm','leftHand','leftMiddleProximal','leftMiddleIntermediate','leftMiddleDistal']],
          16: ['leftRingDistal',   ['leftUpperArm','leftLowerArm','leftHand','leftRingProximal','leftRingIntermediate','leftRingDistal']],
          20: ['leftLittleDistal', ['leftUpperArm','leftLowerArm','leftHand','leftLittleProximal','leftLittleIntermediate','leftLittleDistal']],
        }
        const def = boneMap[idx]
        if (def) {
          const [bone, chain] = def
          addTarget(`left_outstretched_${idx}`, tipWorld, vis(lw), bone, chain, 'left')
        }
      }
    }

    // ── Right finger tip ──────────────────────────────────────────────────────
    if (rightHand && rightHand.length >= 21) {
      const { idx } = mostOutstretchedTip(rightHand)
      const tipLm = rightHand[idx]
      const HAND_SCALE = 0.18
      const tipWorld: Landmark = {
        x: rw.x + tipLm.x * HAND_SCALE,
        y: rw.y - tipLm.y * HAND_SCALE,
        z: rw.z - tipLm.z * HAND_SCALE,
      }
      addTarget('right_index_tip', rightHand[INDEX_TIP_IDX] === tipLm ? tipLm : rightHand[INDEX_TIP_IDX],
        vis(rw), 'rightIndexDistal',
        ['rightUpperArm','rightLowerArm','rightHand','rightIndexProximal','rightIndexIntermediate','rightIndexDistal'], 'right')
      if (idx !== INDEX_TIP_IDX) {
        const boneMap: Record<number, [string, string[]]> = {
          4:  ['rightThumbDistal',  ['rightUpperArm','rightLowerArm','rightHand','rightThumbMetacarpal','rightThumbProximal','rightThumbDistal']],
          12: ['rightMiddleDistal', ['rightUpperArm','rightLowerArm','rightHand','rightMiddleProximal','rightMiddleIntermediate','rightMiddleDistal']],
          16: ['rightRingDistal',   ['rightUpperArm','rightLowerArm','rightHand','rightRingProximal','rightRingIntermediate','rightRingDistal']],
          20: ['rightLittleDistal', ['rightUpperArm','rightLowerArm','rightHand','rightLittleProximal','rightLittleIntermediate','rightLittleDistal']],
        }
        const def = boneMap[idx]
        if (def) {
          const [bone, chain] = def
          addTarget(`right_outstretched_${idx}`, tipWorld, vis(rw), bone, chain, 'right')
        }
      }
    }

    if (targets.length === 0) return {} as OutputsOf<typeof PoseIkTargets>

    // Source shoulder width: tracked subject's shoulder distance in the same units as target positions.
    // Lets consumers compute a uniform scale to fit different-sized target rigs.
    const sourceShoulderWidth = Math.hypot(ls.x - rs.x, ls.y - rs.y, ls.z - rs.z)

    // Source shoulder positions in reference-bone (chest) space, with the same per-axis transform
    // applied as the target positions (so the frontend correction works in the same frame).
    const sourceLeftShoulder:  [number, number, number] = toRefSpace(ls, 'left')
    const sourceRightShoulder: [number, number, number] = toRefSpace(rs, 'right')

    const frame: IkTargetFrame = {
      nodeId: '', referenceBone: refBone,
      sourceShoulderWidth, sourceLeftShoulder, sourceRightShoulder,
      targets,
    }
    return { targets: frame }
  }
}
