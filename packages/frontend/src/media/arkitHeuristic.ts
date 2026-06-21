/**
 * Heuristic estimator: MediaPipe FaceMesh 478 landmarks → ARKit blendshape weights.
 *
 * This is the *free* face path: Holistic already produces face landmarks every frame, so we
 * derive ARKit-shaped weights from them on the main thread (negligible cost) instead of running
 * a second, heavy FaceLandmarker model. The output uses the same ARKit shape names the native
 * model emits, so it feeds the identical backend mapper pipeline (arkit_vrm_mapper trio) — the
 * mappers stay the single calibration/customization layer regardless of source.
 *
 * Config-driven model (see dev-notes/plans/face-calibration.md):
 *   For each ARKit shape, the raw metric is the SUM OF PAIRWISE 3D DISTANCES among the shape's
 *   active marker landmarks, divided by a stable reference distance (outer eye-corners) for
 *   scale invariance. That metric is mapped through [min,max] → [0,1] and optionally inverted.
 *
 *   - 3D distances are inherently rotation-invariant (a rigid head turn doesn't change them), so
 *     no per-frame canonical normalization is needed.
 *   - Direction (e.g. smile-up vs frown-down) is encoded by choosing a stable reference marker
 *     and using `invert` — same edge, opposite sign.
 *   - Sum-of-pairwise equals the single edge for 2 markers and the triangle perimeter for 3,
 *     which covers every shape we use.
 *
 * The DEFAULT_ARKIT_CONFIG below is a rough first pass meant to be tuned interactively with the
 * dev calibration tool (`dev_facecal()`), which exports a config to paste back here.
 */

export interface LandmarkPoint {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** One ARKit shape's heuristic recipe. Metric = sum of pairwise 3D distances among `markers`,
 *  divided by the reference distance; weight = clamp01((metric - min) / (max - min)), inverted
 *  if `invert`. Fewer than 2 markers → the shape is left unset (no output). */
export interface ArkitShapeConfig {
  markers: number[];
  min: number;
  max: number;
  invert?: boolean;
}

export type ArkitHeuristicConfig = Record<string, ArkitShapeConfig>;

// Scale reference: outer eye corners. Expression-stable, so it tracks face size / camera
// distance without being perturbed by the expressions we're measuring.
const REF_A = 33;
const REF_B = 263;

function dist(a: LandmarkPoint, b: LandmarkPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Reference distance used to normalize all metrics for face size. */
export function referenceDistance(pts: LandmarkPoint[]): number {
  return dist(pts[REF_A], pts[REF_B]);
}

/** Sum of pairwise 3D distances among the given landmark indices. */
export function sumPairwiseDistance(
  pts: LandmarkPoint[],
  markers: number[]
): number {
  let s = 0;
  for (let i = 0; i < markers.length; i++)
    for (let j = i + 1; j < markers.length; j++)
      s += dist(pts[markers[i]], pts[markers[j]]);
  return s;
}

/** Raw (scale-normalized) metric for one shape config, before range/invert. */
export function shapeMetric(
  pts: LandmarkPoint[],
  cfg: Pick<ArkitShapeConfig, 'markers'>,
  ref = referenceDistance(pts)
): number {
  if (ref < 1e-6 || cfg.markers.length < 2) return 0;
  return sumPairwiseDistance(pts, cfg.markers) / ref;
}

/** Map a raw metric through a shape's [min,max] range and optional invert. */
export function shapeWeight(metric: number, cfg: ArkitShapeConfig): number {
  const span = cfg.max - cfg.min;
  let w = span !== 0 ? (metric - cfg.min) / span : 0;
  w = clamp01(w);
  return cfg.invert ? 1 - w : w;
}

// ──────────────────────────────────────────────────────────────────────────────
// Default config. Marker indices are FaceMesh canonical points; [min,max] are the
// scale-normalized metric values mapping to weight 0 and 1. ROUGH first pass — to be
// replaced by the calibration tool's export. Shapes that need a non-distance signal
// (mouthClose, cheekSquint, noseSneer) are intentionally omitted until calibrated.
// ──────────────────────────────────────────────────────────────────────────────
export const DEFAULT_ARKIT_CONFIG: ArkitHeuristicConfig = {
  // Jaw / mouth aperture — inner lips 13 (upper) ↔ 14 (lower).
  jawOpen: { markers: [13, 14], min: 0.03, max: 0.3 },

  // Eyes — vertical aperture (top ↔ bottom lid). Blink inverts (small = closed).
  eyeBlinkLeft: { markers: [159, 145], min: 0.03, max: 0.15, invert: true },
  eyeBlinkRight: { markers: [386, 374], min: 0.03, max: 0.15, invert: true },
  eyeWideLeft: { markers: [159, 145], min: 0.15, max: 0.2 },
  eyeWideRight: { markers: [386, 374], min: 0.15, max: 0.2 },
  eyeSquintLeft: { markers: [159, 145], min: 0.07, max: 0.15, invert: true },
  eyeSquintRight: { markers: [386, 374], min: 0.07, max: 0.15, invert: true },

  // Mouth width — corners 61 ↔ 291. Stretch = wide; pucker/funnel = narrow (invert).
  mouthStretchLeft: { markers: [61, 291], min: 0.45, max: 0.58 },
  mouthStretchRight: { markers: [61, 291], min: 0.45, max: 0.58 },
  mouthPucker: { markers: [61, 291], min: 0.32, max: 0.45, invert: true },
  mouthFunnel: { markers: [61, 291], min: 0.3, max: 0.42, invert: true },

  // Smile / frown — corner ↔ outer eye corner (same edge, opposite sign).
  mouthSmileLeft: { markers: [61, 33], min: 0.45, max: 0.58, invert: true },
  mouthSmileRight: { markers: [291, 263], min: 0.45, max: 0.58, invert: true },
  mouthFrownLeft: { markers: [61, 33], min: 0.55, max: 0.68 },
  mouthFrownRight: { markers: [291, 263], min: 0.55, max: 0.68 },

  // Upper lip raise (outer upper lip 0 ↔ nose base 2) / lower lip drop (17 ↔ chin 152).
  mouthUpperUpLeft: { markers: [0, 2], min: 0.08, max: 0.16, invert: true },
  mouthUpperUpRight: { markers: [0, 2], min: 0.08, max: 0.16, invert: true },
  mouthLowerDownLeft: {
    markers: [17, 152],
    min: 0.18,
    max: 0.28,
    invert: true,
  },
  mouthLowerDownRight: {
    markers: [17, 152],
    min: 0.18,
    max: 0.28,
    invert: true,
  },

  // Brows — brow ↔ eye-top gap. Raise grows the gap; brow-down inverts.
  browInnerUp: { markers: [107, 159], min: 0.14, max: 0.24 },
  browOuterUpLeft: { markers: [70, 159], min: 0.16, max: 0.26 },
  browOuterUpRight: { markers: [300, 386], min: 0.16, max: 0.26 },
  browDownLeft: { markers: [107, 159], min: 0.08, max: 0.14, invert: true },
  browDownRight: { markers: [336, 386], min: 0.08, max: 0.14, invert: true },
};

/**
 * Evaluate the config against a frame of face landmarks → ARKit shape weights.
 * Only shapes with ≥2 markers produce output; the rest are left unset.
 */
export function estimateArkitBlendshapes(
  pts: LandmarkPoint[],
  config: ArkitHeuristicConfig = DEFAULT_ARKIT_CONFIG
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!pts || pts.length < 478) return out;
  const ref = referenceDistance(pts);
  if (ref < 1e-6) return out;
  for (const shape in config) {
    const cfg = config[shape];
    if (cfg.markers.length < 2) continue;
    out[shape] = shapeWeight(sumPairwiseDistance(pts, cfg.markers) / ref, cfg);
  }
  return out;
}
