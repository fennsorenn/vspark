import * as THREE from 'three';

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
