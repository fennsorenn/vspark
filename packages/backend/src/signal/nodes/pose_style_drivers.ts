import { SignalNode, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';
import {
  type StyleDrivers,
  type StyleResponse,
  ZERO_DRIVERS,
  STYLE_DRIVER_NAMES,
  resolveStyleResponse,
} from '@vspark/shared/style_rig';

const RAD2DEG = 180 / Math.PI;

/** The bone chains the drivers are read off. Parent → child order matters. */
const TORSO_CHAIN = ['hips', 'spine', 'chest', 'upperChest'] as const;
const HEAD_CHAIN = ['neck', 'head'] as const;

/** Compose the local rotations of a bone chain into one rotation, skipping absent bones. */
function composeChain(
  pose: NormalizedPose,
  chain: readonly string[]
): Quaternion {
  let q = Quaternion.IDENTITY;
  let any = false;
  for (const bone of chain) {
    const r = pose.get(bone as never);
    if (!r || !r.isValid) continue;
    q = q.multiply(r);
    any = true;
  }
  return any ? q.normalize() : Quaternion.IDENTITY;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Pin small values to zero, then rescale so the usable range still reaches ±1. */
function deadzone(v: number, dz: number): number {
  if (dz <= 0) return v;
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

/**
 * Extract stylized-tracking **drivers** from an accurate pose.
 *
 * This is the "read the performance, not the skeleton" half of the stylizer: the
 * full bone set is collapsed into nine normalized scalars (head orientation
 * relative to the torso, torso orientation, arm height, and a motion-energy
 * summary), each conditioned so that downstream synthesis can never produce a
 * broken pose:
 *
 *   raw angle → ÷ range → clamp ±1 → deadzone → rate limit → smooth
 *
 * The **rate limit** is the glitch gate. When a tracker loses a limb and snaps it
 * across the room, the resulting driver step is physically impossible; clipping it
 * to `maxRate` per second turns a violent pop into a short, human-looking slew.
 * The **deadzone** is the stillness gate — it keeps sensor jitter from making a
 * motionless performer shimmer.
 *
 * Integration state (previous drivers, last timestamp) is held on the instance
 * rather than through `setState`, because it is per-frame animation state with no
 * meaning across a restart, and persisting it would put a SQLite write in the
 * 60Hz pose path.
 */
@SignalNode({
  label: 'Style Drivers',
  description:
    'Reads a pose down to a few normalized drivers (head vs torso, torso lean, arm height, motion energy). Deadzoned, rate-limited and smoothed, so tracker glitches become slews instead of pops. Feed into Stylize Pose.',
  tags: ['calibration'],
  color: '#8a4a7a',
})
export class PoseStyleDrivers extends Node {
  static readonly kind = 'pose_style_drivers';

  @valueIn('pose', 'NormalizedPose') poseIn!: () => NormalizedPose | undefined;
  /** `StyleResponse` — ranges + conditioning knobs. Missing fields fall back to defaults. */
  @valueIn('response', 'Any') responseIn!: () =>
    | Partial<StyleResponse>
    | undefined;

  /** Previous emitted drivers — the target of the rate limiter and smoother. */
  private _prev: StyleDrivers = { ...ZERO_DRIVERS };
  private _lastAt = 0;
  /** Memo so multiple pulls in one frame integrate the lag exactly once. */
  private _memoFor: NormalizedPose | null = null;
  private _memo: StyleDrivers = { ...ZERO_DRIVERS };

  @valueOut('drivers', 'StyleDrivers')
  drivers = (): StyleDrivers => {
    const pose = this.poseIn();
    if (!pose) return this._prev;
    if (this._memoFor === pose) return this._memo;

    const r = resolveStyleResponse(this.responseIn());
    const now = Date.now();
    // First frame (or a long stall) → treat as a single 60Hz step so the first
    // pose does not blast through the rate limiter with a huge dt.
    const dt =
      this._lastAt === 0
        ? 1 / 60
        : clamp((now - this._lastAt) / 1000, 1e-3, 0.5);
    this._lastAt = now;

    const raw = this._read(pose, r);
    const next = this._condition(raw, r, dt);

    this._prev = next;
    this._memoFor = pose;
    this._memo = next;
    return next;
  };

  /** Pose → raw, range-normalized drivers (before any conditioning). */
  private _read(pose: NormalizedPose, r: StyleResponse): StyleDrivers {
    const torso = composeChain(pose, TORSO_CHAIN);
    const headRel = composeChain(pose, HEAD_CHAIN);

    const t = torso.toEuler();
    const h = headRel.toEuler();

    const out: StyleDrivers = { ...ZERO_DRIVERS };
    out.headYaw = (h.yaw * RAD2DEG) / r.headRange;
    out.headPitch = (h.pitch * RAD2DEG) / r.headRange;
    out.headRoll = (h.roll * RAD2DEG) / r.headRange;
    out.bodyYaw = (t.yaw * RAD2DEG) / r.bodyRange;
    out.bodyPitch = (t.pitch * RAD2DEG) / r.bodyRange;
    out.bodyRoll = (t.roll * RAD2DEG) / r.bodyRange;

    // Arm height. In the VRM rest pose the arms point along ±X, so elevation is a
    // roll (Z) — mirrored between the sides, hence the negation on the right.
    const lUp = pose.get('leftUpperArm' as never);
    const rUp = pose.get('rightUpperArm' as never);
    if (lUp?.isValid) {
      const raise = lUp.toEuler().roll * RAD2DEG;
      out.armL = (raise - r.armNeutral) / r.armRange;
    }
    if (rUp?.isValid) {
      const raise = -rUp.toEuler().roll * RAD2DEG;
      out.armR = (raise - r.armNeutral) / r.armRange;
    }
    return out;
  }

  /** clamp → deadzone → rate limit → smooth, plus the derived energy driver. */
  private _condition(
    raw: StyleDrivers,
    r: StyleResponse,
    dt: number
  ): StyleDrivers {
    const maxStep = Math.max(0, r.maxRate) * dt;
    // Frame-rate-compensated EMA: `smoothing` is the fraction retained per 60Hz frame.
    const retain = clamp(r.smoothing, 0, 0.999);
    const alpha = retain <= 0 ? 1 : 1 - Math.pow(retain, dt * 60);

    const out: StyleDrivers = { ...ZERO_DRIVERS };
    let motion = 0;
    for (const name of STYLE_DRIVER_NAMES) {
      if (name === 'energy') continue;
      const prev = this._prev[name];
      let v = clamp(raw[name], -1, 1);
      v = deadzone(v, clamp(r.deadzone, 0, 0.9));
      // Glitch gate: no driver may travel faster than maxRate.
      if (maxStep > 0) v = clamp(v, prev - maxStep, prev + maxStep);
      else v = prev;
      v = prev + (v - prev) * alpha;
      out[name] = v;
      motion += Math.abs(v - prev);
    }

    // Energy trails the same smoothing so it does not flicker frame to frame.
    const rawEnergy = clamp(motion / dt / Math.max(1e-6, r.energyScale), 0, 1);
    out.energy = this._prev.energy + (rawEnergy - this._prev.energy) * alpha;
    return out;
  }
}
