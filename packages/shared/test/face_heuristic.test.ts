import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ARKIT_CONFIG,
  estimateArkitBlendshapes,
  referenceDistance,
  shapeMetric,
  shapeWeight,
  signedEdgeSum,
  type ArkitHeuristicConfig,
  type LandmarkPoint,
} from '../src/face_heuristic';

/** FaceMesh outer eye corners — the scale reference every metric divides by. */
const REF_A = 33;
const REF_B = 263;

/**
 * A synthetic 478-point face. Every landmark starts at the origin; tests move only the
 * indices they care about. The eye-corner reference is set wide enough that metrics are
 * well-conditioned.
 */
function makeFace(overrides: Record<number, [number, number, number]> = {}) {
  const pts: LandmarkPoint[] = Array.from({ length: 478 }, () => ({
    x: 0,
    y: 0,
    z: 0,
  }));
  pts[REF_A] = { x: -0.5, y: 0, z: 0 };
  pts[REF_B] = { x: 0.5, y: 0, z: 0 };
  for (const [i, [x, y, z]] of Object.entries(overrides)) {
    pts[Number(i)] = { x, y, z };
  }
  return pts;
}

describe('referenceDistance', () => {
  it('measures the outer eye-corner span', () => {
    expect(referenceDistance(makeFace())).toBeCloseTo(1, 6);
  });

  it('scales with face size', () => {
    const big = makeFace();
    big[REF_A] = { x: -1, y: 0, z: 0 };
    big[REF_B] = { x: 1, y: 0, z: 0 };
    expect(referenceDistance(big)).toBeCloseTo(2, 6);
  });
});

describe('signedEdgeSum', () => {
  const pts = makeFace({ 1: [0, 0, 0], 2: [3, 4, 0], 3: [0, 0, 0], 4: [0, 1, 0] });

  it('sums edge lengths', () => {
    expect(signedEdgeSum(pts, [{ a: 1, b: 2 }])).toBeCloseTo(5, 6);
  });

  it('subtracts negated edges', () => {
    const sum = signedEdgeSum(pts, [
      { a: 1, b: 2 },
      { a: 3, b: 4, negate: true },
    ]);
    expect(sum).toBeCloseTo(4, 6);
  });

  it('is zero for an empty edge list', () => {
    expect(signedEdgeSum(pts, [])).toBe(0);
  });

  it('uses 3D distance, not just the image plane', () => {
    const withZ = makeFace({ 1: [0, 0, 0], 2: [0, 0, 2] });
    expect(signedEdgeSum(withZ, [{ a: 1, b: 2 }])).toBeCloseTo(2, 6);
  });
});

describe('shapeMetric', () => {
  it('normalises by the reference distance so face size cancels', () => {
    const small = makeFace({ 1: [0, 0, 0], 2: [0, 0.5, 0] });
    const big = makeFace({ 1: [0, 0, 0], 2: [0, 1, 0] });
    big[REF_A] = { x: -1, y: 0, z: 0 };
    big[REF_B] = { x: 1, y: 0, z: 0 };
    const edges = [{ a: 1, b: 2 }];
    expect(shapeMetric(small, { edges })).toBeCloseTo(
      shapeMetric(big, { edges }),
      6
    );
  });

  it('returns 0 when there are no edges', () => {
    expect(shapeMetric(makeFace(), { edges: [] })).toBe(0);
  });

  it('returns 0 when the reference distance collapses', () => {
    const degenerate = makeFace({ 1: [0, 0, 0], 2: [0, 1, 0] });
    degenerate[REF_A] = { x: 0, y: 0, z: 0 };
    degenerate[REF_B] = { x: 0, y: 0, z: 0 };
    expect(shapeMetric(degenerate, { edges: [{ a: 1, b: 2 }] })).toBe(0);
  });
});

describe('shapeWeight', () => {
  const cfg = { edges: [], min: 0.1, max: 0.5 };

  it('maps min → 0 and max → 1', () => {
    expect(shapeWeight(0.1, cfg)).toBeCloseTo(0, 6);
    expect(shapeWeight(0.5, cfg)).toBeCloseTo(1, 6);
  });

  it('interpolates linearly in between', () => {
    expect(shapeWeight(0.3, cfg)).toBeCloseTo(0.5, 6);
  });

  it('clamps outside the range', () => {
    expect(shapeWeight(-5, cfg)).toBe(0);
    expect(shapeWeight(5, cfg)).toBe(1);
  });

  it('handles a negative range (a falling metric)', () => {
    const falling = { edges: [], min: -0.15, max: -0.03 };
    expect(shapeWeight(-0.15, falling)).toBeCloseTo(0, 6);
    expect(shapeWeight(-0.03, falling)).toBeCloseTo(1, 6);
  });

  it('returns 0 for a zero-width range rather than dividing by zero', () => {
    expect(shapeWeight(1, { edges: [], min: 0.2, max: 0.2 })).toBe(0);
  });
});

describe('estimateArkitBlendshapes', () => {
  it('returns nothing for a landmark list that is not a full FaceMesh', () => {
    expect(estimateArkitBlendshapes([])).toEqual({});
    const short = Array.from({ length: 100 }, () => ({ x: 0, y: 0, z: 0 }));
    expect(estimateArkitBlendshapes(short)).toEqual({});
  });

  it('returns nothing when the scale reference collapses', () => {
    const degenerate = makeFace();
    degenerate[REF_A] = { x: 0, y: 0, z: 0 };
    degenerate[REF_B] = { x: 0, y: 0, z: 0 };
    expect(estimateArkitBlendshapes(degenerate)).toEqual({});
  });

  it('emits every configured shape, all within [0,1]', () => {
    const out = estimateArkitBlendshapes(makeFace());
    const configured = Object.keys(DEFAULT_ARKIT_CONFIG).filter(
      (k) => DEFAULT_ARKIT_CONFIG[k].edges.length > 0
    );
    expect(Object.keys(out).sort()).toEqual(configured.sort());
    for (const [shape, w] of Object.entries(out)) {
      expect(w, shape).toBeGreaterThanOrEqual(0);
      expect(w, shape).toBeLessThanOrEqual(1);
    }
  });

  it('raises jawOpen as the inner lips separate', () => {
    const closed = estimateArkitBlendshapes(
      makeFace({ 13: [0, 0, 0], 14: [0, 0.03, 0] })
    );
    const open = estimateArkitBlendshapes(
      makeFace({ 13: [0, 0, 0], 14: [0, 0.25, 0] })
    );
    expect(open.jawOpen).toBeGreaterThan(closed.jawOpen);
    expect(closed.jawOpen).toBeCloseTo(0, 5);
  });

  it('raises eyeBlink as the lid aperture closes', () => {
    const wide = estimateArkitBlendshapes(
      makeFace({ 159: [0, 0, 0], 145: [0, 0.14, 0] })
    );
    const shut = estimateArkitBlendshapes(
      makeFace({ 159: [0, 0, 0], 145: [0, 0.03, 0] })
    );
    expect(shut.eyeBlinkLeft).toBeGreaterThan(wide.eyeBlinkLeft);
  });

  it('skips shapes whose config has no edges', () => {
    const cfg: ArkitHeuristicConfig = {
      unconfigured: { edges: [], min: 0, max: 1 },
      jawOpen: { edges: [{ a: 13, b: 14 }], min: 0.03, max: 0.3 },
    };
    const out = estimateArkitBlendshapes(
      makeFace({ 13: [0, 0, 0], 14: [0, 0.2, 0] }),
      cfg
    );
    expect(out).not.toHaveProperty('unconfigured');
    expect(out.jawOpen).toBeGreaterThan(0);
  });

  it('honours a custom config', () => {
    const cfg: ArkitHeuristicConfig = {
      custom: { edges: [{ a: 1, b: 2 }], min: 0, max: 1 },
    };
    const out = estimateArkitBlendshapes(
      makeFace({ 1: [0, 0, 0], 2: [0, 0.5, 0] }),
      cfg
    );
    expect(Object.keys(out)).toEqual(['custom']);
    expect(out.custom).toBeCloseTo(0.5, 6);
  });

  it('is invariant to face scale', () => {
    const near = makeFace({ 13: [0, 0, 0], 14: [0, 0.15, 0] });
    const far = makeFace({ 13: [0, 0, 0], 14: [0, 0.3, 0] });
    far[REF_A] = { x: -1, y: 0, z: 0 };
    far[REF_B] = { x: 1, y: 0, z: 0 };
    expect(estimateArkitBlendshapes(near).jawOpen).toBeCloseTo(
      estimateArkitBlendshapes(far).jawOpen,
      6
    );
  });
});
