/**
 * Helpers for the dev-facing face-heuristic calibration tool (`dev_facecal()`).
 * Pure / headless so they can be unit-reasoned about independently of the window UI.
 * See dev-notes/plans/face-calibration.md.
 */

import type {
  LandmarkPoint,
  ArkitHeuristicConfig,
  ShapeEdge,
} from '@vspark/shared/face_heuristic';

// ── Live min/max tracking ──────────────────────────────────────────────────────

/** Running min/max of a scalar metric, with reset. The calibration UI keeps one per
 *  shape to auto-suggest [min,max], with the dev able to keep/capture/override. */
export class MinMaxTracker {
  min = Infinity;
  max = -Infinity;

  observe(v: number): void {
    if (!Number.isFinite(v)) return;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  reset(): void {
    this.min = Infinity;
    this.max = -Infinity;
  }

  /** True once at least one finite sample established a real range. */
  get valid(): boolean {
    return this.max > this.min;
  }
}

// ── Canonical preview basis (overlay legibility only — NOT used by the metric) ──

/**
 * A 2D similarity frame derived from the face: origin at the outer-eye-corner midpoint,
 * x-axis along the eye line, y-axis perpendicular toward the chin, scaled so the
 * eye-corner span is 1. Projecting landmarks through this uprights and size-normalizes
 * the face for the preview, making markers easier to target on a tilted head. It only
 * uses x/y (display is 2D) and intentionally does not touch the heuristic metric, which
 * stays in raw rotation-invariant 3D distance space.
 */
export interface FaceBasis2D {
  ox: number;
  oy: number;
  exx: number;
  exy: number;
  eyx: number;
  eyy: number;
  scale: number;
}

export function faceBasis2D(pts: LandmarkPoint[]): FaceBasis2D {
  const a = pts[33];
  const b = pts[263]; // outer eye corners
  const ox = (a.x + b.x) / 2;
  const oy = (a.y + b.y) / 2;
  let exx = b.x - a.x;
  let exy = b.y - a.y;
  const len = Math.hypot(exx, exy) || 1;
  exx /= len;
  exy /= len;
  // Perpendicular to the eye line; orient toward the chin so the face is upright.
  let eyx = -exy;
  let eyy = exx;
  const chin = pts[152];
  if ((chin.x - ox) * eyx + (chin.y - oy) * eyy < 0) {
    eyx = -eyx;
    eyy = -eyy;
  }
  return { ox, oy, exx, exy, eyx, eyy, scale: 1 / len };
}

/** Project a landmark into canonical face units (eye-corner span = 1, origin between eyes). */
export function projectCanonical(
  p: LandmarkPoint,
  basis: FaceBasis2D
): { x: number; y: number } {
  const vx = p.x - basis.ox;
  const vy = p.y - basis.oy;
  return {
    x: (vx * basis.exx + vy * basis.exy) * basis.scale,
    y: (vx * basis.eyx + vy * basis.eyy) * basis.scale,
  };
}

// ── Left/right mirroring (for "from mirrored" in the calibration tool) ──────────

/** The opposite-side shape name, or null if the shape isn't sided. */
export function mirrorShapeName(shape: string): string | null {
  if (shape.endsWith('Left')) return shape.slice(0, -4) + 'Right';
  if (shape.endsWith('Right')) return shape.slice(0, -5) + 'Left';
  return null;
}

/**
 * Find the landmark mirrored across the face's vertical midline, using the live
 * frame: project to canonical space, flip x, and pick the nearest landmark.
 * Centerline points map (approximately) to themselves. General over all indices,
 * so it works for whatever the dev clicked, without a hardcoded symmetry table.
 */
export function mirrorLandmark(
  pts: LandmarkPoint[],
  i: number,
  basis: FaceBasis2D = faceBasis2D(pts)
): number {
  const c = projectCanonical(pts[i], basis);
  const tx = -c.x;
  const ty = c.y;
  let best = i;
  let bestD = Infinity;
  for (let j = 0; j < pts.length; j++) {
    const cj = projectCanonical(pts[j], basis);
    const d = (cj.x - tx) ** 2 + (cj.y - ty) ** 2;
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

/** Mirror a list of edges across the face midline (one basis for the batch). */
export function mirrorEdges(
  pts: LandmarkPoint[],
  edges: ShapeEdge[]
): ShapeEdge[] {
  const basis = faceBasis2D(pts);
  return edges.map((e) => ({
    a: mirrorLandmark(pts, e.a, basis),
    b: mirrorLandmark(pts, e.b, basis),
    ...(e.negate ? { negate: true } : {}),
  }));
}

// ── Config (de)serialization for the copy-out / paste-in field ──────────────────

export function serializeConfig(config: ArkitHeuristicConfig): string {
  return JSON.stringify(config, null, 2);
}

/** Parse + lightly validate a pasted config. Returns the config or an error string. */
export function parseConfig(text: string): {
  config?: ArkitHeuristicConfig;
  error?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!parsed || typeof parsed !== 'object')
    return { error: 'Config must be a JSON object.' };
  const out: ArkitHeuristicConfig = {};
  for (const [shape, raw] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    const c = raw as Record<string, unknown>;
    if (
      !c ||
      !Array.isArray(c.edges) ||
      typeof c.min !== 'number' ||
      typeof c.max !== 'number'
    )
      return { error: `Invalid entry for "${shape}".` };
    const edges: ShapeEdge[] = [];
    for (const e of c.edges as unknown[]) {
      const ed = e as Record<string, unknown>;
      if (!ed || typeof ed.a !== 'number' || typeof ed.b !== 'number')
        return { error: `Invalid edge in "${shape}".` };
      edges.push({ a: ed.a, b: ed.b, ...(ed.negate ? { negate: true } : {}) });
    }
    out[shape] = { edges, min: c.min, max: c.max };
  }
  return { config: out };
}
