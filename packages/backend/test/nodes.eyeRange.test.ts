/**
 * Eye range mapping: tracked eye rotations scaled into the avatar model's VRM
 * look-at limits (signal/nodes/eye_range_map.ts, vrm/lookAt.ts), and the
 * receiver graphs that insert the stage (behaviors/eyeRange.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NormalizedPose, Quaternion } from '@vspark/shared/signal';
import type { GraphDescriptor } from '@vspark/shared/signal';
import { pullValue } from './helpers/nodeHarness.js';

vi.mock('../src/vrm/lookAt.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/vrm/lookAt.js')>();
  return { ...real, eyeRangesForNode: vi.fn(() => null) };
});
import {
  eyeRangesForNode,
  extractEyeRanges,
  DEFAULT_EYE_RANGES,
  type EyeRanges,
} from '../src/vrm/lookAt.js';
import { mapEyeRotation } from '../src/signal/nodes/eye_range_map.js';
import { IFACIALMOCAP_PIPELINE_TEMPLATE } from '../src/behaviors/ifacialmocap_receiver/graph.js';
import {
  VMC_PIPELINE_TEMPLATE,
  VMC_2D_PIPELINE_TEMPLATE,
} from '../src/behaviors/vmc_receiver/graph.js';

const D = Math.PI / 180;
const RANGES: EyeRanges = {
  type: 'bone',
  horizontalInner: 8,
  horizontalOuter: 12,
  verticalDown: 6,
  verticalUp: 9,
};
const deg = (q: Quaternion) => {
  const e = q.toEuler();
  return { pitch: e.pitch / D, yaw: e.yaw / D, roll: e.roll / D };
};

describe('extractEyeRanges', () => {
  it('reads VRM 1.0 range maps', () => {
    expect(
      extractEyeRanges({
        extensions: {
          VRMC_vrm: {
            lookAt: {
              type: 'bone',
              rangeMapHorizontalInner: { inputMaxValue: 90, outputScale: 8 },
              rangeMapHorizontalOuter: { inputMaxValue: 90, outputScale: 12 },
              rangeMapVerticalDown: { inputMaxValue: 90, outputScale: 6 },
              rangeMapVerticalUp: { inputMaxValue: 90, outputScale: 9 },
            },
          },
        },
      })
    ).toEqual(RANGES);
  });

  it('reads VRM 0.x firstPerson yRange and the BlendShape type', () => {
    expect(
      extractEyeRanges({
        extensions: {
          VRM: {
            firstPerson: {
              lookAtTypeName: 'BlendShape',
              lookAtHorizontalInner: { xRange: 90, yRange: 1 },
              lookAtHorizontalOuter: { xRange: 90, yRange: 1 },
              lookAtVerticalDown: { xRange: 90, yRange: 1 },
              lookAtVerticalUp: { xRange: 90, yRange: 1 },
            },
          },
        },
      })
    ).toMatchObject({ type: 'expression', horizontalOuter: 1 });
  });

  it('falls back per missing field, and returns null without look-at', () => {
    expect(
      extractEyeRanges({ extensions: { VRMC_vrm: { lookAt: {} } } })
    ).toEqual(DEFAULT_EYE_RANGES);
    expect(extractEyeRanges({})).toBeNull();
  });
});

describe('mapEyeRotation', () => {
  it('maps the physical range onto the model range, per direction', () => {
    // Left eye, +yaw = outward → horizontalOuter (12°); 15° of 30° → 6°.
    expect(
      deg(
        mapEyeRotation(Quaternion.fromEuler(0, 15 * D, 0), 'left', RANGES, 30)
      ).yaw
    ).toBeCloseTo(6, 4);
    // Right eye, +yaw = inward → horizontalInner (8°); 15° of 30° → 4°.
    expect(
      deg(
        mapEyeRotation(Quaternion.fromEuler(0, 15 * D, 0), 'right', RANGES, 30)
      ).yaw
    ).toBeCloseTo(4, 4);
    // Pitch: + → verticalUp (9°), − → verticalDown (6°).
    expect(
      deg(
        mapEyeRotation(Quaternion.fromEuler(30 * D, 0, 0), 'left', RANGES, 30)
      ).pitch
    ).toBeCloseTo(9, 4);
    expect(
      deg(
        mapEyeRotation(Quaternion.fromEuler(-15 * D, 0, 0), 'left', RANGES, 30)
      ).pitch
    ).toBeCloseTo(-3, 4);
  });

  it('clamps beyond the physical range and drops roll', () => {
    const out = deg(
      mapEyeRotation(
        Quaternion.fromEuler(0, -50 * D, 10 * D),
        'left',
        RANGES,
        30
      )
    );
    expect(out.yaw).toBeCloseTo(-8, 3); // left eye −yaw = inward, clamped
    expect(out.roll).toBeCloseTo(0, 4);
  });

  it('honours a custom physical range', () => {
    expect(
      deg(
        mapEyeRotation(Quaternion.fromEuler(0, 10 * D, 0), 'left', RANGES, 20)
      ).yaw
    ).toBeCloseTo(6, 4);
  });
});

describe('eye_range_map node', () => {
  const pose = () =>
    new NormalizedPose([
      ['leftEye', Quaternion.fromEuler(0, 30 * D, 0)],
      ['rightEye', Quaternion.fromEuler(0, 30 * D, 0)],
      ['head', Quaternion.fromEuler(0, 30 * D, 0)],
    ]);
  const run = (config: Record<string, unknown>) =>
    pullValue('eye_range_map', 'pose', {
      pose: pose(),
      nodeId: 'avatar-1',
      inputMaxDeg: 30,
      ...config,
    }) as NormalizedPose;

  beforeEach(() => vi.mocked(eyeRangesForNode).mockReset());

  it('passes the pose through when disabled', () => {
    const out = run({ enabled: false });
    expect(deg(out.get('leftEye')!).yaw).toBeCloseTo(30, 3);
  });

  it("maps eyes into the model's range and leaves other bones alone", () => {
    vi.mocked(eyeRangesForNode).mockReturnValue(RANGES);
    const out = run({ enabled: true });
    expect(eyeRangesForNode).toHaveBeenCalledWith('avatar-1');
    expect(deg(out.get('leftEye')!).yaw).toBeCloseTo(12, 3); // outer
    expect(deg(out.get('rightEye')!).yaw).toBeCloseTo(8, 3); // inner
    expect(deg(out.get('head')!).yaw).toBeCloseTo(30, 3);
  });

  it('uses the default range when the model declares none', () => {
    vi.mocked(eyeRangesForNode).mockReturnValue(null);
    const out = run({ enabled: true });
    expect(deg(out.get('leftEye')!).yaw).toBeCloseTo(10, 3);
  });

  it('leaves eye bones alone for an expression-type look-at model', () => {
    vi.mocked(eyeRangesForNode).mockReturnValue({
      ...RANGES,
      type: 'expression',
    });
    const out = run({ enabled: true });
    expect(deg(out.get('leftEye')!).yaw).toBeCloseTo(30, 3);
  });
});

describe('receiver graphs', () => {
  type T = Omit<GraphDescriptor, 'id'>;
  const intoPoseOut = (t: T) =>
    t.edges.filter((e) => e.toNodeId === 'pose_out' && e.toPort === 'pose');
  const defaultOf = (t: T) =>
    (
      t.nodes.find((n) => n.id === 'cfg_eye_range_en')?.defaultConfig as
        | { defaultValue: boolean }
        | undefined
    )?.defaultValue;

  it('iFacialMocap maps eyes after head calibration, on by default', () => {
    const t = IFACIALMOCAP_PIPELINE_TEMPLATE;
    expect(intoPoseOut(t).map((e) => e.fromNodeId)).toEqual(['eye_range']);
    expect(
      t.edges.some(
        (e) => e.fromNodeId === 'head_calib' && e.toNodeId === 'eye_range'
      )
    ).toBe(true);
    expect(defaultOf(t)).toBe(true);
  });

  it('VMC maps eyes after arm calibration, off by default', () => {
    const t = VMC_PIPELINE_TEMPLATE;
    expect(intoPoseOut(t).map((e) => e.fromNodeId)).toEqual(['eye_range']);
    expect(
      t.edges.some(
        (e) => e.fromNodeId === 'arm_ik_calib' && e.toNodeId === 'eye_range'
      )
    ).toBe(true);
    expect(defaultOf(t)).toBe(false);
  });

  it('the Live2D VMC variant has no eye stage', () => {
    const t = VMC_2D_PIPELINE_TEMPLATE;
    expect(t.nodes.some((n) => n.id === 'eye_range')).toBe(false);
    expect(intoPoseOut(t).map((e) => e.fromNodeId)).toEqual(['head_calib']);
  });
});
