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
