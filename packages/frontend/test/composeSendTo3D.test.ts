/**
 * composeSendTo3D.test.ts — unit tests for the 2D→3D placement math
 * (computeSendTo3DPlacement): a compose layer over a camera-view maps to a
 * world position + quad size that projects back onto the same rect.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSendTo3DPlacement,
  findOverlappingCameraView,
} from '../src/components/editor/composeSendTo3D';

const CW = 1920;
const CH = 1080;

type L = {
  id: string;
  kind: string;
  parentId: string | null;
  rootComposeSceneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  anchorH: 'left' | 'right';
  anchorV: 'top' | 'bottom';
  rotation: number;
  config: Record<string, unknown>;
  cameraNodeId?: string | null;
};

const layer = (over: Partial<L>): L => ({
  id: 'l',
  kind: 'image',
  parentId: null,
  rootComposeSceneId: 'scene',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  anchorH: 'left',
  anchorV: 'top',
  rotation: 0,
  config: {},
  cameraNodeId: null,
  ...over,
});

// A camera-view covering the whole 1920×1080 stage.
const camView = layer({
  id: 'cam',
  kind: 'camera_view',
  cameraNodeId: 'camNode',
  x: 0,
  y: 0,
  width: CW,
  height: CH,
});

const cameraNode = (over: Record<string, unknown>) =>
  ({
    id: 'camNode',
    components: {
      transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      camera: over,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const byId = (ls: L[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new Map(ls.map((l) => [l.id, l as any] as const));

describe('computeSendTo3DPlacement', () => {
  it('ortho: centred source lands on the view axis, size scales with the rect', () => {
    // Source is the centre 960×540 region → half the width & height of the view.
    const src = layer({ x: 480, y: 270, width: 960, height: 540 });
    const cam = cameraNode({
      projection: 'orthographic',
      orthoSize: 2,
      near: 0.1,
      far: 1000,
    });
    const p = computeSendTo3DPlacement(
      cam,
      camView as never,
      src as never,
      byId([camView, src]) as never,
      CW,
      CH
    );
    // aspect = 1920/1080 = 16/9; halfWw = 2*aspect, halfHw = 2.
    expect(p.position[0]).toBeCloseTo(0, 4);
    expect(p.position[1]).toBeCloseTo(0, 4);
    expect(p.position[2]).toBeCloseTo(-5, 4); // depth default 5, forward −Z
    // Source is half the view: width = halfWw = orthoSize*aspect = 2*16/9.
    expect(p.width).toBeCloseTo((2 * 16) / 9, 3);
    expect(p.height).toBeCloseTo(2, 3); // half of full height (2*halfHw = 4)
  });

  it('ortho: an off-centre source offsets along the camera right/up axes', () => {
    // Top-left quadrant centre: at (480,270) canonical → NDC (−0.5, +0.5).
    const src = layer({ x: 0, y: 0, width: 960, height: 540 });
    const cam = cameraNode({ projection: 'orthographic', orthoSize: 2 });
    const p = computeSendTo3DPlacement(
      cam,
      camView as never,
      src as never,
      byId([camView, src]) as never,
      CW,
      CH
    );
    const halfWw = 2 * (16 / 9);
    expect(p.position[0]).toBeCloseTo(-0.5 * halfWw, 3);
    expect(p.position[1]).toBeCloseTo(0.5 * 2, 3);
  });

  it('perspective: centred source sits on the origin plane', () => {
    const src = layer({ x: 480, y: 270, width: 960, height: 540 });
    const cam = {
      id: 'camNode',
      components: {
        transform: { x: 0, y: 0, z: 10 },
        camera: { projection: 'perspective', fov: 50, near: 0.1, far: 1000 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const p = computeSendTo3DPlacement(
      cam,
      camView as never,
      src as never,
      byId([camView, src]) as never,
      CW,
      CH
    );
    // depth = 10 (camera to origin plane) → node at z ≈ 0.
    expect(p.position[2]).toBeCloseTo(0, 3);
    const halfHw = 10 * Math.tan((50 * Math.PI) / 180 / 2);
    expect(p.height).toBeCloseTo(halfHw, 3); // 0.5 * (2*halfHw)
  });
});

describe('findOverlappingCameraView', () => {
  it('returns the camera-view a layer overlaps', () => {
    const src = layer({ x: 100, y: 100, width: 400, height: 300 });
    expect(
      findOverlappingCameraView(src as never, [camView, src] as never, CW, CH)
        ?.id
    ).toBe('cam');
  });

  it('returns null when the layer is clear of every camera-view', () => {
    const smallCam = layer({
      id: 'cam',
      kind: 'camera_view',
      cameraNodeId: 'camNode',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
    const src = layer({ x: 1000, y: 800, width: 200, height: 100 });
    expect(
      findOverlappingCameraView(src as never, [smallCam, src] as never, CW, CH)
    ).toBeNull();
  });
});
