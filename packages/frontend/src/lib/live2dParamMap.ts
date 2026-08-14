// ---------------------------------------------------------------------------
// Live2D parameter-mapping layer.
//
// vspark already produces, per scene node, the exact face/head data a Live2D
// rig wants: a blendshape record (jawOpen, eyeBlink*, browInnerUp, Fcl_MTH_*,
// ARKit shapes) summed/clamped by the broadcast bus, plus a `neck` head
// quaternion in the pose feed. This module is the pure translation from that
// data into Live2D parameter values (`ParamAngleX`, `ParamEyeLOpen`, …).
//
// It is intentionally side-effect-free and stateless: the node reads the store
// and passes values in; smoothing (EMA) is the caller's concern so this stays
// trivially testable. The default map is overridable per node via the
// properties-panel param-map editor. Head-angle math is ported from the
// backend's pose_torso_head_to_bones.ts (`quatToEulerXYZ`) so the two agree.
// ---------------------------------------------------------------------------

export type Vec4 = [number, number, number, number];
export type BlendshapeRecord = Record<string, number>;

/**
 * How one Live2D parameter is derived from the blendshape record. Head angles
 * are handled separately (they come from the head quaternion, not blendshapes).
 */
export interface ParamMapEntry {
  /** Primary blendshape field to read (0 if absent). */
  source: string;
  /** Optional second field, combined with `source` per `combine`. */
  source2?: string;
  /** `max` → max(a, b); `sub` → a - b; default → just `a`. */
  combine?: 'max' | 'sub';
  /** Replace the raw value with `1 - raw` (e.g. blink weight → eye-open). */
  invert?: boolean;
  /** Linear shaping applied after combine/invert: `raw * gain + bias`. */
  gain?: number;
  bias?: number;
  /** Output clamp. Defaults to [0, 1]. */
  min?: number;
  max?: number;
}

export type Live2dParamMap = Record<string, ParamMapEntry>;

/** Per-axis head-rotation shaping. Live2D ParamAngle* are in degrees (~±30). */
export interface HeadAngleConfig {
  pitchGain?: number; // ParamAngleX (nod)
  yawGain?: number; // ParamAngleY (turn)
  rollGain?: number; // ParamAngleZ (tilt)
  /** Symmetric clamp in degrees. Default 30. */
  rangeDeg?: number;
  /** Parameter ids, in case a model uses non-standard names. */
  pitchParam?: string;
  yawParam?: string;
  rollParam?: string;
}

/**
 * Default blendshape → Live2D parameter map. Names on the right are the Live2D
 * standard parameter ids; names inside entries are the fields vspark emits
 * (see face_landmarks_to_blendshapes.ts, MicCapture.ts, arkit_tables.ts).
 */
export const DEFAULT_BLENDSHAPE_MAP: Live2dParamMap = {
  ParamEyeLOpen: {
    source: 'eyeBlinkLeft',
    source2: 'Fcl_EYE_Close_L',
    combine: 'max',
    invert: true,
  },
  ParamEyeROpen: {
    source: 'eyeBlinkRight',
    source2: 'Fcl_EYE_Close_R',
    combine: 'max',
    invert: true,
  },
  // Mouth open from `jawOpen` (ARKit passthrough) OR `Fcl_MTH_A` (the VMC
  // pipeline's default fcl mapper, which converts jawOpen → Fcl_MTH_A). `max`
  // so it lights up under either mapper config.
  ParamMouthOpenY: { source: 'jawOpen', source2: 'Fcl_MTH_A', combine: 'max' },
  // Vowel width: I pulls the mouth wide (+1), U purses it (-1).
  ParamMouthForm: {
    source: 'Fcl_MTH_I',
    source2: 'Fcl_MTH_U',
    combine: 'sub',
    min: -1,
    max: 1,
  },
  // Brow raise from `browInnerUp` (ARKit) OR `Fcl_BRW_Surprised` (fcl mapper).
  ParamBrowLY: {
    source: 'browInnerUp',
    source2: 'Fcl_BRW_Surprised',
    combine: 'max',
  },
  ParamBrowRY: {
    source: 'browInnerUp',
    source2: 'Fcl_BRW_Surprised',
    combine: 'max',
  },
};

export const DEFAULT_HEAD_CONFIG: Required<
  Pick<HeadAngleConfig, 'pitchGain' | 'yawGain' | 'rollGain' | 'rangeDeg'>
> = {
  pitchGain: 1,
  yawGain: 1,
  rollGain: 1,
  rangeDeg: 30,
};

const RAD2DEG = 180 / Math.PI;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Decompose a unit quaternion [x, y, z, w] into intrinsic XYZ Euler angles
 * (radians). Ported verbatim from pose_torso_head_to_bones.ts so head angles
 * match the backend's own decomposition.
 */
export function quatToEulerXYZ(q: Vec4): { x: number; y: number; z: number } {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m23 = 2 * (y * z - x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const sy = clamp(m13, -1, 1);
  const ey = Math.asin(sy);
  let ex: number;
  let ez: number;
  if (Math.abs(m13) < 0.9999) {
    ex = Math.atan2(-m23, m33);
    ez = Math.atan2(-m12, m11);
  } else {
    ex = Math.atan2(2 * (y * z + x * w), 1 - 2 * (x * x + z * z));
    ez = 0;
  }
  return { x: ex, y: ey, z: ez };
}

function evalEntry(bs: BlendshapeRecord, e: ParamMapEntry): number {
  const a = bs[e.source] ?? 0;
  const b = e.source2 != null ? (bs[e.source2] ?? 0) : 0;
  let raw: number;
  if (e.combine === 'max') raw = Math.max(a, b);
  else if (e.combine === 'sub') raw = a - b;
  else raw = a;
  if (e.invert) raw = 1 - raw;
  const v = raw * (e.gain ?? 1) + (e.bias ?? 0);
  return clamp(v, e.min ?? 0, e.max ?? 1);
}

export interface MapOptions {
  /** Overrides merged over `DEFAULT_BLENDSHAPE_MAP`. */
  map?: Live2dParamMap;
  /** Head-angle shaping overrides. */
  head?: HeadAngleConfig;
}

/**
 * Translate a frame of vspark tracking data into Live2D parameter assignments.
 * `blendshapes` / `neckQuat` may be undefined (no fresh tracking) — the
 * corresponding parameters are simply omitted, leaving the model's own
 * auto-blink/breath + idle motion to drive them.
 */
export function mapToLive2dParams(
  blendshapes: BlendshapeRecord | undefined,
  neckQuat: Vec4 | undefined,
  opts: MapOptions = {}
): Array<[string, number]> {
  const out: Array<[string, number]> = [];

  if (neckQuat) {
    const h = opts.head ?? {};
    const range = h.rangeDeg ?? DEFAULT_HEAD_CONFIG.rangeDeg;
    const e = quatToEulerXYZ(neckQuat);
    const pitch = e.x * (h.pitchGain ?? DEFAULT_HEAD_CONFIG.pitchGain) * RAD2DEG;
    const yaw = e.y * (h.yawGain ?? DEFAULT_HEAD_CONFIG.yawGain) * RAD2DEG;
    const roll = e.z * (h.rollGain ?? DEFAULT_HEAD_CONFIG.rollGain) * RAD2DEG;
    out.push([h.pitchParam ?? 'ParamAngleX', clamp(pitch, -range, range)]);
    out.push([h.yawParam ?? 'ParamAngleY', clamp(yaw, -range, range)]);
    out.push([h.rollParam ?? 'ParamAngleZ', clamp(roll, -range, range)]);
  }

  if (blendshapes) {
    const map = opts.map
      ? { ...DEFAULT_BLENDSHAPE_MAP, ...opts.map }
      : DEFAULT_BLENDSHAPE_MAP;
    for (const paramId of Object.keys(map)) {
      out.push([paramId, evalEntry(blendshapes, map[paramId])]);
    }
  }

  return out;
}
