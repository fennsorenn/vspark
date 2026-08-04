import { describe, it, expect } from 'vitest';
import {
  STYLE_DRIVER_NAMES,
  STYLE_RIG_FOLLOW,
  STYLE_RIG_COUNTER,
  STYLE_RIG_PRESETS,
  STYLE_RIG_PRESET_NAMES,
  DEFAULT_STYLE_RIG_PRESET,
  styleRigPreset,
  ZERO_DRIVERS,
  DEFAULT_STYLE_RESPONSE,
  DEFAULT_STYLE_RIG,
  resolveStyleResponse,
  mergeStyleRig,
  evaluateBoneResponse,
  type StyleDrivers,
  type StyleRig,
} from '../src/style_rig.js';
import { VRM_BONE_NAMES } from '../src/signal.js';

describe('STYLE_DRIVER_NAMES / ZERO_DRIVERS', () => {
  it('are in sync — every declared driver has a zero entry and nothing else does', () => {
    expect(Object.keys(ZERO_DRIVERS).sort()).toEqual(
      [...STYLE_DRIVER_NAMES].sort()
    );
    for (const v of Object.values(ZERO_DRIVERS)) expect(v).toBe(0);
  });

  it('has unique names', () => {
    expect(new Set(STYLE_DRIVER_NAMES).size).toBe(STYLE_DRIVER_NAMES.length);
  });
});

describe('resolveStyleResponse', () => {
  it('returns the defaults for undefined and null', () => {
    expect(resolveStyleResponse()).toEqual(DEFAULT_STYLE_RESPONSE);
    expect(resolveStyleResponse(null)).toEqual(DEFAULT_STYLE_RESPONSE);
  });

  it('overlays only the fields that were supplied', () => {
    const r = resolveStyleResponse({ headRange: 90, deadzone: 0 });
    expect(r.headRange).toBe(90);
    expect(r.deadzone).toBe(0);
    expect(r.bodyRange).toBe(DEFAULT_STYLE_RESPONSE.bodyRange);
    expect(r.maxRate).toBe(DEFAULT_STYLE_RESPONSE.maxRate);
  });

  it('does not mutate the shared defaults object', () => {
    resolveStyleResponse({ headRange: 999 });
    expect(DEFAULT_STYLE_RESPONSE.headRange).toBe(45);
  });
});

describe('DEFAULT_STYLE_RIG — the design invariants', () => {
  it('only names real VRM humanoid bones', () => {
    for (const bone of Object.keys(DEFAULT_STYLE_RIG))
      expect(VRM_BONE_NAMES).toContain(bone);
  });

  it('only references declared drivers', () => {
    for (const entry of Object.values(DEFAULT_STYLE_RIG))
      for (const driver of Object.keys(entry.drivers))
        expect(STYLE_DRIVER_NAMES).toContain(driver);
  });

  it('spreads each head driver down the chain to ~headRange in total', () => {
    // The contract that keeps "stylized" from also meaning "no longer looking
    // where you are looking": summed over the chain, one unit of a head driver
    // still produces about a full headRange of world rotation.
    const chain = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
    for (const [driver, axis] of [
      ['headYaw', 1],
      ['headPitch', 0],
      ['headRoll', 2],
    ] as const) {
      const total = chain.reduce(
        (sum, bone) =>
          sum + (DEFAULT_STYLE_RIG[bone]?.drivers[driver]?.[axis] ?? 0),
        0
      );
      expect(total).toBeGreaterThanOrEqual(
        DEFAULT_STYLE_RESPONSE.headRange * 0.9
      );
      expect(total).toBeLessThanOrEqual(
        DEFAULT_STYLE_RESPONSE.headRange * 1.15
      );
    }
  });

  it('spreads each body driver across the torso to ~bodyRange in total', () => {
    const chain = ['hips', 'spine', 'chest', 'upperChest'];
    for (const [driver, axis] of [
      ['bodyYaw', 1],
      ['bodyPitch', 0],
      ['bodyRoll', 2],
    ] as const) {
      const total = chain.reduce(
        (sum, bone) =>
          sum + (DEFAULT_STYLE_RIG[bone]?.drivers[driver]?.[axis] ?? 0),
        0
      );
      expect(total).toBeGreaterThanOrEqual(
        DEFAULT_STYLE_RESPONSE.bodyRange * 0.9
      );
      expect(total).toBeLessThanOrEqual(
        DEFAULT_STYLE_RESPONSE.bodyRange * 1.15
      );
    }
  });

  it('counter-rotates head and neck against torso lean (keeps the gaze level)', () => {
    expect(DEFAULT_STYLE_RIG.head.drivers.bodyPitch![0]).toBeLessThan(0);
    expect(DEFAULT_STYLE_RIG.head.drivers.bodyRoll![2]).toBeLessThan(0);
    expect(DEFAULT_STYLE_RIG.neck.drivers.bodyPitch![0]).toBeLessThan(0);
    expect(DEFAULT_STYLE_RIG.neck.drivers.bodyRoll![2]).toBeLessThan(0);
  });

  it('staggers lag down the chain — hips trail furthest, head least', () => {
    const lags = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'].map(
      (b) => DEFAULT_STYLE_RIG[b].lag!
    );
    for (let i = 1; i < lags.length; i++)
      expect(lags[i]).toBeLessThan(lags[i - 1]);
  });

  it('mirrors anatomical motion per side but shares the sign for whole-body motion', () => {
    // Each shoulder lifts with its OWN arm → mirrored signs.
    expect(DEFAULT_STYLE_RIG.leftShoulder.drivers.armL![2]).toBeGreaterThan(0);
    expect(DEFAULT_STYLE_RIG.rightShoulder.drivers.armR![2]).toBeLessThan(0);
    // A torso turn rotates the whole frame → same sign on both sides.
    expect(DEFAULT_STYLE_RIG.leftShoulder.drivers.bodyYaw![1]).toBe(
      DEFAULT_STYLE_RIG.rightShoulder.drivers.bodyYaw![1]
    );
    expect(DEFAULT_STYLE_RIG.leftUpperArm.drivers.bodyRoll![2]).toBe(
      DEFAULT_STYLE_RIG.rightUpperArm.drivers.bodyRoll![2]
    );
  });

  it('replaces the spine chain but only adds to the limbs', () => {
    for (const bone of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'])
      expect(DEFAULT_STYLE_RIG[bone].mode).toBe('replace');
    for (const bone of [
      'leftUpperArm',
      'rightUpperArm',
      'leftLowerArm',
      'rightLowerArm',
    ])
      expect(DEFAULT_STYLE_RIG[bone].mode).toBe('add');
  });

  it('leaves the `energy` driver unmapped — it is there to be wired by hand', () => {
    for (const entry of Object.values(DEFAULT_STYLE_RIG))
      expect(entry.drivers.energy).toBeUndefined();
  });
});

describe('mergeStyleRig', () => {
  it('returns the base by identity when there are no overrides', () => {
    expect(mergeStyleRig(DEFAULT_STYLE_RIG, null)).toBe(DEFAULT_STYLE_RIG);
    expect(mergeStyleRig(DEFAULT_STYLE_RIG, undefined)).toBe(DEFAULT_STYLE_RIG);
  });

  it('merges per driver, leaving the rest of the bone and other bones alone', () => {
    const merged = mergeStyleRig(DEFAULT_STYLE_RIG, {
      head: { drivers: { headYaw: [0, 40, 0] } },
    });
    expect(merged.head.drivers.headYaw).toEqual([0, 40, 0]);
    expect(merged.head.drivers.headPitch).toEqual(
      DEFAULT_STYLE_RIG.head.drivers.headPitch
    );
    expect(merged.neck).toEqual(DEFAULT_STYLE_RIG.neck);
  });

  it('inherits mode and lag from the base when the override omits them', () => {
    const merged = mergeStyleRig(DEFAULT_STYLE_RIG, {
      leftUpperArm: { drivers: { bodyYaw: [0, -9, 0] } },
    });
    expect(merged.leftUpperArm.mode).toBe(DEFAULT_STYLE_RIG.leftUpperArm.mode);
    expect(merged.leftUpperArm.lag).toBe(DEFAULT_STYLE_RIG.leftUpperArm.lag);
  });

  it('lets an override change mode and lag', () => {
    const merged = mergeStyleRig(DEFAULT_STYLE_RIG, {
      head: { mode: 'add', lag: 9, drivers: {} },
    });
    expect(merged.head.mode).toBe('add');
    expect(merged.head.lag).toBe(9);
  });

  it('defaults an all-new bone to replace mode with unit lag', () => {
    const merged = mergeStyleRig(
      {},
      { spine: { drivers: { bodyYaw: [0, 5, 0] } } }
    );
    expect(merged.spine.mode).toBe('replace');
    expect(merged.spine.lag).toBe(1);
  });

  it('adds bones the base rig never mentioned', () => {
    const merged = mergeStyleRig(DEFAULT_STYLE_RIG, {
      leftUpperLeg: { mode: 'add', lag: 5, drivers: { bodyRoll: [0, 0, 3] } },
    });
    expect(merged.leftUpperLeg.drivers.bodyRoll).toEqual([0, 0, 3]);
    expect(merged.leftUpperLeg.mode).toBe('add');
    // Base bones survive alongside.
    expect(merged.head).toBeDefined();
  });

  it('prunes zeroed driver entries instead of keeping dead weight', () => {
    const merged = mergeStyleRig(DEFAULT_STYLE_RIG, {
      head: { drivers: { headRoll: [0, 0, 0] } },
    });
    expect(merged.head.drivers.headRoll).toBeUndefined();
    expect(merged.head.drivers.headYaw).toBeDefined();
  });

  it('drops a bone entirely once every driver on it is zeroed (the UI "off" switch)', () => {
    const zeroed: StyleRig = {
      head: {
        drivers: Object.fromEntries(
          Object.keys(DEFAULT_STYLE_RIG.head.drivers).map((d) => [d, [0, 0, 0]])
        ),
      },
    };
    const merged = mergeStyleRig(DEFAULT_STYLE_RIG, zeroed);
    expect(merged.head).toBeUndefined();
    expect(merged.neck).toBeDefined();
  });

  it('does not mutate either input', () => {
    const base: StyleRig = {
      head: { mode: 'replace', lag: 1, drivers: { headYaw: [0, 1, 0] } },
    };
    const over: StyleRig = { head: { drivers: { headYaw: [0, 2, 0] } } };
    mergeStyleRig(base, over);
    expect(base.head.drivers.headYaw).toEqual([0, 1, 0]);
    expect(over.head.drivers.headYaw).toEqual([0, 2, 0]);
  });
});

describe('evaluateBoneResponse', () => {
  const drivers = (patch: Partial<StyleDrivers>): StyleDrivers => ({
    ...ZERO_DRIVERS,
    ...patch,
  });

  it('sums per-driver contributions weighted by driver value', () => {
    expect(
      evaluateBoneResponse(
        { drivers: { headYaw: [0, 10, 0], bodyYaw: [0, 6, 0] } },
        drivers({ headYaw: 0.5, bodyYaw: 1 })
      )
    ).toEqual([0, 11, 0]);
  });

  it('accumulates across all three axes', () => {
    expect(
      evaluateBoneResponse(
        { drivers: { headYaw: [1, 2, 3], headRoll: [10, 20, 30] } },
        drivers({ headYaw: 1, headRoll: 0.5 })
      )
    ).toEqual([6, 12, 18]);
  });

  it('is zero when every driver is zero', () => {
    expect(evaluateBoneResponse(DEFAULT_STYLE_RIG.head, ZERO_DRIVERS)).toEqual([
      0, 0, 0,
    ]);
  });

  it('is zero for an entry with no drivers at all', () => {
    expect(
      evaluateBoneResponse({ drivers: {} }, drivers({ headYaw: 1 }))
    ).toEqual([0, 0, 0]);
  });

  it('ignores drivers the frame does not carry', () => {
    const partial = { headYaw: 1 } as unknown as StyleDrivers;
    expect(
      evaluateBoneResponse(
        { drivers: { headYaw: [0, 10, 0], bodyRoll: [0, 0, 7] } },
        partial
      )
    ).toEqual([0, 10, 0]);
  });

  it('negates cleanly for negative driver values', () => {
    expect(
      evaluateBoneResponse(
        { drivers: { headYaw: [0, 10, 0] } },
        drivers({ headYaw: -1 })
      )
    ).toEqual([0, -10, 0]);
  });
});

// ---------------------------------------------------------------------------
// Rig presets — the two conventions 2D rigs are built on
// ---------------------------------------------------------------------------

const TORSO = ['hips', 'spine', 'chest', 'upperChest'];
const HEAD_CHAIN = ['neck', 'head'];
const HEAD_AXES = [
  ['headYaw', 1],
  ['headPitch', 0],
  ['headRoll', 2],
] as const;

const sum = (rig: StyleRig, bones: string[], driver: string, axis: number) =>
  bones.reduce(
    (acc, b) =>
      acc +
      (rig[b]?.drivers[driver as keyof (typeof rig)[string]['drivers']]?.[
        axis
      ] ?? 0),
    0
  );

describe('style rig presets', () => {
  it('exposes exactly the declared presets, with follow as the default', () => {
    expect(Object.keys(STYLE_RIG_PRESETS).sort()).toEqual(
      [...STYLE_RIG_PRESET_NAMES].sort()
    );
    expect(DEFAULT_STYLE_RIG_PRESET).toBe('follow');
    expect(STYLE_RIG_PRESETS.follow).toBe(STYLE_RIG_FOLLOW);
    expect(STYLE_RIG_PRESETS.counter).toBe(STYLE_RIG_COUNTER);
  });

  it('styleRigPreset resolves names and falls back to follow', () => {
    expect(styleRigPreset('counter')).toBe(STYLE_RIG_COUNTER);
    expect(styleRigPreset('follow')).toBe(STYLE_RIG_FOLLOW);
    for (const bad of [undefined, null, '', 'nope'])
      expect(styleRigPreset(bad)).toBe(STYLE_RIG_FOLLOW);
  });

  it('follow moves the torso WITH the head on every head axis', () => {
    for (const [driver, axis] of HEAD_AXES)
      expect(sum(STYLE_RIG_FOLLOW, TORSO, driver, axis)).toBeGreaterThan(0);
  });

  it('counter moves the torso AGAINST the head on every head axis', () => {
    for (const [driver, axis] of HEAD_AXES)
      expect(sum(STYLE_RIG_COUNTER, TORSO, driver, axis)).toBeLessThan(0);
  });

  it('counter compensates on the head+neck so the gaze still lands on target', () => {
    // The trap this guards: negating the torso terms alone would drop the summed
    // head-in-world rotation from ~47° to ~13°, i.e. the avatar would stop looking
    // where the performer looks. Head + neck must carry MORE than the full range.
    for (const [driver, axis] of HEAD_AXES) {
      const headNeck = sum(STYLE_RIG_COUNTER, HEAD_CHAIN, driver, axis);
      expect(headNeck).toBeGreaterThan(DEFAULT_STYLE_RESPONSE.headRange);
      expect(headNeck).toBeGreaterThan(
        sum(STYLE_RIG_FOLLOW, HEAD_CHAIN, driver, axis)
      );
    }
  });

  it('BOTH presets keep the whole-chain total at ~headRange', () => {
    // The invariant that makes the presets interchangeable: whichever convention
    // you pick, the head still ends up pointing where you are pointing it.
    const chain = [...TORSO, ...HEAD_CHAIN];
    for (const rig of [STYLE_RIG_FOLLOW, STYLE_RIG_COUNTER])
      for (const [driver, axis] of HEAD_AXES) {
        const total = sum(rig, chain, driver, axis);
        expect(total).toBeGreaterThanOrEqual(
          DEFAULT_STYLE_RESPONSE.headRange * 0.9
        );
        expect(total).toBeLessThanOrEqual(
          DEFAULT_STYLE_RESPONSE.headRange * 1.15
        );
      }
  });

  it('the presets differ ONLY in how the torso answers the head', () => {
    // Body drivers, shoulders, arms, lags and modes are shared — "follow vs
    // counter" is only ever a statement about the head→torso coupling.
    for (const bone of Object.keys(STYLE_RIG_FOLLOW)) {
      const f = STYLE_RIG_FOLLOW[bone];
      const c = STYLE_RIG_COUNTER[bone];
      expect(c).toBeDefined();
      expect(c.mode).toBe(f.mode);
      expect(c.lag).toBe(f.lag);
      for (const driver of Object.keys(f.drivers)) {
        if (driver.startsWith('head')) continue;
        expect(c.drivers[driver as keyof typeof c.drivers]).toEqual(
          f.drivers[driver as keyof typeof f.drivers]
        );
      }
    }
  });

  it('counter keeps the head countering torso lean, same as follow', () => {
    // The OTHER coupling direction (body driver → head bone) is opposed in both.
    expect(STYLE_RIG_COUNTER.head.drivers.bodyRoll![2]).toBeLessThan(0);
    expect(STYLE_RIG_COUNTER.neck.drivers.bodyPitch![0]).toBeLessThan(0);
  });

  it('leaves the follow preset untouched when building counter', () => {
    expect(STYLE_RIG_FOLLOW.head.drivers.headYaw).toEqual([0, 20, 0]);
    expect(STYLE_RIG_COUNTER.head.drivers.headYaw).toEqual([0, 38, 0]);
  });
});
