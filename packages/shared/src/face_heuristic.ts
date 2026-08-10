/**
 * Heuristic estimator: MediaPipe FaceMesh 478 landmarks → ARKit blendshape weights.
 *
 * This is the *free* face path: Holistic already produces face landmarks every frame, so we
 * derive ARKit-shaped weights from them on the main thread (negligible cost) instead of running
 * a second, heavy FaceLandmarker model. The output uses the same ARKit shape names the native
 * model emits, so it feeds the identical backend mapper pipeline (arkit_vrm_mapper trio) — the
 * mappers stay the single calibration/customization layer regardless of source.
 *
 * SHARED (`@vspark/shared/face_heuristic`), not frontend-only: server-side capture providers
 * derive face weights from the same 478-point FaceMesh topology and must produce byte-identical
 * output, so this lives next to the other pure-math modules rather than in `frontend/src/media`.
 * Pure math — no DOM, no imports. Keep it that way so both runtimes can use it.
 *
 * Config-driven model (see dev-notes/plans/face-calibration.md):
 *   For each ARKit shape, the raw metric is a SIGNED SUM OF EDGE LENGTHS — each edge is a pair
 *   of landmarks contributing ±its 3D distance, divided by a stable reference distance (outer
 *   eye-corners) for scale invariance. The metric maps through [min,max] → [0,1].
 *
 *   - 3D distances are inherently rotation-invariant (a rigid head turn doesn't change them), so
 *     no per-frame canonical normalization is needed.
 *   - Per-edge `negate` lets a shape encode a *difference* of distances (e.g. lip-corner angle =
 *     outer-lip→ref minus inner-lip→ref), and also replaces a global range-invert: a falling
 *     metric is handled by negating its edge(s) and using a negative [min,max].
 *
 * DEFAULT_ARKIT_CONFIG is a rough first pass meant to be tuned interactively with the dev
 * calibration tool (`dev_facecal()`), which exports a config to paste back here.
 */

export interface LandmarkPoint {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** One directed edge: contributes ±dist(a,b) to the shape metric. */
export interface ShapeEdge {
  a: number;
  b: number;
  negate?: boolean;
}

/** One ARKit shape's heuristic recipe. Metric = (signed Σ edge lengths) / referenceDistance;
 *  weight = clamp01((metric - min) / (max - min)). No edges → the shape is left unset. */
export interface ArkitShapeConfig {
  edges: ShapeEdge[];
  min: number;
  max: number;
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

/** Signed sum of edge lengths (each edge ±dist(a,b)). */
export function signedEdgeSum(
  pts: LandmarkPoint[],
  edges: ShapeEdge[]
): number {
  let s = 0;
  for (const e of edges) s += (e.negate ? -1 : 1) * dist(pts[e.a], pts[e.b]);
  return s;
}

/** Raw (scale-normalized) metric for one shape config, before the range mapping. */
export function shapeMetric(
  pts: LandmarkPoint[],
  cfg: Pick<ArkitShapeConfig, 'edges'>,
  ref = referenceDistance(pts)
): number {
  if (ref < 1e-6 || cfg.edges.length < 1) return 0;
  return signedEdgeSum(pts, cfg.edges) / ref;
}

/** Map a raw metric through a shape's [min,max] range → [0,1]. */
export function shapeWeight(metric: number, cfg: ArkitShapeConfig): number {
  const span = cfg.max - cfg.min;
  return clamp01(span !== 0 ? (metric - cfg.min) / span : 0);
}

// ──────────────────────────────────────────────────────────────────────────────
// Default config. Each edge is { a, b, negate? } over FaceMesh canonical landmark
// indices; [min,max] are the scale-normalized signed metric bounds. The edge topology
// and signs are reasoned from geometry to isolate each motion (and stay jaw/rotation
// independent); the [min,max] numbers are still rough and meant to be dialed in with the
// dev calibration tool (`dev_facecal()`) via its capture/keep range controls.
// Shapes needing a signal we can't reliably express from landmarks (mouthClose,
// cheekSquint, noseSneer) are omitted until calibrated.
// ──────────────────────────────────────────────────────────────────────────────
export const DEFAULT_ARKIT_CONFIG: ArkitHeuristicConfig = {
  // Jaw / mouth aperture — inner lips 13 (upper) ↔ 14 (lower).
  jawOpen: { edges: [{ a: 13, b: 14 }], min: 0.03, max: 0.3 },

  // Eyes — vertical aperture (upper lid ↔ lower lid). Blink/squint = falling aperture (negated).
  eyeBlinkLeft: {
    edges: [{ a: 159, b: 145, negate: true }],
    min: -0.15,
    max: -0.03,
  },
  eyeBlinkRight: {
    edges: [{ a: 386, b: 374, negate: true }],
    min: -0.15,
    max: -0.03,
  },
  eyeWideLeft: { edges: [{ a: 159, b: 145 }], min: 0.15, max: 0.2 },
  eyeWideRight: { edges: [{ a: 386, b: 374 }], min: 0.15, max: 0.2 },
  // Squint = mild partial close; shares the aperture edge with a tighter range.
  eyeSquintLeft: {
    edges: [{ a: 159, b: 145, negate: true }],
    min: -0.13,
    max: -0.08,
  },
  eyeSquintRight: {
    edges: [{ a: 386, b: 374, negate: true }],
    min: -0.13,
    max: -0.08,
  },

  // Mouth width — corners 61 ↔ 291. Stretch = wide; pucker/funnel = narrow (negated).
  mouthStretchLeft: { edges: [{ a: 61, b: 291 }], min: 0.46, max: 0.58 },
  mouthStretchRight: { edges: [{ a: 61, b: 291 }], min: 0.46, max: 0.58 },
  mouthPucker: {
    edges: [{ a: 61, b: 291, negate: true }],
    min: -0.46,
    max: -0.36,
  },
  mouthFunnel: {
    edges: [{ a: 61, b: 291, negate: true }],
    min: -0.44,
    max: -0.34,
  },

  // Smile — corner rises toward the outer eye corner (captures up+out; jaw-independent).
  mouthSmileLeft: {
    edges: [{ a: 61, b: 33, negate: true }],
    min: -0.58,
    max: -0.46,
  },
  mouthSmileRight: {
    edges: [{ a: 291, b: 263, negate: true }],
    min: -0.58,
    max: -0.46,
  },
  // Frown — lower-lip angle at the corner: corner drops toward the chin relative to the
  // lip centre. d(centreLip17,chin) − d(corner,chin) rises as the corner sinks; jaw-open
  // drops both toward the chin equally, so it cancels (no false trigger on an open mouth).
  mouthFrownLeft: {
    edges: [
      { a: 17, b: 152 },
      { a: 61, b: 152, negate: true },
    ],
    min: 0.0,
    max: 0.06,
  },
  mouthFrownRight: {
    edges: [
      { a: 17, b: 152 },
      { a: 291, b: 152, negate: true },
    ],
    min: 0.0,
    max: 0.06,
  },

  // Upper lip raise — outer upper-lip point rises toward the subnasal point 2 (stable
  // under jaw motion). Lower lip drop — outer lower-lip point falls toward the chin 152,
  // measured relative to it so a jaw-open (which moves both down together) cancels.
  mouthUpperUpLeft: {
    edges: [{ a: 37, b: 2, negate: true }],
    min: -0.14,
    max: -0.09,
  },
  mouthUpperUpRight: {
    edges: [{ a: 267, b: 2, negate: true }],
    min: -0.14,
    max: -0.09,
  },
  mouthLowerDownLeft: {
    edges: [
      { a: 84, b: 152 },
      { a: 17, b: 152, negate: true },
    ],
    min: -0.02,
    max: 0.05,
  },
  mouthLowerDownRight: {
    edges: [
      { a: 314, b: 152 },
      { a: 17, b: 152, negate: true },
    ],
    min: -0.02,
    max: 0.05,
  },

  // Brows — brow ↔ eye-top gap grows on raise. browInnerUp is bilateral: sum of both
  // inner-brow gaps. Outer raise per side; brow-down is the inner gap shrinking (negated).
  browInnerUp: {
    edges: [
      { a: 107, b: 159 },
      { a: 336, b: 386 },
    ],
    min: 0.34,
    max: 0.46,
  },
  browOuterUpLeft: { edges: [{ a: 70, b: 159 }], min: 0.16, max: 0.26 },
  browOuterUpRight: { edges: [{ a: 300, b: 386 }], min: 0.16, max: 0.26 },
  browDownLeft: {
    edges: [{ a: 107, b: 159, negate: true }],
    min: -0.16,
    max: -0.1,
  },
  browDownRight: {
    edges: [{ a: 336, b: 386, negate: true }],
    min: -0.16,
    max: -0.1,
  },
};

/**
 * Evaluate the config against a frame of face landmarks → ARKit shape weights.
 * Only shapes with ≥1 edge produce output; the rest are left unset.
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
    if (cfg.edges.length < 1) continue;
    out[shape] = shapeWeight(signedEdgeSum(pts, cfg.edges) / ref, cfg);
  }
  return out;
}
