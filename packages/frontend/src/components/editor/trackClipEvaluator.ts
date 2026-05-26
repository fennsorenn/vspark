import type { TrackClipKeyframeRecord, TrackClipLaneRecord } from '../../api/client'

/** Evaluate a lane at time t (seconds since clip start, already wrapped/clamped).
 *  Returns the lane's `defaultValue` when there are no keyframes. */
export function evaluateLane(lane: TrackClipLaneRecord, t: number): number {
  const kfs = lane.keyframes
  if (kfs.length === 0) return lane.defaultValue
  if (t <= kfs[0].t) return kfs[0].value
  if (t >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].value

  // Binary search for the segment.
  let lo = 0, hi = kfs.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (kfs[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = kfs[lo]
  const b = kfs[lo + 1]
  return interpolate(a, b, t)
}

function interpolate(a: TrackClipKeyframeRecord, b: TrackClipKeyframeRecord, t: number): number {
  const span = b.t - a.t
  if (span <= 0) return b.value
  const u = (t - a.t) / span
  // 'step' = hold a until we reach b.
  if (a.easing === 'step') return a.value
  if (a.easing === 'bezier') {
    // Handles are stored as fractions of the adjoining segment (see the field
    // docs on TrackClipKeyframe), so they're already in normalized-segment space:
    //   p1 = (a.outHandleTFraction, a.outHandleVFraction)
    //   p2 = (1 − b.inHandleTFraction, 1 − b.inHandleVFraction)
    // The in-handle subtracts because it points "back toward a" and the fraction
    // is stored as a positive magnitude.
    // Falls back to linear if any handle is null.
    if (
      a.outHandleTFraction == null || a.outHandleVFraction == null ||
      b.inHandleTFraction  == null || b.inHandleVFraction  == null
    ) {
      return a.value + (b.value - a.value) * u
    }
    const dv  = b.value - a.value
    const p1x = a.outHandleTFraction
    const p1y = a.outHandleVFraction
    const p2x = 1 - b.inHandleTFraction
    const p2y = 1 - b.inHandleVFraction
    const eased = cubicBezierY(solveCubicBezierTForX(u, p1x, p2x), p1y, p2y)
    return a.value + dv * eased
  }
  // linear (default)
  return a.value + (b.value - a.value) * u
}

/** Cubic-bezier scalar f(t) for control points (0, p, q, 1). */
function cubicBezierY(t: number, p1y: number, p2y: number): number {
  const it = 1 - t
  return 3 * it * it * t * p1y + 3 * it * t * t * p2y + t * t * t
}

/** Solve cubic bezier x(t) = target for t∈[0,1] via Newton + bisection fallback.
 *  Control points on x-axis are (0, p1x, p2x, 1). */
function solveCubicBezierTForX(x: number, p1x: number, p2x: number): number {
  // Newton iterations from x as the initial guess.
  let t = x
  for (let i = 0; i < 8; i++) {
    const fx = cubicBezierY(t, p1x, p2x) - x
    if (Math.abs(fx) < 1e-5) return t
    const dx = bezierDerivativeX(t, p1x, p2x)
    if (Math.abs(dx) < 1e-6) break
    t -= fx / dx
  }
  // Bisection fallback if Newton didn't converge or went out of bounds.
  let lo = 0, hi = 1
  t = x
  for (let i = 0; i < 32; i++) {
    const fx = cubicBezierY(t, p1x, p2x) - x
    if (Math.abs(fx) < 1e-5) return t
    if (fx > 0) hi = t
    else        lo = t
    t = (lo + hi) / 2
  }
  return t
}

function bezierDerivativeX(t: number, p1x: number, p2x: number): number {
  const it = 1 - t
  return 3 * it * it * p1x + 6 * it * t * (p2x - p1x) + 3 * t * t * (1 - p2x)
}

/** Wrap a playback time `tRaw` (seconds since startedAt) into [0, duration] for looping
 *  clips, or clamp + return null when a non-looping clip has finished. */
export function resolveClipTime(tRaw: number, duration: number, loop: boolean): number | null {
  if (duration <= 0) return 0
  if (tRaw < 0) return 0
  if (loop) {
    const wrapped = tRaw % duration
    return wrapped < 0 ? wrapped + duration : wrapped
  }
  if (tRaw >= duration) return null
  return tRaw
}
