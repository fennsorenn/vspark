/**
 * Helpers for the dev-facing face-heuristic calibration tool (`dev_facecal()`).
 * Pure / headless so they can be unit-reasoned about independently of the window UI.
 * See dev-notes/plans/face-calibration.md.
 */

import type { LandmarkPoint, ArkitHeuristicConfig } from './arkitHeuristic';

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
      !Array.isArray(c.markers) ||
      !c.markers.every((m) => typeof m === 'number') ||
      typeof c.min !== 'number' ||
      typeof c.max !== 'number'
    )
      return { error: `Invalid entry for "${shape}".` };
    out[shape] = {
      markers: c.markers as number[],
      min: c.min,
      max: c.max,
      ...(c.invert ? { invert: true } : {}),
    };
  }
  return { config: out };
}
