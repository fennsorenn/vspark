/**
 * composeSnap.test.ts — unit tests for compose-layer move snapping
 * (snapLayerMove): the layer's left/centre/right and top/centre/bottom pull onto
 * the parent box's edges + centre within a threshold.
 */
import { describe, it, expect } from 'vitest';
import {
  snapLayerMove,
  snapResizeBox,
} from '../src/components/editor/composeLayerInteractions';

// Parent box (e.g. the 1920×1080 viewport for a top-level layer).
const FW = 1920;
const FH = 1080;
const THRESH = 10;

// A 200×100 layer anchored top-left, px units.
const layer = {
  anchorH: 'left' as const,
  anchorV: 'top' as const,
  config: {},
  width: 200,
  height: 100,
};

describe('snapLayerMove', () => {
  it('snaps the layer centre to the parent centre when within threshold', () => {
    // Centre-x target: left so that centre = 960 → left = 860. Start 4px off.
    const r = snapLayerMove(864, 490, layer, FW, FH, THRESH);
    expect(r.x).toBe(860); // centred horizontally (860 + 100 = 960)
    expect(r.y).toBe(490); // 490 + 50 = 540 = centre → already centred
    expect(r.vx).toEqual([FW / 2]);
    expect(r.hy).toEqual([FH / 2]);
  });

  it('snaps the left edge to the parent left border', () => {
    const r = snapLayerMove(5, 300, layer, FW, FH, THRESH);
    expect(r.x).toBe(0);
    expect(r.vx).toEqual([0]);
  });

  it('snaps the right edge to the parent right border', () => {
    // right edge = x + width; want x+200 = 1920 → x = 1720. Start 6px short.
    const r = snapLayerMove(1714, 300, layer, FW, FH, THRESH);
    expect(r.x).toBe(1720);
    expect(r.vx).toEqual([FW]);
  });

  it('does not snap when outside the threshold', () => {
    const r = snapLayerMove(500, 300, layer, FW, FH, THRESH);
    expect(r.x).toBe(500);
    expect(r.y).toBe(300);
    expect(r.vx).toEqual([]);
    expect(r.hy).toEqual([]);
  });

  it('snaps a right-anchored layer by its visual edges', () => {
    // Right-anchored: x is the gap from the parent's right edge to the layer's
    // right edge. x=4 → right edge at 1916 → snaps to 1920 (x=0).
    const rl = { ...layer, anchorH: 'right' as const };
    const r = snapLayerMove(4, 300, rl, FW, FH, THRESH);
    expect(r.x).toBe(0);
    expect(r.vx).toEqual([FW]);
  });

  it('handles percentage units (centre snap)', () => {
    // width 25% of 1920 = 480px. centre target x so left+240 = 960 → left=720 →
    // x% = 720/1920*100 = 37.5. Start at 37 (720-ish, within 10px).
    const pct = {
      ...layer,
      config: { xUnit: '%', widthUnit: '%' },
      width: 25,
    };
    const r = snapLayerMove(37, 490, pct, FW, FH, THRESH);
    expect(r.x).toBeCloseTo(37.5, 5); // centred
    expect(r.vx).toEqual([FW / 2]);
  });

  it('no-ops with a degenerate parent frame', () => {
    const r = snapLayerMove(10, 10, layer, 0, 0, THRESH);
    expect(r).toEqual({ x: 10, y: 10, vx: [], hy: [] });
  });
});

describe('snapResizeBox', () => {
  const box = { left: 200, right: 704, top: 100, bottom: 400 };

  it('snaps the east (right) edge to the parent right border', () => {
    const r = snapResizeBox(
      { ...box, right: 1914 }, // 6px shy of 1920
      { e: true, w: false, n: false, s: false },
      FW,
      FH,
      THRESH
    );
    expect(r.right).toBe(FW);
    expect(r.left).toBe(box.left); // pinned edge untouched
    expect(r.vx).toEqual([FW]);
    expect(r.hy).toEqual([]);
  });

  it('snaps the west (left) edge to the parent centre', () => {
    // right must sit past the centre or the snap would invert the box.
    const r = snapResizeBox(
      { left: 964, right: 1400, top: 100, bottom: 400 }, // left near 960
      { e: false, w: true, n: false, s: false },
      FW,
      FH,
      THRESH
    );
    expect(r.left).toBe(FW / 2);
    expect(r.right).toBe(1400); // pinned
    expect(r.vx).toEqual([FW / 2]);
  });

  it('snaps both edges for a corner grab (se → right + bottom)', () => {
    const r = snapResizeBox(
      { left: 200, right: 1916, top: 100, bottom: 1074 },
      { e: true, w: false, n: false, s: true },
      FW,
      FH,
      THRESH
    );
    expect(r.right).toBe(FW);
    expect(r.bottom).toBe(FH);
    expect(r.vx).toEqual([FW]);
    expect(r.hy).toEqual([FH]);
  });

  it('never inverts the box (ignores a snap that would cross the pinned edge)', () => {
    // Right edge is only 3px from the left edge; a centre target far away won't
    // apply, and no target within 3px lies past the left edge here.
    const r = snapResizeBox(
      { left: 900, right: 903, top: 100, bottom: 400 },
      { e: true, w: false, n: false, s: false },
      FW,
      FH,
      2
    );
    expect(r.right).toBe(903); // unchanged
    expect(r.vx).toEqual([]);
  });

  it('does not snap edges that are not moving', () => {
    const r = snapResizeBox(
      { ...box, left: 4 }, // left near 0, but only the EAST edge is moving
      { e: true, w: false, n: false, s: false },
      FW,
      FH,
      THRESH
    );
    expect(r.left).toBe(4); // not snapped — west isn't the grabbed edge
    expect(r.vx).toEqual([]);
  });
});
