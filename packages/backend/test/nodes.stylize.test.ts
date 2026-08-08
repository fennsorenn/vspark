/**
 * nodes.stylize.test.ts
 *
 * Unit tests for the stylized-tracking signal nodes:
 *   pose_style_drivers, pose_stylize
 *
 * The pure rig data model they consume (default rig invariants, mergeStyleRig,
 * evaluateBoneResponse) is tested in packages/shared/test/style_rig.test.ts.
 *
 * Both nodes are time-dependent (rate limiting, follow-through lag), so every
 * temporal test drives `Date.now()` through fake timers and re-pulls the value
 * output on a LIVE graph — the nodes memoize per input-pose object, so each frame
 * must supply a fresh `NormalizedPose` instance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Quaternion, NormalizedPose } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { mkEvent } from '@vspark/shared/signal';
import {
  DEFAULT_STYLE_RIG,
  STYLE_RIG_FOLLOW,
  STYLE_RIG_COUNTER,
  STYLE_RIG_HEAD_ONLY,
  STYLE_RIG_HEAD_ONLY_COUNTER,
  STYLE_PRESETS,
  MAX_STYLE_STRENGTH,
  ZERO_DRIVERS,
  STYLE_DRIVER_NAMES,
  type StyleDrivers,
} from '@vspark/shared/style_rig';
import { buildGraph, pullValue } from './helpers/nodeHarness.js';

const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** A pose from bone → [pitchDeg, yawDeg, rollDeg]. Fresh object every call. */
function poseOf(
  bones: Record<string, [number, number, number]>
): NormalizedPose {
  return new NormalizedPose(
    Object.entries(bones).map(
      ([b, [p, y, r]]) =>
        [
          b as VRMBoneName,
          Quaternion.fromEuler(p * DEG, y * DEG, r * DEG),
        ] as const
    )
  );
}

function euler(q: Quaternion | undefined): [number, number, number] {
  if (!q) return [NaN, NaN, NaN];
  const e = q.toEuler();
  return [e.pitch * RAD2DEG, e.yaw * RAD2DEG, e.roll * RAD2DEG];
}

/**
 * A live single-node graph whose value inputs are fed from a MUTABLE config
 * object, so successive frames can change the input without rebuilding (and
 * losing) the node's integrator state. The engine reads config through a getter
 * on every access, so mutating the object is enough.
 */
function liveNode(
  kind: string,
  outPort: string,
  config: Record<string, unknown>
) {
  const cfg = { ...config };
  const { graph } = buildGraph(
    [
      { id: 'n', kind },
      { id: 'trg', kind: 'component_trigger' },
      { id: 'sink', kind: 'log' },
    ],
    [
      {
        fromNodeId: 'n',
        fromPort: outPort,
        toNodeId: 'sink',
        toPort: 'inputs',
      },
      {
        fromNodeId: 'trg',
        fromPort: 'trigger',
        toNodeId: 'sink',
        toPort: 'trigger',
      },
    ],
    { n: cfg }
  );
  return {
    cfg,
    /** Apply a config patch, then pull the output port once. */
    pull(patch: Record<string, unknown> = {}): unknown {
      Object.assign(cfg, patch);
      graph.fire('trg', 'trigger', mkEvent(undefined));
      return (graph.peekInput('sink', 'inputs') as unknown[])[0];
    },
  };
}

/** Conditioning disabled — raw range-normalized drivers, for deterministic math. */
const RAW_RESPONSE = { maxRate: 1e6, smoothing: 0, deadzone: 0 };

let consoleMocks: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  consoleMocks = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
  ];
});
afterEach(() => {
  consoleMocks.forEach((m) => m.mockRestore());
  vi.useRealTimers();
});

// ──────────────────────────────────────────────────────────────────────────────
// pose_style_drivers
// ──────────────────────────────────────────────────────────────────────────────

describe('pose_style_drivers', () => {
  it('normalizes head-vs-torso rotation against headRange', () => {
    const d = pullValue('pose_style_drivers', 'drivers', {
      pose: poseOf({ head: [0, 45, 0] }),
      response: { ...RAW_RESPONSE, headRange: 45 },
    }) as StyleDrivers;
    expect(d.headYaw).toBeCloseTo(1, 4);
    expect(d.headPitch).toBeCloseTo(0, 4);
    expect(d.bodyYaw).toBeCloseTo(0, 4);
  });

  it('composes the neck and head into one head-vs-torso rotation', () => {
    const d = pullValue('pose_style_drivers', 'drivers', {
      pose: poseOf({ neck: [0, 20, 0], head: [0, 25, 0] }),
      response: { ...RAW_RESPONSE, headRange: 45 },
    }) as StyleDrivers;
    expect(d.headYaw).toBeCloseTo(1, 3);
  });

  it('reads the torso chain into the body drivers, not the head drivers', () => {
    const d = pullValue('pose_style_drivers', 'drivers', {
      pose: poseOf({ spine: [0, 0, 10], chest: [0, 0, 15] }),
      response: { ...RAW_RESPONSE, bodyRange: 25 },
    }) as StyleDrivers;
    expect(d.bodyRoll).toBeCloseTo(1, 3);
    expect(d.headRoll).toBeCloseTo(0, 4);
  });

  it('clamps beyond the configured range instead of running away', () => {
    const d = pullValue('pose_style_drivers', 'drivers', {
      pose: poseOf({ head: [0, 80, 0] }),
      response: { ...RAW_RESPONSE, headRange: 45 },
    }) as StyleDrivers;
    expect(d.headYaw).toBe(1);
  });

  it('maps arm elevation to mirrored armL / armR drivers', () => {
    // Both arms raised: left is +roll, right is -roll (mirrored rest axes).
    const d = pullValue('pose_style_drivers', 'drivers', {
      pose: poseOf({ leftUpperArm: [0, 0, 30], rightUpperArm: [0, 0, -30] }),
      response: { ...RAW_RESPONSE, armRange: 90, armNeutral: -60 },
    }) as StyleDrivers;
    expect(d.armL).toBeCloseTo(1, 3);
    expect(d.armR).toBeCloseTo(1, 3);
  });

  it('treats a relaxed hanging arm as ≈neutral (no phantom shoulder droop)', () => {
    const d = pullValue('pose_style_drivers', 'drivers', {
      pose: poseOf({ leftUpperArm: [0, 0, -60] }),
      response: { ...RAW_RESPONSE, armRange: 90, armNeutral: -60 },
    }) as StyleDrivers;
    expect(d.armL).toBeCloseTo(0, 4);
  });

  it('deadzones jitter to exactly zero and rescales what survives to full range', () => {
    const small = pullValue('pose_style_drivers', 'drivers', {
      pose: poseOf({ head: [0, 2, 0] }),
      response: { ...RAW_RESPONSE, headRange: 45, deadzone: 0.1 },
    }) as StyleDrivers;
    expect(small.headYaw).toBe(0);

    const full = pullValue('pose_style_drivers', 'drivers', {
      pose: poseOf({ head: [0, 45, 0] }),
      response: { ...RAW_RESPONSE, headRange: 45, deadzone: 0.1 },
    }) as StyleDrivers;
    expect(full.headYaw).toBeCloseTo(1, 4);
  });

  it('rate-limits an impossible jump into a human slew (the glitch gate)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const n = liveNode('pose_style_drivers', 'drivers', {
      pose: poseOf({}),
      response: { maxRate: 5, smoothing: 0, deadzone: 0 },
    });

    // Frame 1: the tracker teleports the head to full deflection.
    const f1 = n.pull({ pose: poseOf({ head: [0, 45, 0] }) }) as StyleDrivers;
    // dt is the 1/60 startup step ⇒ at most 5 * 1/60 of travel.
    expect(f1.headYaw).toBeGreaterThan(0);
    expect(f1.headYaw).toBeLessThanOrEqual(5 / 60 + 1e-9);

    // Frame 2, 16ms later: another bounded step, never a snap to 1.
    vi.setSystemTime(1_000_016);
    const f2 = n.pull({ pose: poseOf({ head: [0, 45, 0] }) }) as StyleDrivers;
    expect(f2.headYaw).toBeGreaterThan(f1.headYaw);
    expect(f2.headYaw).toBeLessThan(0.2);
  });

  it('converges on the true value once the jump is over', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const n = liveNode('pose_style_drivers', 'drivers', {
      pose: poseOf({}),
      response: { maxRate: 5, smoothing: 0, deadzone: 0 },
    });
    let d = ZERO_DRIVERS;
    for (let i = 1; i <= 60; i++) {
      vi.setSystemTime(1_000_000 + i * 16);
      d = n.pull({ pose: poseOf({ head: [0, 45, 0] }) }) as StyleDrivers;
    }
    expect(d.headYaw).toBeCloseTo(1, 3);
  });

  it('smoothing damps the approach without changing the destination', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const n = liveNode('pose_style_drivers', 'drivers', {
      pose: poseOf({}),
      response: { maxRate: 1e6, smoothing: 0.5, deadzone: 0 },
    });
    const first = n.pull({
      pose: poseOf({ head: [0, 45, 0] }),
    }) as StyleDrivers;
    expect(first.headYaw).toBeGreaterThan(0);
    expect(first.headYaw).toBeLessThan(1);

    let d = first;
    for (let i = 1; i <= 40; i++) {
      vi.setSystemTime(2_000_000 + i * 16);
      d = n.pull({ pose: poseOf({ head: [0, 45, 0] }) }) as StyleDrivers;
    }
    expect(d.headYaw).toBeCloseTo(1, 3);
  });

  it('reports motion as energy and settles back to zero when still', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const n = liveNode('pose_style_drivers', 'drivers', {
      pose: poseOf({}),
      response: { maxRate: 1e6, smoothing: 0, deadzone: 0, energyScale: 4 },
    });
    vi.setSystemTime(3_000_016);
    const moving = n.pull({
      pose: poseOf({ head: [0, 45, 0] }),
    }) as StyleDrivers;
    expect(moving.energy).toBeGreaterThan(0);

    let d = moving;
    for (let i = 2; i <= 20; i++) {
      vi.setSystemTime(3_000_000 + i * 16);
      d = n.pull({ pose: poseOf({ head: [0, 45, 0] }) }) as StyleDrivers;
    }
    expect(d.energy).toBeCloseTo(0, 3);
  });

  it('emits every declared driver name', () => {
    const d = pullValue('pose_style_drivers', 'drivers', {
      pose: poseOf({ head: [0, 10, 0] }),
      response: RAW_RESPONSE,
    }) as StyleDrivers;
    for (const name of STYLE_DRIVER_NAMES) expect(d[name]).toBeTypeOf('number');
  });

  it('ignores invalid (zero-magnitude) quaternions rather than producing NaN', () => {
    const pose = new NormalizedPose([
      ['head' as VRMBoneName, new Quaternion(0, 0, 0, 0)],
    ]);
    const d = pullValue('pose_style_drivers', 'drivers', {
      pose,
      response: RAW_RESPONSE,
    }) as StyleDrivers;
    expect(d.headYaw).toBe(0);
    expect(Number.isNaN(d.headYaw)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// pose_stylize
// ──────────────────────────────────────────────────────────────────────────────

/** Full deflection on one driver, nothing else. */
function drivers(patch: Partial<StyleDrivers>): StyleDrivers {
  return { ...ZERO_DRIVERS, ...patch };
}

describe('pose_stylize', () => {
  it('fans one head driver across the whole spine chain', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: drivers({ headYaw: 1 }),
      amount: 1,
      lag: 0,
    }) as NormalizedPose;

    // Every bone in the chain participates — that IS the feature.
    for (const bone of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'])
      expect(Math.abs(euler(out.get(bone as VRMBoneName))[1])).toBeGreaterThan(
        0.5
      );

    // …and the head is no longer carrying the whole 45° by itself.
    expect(euler(out.get('head' as VRMBoneName))[1]).toBeCloseTo(
      DEFAULT_STYLE_RIG.head.drivers.headYaw![1],
      3
    );
  });

  it('keeps the total world rotation close to what the performer did', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: drivers({ headYaw: 1 }),
      amount: 1,
      lag: 0,
    }) as NormalizedPose;
    const total = [
      'hips',
      'spine',
      'chest',
      'upperChest',
      'neck',
      'head',
    ].reduce((sum, b) => sum + euler(out.get(b as VRMBoneName))[1], 0);
    expect(total).toBeGreaterThan(40);
    expect(total).toBeLessThan(52);
  });

  it('synthesizes replace-mode bones the tracker never sent', () => {
    // A face-only source sends just the head; the rig still drives a whole body.
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: drivers({ headYaw: 1 }),
      amount: 1,
      lag: 0,
    }) as NormalizedPose;
    expect(out.has('hips' as VRMBoneName)).toBe(true);
    expect(out.has('spine' as VRMBoneName)).toBe(true);
  });

  it('does not invent add-mode bones that were never tracked', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: drivers({ bodyYaw: 1 }),
      amount: 1,
      lag: 0,
    }) as NormalizedPose;
    expect(out.has('leftLowerArm' as VRMBoneName)).toBe(false);
  });

  it('layers add-mode bones over the tracked rotation instead of replacing it', () => {
    const tracked: [number, number, number] = [0, 0, 40];
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ leftLowerArm: tracked }),
      drivers: drivers({ bodyRoll: 1 }),
      amount: 1,
      lag: 0,
    }) as NormalizedPose;
    const got = euler(out.get('leftLowerArm' as VRMBoneName));
    // Tracked 40° roll + the rig's -2° bodyRoll follow-through.
    const expected =
      tracked[2] + DEFAULT_STYLE_RIG.leftLowerArm.drivers.bodyRoll![2];
    expect(got[2]).toBeCloseTo(expected, 2);
  });

  it('amount = 0 passes the accurate pose through untouched', () => {
    const input = poseOf({ head: [0, 45, 0], leftLowerArm: [0, 0, 40] });
    const out = pullValue('pose_stylize', 'pose', {
      pose: input,
      drivers: drivers({ headYaw: 1, bodyRoll: 1 }),
      amount: 0,
      lag: 0,
    }) as NormalizedPose;
    for (const bone of ['head', 'leftLowerArm'] as VRMBoneName[]) {
      const a = euler(input.get(bone));
      const b = euler(out.get(bone));
      expect(b[0]).toBeCloseTo(a[0], 4);
      expect(b[1]).toBeCloseTo(a[1], 4);
      expect(b[2]).toBeCloseTo(a[2], 4);
    }
  });

  it('amount blends continuously between accurate and stylized', () => {
    const mk = (amount: number) =>
      euler(
        (
          pullValue('pose_stylize', 'pose', {
            pose: poseOf({ head: [0, 45, 0] }),
            drivers: drivers({ headYaw: 1 }),
            amount,
            lag: 0,
          }) as NormalizedPose
        ).get('head' as VRMBoneName)
      )[1];
    const [a0, a5, a1] = [mk(0), mk(0.5), mk(1)];
    expect(a0).toBeCloseTo(45, 3);
    expect(a1).toBeCloseTo(DEFAULT_STYLE_RIG.head.drivers.headYaw![1], 3);
    expect(a5).toBeLessThan(a0);
    expect(a5).toBeGreaterThan(a1);
  });

  it('bounds the output no matter how extreme the drivers get', () => {
    // Drivers arriving out of range (a caller bug, or a hand-wired graph) must not
    // be able to fold the avatar in half.
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: drivers({ headYaw: 1, headPitch: 1, headRoll: 1, bodyYaw: 1 }),
      amount: 1,
      lag: 0,
    }) as NormalizedPose;
    for (const [, q] of out.entries()) {
      const e = euler(q);
      for (const angle of e) expect(Math.abs(angle)).toBeLessThan(90);
    }
  });

  it('passes bones the rig does not own straight through', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ leftIndexProximal: [0, 0, 33] }),
      drivers: drivers({ headYaw: 1 }),
      amount: 1,
      lag: 0,
    }) as NormalizedPose;
    expect(euler(out.get('leftIndexProximal' as VRMBoneName))[2]).toBeCloseTo(
      33,
      3
    );
  });

  it('restUnmapped sends un-owned bones to rest (glitchy fingers stop flailing)', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ leftIndexProximal: [0, 0, 33] }),
      drivers: drivers({ headYaw: 1 }),
      amount: 1,
      lag: 0,
      restUnmapped: true,
    }) as NormalizedPose;
    expect(euler(out.get('leftIndexProximal' as VRMBoneName))[2]).toBeCloseTo(
      0,
      6
    );
  });

  it('zero drivers rest the replace-mode bones', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: ZERO_DRIVERS,
      amount: 1,
      lag: 0,
    }) as NormalizedPose;
    expect(euler(out.get('head' as VRMBoneName))[1]).toBeCloseTo(0, 6);
  });

  it('applies a user rig override on top of the default', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: drivers({ headYaw: 1 }),
      amount: 1,
      lag: 0,
      rig: { head: { drivers: { headYaw: [0, 40, 0] } } },
    }) as NormalizedPose;
    expect(euler(out.get('head' as VRMBoneName))[1]).toBeCloseTo(40, 3);
  });

  it('lags each bone behind the drivers, hips further than head', () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    const n = liveNode('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 0, 0] }),
      drivers: ZERO_DRIVERS,
      amount: 1,
      lag: 0.15,
    });
    // Settle at rest first (frame 1 snaps to target — there is no history yet).
    n.pull({ pose: poseOf({ head: [0, 0, 0] }) });

    // Now step the drivers and watch the chain trail behind.
    vi.setSystemTime(4_000_016);
    const out = n.pull({
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: drivers({ headYaw: 1, bodyYaw: 1 }),
    }) as NormalizedPose;

    const frac = (bone: string, driverDeg: number) =>
      euler(out.get(bone as VRMBoneName))[1] / driverDeg;

    const headFrac = frac('head', DEFAULT_STYLE_RIG.head.drivers.headYaw![1]);
    const hipsTarget =
      DEFAULT_STYLE_RIG.hips.drivers.headYaw![1] +
      DEFAULT_STYLE_RIG.hips.drivers.bodyYaw![1];
    const hipsFrac = frac('hips', hipsTarget);

    // Both trail (neither has arrived), and the hips trail further than the head.
    expect(headFrac).toBeGreaterThan(0);
    expect(headFrac).toBeLessThan(1);
    expect(hipsFrac).toBeLessThan(headFrac);
  });

  it('converges to the un-lagged target once the drivers hold still', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const n = liveNode('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 0, 0] }),
      drivers: ZERO_DRIVERS,
      amount: 1,
      lag: 0.1,
    });
    n.pull({});
    let out = n.pull({}) as NormalizedPose;
    for (let i = 1; i <= 120; i++) {
      vi.setSystemTime(5_000_000 + i * 16);
      out = n.pull({
        pose: poseOf({ head: [0, 45, 0] }),
        drivers: drivers({ headYaw: 1 }),
      }) as NormalizedPose;
    }
    expect(euler(out.get('head' as VRMBoneName))[1]).toBeCloseTo(
      DEFAULT_STYLE_RIG.head.drivers.headYaw![1],
      2
    );
  });

  it('returns undefined without an input pose', () => {
    expect(
      pullValue('pose_stylize', 'pose', { drivers: ZERO_DRIVERS })
    ).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Wired together — the shape the pose_stylizer behavior graph uses
// ──────────────────────────────────────────────────────────────────────────────

describe('pose_style_drivers → pose_stylize', () => {
  it('round-trips a tracked head turn into a whole-body turn', () => {
    const pose = poseOf({ head: [0, 45, 0] });
    const { graph } = buildGraph(
      [
        { id: 'drivers', kind: 'pose_style_drivers' },
        { id: 'stylize', kind: 'pose_stylize' },
        { id: 'trg', kind: 'component_trigger' },
        { id: 'sink', kind: 'log' },
      ],
      [
        {
          fromNodeId: 'drivers',
          fromPort: 'drivers',
          toNodeId: 'stylize',
          toPort: 'drivers',
          kind: 'value',
        },
        {
          fromNodeId: 'stylize',
          fromPort: 'pose',
          toNodeId: 'sink',
          toPort: 'inputs',
        },
        {
          fromNodeId: 'trg',
          fromPort: 'trigger',
          toNodeId: 'sink',
          toPort: 'trigger',
        },
      ],
      {
        drivers: { pose, response: { ...RAW_RESPONSE, headRange: 45 } },
        stylize: { pose, amount: 1, lag: 0 },
      }
    );
    graph.fire('trg', 'trigger', mkEvent(undefined));
    const out = (
      graph.peekInput('sink', 'inputs') as unknown[]
    )[0] as NormalizedPose;

    expect(euler(out.get('head' as VRMBoneName))[1]).toBeCloseTo(
      DEFAULT_STYLE_RIG.head.drivers.headYaw![1],
      2
    );
    expect(euler(out.get('hips' as VRMBoneName))[1]).toBeCloseTo(
      DEFAULT_STYLE_RIG.hips.drivers.headYaw![1],
      2
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// pose_stylize — rig presets (body follows the head vs twists against it)
// ──────────────────────────────────────────────────────────────────────────────

describe('pose_stylize rig presets', () => {
  const stylizeWith = (preset?: string) =>
    pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: { ...ZERO_DRIVERS, headYaw: 1 },
      amount: 1,
      lag: 0,
      ...(preset === undefined ? {} : { preset }),
    }) as NormalizedPose;

  const yawOf = (out: NormalizedPose, bone: string) =>
    euler(out.get(bone as VRMBoneName))[1];

  it('defaults to follow — the torso turns WITH the head', () => {
    const out = stylizeWith();
    for (const bone of ['hips', 'spine', 'chest', 'upperChest'])
      expect(yawOf(out, bone)).toBeGreaterThan(0);
    expect(yawOf(out, 'head')).toBeCloseTo(
      STYLE_RIG_FOLLOW.head.drivers.headYaw![1],
      2
    );
  });

  it('counter turns the torso AGAINST the head', () => {
    const out = stylizeWith('counter');
    for (const bone of ['hips', 'spine', 'chest', 'upperChest'])
      expect(yawOf(out, bone)).toBeLessThan(0);
    expect(yawOf(out, 'head')).toBeCloseTo(
      STYLE_RIG_COUNTER.head.drivers.headYaw![1],
      2
    );
  });

  it('both presets still land the head on target overall', () => {
    const chain = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
    for (const preset of ['follow', 'counter']) {
      const out = stylizeWith(preset);
      const total = chain.reduce((acc, b) => acc + yawOf(out, b), 0);
      expect(total).toBeGreaterThan(40);
      expect(total).toBeLessThan(52);
    }
  });

  it('an unknown preset name falls back to follow rather than emptying the rig', () => {
    const out = stylizeWith('nonsense');
    expect(yawOf(out, 'hips')).toBeGreaterThan(0);
    expect(yawOf(out, 'head')).toBeCloseTo(
      DEFAULT_STYLE_RIG.head.drivers.headYaw![1],
      2
    );
  });

  it('user overrides merge over the SELECTED preset, not always the default', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: { ...ZERO_DRIVERS, headYaw: 1 },
      amount: 1,
      lag: 0,
      preset: 'counter',
      // Only the head is overridden; the torso must still come from `counter`.
      rig: { head: { drivers: { headYaw: [0, 30, 0] } } },
    }) as NormalizedPose;
    expect(yawOf(out, 'head')).toBeCloseTo(30, 2);
    expect(yawOf(out, 'hips')).toBeLessThan(0);
  });

  it('switching preset on a live node re-resolves the rig', () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_000_000);
    const n = liveNode('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: { ...ZERO_DRIVERS, headYaw: 1 },
      amount: 1,
      lag: 0,
      preset: 'follow',
    });
    const before = n.pull({
      pose: poseOf({ head: [0, 45, 0] }),
    }) as NormalizedPose;
    expect(yawOf(before, 'hips')).toBeGreaterThan(0);

    vi.setSystemTime(6_000_016);
    const after = n.pull({
      pose: poseOf({ head: [0, 45, 0] }),
      preset: 'counter',
    }) as NormalizedPose;
    expect(yawOf(after, 'hips')).toBeLessThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Presets that reach beyond the rig (headOnly, expressive)
// ──────────────────────────────────────────────────────────────────────────────

describe('pose_stylize / pose_style_drivers preset bundles', () => {
  const yawOf = (out: NormalizedPose, bone: string) =>
    euler(out.get(bone as VRMBoneName))[1];

  it('headOnly ignores body drivers entirely', () => {
    // A pose with a big torso twist and NO head rotation. follow moves the torso;
    // headOnly must not, because it never reads the body drivers.
    const twisted = () => poseOf({ hips: [0, 20, 0], spine: [0, 5, 0] });
    const cfg = (preset: string) => ({
      pose: twisted(),
      drivers: { ...ZERO_DRIVERS, bodyYaw: 1 },
      amount: 1,
      lag: 0,
      preset,
    });

    const followed = pullValue(
      'pose_stylize',
      'pose',
      cfg('follow')
    ) as NormalizedPose;
    expect(Math.abs(yawOf(followed, 'chest'))).toBeGreaterThan(1);

    const headOnly = pullValue(
      'pose_stylize',
      'pose',
      cfg('headOnly')
    ) as NormalizedPose;
    expect(yawOf(headOnly, 'chest')).toBeCloseTo(0, 6);
    expect(yawOf(headOnly, 'hips')).toBeCloseTo(0, 6);
  });

  it('headOnly drives the whole torso from head movement alone', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: { ...ZERO_DRIVERS, headYaw: 1 },
      amount: 1,
      lag: 0,
      preset: 'headOnly',
    }) as NormalizedPose;
    for (const bone of ['hips', 'spine', 'chest', 'upperChest'])
      expect(yawOf(out, bone)).toBeGreaterThan(0);
    expect(yawOf(out, 'head')).toBeCloseTo(
      STYLE_RIG_HEAD_ONLY.head.drivers.headYaw![1],
      2
    );
  });

  it('headOnly moves the body more, and the head less, than follow', () => {
    const mk = (preset: string) =>
      pullValue('pose_stylize', 'pose', {
        pose: poseOf({ head: [0, 45, 0] }),
        drivers: { ...ZERO_DRIVERS, headYaw: 1 },
        amount: 1,
        lag: 0,
        preset,
      }) as NormalizedPose;
    const f = mk('follow');
    const h = mk('headOnly');
    expect(yawOf(h, 'chest')).toBeGreaterThan(yawOf(f, 'chest'));
    expect(yawOf(h, 'head')).toBeLessThan(yawOf(f, 'head'));
  });

  it('headOnly leaves untracked forearms alone (they drop out of the rig)', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0], leftLowerArm: [0, 0, 40] }),
      drivers: { ...ZERO_DRIVERS, headYaw: 1, bodyRoll: 1 },
      amount: 1,
      lag: 0,
      preset: 'headOnly',
    }) as NormalizedPose;
    // follow would add a bodyRoll follow-through here; headOnly passes it through.
    expect(euler(out.get('leftLowerArm' as VRMBoneName))[2]).toBeCloseTo(40, 3);
  });

  it('expressive reaches a full driver from less head movement', () => {
    // 30° of head turn: a full driver under expressive, two-thirds under follow.
    const drive = (preset?: string) =>
      pullValue('pose_style_drivers', 'drivers', {
        pose: poseOf({ head: [0, 30, 0] }),
        response: { maxRate: 1e6, smoothing: 0, deadzone: 0 },
        ...(preset === undefined ? {} : { preset }),
      }) as StyleDrivers;

    expect(drive('expressive').headYaw).toBeCloseTo(1, 3);
    expect(drive('follow').headYaw).toBeCloseTo(30 / 45, 3);
  });

  it('a user response override still beats the preset', () => {
    const d = pullValue('pose_style_drivers', 'drivers', {
      pose: poseOf({ head: [0, 30, 0] }),
      response: { maxRate: 1e6, smoothing: 0, deadzone: 0, headRange: 60 },
      preset: 'expressive',
    }) as StyleDrivers;
    expect(d.headYaw).toBeCloseTo(30 / 60, 3);
  });

  it('an unset lag falls through to the preset’s base follow-through', () => {
    vi.useFakeTimers();
    vi.setSystemTime(7_000_000);
    // expressive trails more than the global default, so after one 16ms step from
    // rest it has travelled LESS of the way to target than follow has.
    const step = (preset: string) => {
      vi.setSystemTime(7_000_000);
      const n = liveNode('pose_stylize', 'pose', {
        pose: poseOf({ head: [0, 0, 0] }),
        drivers: ZERO_DRIVERS,
        amount: 1,
        preset,
        // `lag` deliberately absent → preset supplies it.
      });
      n.pull({ pose: poseOf({ head: [0, 0, 0] }) });
      vi.setSystemTime(7_000_016);
      return n.pull({
        pose: poseOf({ head: [0, 45, 0] }),
        drivers: { ...ZERO_DRIVERS, headYaw: 1 },
      }) as NormalizedPose;
    };
    expect(yawOf(step('expressive'), 'head')).toBeLessThan(
      yawOf(step('follow'), 'head')
    );
    expect(STYLE_PRESETS.expressive.lag).toBeGreaterThan(0.08);
  });

  it('follow and counter carry no response override of their own', () => {
    expect(STYLE_PRESETS.follow.response).toBeUndefined();
    expect(STYLE_PRESETS.counter.response).toBeUndefined();
    expect(STYLE_RIG_FOLLOW).toBe(STYLE_PRESETS.follow.rig);
    expect(STYLE_RIG_COUNTER).toBe(STYLE_PRESETS.counter.rig);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// pose_stylize — overall strength (a MULTIPLIER, distinct from the amount BLEND)
// ──────────────────────────────────────────────────────────────────────────────

describe('pose_stylize strength', () => {
  const yawOf = (out: NormalizedPose, bone: string) =>
    euler(out.get(bone as VRMBoneName))[1];

  const mk = (extra: Record<string, unknown> = {}) =>
    pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: { ...ZERO_DRIVERS, headYaw: 1 },
      amount: 1,
      lag: 0,
      ...extra,
    }) as NormalizedPose;

  it('defaults to 1 — the rig exactly as authored', () => {
    expect(yawOf(mk(), 'head')).toBeCloseTo(
      yawOf(mk({ strength: 1 }), 'head'),
      6
    );
    expect(yawOf(mk(), 'head')).toBeCloseTo(
      STYLE_RIG_FOLLOW.head.drivers.headYaw![1],
      2
    );
  });

  it('scales every rig contribution proportionally', () => {
    const half = mk({ strength: 0.5 });
    const full = mk({ strength: 1 });
    for (const bone of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'])
      expect(yawOf(half, bone)).toBeCloseTo(yawOf(full, bone) / 2, 2);
  });

  it('exaggerates past the authored rig above 1', () => {
    // This is what `amount` structurally cannot do — it tops out at fully stylized.
    expect(yawOf(mk({ strength: 2 }), 'head')).toBeGreaterThan(
      yawOf(mk({ strength: 1 }), 'head')
    );
    expect(yawOf(mk({ strength: 2 }), 'head')).toBeCloseTo(
      2 * STYLE_RIG_FOLLOW.head.drivers.headYaw![1],
      1
    );
  });

  it('strength 0 rests the replace bones — a different "off" from amount 0', () => {
    // strength 0: the rig contributes nothing, so replace bones go to REST.
    const noStrength = mk({ strength: 0 });
    expect(yawOf(noStrength, 'head')).toBeCloseTo(0, 6);
    expect(yawOf(noStrength, 'hips')).toBeCloseTo(0, 6);
    // amount 0: tracking passes through untouched, so the head keeps its 45°.
    expect(yawOf(mk({ amount: 0 }), 'head')).toBeCloseTo(45, 3);
  });

  it('leaves add-mode bones on their tracked rotation at strength 0', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ leftLowerArm: [0, 0, 40] }),
      drivers: { ...ZERO_DRIVERS, bodyRoll: 1 },
      amount: 1,
      lag: 0,
      strength: 0,
    }) as NormalizedPose;
    expect(euler(out.get('leftLowerArm' as VRMBoneName))[2]).toBeCloseTo(40, 3);
  });

  it('clamps out-of-range values instead of folding the avatar', () => {
    expect(yawOf(mk({ strength: 99 }), 'head')).toBeCloseTo(
      yawOf(mk({ strength: MAX_STYLE_STRENGTH }), 'head'),
      6
    );
    expect(yawOf(mk({ strength: -5 }), 'head')).toBeCloseTo(0, 6);
  });

  it('composes with amount — they are independent axes', () => {
    // Half strength then half blend lands between rest and the half-strength pose.
    const halfStrength = yawOf(mk({ strength: 0.5 }), 'head');
    const both = yawOf(mk({ strength: 0.5, amount: 0.5 }), 'head');
    expect(both).toBeGreaterThan(halfStrength);
    expect(both).toBeLessThan(45);
  });

  it('eases in through the lag integrator rather than snapping', () => {
    vi.useFakeTimers();
    vi.setSystemTime(8_000_000);
    const n = liveNode('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: { ...ZERO_DRIVERS, headYaw: 1 },
      amount: 1,
      lag: 0.15,
      strength: 1,
    });
    const settled = n.pull({
      pose: poseOf({ head: [0, 45, 0] }),
    }) as NormalizedPose;
    const before = yawOf(settled, 'head');

    // Bump strength; one 16ms step must move only PART of the way to 2×.
    vi.setSystemTime(8_000_016);
    const stepped = n.pull({
      pose: poseOf({ head: [0, 45, 0] }),
      strength: 2,
    }) as NormalizedPose;
    const after = yawOf(stepped, 'head');
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(before * 2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// The head-only family: follow vs contrapposto, and the nod
// ──────────────────────────────────────────────────────────────────────────────

describe('pose_stylize head-only presets', () => {
  const drive = (preset: string, driver: keyof StyleDrivers) =>
    pullValue('pose_stylize', 'pose', {
      pose: poseOf({ head: [0, 45, 0] }),
      drivers: { ...ZERO_DRIVERS, [driver]: 1 },
      amount: 1,
      lag: 0,
      preset,
    }) as NormalizedPose;

  const axisOf = (out: NormalizedPose, bone: string, axis: number) =>
    euler(out.get(bone as VRMBoneName))[axis];

  it('headOnlyCounter twists the torso against a head turn', () => {
    const out = drive('headOnlyCounter', 'headYaw');
    for (const bone of ['hips', 'spine', 'chest', 'upperChest'])
      expect(axisOf(out, bone, 1)).toBeLessThan(0);
    // …while the head itself carries far more, so the gaze still lands.
    expect(axisOf(out, 'head', 1)).toBeCloseTo(
      STYLE_RIG_HEAD_ONLY_COUNTER.head.drivers.headYaw![1],
      2
    );
  });

  it('the two head-only presets turn the torso opposite ways', () => {
    expect(axisOf(drive('headOnly', 'headYaw'), 'chest', 1)).toBeGreaterThan(0);
    expect(
      axisOf(drive('headOnlyCounter', 'headYaw'), 'chest', 1)
    ).toBeLessThan(0);
  });

  it('headOnlyCounter ignores body drivers, same as headOnly', () => {
    const out = pullValue('pose_stylize', 'pose', {
      pose: poseOf({ hips: [0, 20, 0] }),
      drivers: { ...ZERO_DRIVERS, bodyYaw: 1, bodyRoll: 1 },
      amount: 1,
      lag: 0,
      preset: 'headOnlyCounter',
    }) as NormalizedPose;
    expect(axisOf(out, 'chest', 1)).toBeCloseTo(0, 6);
    expect(axisOf(out, 'chest', 2)).toBeCloseTo(0, 6);
  });

  it('nods mostly with the head, not the spine, in BOTH head-only presets', () => {
    // A nod spread down the spine reads as bowing, not agreeing.
    for (const preset of ['headOnly', 'headOnlyCounter']) {
      const out = drive(preset, 'headPitch');
      const torso = ['hips', 'spine', 'chest', 'upperChest'].reduce(
        (acc, b) => acc + Math.abs(axisOf(out, b, 0)),
        0
      );
      const headNeck = ['neck', 'head'].reduce(
        (acc, b) => acc + Math.abs(axisOf(out, b, 0)),
        0
      );
      expect(headNeck / (headNeck + torso), preset).toBeGreaterThan(0.7);
    }
  });

  it('nods less into the torso than it turns, in BOTH head-only presets', () => {
    for (const preset of ['headOnly', 'headOnlyCounter']) {
      const torsoOn = (driver: keyof StyleDrivers, axis: number) =>
        ['hips', 'spine', 'chest', 'upperChest'].reduce(
          (acc, b) => acc + Math.abs(axisOf(drive(preset, driver), b, axis)),
          0
        );
      expect(torsoOn('headPitch', 0), preset).toBeLessThan(
        torsoOn('headYaw', 1)
      );
    }
  });

  it('still lands the nod on target overall', () => {
    for (const preset of ['headOnly', 'headOnlyCounter']) {
      const out = drive(preset, 'headPitch');
      const total = [
        'hips',
        'spine',
        'chest',
        'upperChest',
        'neck',
        'head',
      ].reduce((acc, b) => acc + axisOf(out, b, 0), 0);
      expect(total, preset).toBeGreaterThan(40);
      expect(total, preset).toBeLessThan(52);
    }
  });
});
