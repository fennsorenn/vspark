import * as THREE from 'three';

/**
 * True when the per-frame loop should run the **tracked** composition (weighted
 * base animation + tracking) rather than playing the idle straight.
 *
 * `trackingLive` is load-bearing and must not be dropped in favour of pose
 * presence alone. Ambient producers publish to the broadcast bus additively and
 * forever — Breathing's `pose_broadcast` runs independent of tracking — so
 * `poseActive` stays true for the lifetime of that behavior. Keying only on the
 * bus meant the weighted path ran permanently and a straight idle was
 * unreachable whenever Breathing was attached.
 *
 * The same predicate drives the blend ramp target and the filter-reset
 * transition, so all three agree on what "tracked" means.
 */
export function trackedComposeActive(
  trackingLive: boolean,
  poseActive: boolean
): boolean {
  return trackingLive && poseActive;
}

/**
 * Tracks a cross-fade between two animation sources.
 *
 * The frame loop asks "which source should be showing?" each frame. When that
 * answer changes, the previous source becomes the fade's `from` and the new one
 * its `to`, and `progress` walks 0→1 over `durationS`. Until it lands, both
 * sources are read and blended — which is only possible because each lives in its
 * own buffer (see ClipSlot / ShadowSkeleton in Viewport.tsx).
 *
 * Retargeting a fade mid-flight (the source changes again before it completes)
 * restarts from the *current blended* position rather than snapping: the caller
 * passes the pose it last rendered as the new `from`, so there's no discontinuity.
 * That's why `retarget()` reports whether the caller needs to freeze the outgoing
 * pose.
 */
export class SourceFade<T extends string> {
  private _from: T | null = null;
  private _to: T | null = null;
  private _progress = 1;

  /** The source being faded away from, or null when settled / fading in. */
  get from(): T | null {
    return this._progress >= 1 ? null : this._from;
  }

  /** The source being faded toward — the settled source once progress hits 1. */
  get to(): T | null {
    return this._to;
  }

  /** 0 = fully `from`, 1 = fully `to`. */
  get progress(): number {
    return this._progress;
  }

  /** True while a fade is in flight (both sides contribute). */
  get fading(): boolean {
    return this._progress < 1 && this._from !== null;
  }

  /**
   * Point the fade at `next`. Returns true when this begins a NEW fade away from
   * a different source — the caller's cue to freeze the outgoing pose if that
   * source's clip is about to be torn down.
   *
   * Interrupting a fade in flight makes the *incoming* source (`_to`) the new
   * outgoing one. That is an approximation: strictly, the pose on screen mid-fade
   * is a blend of two sources and cannot be named by a single source id. Using
   * `_to` keeps the dominant side (it's what the fade was converging on) and, for
   * the common late-interruption case, is very close to what was rendered. The
   * exact alternative is for the caller to freeze the blended pose and fade from
   * that — which is what `FrozenPose` supports when the outgoing clip is also
   * being discarded.
   */
  retarget(next: T | null, instant = false): boolean {
    if (next === this._to) return false;
    const wasShowing = this._to;
    this._from = wasShowing;
    this._to = next;
    this._progress = instant || wasShowing === null ? 1 : 0;
    return this._progress < 1;
  }

  /** Advance by `dt` seconds over a fade of `durationS`. */
  advance(dt: number, durationS: number): void {
    if (this._progress >= 1) return;
    if (durationS <= 0) {
      this._progress = 1;
      return;
    }
    this._progress = Math.min(1, this._progress + dt / durationS);
  }

  /** Collapse to settled-on-`to`, discarding any in-flight fade. */
  settle(): void {
    this._progress = 1;
    this._from = null;
  }
}

/**
 * Holds the last tracked pose that actually had bones, so a fade-out has real
 * tracking data to fade *from*.
 *
 * When every producer for a node drops out, the broadcast bus emits one final
 * frame with **empty bones** (`bus.ts` `_emitFallback`). The pose object is
 * therefore non-null but empty, so the composition still runs yet finds no bones:
 * every bone's tracking term became null and its weight 0 in a single frame,
 * regardless of `modeWeight`. `modeWeight` scales the tracking *weight*, and
 * scaling a term that is already gone is a no-op — which is why the exit snapped
 * while the entry (data arrives before the ramp starts) looked fine.
 *
 * Latching the last populated pose lets the ramp interpolate from a real tracked
 * pose to the animation, which is what it was designed to do.
 */
export class TrackedPoseLatch {
  private q = new Map<string, THREE.Quaternion>();
  private valid = false;

  /** Store a pose that has bones. Ignores empty poses — those are the fallback. */
  update(pose: Record<string, { rotation: [number, number, number, number] }>): void {
    const names = Object.keys(pose);
    if (names.length === 0) return;
    for (const name of names) {
      const r = pose[name].rotation;
      const stored = this.q.get(name);
      if (stored) stored.set(r[0], r[1], r[2], r[3]);
      else this.q.set(name, new THREE.Quaternion(r[0], r[1], r[2], r[3]));
    }
    this.valid = true;
  }

  /** Bone names held, for rebuilding a pose object. */
  names(): string[] {
    return this.valid ? [...this.q.keys()] : [];
  }

  get(name: string): THREE.Quaternion | null {
    return (this.valid && this.q.get(name)) || null;
  }

  get active(): boolean {
    return this.valid;
  }

  /** Release the latch once the fade has settled, so it can't leak into a later session. */
  clear(): void {
    this.valid = false;
    this.q.clear();
  }
}

/**
 * Compose one bone under the **unified** tracked/untracked path.
 *
 * There used to be two branches: a tracked one that scaled the animation by the
 * section's Anim lever, and an untracked one that played the animation straight
 * (`animInf = 1`). They switched instantly on `trackingLive` while the tracking
 * weight ramped separately, so at the switchover the only difference left was the
 * lever — and every section with Anim < 1 jumped by exactly `1 - anim`. Sections
 * at Anim 1 didn't move at all, which is why only *part* of the pose snapped, and
 * the two directions left `blend` in different intermediate states, which is why
 * the snapping looked different each way.
 *
 * `mode` collapses that boundary: 0 = fully untracked (animation straight, no
 * tracking), 1 = fully tracked (levers applied, tracking stacked). The lever and
 * the tracking weight are both scaled by it, so `mode = 0` is *identical by
 * construction* to the old untracked branch rather than merely similar — the two
 * paths cannot drift apart again.
 *
 * Only the tracked side needs composing: at `mode = 0` the result is the animation
 * pose itself, so there is no second buffer to build and blend against.
 */
export function composeBonePose(
  rest: THREE.Quaternion,
  animQ: THREE.Quaternion,
  trackedQ: THREE.Quaternion | null,
  animInf: number,
  trackWeight: number,
  mode: number,
  out: THREE.Quaternion = new THREE.Quaternion()
): THREE.Quaternion {
  const m = mode < 0 ? 0 : mode > 1 ? 1 : mode;
  // animInf ramps 1 → lever as the tracked mode takes over.
  const effAnim = 1 + (animInf - 1) * m;
  // Tracking only contributes in proportion to the tracked mode.
  const effTrack = trackWeight * m;
  return stackBoneRotation(rest, animQ, trackedQ, effAnim, effTrack, out);
}

/**
 * The hips-position counterpart of `composeBonePose`: the legs Anim lever ramps in
 * with the tracked mode, so root motion plays at full strength when untracked.
 */
export function composeHipsPositionBlended(
  animPos: THREE.Vector3,
  restPos: THREE.Vector3,
  legsAnim: number,
  animActive: boolean,
  mode: number,
  outPos: THREE.Vector3
): THREE.Vector3 {
  const m = mode < 0 ? 0 : mode > 1 ? 1 : mode;
  return composeHipsPosition(
    animPos,
    restPos,
    1 + (legsAnim - 1) * m,
    animActive,
    outPos
  );
}

/**
 * Cross-fade between two animation poses for one bone.
 *
 * `t` is the fade progress in 0..1: 0 = fully `from`, 1 = fully `to`. Either side
 * may be null, meaning "this source has nothing to contribute" — a null side
 * resolves to the other, and both null resolves to `rest`. That lets a caller fade
 * in from nothing (a scheduled clip starting) or out to nothing (a clip retiring
 * with no loop to hand back to) without special-casing.
 *
 * Blending animation sources is separate from, and happens *before*, stacking
 * tracking on top: the result of this is what `stackBoneRotation` receives as its
 * `animQ`.
 */
export function crossfadeAnimPose(
  rest: THREE.Quaternion,
  from: THREE.Quaternion | null,
  to: THREE.Quaternion | null,
  t: number,
  out: THREE.Quaternion = new THREE.Quaternion()
): THREE.Quaternion {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  if (!from && !to) return out.copy(rest);
  if (!from) return out.copy(rest).slerp(to!, k);
  if (!to) return out.copy(from).slerp(rest, k);
  return out.copy(from).slerp(to, k);
}

/**
 * Cross-fade two hips positions (root motion), matching `crossfadeAnimPose`'s
 * null semantics: a missing side means "no root motion from this source", which is
 * the rest position rather than the origin.
 */
export function crossfadeHipsPosition(
  restPos: THREE.Vector3,
  from: THREE.Vector3 | null,
  to: THREE.Vector3 | null,
  t: number,
  out: THREE.Vector3 = new THREE.Vector3()
): THREE.Vector3 {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const a = from ?? restPos;
  const b = to ?? restPos;
  return out.copy(a).lerp(b, k);
}

// Scratch quats for the stacking composition. The per-frame pose loop is
// single-threaded and calls this one bone at a time, so module-scoped scratch is
// safe and avoids per-bone allocation.
const _trackDelta = new THREE.Quaternion();
const _scaledDelta = new THREE.Quaternion();
const _IDENTITY = new THREE.Quaternion();

/**
 * Compose one bone's final rotation under the "tracking stacks on animation"
 * model: start from `rest`, blend toward the base-animation pose by `animInf`,
 * then stack the tracking delta (tracking relative to rest) scaled by
 * `trackWeight` on top.
 *
 *   final = slerp(rest, animQ, animInf) · slerp(identity, rest⁻¹·trackedQ, trackWeight)
 *
 * Corners:
 *   - animInf=1, trackWeight=0            → animQ            (animation only)
 *   - animInf=0, trackWeight=1            → trackedQ         (tracking only)
 *   - animInf=0, trackWeight=0            → rest
 *   - animInf=1, trackWeight=1            → base animation with full tracking stacked
 *
 * `animInf` and `trackWeight` are scaled independently, so both sliders always
 * affect the result. `trackedQ` null (an untracked bone) drops the tracking term
 * so the bone follows the scaled base animation alone. `trackWeight` must be
 * pre-clamped to [0,1] — it already folds in the transition ramp (Track × blend).
 * `animQ` should be the base-animation pose, or `rest` when no clip is active.
 */
export function stackBoneRotation(
  rest: THREE.Quaternion,
  animQ: THREE.Quaternion,
  trackedQ: THREE.Quaternion | null,
  animInf: number,
  trackWeight: number,
  out: THREE.Quaternion = new THREE.Quaternion()
): THREE.Quaternion {
  // Scaled base animation: rest → animQ by the Anim influence.
  out.copy(rest).slerp(animQ, animInf);
  if (trackedQ && trackWeight > 0) {
    // Tracking delta relative to rest, scaled by the Track weight, stacked on top.
    _trackDelta.copy(rest).invert().multiply(trackedQ);
    _scaledDelta.copy(_IDENTITY).slerp(_trackDelta, trackWeight);
    out.multiply(_scaledDelta);
  }
  return out;
}

/**
 * Compose the hips' root-motion **position** (the translation / weight-shift
 * baked into a clip) into `outPos`. The hips' position follows the **legs**
 * section — its job is mostly to ride the leg movement — so its animation
 * influence is scaled by the legs Anim weight, blending the animated position
 * toward rest:
 *
 *   outPos = lerp(restPos, animActive ? animPos : restPos, legsAnim)
 *
 *   - legsAnim=1 → full root motion (animated position)
 *   - legsAnim=0 → hips planted at rest (no translation)
 *   - no active clip → rest (there's no animated position to honour)
 *
 * Rotation-only tracking never carries a hips position, so there's no tracking
 * term. Callers use this to *restore* the hips position after the composition
 * step's `resetNormalizedPose()` / `update()` passes, which copy the rest hips
 * position back onto the raw bone and would otherwise pin the hips to rest every
 * frame — silently killing root motion whenever tracking or a partial-tracking
 * slider is active.
 */
export function composeHipsPosition(
  animPos: THREE.Vector3,
  restPos: THREE.Vector3,
  legsAnim: number,
  animActive: boolean,
  outPos: THREE.Vector3
): THREE.Vector3 {
  const contrib = animActive ? animPos : restPos;
  return outPos.copy(restPos).lerp(contrib, legsAnim);
}
