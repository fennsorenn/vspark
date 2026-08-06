import { SignalNode, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';
import {
  type StyleDrivers,
  type StyleRig,
  type DriverResponse,
  DEFAULT_STYLE_RIG,
  ZERO_DRIVERS,
  mergeStyleRig,
  evaluateBoneResponse,
  styleRigPreset,
  styleRigPresetLag,
  DEFAULT_STYLE_STRENGTH,
  MAX_STYLE_STRENGTH,
} from '@vspark/shared/style_rig';

const DEG2RAD = Math.PI / 180;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Synthesize a stylized pose from a handful of drivers.
 *
 * Every bone named in the rig gets a target Euler triple that is the weighted sum
 * of the drivers (`evaluateBoneResponse`), then:
 *
 *  - **replace** bones take that rotation outright, discarding what tracking said.
 *    Because the drivers are clamped to ±1 and the rig's contributions are fixed
 *    degrees, the result is bounded by construction — this is the mode that makes
 *    glitches unable to produce a broken pose. Replace bones are emitted even when
 *    the tracker never sent them, so a face-only source still drives a whole body.
 *  - **add** bones keep their tracked rotation and get the authored offset layered
 *    on in parent space, which is how the limbs stay the performer's own while
 *    still picking up follow-through from the torso.
 *
 * Between the sum and the output sits a per-bone first-order **lag**. Staggering
 * the time constant down the chain (hips trail furthest, head least) is what turns
 * a rigid marionette into something that whips and settles. Anything sharper than
 * that — overshoot, spring bounce — is better added on the client via the avatar's
 * Motion Snappiness (second-order dynamics), which composes on top of this.
 *
 * Finally `amount` slerps the whole result against the untouched tracked pose, so
 * the behavior is a continuous dial from "accurate" (0) to "pretty" (1) rather
 * than an on/off switch.
 *
 * Lag state lives on the instance, not in `setState`: it is per-frame animation
 * state with no meaning across a restart, and persisting it would put a SQLite
 * write in the 60Hz pose path.
 */
@SignalNode({
  label: 'Stylize Pose',
  description:
    'Rebuilds the pose from Style Drivers through a response rig: each driver fans out across the whole body with a per-bone falloff and lag. Replace-mode bones are fully synthesized (glitch-proof); add-mode bones keep tracking and gain follow-through. amount dials accurate → stylized.',
  tags: ['calibration'],
  color: '#8a4a7a',
})
export class PoseStylize extends Node {
  static readonly kind = 'pose_stylize';

  @valueIn('pose', 'NormalizedPose') poseIn!: () => NormalizedPose | undefined;
  @valueIn('drivers', 'StyleDrivers') driversIn!: () =>
    | StyleDrivers
    | undefined;
  /** 0 = pass tracking through untouched, 1 = fully stylized. A BLEND. */
  @valueIn('amount', 'Float') amountIn!: () => number | undefined;
  /**
   * Overall multiplier on every contribution the rig makes — 0 = the rig does
   * nothing, 1 = as authored, 2 = twice as far. Distinct from `amount`: that
   * blends the result against tracking and cannot exceed "fully stylized", while
   * this changes how far the stylized pose travels and CAN exaggerate past the
   * authored rig. Applied before the lag integrator, so changing it eases in.
   */
  @valueIn('strength', 'Float') strengthIn!: () => number | undefined;
  /**
   * Base follow-through time constant in seconds; scaled per bone by the rig's
   * `lag`. Unset falls back to the preset's own base (`expressive` trails more).
   */
  @valueIn('lag', 'Float') lagIn!: () => number | null | undefined;
  /**
   * Which stock rig to start from: `'follow'` (the torso moves with the head) or
   * `'counter'` (it twists against it) — the two conventions 2D rigs are built
   * on. Unknown/absent falls back to `follow`.
   */
  @valueIn('preset', 'String') presetIn!: () => string | undefined;
  /** `StyleRig` overrides, merged over the selected preset. */
  @valueIn('rig', 'Any') rigIn!: () => StyleRig | undefined;
  /** Send bones the rig does not own back to rest instead of passing tracking through. */
  @valueIn('restUnmapped', 'Bool') restUnmappedIn!: () => boolean | undefined;

  /** Per-bone lagged Euler triple (degrees), the integrator's carry. */
  private readonly _current = new Map<string, DriverResponse>();
  private _lastAt = 0;
  /** Cached merged rig, rebuilt only when the preset or override identity changes. */
  private _rigFor: StyleRig | undefined | null = null;
  private _presetFor: string | undefined | null = null;
  private _rig: StyleRig = DEFAULT_STYLE_RIG;
  /** Memo so multiple pulls in one frame integrate the lag exactly once. */
  private _memoFor: NormalizedPose | null = null;
  private _memo: NormalizedPose | null = null;

  @valueOut('pose', 'NormalizedPose')
  pose = (): NormalizedPose | undefined => {
    const pose = this.poseIn();
    if (!pose) return undefined;
    if (this._memoFor === pose && this._memo) return this._memo;

    const amount = clamp(this.amountIn() ?? 1, 0, 1);
    const strength = clamp(
      this.strengthIn() ?? DEFAULT_STYLE_STRENGTH,
      0,
      MAX_STYLE_STRENGTH
    );
    const drivers = this.driversIn() ?? ZERO_DRIVERS;
    const rig = this._resolveRig();
    const restUnmapped = this.restUnmappedIn() ?? false;

    const now = Date.now();
    const dt =
      this._lastAt === 0
        ? 1 / 60
        : clamp((now - this._lastAt) / 1000, 1e-3, 0.5);
    this._lastAt = now;

    const baseLag = Math.max(
      0,
      this.lagIn() ?? styleRigPresetLag(this.presetIn())
    );
    const out = new Map<VRMBoneName, Quaternion>();

    // 1. Carry over what tracking gave us (or flatten it, when asked to).
    for (const [bone, q] of pose.entries()) {
      out.set(bone, restUnmapped && !rig[bone] ? Quaternion.IDENTITY : q);
    }

    // 2. Lay the rig over the top.
    for (const [bone, entry] of Object.entries(rig)) {
      const raw = evaluateBoneResponse(entry, drivers);
      const target: DriverResponse =
        strength === 1
          ? raw
          : [raw[0] * strength, raw[1] * strength, raw[2] * strength];
      const lagged = this._integrate(
        bone,
        target,
        baseLag * (entry.lag ?? 1),
        dt
      );
      const offset = Quaternion.fromEuler(
        lagged[0] * DEG2RAD,
        lagged[1] * DEG2RAD,
        lagged[2] * DEG2RAD
      );
      const boneName = bone as VRMBoneName;
      const tracked = pose.get(boneName);

      if ((entry.mode ?? 'replace') === 'replace') {
        // Synthesized outright — emitted even if the tracker never sent this bone.
        const base = tracked ?? Quaternion.IDENTITY;
        out.set(boneName, amount >= 1 ? offset : base.slerp(offset, amount));
      } else {
        // Additive: nothing to layer onto if the performer isn't driving this bone.
        if (!tracked || !tracked.isValid) continue;
        const styled = offset.multiply(tracked).normalize();
        out.set(boneName, amount >= 1 ? styled : tracked.slerp(styled, amount));
      }
    }

    const result = new NormalizedPose(out);
    this._memoFor = pose;
    this._memo = result;
    return result;
  };

  /**
   * Merge the user's rig over the selected preset, memoized on the preset name
   * and the override object's identity.
   */
  private _resolveRig(): StyleRig {
    const overrides = this.rigIn();
    const preset = this.presetIn();
    if (this._rigFor !== overrides || this._presetFor !== preset) {
      this._rigFor = overrides;
      this._presetFor = preset;
      this._rig = mergeStyleRig(styleRigPreset(preset), overrides);
    }
    return this._rig;
  }

  /**
   * First-order lag towards `target` with time constant `tau` seconds. The
   * exponential form keeps the feel identical whatever rate the tracker runs at.
   */
  private _integrate(
    bone: string,
    target: DriverResponse,
    tau: number,
    dt: number
  ): DriverResponse {
    const cur = this._current.get(bone);
    if (!cur || tau <= 0) {
      const next: DriverResponse = [target[0], target[1], target[2]];
      this._current.set(bone, next);
      return next;
    }
    const k = 1 - Math.exp(-dt / tau);
    const next: DriverResponse = [
      cur[0] + (target[0] - cur[0]) * k,
      cur[1] + (target[1] - cur[1]) * k,
      cur[2] + (target[2] - cur[2]) * k,
    ];
    this._current.set(bone, next);
    return next;
  }
}
