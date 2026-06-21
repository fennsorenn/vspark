/**
 * Heuristic estimator: MediaPipe FaceMesh 478 landmarks → ARKit blendshape weights.
 *
 * This is the *free* face path: Holistic already produces face landmarks every frame, so we
 * derive ARKit-shaped weights from them on the main thread (negligible cost) instead of running
 * a second, heavy FaceLandmarker model. The output uses the same ARKit shape names the native
 * model emits, so it feeds the identical backend mapper pipeline (arkit_vrm_mapper trio) — the
 * mappers stay the single calibration/customization layer regardless of source.
 *
 * Accuracy note: these are geometric approximations, not a trained model. They are intentionally
 * written as independent per-shape blocks with named TUNE constants so each can be isolated and
 * refined. Shapes we can't yet estimate reliably from landmarks are left unset (0).
 *
 * Index/side convention matches the rest of the (mirrored-frame) pipeline: the frame fed to
 * MediaPipe is horizontally mirrored, and we keep the same left/right landmark grouping the
 * existing face→blendshape node used. If a paired shape drives the wrong avatar side in testing,
 * the fix is to swap that pair's indices here.
 */

export interface LandmarkPoint {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

// FaceMesh canonical landmark indices.
const I = {
  cheekL: 234,
  cheekR: 454,
  chin: 152,
  forehead: 10,
  noseTip: 1,
  noseBase: 2,
  // Mouth
  mouthCornerL: 61,
  mouthCornerR: 291,
  lipTopIn: 13,
  lipBotIn: 14,
  lipTopOut: 0,
  lipBotOut: 17,
  // Eyes (grouping kept consistent with the prior pipeline)
  eyeL_top: 159,
  eyeL_bot: 145,
  eyeL_out: 33,
  eyeL_in: 133,
  eyeR_top: 386,
  eyeR_bot: 374,
  eyeR_out: 263,
  eyeR_in: 362,
  // Brows
  browL_in: 107,
  browL_out: 70,
  browR_in: 336,
  browR_out: 300,
  // Nostrils / nose wings
  noseWingL: 102,
  noseWingR: 331,
};

// ── Per-shape tuning. Each is [neutralBaseline, range] over a normalized metric. ──────────────
// A metric m maps to weight clamp01((m - neutral) / range). Flip sign by negating range usage.
const TUNE = {
  jawOpen: { neutral: 0.035, range: 0.32 }, // inner lip gap / faceW
  mouthSmile: { neutral: 0.01, range: 0.06 }, // corner lift / faceW
  mouthFrown: { neutral: 0.01, range: 0.05 }, // corner drop / faceW
  mouthStretch: { neutral: 0.47, range: 0.13 }, // mouth width / faceW (above neutral)
  mouthPucker: { neutral: 0.42, range: 0.16 }, // narrowing: (neutral - width/faceW)
  eyeOpenNeutral: 0.28, // eye aspect ratio (EAR) at rest
  eyeBlinkRange: 0.19, // EAR drop to fully closed
  eyeWideRange: 0.12, // EAR rise to fully wide
  browRaise: { neutral: 0.165, range: 0.05 }, // brow-to-eye gap / faceH
  upperLipUp: { neutral: 0.34, range: 0.08 }, // (nose→upperlip)/faceH shrink
  lowerLipDown: { neutral: 0.27, range: 0.09 }, // (lowerlip→chin)/faceH shrink
};

function dist(a: LandmarkPoint, b: LandmarkPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
/** Map a metric to [0,1] given a neutral baseline and range above it. */
function ramp(metric: number, neutral: number, range: number): number {
  return clamp01((metric - neutral) / range);
}

export function estimateArkitBlendshapes(
  pts: LandmarkPoint[]
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!pts || pts.length < 478) return out;

  const faceW = dist(pts[I.cheekL], pts[I.cheekR]);
  const faceH = dist(pts[I.forehead], pts[I.chin]);
  if (faceW < 1e-6 || faceH < 1e-6) return out;
  const invW = 1 / faceW;
  const invH = 1 / faceH;

  // ── Jaw / mouth open ─────────────────────────────────────────────────────────
  const lipGap = dist(pts[I.lipTopIn], pts[I.lipBotIn]) * invW;
  const jawOpen = ramp(lipGap, TUNE.jawOpen.neutral, TUNE.jawOpen.range);
  out.jawOpen = jawOpen;
  // Lips pressed shut (gap below neutral) — only meaningful when jaw isn't open.
  out.mouthClose =
    clamp01((TUNE.jawOpen.neutral - lipGap) / 0.03) * (1 - jawOpen);

  // ── Mouth corners: smile (lift) / frown (drop), per side ─────────────────────
  const mouthCenterY = (pts[I.lipTopIn].y + pts[I.lipBotIn].y) / 2;
  // y grows downward → corner above center (lift) means centerY - cornerY > 0.
  const liftL = (mouthCenterY - pts[I.mouthCornerL].y) * invW;
  const liftR = (mouthCenterY - pts[I.mouthCornerR].y) * invW;
  out.mouthSmileLeft = ramp(
    liftL,
    TUNE.mouthSmile.neutral,
    TUNE.mouthSmile.range
  );
  out.mouthSmileRight = ramp(
    liftR,
    TUNE.mouthSmile.neutral,
    TUNE.mouthSmile.range
  );
  out.mouthFrownLeft = ramp(
    -liftL,
    TUNE.mouthFrown.neutral,
    TUNE.mouthFrown.range
  );
  out.mouthFrownRight = ramp(
    -liftR,
    TUNE.mouthFrown.neutral,
    TUNE.mouthFrown.range
  );

  // ── Mouth width: stretch (wide) vs pucker (narrow) ───────────────────────────
  const mouthW = dist(pts[I.mouthCornerL], pts[I.mouthCornerR]) * invW;
  const stretch = ramp(
    mouthW,
    TUNE.mouthStretch.neutral,
    TUNE.mouthStretch.range
  );
  out.mouthStretchLeft = stretch;
  out.mouthStretchRight = stretch;
  const pucker = clamp01(
    (TUNE.mouthPucker.neutral - mouthW) / TUNE.mouthPucker.range
  );
  out.mouthPucker = pucker * (1 - jawOpen); // pursed = narrow + closed
  out.mouthFunnel = pucker * jawOpen; // funnel/O = narrow + open

  // ── Upper lip raise / lower lip drop ─────────────────────────────────────────
  const noseToUpper = (pts[I.lipTopOut].y - pts[I.noseBase].y) * invH;
  const upperUp = clamp01(
    (TUNE.upperLipUp.neutral - noseToUpper) / TUNE.upperLipUp.range
  );
  out.mouthUpperUpLeft = upperUp;
  out.mouthUpperUpRight = upperUp;
  const lowerToChin = (pts[I.chin].y - pts[I.lipBotOut].y) * invH;
  const lowerDown = clamp01(
    (TUNE.lowerLipDown.neutral - lowerToChin) / TUNE.lowerLipDown.range
  );
  out.mouthLowerDownLeft = lowerDown;
  out.mouthLowerDownRight = lowerDown;

  // ── Eyes: blink / wide / squint via eye-aspect-ratio (EAR) ───────────────────
  const earL =
    dist(pts[I.eyeL_top], pts[I.eyeL_bot]) /
    dist(pts[I.eyeL_out], pts[I.eyeL_in]);
  const earR =
    dist(pts[I.eyeR_top], pts[I.eyeR_bot]) /
    dist(pts[I.eyeR_out], pts[I.eyeR_in]);
  const blinkL = clamp01((TUNE.eyeOpenNeutral - earL) / TUNE.eyeBlinkRange);
  const blinkR = clamp01((TUNE.eyeOpenNeutral - earR) / TUNE.eyeBlinkRange);
  out.eyeBlinkLeft = blinkL;
  out.eyeBlinkRight = blinkR;
  out.eyeWideLeft = clamp01((earL - TUNE.eyeOpenNeutral) / TUNE.eyeWideRange);
  out.eyeWideRight = clamp01((earR - TUNE.eyeOpenNeutral) / TUNE.eyeWideRange);
  // Squint: mild partial close that correlates with cheek raise (smile). Kept low
  // so it doesn't fight blink on the shared Fcl_EYE_Close targets.
  out.eyeSquintLeft = clamp01(blinkL * 0.4 + out.mouthSmileLeft * 0.4);
  out.eyeSquintRight = clamp01(blinkR * 0.4 + out.mouthSmileRight * 0.4);

  // ── Brows: inner/outer raise, brow-down ──────────────────────────────────────
  const browGapL_in = (pts[I.eyeL_top].y - pts[I.browL_in].y) * invH;
  const browGapR_in = (pts[I.eyeR_top].y - pts[I.browR_in].y) * invH;
  const browGapL_out = (pts[I.eyeL_top].y - pts[I.browL_out].y) * invH;
  const browGapR_out = (pts[I.eyeR_top].y - pts[I.browR_out].y) * invH;
  const innerRaise = ramp(
    (browGapL_in + browGapR_in) / 2,
    TUNE.browRaise.neutral,
    TUNE.browRaise.range
  );
  out.browInnerUp = innerRaise;
  out.browOuterUpLeft = ramp(
    browGapL_out,
    TUNE.browRaise.neutral,
    TUNE.browRaise.range
  );
  out.browOuterUpRight = ramp(
    browGapR_out,
    TUNE.browRaise.neutral,
    TUNE.browRaise.range
  );
  // Brow-down: gap shrinks below neutral.
  out.browDownLeft = ramp(
    -browGapL_in,
    -TUNE.browRaise.neutral,
    TUNE.browRaise.range
  );
  out.browDownRight = ramp(
    -browGapR_in,
    -TUNE.browRaise.neutral,
    TUNE.browRaise.range
  );

  // ── Cheek squint / nose sneer: cheap proxies for now (to be refined) ─────────
  out.cheekSquintLeft = out.mouthSmileLeft * 0.5;
  out.cheekSquintRight = out.mouthSmileRight * 0.5;
  out.noseSneerLeft = upperUp * 0.5;
  out.noseSneerRight = upperUp * 0.5;

  return out;
}
