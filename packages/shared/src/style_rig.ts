/**
 * Stylized-tracking rig: the data model behind the `pose_stylizer` behavior.
 *
 * The idea, borrowed from how 2D (Live2D-style) avatars are rigged: the rig is
 * NOT bound tightly to the tracked skeleton. Instead a handful of low-dimensional
 * **drivers** are read off the performer (roughly: where is the head pointing,
 * where is the torso leaning, how high are the arms) and those drivers then fan
 * out across the *whole* body through an artist-authored response table.
 *
 * That buys two things at once:
 *
 *  1. **Dynamism.** A small head turn no longer moves only the head — it travels
 *     down the neck, chest, spine and hips with a falloff and a per-bone lag, so
 *     the body reads as one connected performance instead of a floating head.
 *  2. **Robustness.** Bones in `replace` mode are *synthesized* from the drivers
 *     rather than copied from tracking. A tracking glitch can at worst yank a
 *     driver, and drivers are deadzoned, rate-limited, smoothed and clamped to
 *     [-1, 1] — so the output pose stays inside the rig's authored range and can
 *     never fold into a broken pose.
 *
 * This module is pure data + pure helpers, and lives in `shared` so the backend
 * nodes and the frontend properties panel read the same default rig (no drift).
 *
 * See dev-notes/modules/stylized-tracking.md.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Drivers — the low-dimensional performance summary
// ──────────────────────────────────────────────────────────────────────────────

export const STYLE_DRIVER_NAMES = [
  'headYaw',
  'headPitch',
  'headRoll',
  'bodyYaw',
  'bodyPitch',
  'bodyRoll',
  'armL',
  'armR',
  'energy',
] as const;

export type StyleDriverName = (typeof STYLE_DRIVER_NAMES)[number];

/**
 * One frame of drivers. All of them are normalized and clamped:
 *
 * - `head*` — head orientation RELATIVE TO THE TORSO, ±1 at `response.headRange`.
 * - `body*` — torso orientation in world, ±1 at `response.bodyRange`.
 * - `armL` / `armR` — arm height relative to `response.armNeutral`, ±1 at
 *   `response.armRange`. Positive = raised.
 * - `energy` — 0..1 summary of how fast the drivers are currently moving. Nothing
 *   in the default rig consumes it; it is there to be wired into a Logic graph
 *   (expression intensity, particle rate, …).
 */
export type StyleDrivers = Record<StyleDriverName, number>;

export const ZERO_DRIVERS: StyleDrivers = {
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  bodyYaw: 0,
  bodyPitch: 0,
  bodyRoll: 0,
  armL: 0,
  armR: 0,
  energy: 0,
};

// ──────────────────────────────────────────────────────────────────────────────
// Response — how raw tracking is turned into drivers
// ──────────────────────────────────────────────────────────────────────────────

export interface StyleResponse {
  /** Head-vs-torso rotation (degrees) that maps to a head driver of 1. */
  headRange: number;
  /** Torso rotation (degrees) that maps to a body driver of 1. */
  bodyRange: number;
  /** Arm raise (degrees) above `armNeutral` that maps to an arm driver of 1. */
  armRange: number;
  /**
   * Arm elevation (degrees, signed "raise" — 0 = straight out sideways, negative
   * = hanging down) treated as the neutral resting arm. Keeps a relaxed arm from
   * reading as "lowered" and dropping the shoulder.
   */
  armNeutral: number;
  /**
   * Driver magnitude below which the driver is pinned to 0, and above which it is
   * rescaled back to full range. Kills tracker jitter so a still performer reads
   * as still.
   */
  deadzone: number;
  /**
   * Maximum driver change per second. This is the glitch gate: a tracker that
   * teleports a limb produces an impossible driver jump, which gets clipped to a
   * humanly-plausible slew instead of snapping the avatar.
   */
  maxRate: number;
  /**
   * Fraction of the previous driver retained per 60Hz frame (0 = no smoothing,
   * 0.9 = very heavy). Frame-rate compensated, so the feel does not change with
   * the tracker's frame rate.
   */
  smoothing: number;
  /**
   * Driver-units-per-second of total driver motion that reads as `energy` = 1.
   */
  energyScale: number;
}

export const DEFAULT_STYLE_RESPONSE: StyleResponse = {
  headRange: 45,
  bodyRange: 25,
  armRange: 90,
  armNeutral: -60,
  deadzone: 0.03,
  maxRate: 5,
  smoothing: 0.35,
  energyScale: 4,
};

/** Fill in any missing `StyleResponse` field from the defaults. */
export function resolveStyleResponse(
  partial?: Partial<StyleResponse> | null
): StyleResponse {
  return { ...DEFAULT_STYLE_RESPONSE, ...(partial ?? {}) };
}

// ──────────────────────────────────────────────────────────────────────────────
// Rig — how drivers fan out onto bones
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Euler contribution in DEGREES at driver = 1, as `[pitchX, yawY, rollZ]` — the
 * same intrinsic-ZYX convention as `Quaternion.fromEuler` / `toEuler`.
 *
 * Sign convention for left/right pairs: a contribution that describes a **global
 * body motion** (the torso leans, so both arms swing with it) uses the SAME sign
 * on both sides, because it is one rotation of the whole avatar frame. A
 * contribution that describes an **anatomically mirrored motion** (each shoulder
 * lifting with its own arm) flips sign between the sides.
 */
export type DriverResponse = [number, number, number];

export interface StyleBoneResponse {
  /**
   * `replace` — the bone is fully synthesized from the drivers and the tracked
   * rotation is discarded. This is what makes the pose glitch-proof, and it is
   * the right mode for the spine chain, neck, head and shoulders.
   *
   * `add` — the authored offset is layered on TOP of the tracked rotation. Used
   * for limbs, where the performer's own motion should survive and the rig only
   * contributes follow-through.
   */
  mode?: 'replace' | 'add';
  /**
   * Per-bone multiplier on the behavior's base follow-through time. Larger =
   * this bone trails further behind the drivers. Staggering it down the chain
   * (hips lag most, head least) is what produces the whip/settle that reads as
   * "alive" rather than "rigid".
   */
  lag?: number;
  /** Degrees contributed per driver at driver = 1. Missing driver = no response. */
  drivers: Partial<Record<StyleDriverName, DriverResponse>>;
}

/** Bone name (a `VRMBoneName`) → its response. Bones absent from the rig are untouched. */
export type StyleRig = Record<string, StyleBoneResponse>;

/**
 * The "follow" rig — the body moves WITH the head.
 *
 * Read the primary chains column-wise: for each head driver the per-bone yaw /
 * pitch / roll contributions SUM to roughly `response.headRange` (45°), so the
 * head still ends up pointing where the performer is actually looking — it just
 * gets there through the whole body instead of the neck alone. Same for the body
 * drivers against `bodyRange` (25°).
 *
 * The rest is the styling:
 *  - the head counter-rotates against torso lean, so the gaze stays level (this
 *    single term is most of what separates "puppet" from "performer");
 *  - the shoulders lag behind a torso turn;
 *  - each shoulder lifts with its own arm — something tracking essentially never
 *    reproduces, and a strong readability cue;
 *  - the arms swing against the torso as a pendulum, layered over real tracking.
 *
 * Note that the head↔body coupling is DIRECTIONAL, and this rig deliberately runs
 * it both ways: the torso follows the head (positive `head*` terms below), while
 * the head counters the torso (negative `body*` terms on neck/head). See
 * `STYLE_RIG_COUNTER` for the other convention.
 */
export const STYLE_RIG_FOLLOW: StyleRig = {
  hips: {
    mode: 'replace',
    lag: 2.6,
    drivers: {
      headYaw: [0, 2, 0],
      headPitch: [1, 0, 0],
      bodyYaw: [0, 6, 0],
      bodyPitch: [6, 0, 0],
      bodyRoll: [0, 0, 5],
    },
  },
  spine: {
    mode: 'replace',
    lag: 2.0,
    drivers: {
      headYaw: [0, 3, 0],
      headPitch: [2, 0, 0],
      bodyYaw: [0, 6, 0],
      bodyPitch: [7, 0, 0],
      bodyRoll: [0, 0, 7],
    },
  },
  chest: {
    mode: 'replace',
    lag: 1.5,
    drivers: {
      headYaw: [0, 5, 0],
      headPitch: [4, 0, 0],
      headRoll: [0, 0, 3],
      bodyYaw: [0, 7, 0],
      bodyPitch: [7, 0, 0],
      bodyRoll: [0, 0, 7],
    },
  },
  upperChest: {
    mode: 'replace',
    lag: 1.1,
    drivers: {
      headYaw: [0, 7, 0],
      headPitch: [6, 0, 0],
      headRoll: [0, 0, 5],
      bodyYaw: [0, 7, 0],
      bodyPitch: [6, 0, 0],
      bodyRoll: [0, 0, 7],
    },
  },
  neck: {
    mode: 'replace',
    lag: 0.5,
    drivers: {
      headYaw: [0, 10, 0],
      headPitch: [12, 0, 0],
      headRoll: [0, 0, 12],
      // Counter-lean: keep the head from riding the torso all the way over.
      bodyPitch: [-4, 0, 0],
      bodyRoll: [0, 0, -4],
    },
  },
  head: {
    mode: 'replace',
    lag: 0.2,
    drivers: {
      headYaw: [0, 20, 0],
      headPitch: [22, 0, 0],
      headRoll: [0, 0, 26],
      bodyPitch: [-6, 0, 0],
      bodyRoll: [0, 0, -7],
    },
  },
  leftShoulder: {
    mode: 'replace',
    lag: 1.4,
    drivers: {
      // Global motion → same sign on both shoulders (the pair lags one turn).
      bodyYaw: [0, -4, 0],
      // Mirrored motion → opposite sign per side.
      armL: [0, 0, 8],
    },
  },
  rightShoulder: {
    mode: 'replace',
    lag: 1.4,
    drivers: {
      bodyYaw: [0, -4, 0],
      armR: [0, 0, -8],
    },
  },
  leftUpperArm: {
    mode: 'add',
    lag: 3.0,
    drivers: {
      bodyYaw: [0, -5, 0],
      bodyRoll: [0, 0, -4],
      headYaw: [0, -2, 0],
    },
  },
  rightUpperArm: {
    mode: 'add',
    lag: 3.0,
    drivers: {
      bodyYaw: [0, -5, 0],
      bodyRoll: [0, 0, -4],
      headYaw: [0, -2, 0],
    },
  },
  leftLowerArm: {
    mode: 'add',
    lag: 4.0,
    drivers: {
      bodyYaw: [0, -3, 0],
      bodyRoll: [0, 0, -2],
    },
  },
  rightLowerArm: {
    mode: 'add',
    lag: 4.0,
    drivers: {
      bodyYaw: [0, -3, 0],
      bodyRoll: [0, 0, -2],
    },
  },
};

/**
 * The head-driver half of the "counter" rig, expressed as a delta on the follow
 * rig — the file's own documentation of what actually separates the two
 * conventions. Everything else (body drivers, shoulders, arms, lags, modes) is
 * shared, because "follow vs counter" is only ever a statement about how the
 * torso answers the HEAD.
 *
 * Two things happen here, and the second is the one that is easy to get wrong:
 *
 *  1. The torso terms flip sign — turn your head right and the chest, spine and
 *     hips twist LEFT. That is the contrapposto / S-curve read.
 *  2. The head and neck are scaled UP to compensate. This is not optional: with
 *     the torso subtracting instead of adding, simply negating those four numbers
 *     would drop the summed head-in-world rotation from ~47° to ~13°, i.e. the
 *     avatar would stop looking where the performer is looking. Head + neck carry
 *     ~55° so that the net still lands on `headRange`.
 */
const COUNTER_HEAD_RESPONSE: StyleRig = {
  hips: { drivers: { headYaw: [0, -1, 0], headPitch: [-1, 0, 0] } },
  spine: {
    drivers: {
      headYaw: [0, -2, 0],
      headPitch: [-2, 0, 0],
      headRoll: [0, 0, -2],
    },
  },
  chest: {
    drivers: {
      headYaw: [0, -3, 0],
      headPitch: [-3, 0, 0],
      headRoll: [0, 0, -2],
    },
  },
  upperChest: {
    drivers: {
      headYaw: [0, -4, 0],
      headPitch: [-4, 0, 0],
      headRoll: [0, 0, -3],
    },
  },
  neck: {
    drivers: {
      headYaw: [0, 17, 0],
      headPitch: [18, 0, 0],
      headRoll: [0, 0, 17],
    },
  },
  head: {
    drivers: {
      headYaw: [0, 38, 0],
      headPitch: [37, 0, 0],
      headRoll: [0, 0, 35],
    },
  },
};

/**
 * The "counter" rig — the body moves AGAINST the head.
 *
 * The other of the two conventions 2D rigs are built on. Where `STYLE_RIG_FOLLOW`
 * reads as the whole body leaning into a look, this reads as a twist: the head
 * cranks around and the torso resists, which is the more theatrical, more
 * "posed" silhouette. Neither is more correct — they are different characters.
 */
export const STYLE_RIG_COUNTER: StyleRig = mergeStyleRig(
  STYLE_RIG_FOLLOW,
  COUNTER_HEAD_RESPONSE
);

export const STYLE_RIG_PRESET_NAMES = ['follow', 'counter'] as const;
export type StyleRigPreset = (typeof STYLE_RIG_PRESET_NAMES)[number];

export const STYLE_RIG_PRESETS: Record<StyleRigPreset, StyleRig> = {
  follow: STYLE_RIG_FOLLOW,
  counter: STYLE_RIG_COUNTER,
};

/** The preset used when a behavior does not name one. */
export const DEFAULT_STYLE_RIG_PRESET: StyleRigPreset = 'follow';

/** The rig a behavior starts from before its own per-bone overrides are merged. */
export const DEFAULT_STYLE_RIG: StyleRig = STYLE_RIG_FOLLOW;

/** Resolve a (possibly unknown / absent) preset name to its rig. */
export function styleRigPreset(name?: string | null): StyleRig {
  return (
    STYLE_RIG_PRESETS[name as StyleRigPreset] ??
    STYLE_RIG_PRESETS[DEFAULT_STYLE_RIG_PRESET]
  );
}

/**
 * Merge a user rig over a base rig, per bone and per driver, so an override only
 * has to name what it changes. A bone whose merged `drivers` map ends up empty is
 * dropped from the result — that is how the UI switches a bone off entirely.
 */
export function mergeStyleRig(
  base: StyleRig,
  overrides?: StyleRig | null
): StyleRig {
  if (!overrides) return base;
  const out: StyleRig = {};
  for (const bone of new Set([
    ...Object.keys(base),
    ...Object.keys(overrides),
  ])) {
    const b = base[bone];
    const o = overrides[bone];
    if (!o) {
      out[bone] = b;
      continue;
    }
    const drivers = { ...(b?.drivers ?? {}), ...o.drivers };
    // Prune explicit nulls/zero-triples so "clear this driver" round-trips.
    for (const [name, resp] of Object.entries(drivers)) {
      if (!resp || (resp[0] === 0 && resp[1] === 0 && resp[2] === 0))
        delete drivers[name as StyleDriverName];
    }
    if (Object.keys(drivers).length === 0) continue;
    out[bone] = {
      mode: o.mode ?? b?.mode ?? 'replace',
      lag: o.lag ?? b?.lag ?? 1,
      drivers,
    };
  }
  return out;
}

/**
 * Sum a rig entry's per-driver contributions into one Euler triple, in DEGREES.
 * Pure — the lag integration that consumes it lives in the `pose_stylize` node.
 */
export function evaluateBoneResponse(
  entry: StyleBoneResponse,
  drivers: StyleDrivers
): DriverResponse {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [name, resp] of Object.entries(entry.drivers)) {
    if (!resp) continue;
    const d = drivers[name as StyleDriverName] ?? 0;
    if (d === 0) continue;
    x += resp[0] * d;
    y += resp[1] * d;
    z += resp[2] * d;
  }
  return [x, y, z];
}
