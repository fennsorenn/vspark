import { describe, it, expect } from 'vitest';
import {
  STYLE_DRIVER_NAMES,
  STYLE_RIG_FOLLOW,
  STYLE_RIG_COUNTER,
  STYLE_RIG_HEAD_ONLY,
  STYLE_RIG_HEAD_ONLY_COUNTER,
  STYLE_PRESETS,
  STYLE_PRESET_NAMES,
  DEFAULT_STYLE_PRESET,
  DEFAULT_STYLE_LAG,
  stylePreset,
  styleRigPreset,
  SIMPLE_CHANNELS,
  SIMPLE_SECTION_BONES,
  SIMPLE_CHANNEL_SPEC,
  deriveSimpleRig,
  compileSimpleRig,
  resolveRigMode,
  resolveStyleRig,
  DEFAULT_RIG_MODE,
  RIG_MODES,
  styleRigPresetLag,
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

  it('leaves the `energy` driver unmapped — users opt into it per bone', () => {
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

describe('style presets', () => {
  it('exposes exactly the declared presets, with follow as the default', () => {
    expect(Object.keys(STYLE_PRESETS).sort()).toEqual(
      [...STYLE_PRESET_NAMES].sort()
    );
    expect(DEFAULT_STYLE_PRESET).toBe('follow');
    expect(STYLE_PRESETS.follow.rig).toBe(STYLE_RIG_FOLLOW);
    expect(STYLE_PRESETS.counter.rig).toBe(STYLE_RIG_COUNTER);
    expect(STYLE_PRESETS.headOnly.rig).toBe(STYLE_RIG_HEAD_ONLY);
    expect(STYLE_PRESETS.headOnlyCounter.rig).toBe(STYLE_RIG_HEAD_ONLY_COUNTER);
  });

  it('resolves names and falls back to follow for junk', () => {
    expect(styleRigPreset('counter')).toBe(STYLE_RIG_COUNTER);
    expect(styleRigPreset('headOnly')).toBe(STYLE_RIG_HEAD_ONLY);
    for (const bad of [undefined, null, '', 'nope'])
      expect(styleRigPreset(bad)).toBe(STYLE_RIG_FOLLOW);
    expect(stylePreset('nope')).toBe(STYLE_PRESETS.follow);
  });

  it('every preset rig names real bones and declared drivers', () => {
    for (const { rig } of Object.values(STYLE_PRESETS))
      for (const [bone, entry] of Object.entries(rig)) {
        expect(VRM_BONE_NAMES).toContain(bone);
        for (const driver of Object.keys(entry.drivers))
          expect(STYLE_DRIVER_NAMES).toContain(driver);
      }
  });

  it('EVERY preset rig totals ~headRange across the chain', () => {
    // Every rig is authored against the DEFAULT design range, so at driver = 1 the
    // chain produces about a full headRange of world rotation. That is what keeps
    // "stylized" from also meaning "no longer looking where you are looking".
    // (A preset that narrows `response.headRange` — see `expressive` — amplifies
    // on top of this; the rig itself stays 1:1.)
    const chain = [...TORSO, ...HEAD_CHAIN];
    const range = DEFAULT_STYLE_RESPONSE.headRange;
    for (const name of STYLE_PRESET_NAMES) {
      const { rig } = STYLE_PRESETS[name];
      for (const [driver, axis] of HEAD_AXES) {
        const total = sum(rig, chain, driver, axis);
        expect(total, `${name}/${driver}`).toBeGreaterThanOrEqual(range * 0.9);
        expect(total, `${name}/${driver}`).toBeLessThanOrEqual(range * 1.15);
      }
    }
  });

  // ── follow vs counter: the two head↔torso conventions ────────────────────

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

  it('follow and counter differ ONLY in how the torso answers the head', () => {
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
    expect(STYLE_RIG_COUNTER.head.drivers.bodyRoll![2]).toBeLessThan(0);
    expect(STYLE_RIG_COUNTER.neck.drivers.bodyPitch![0]).toBeLessThan(0);
  });

  // ── headOnly: head orientation is the only steering signal ───────────────

  const HEAD_ONLY_RIGS = [
    ['headOnly', STYLE_RIG_HEAD_ONLY],
    ['headOnlyCounter', STYLE_RIG_HEAD_ONLY_COUNTER],
  ] as const;

  it('NEITHER head-only rig consumes a body or arm driver anywhere', () => {
    for (const [name, rig] of HEAD_ONLY_RIGS)
      for (const [bone, entry] of Object.entries(rig))
        for (const driver of Object.keys(entry.drivers))
          expect(driver.startsWith('head'), `${name}.${bone}.${driver}`).toBe(
            true
          );
  });

  it('headOnly still drives the torso — off the head instead', () => {
    for (const [driver, axis] of HEAD_AXES)
      expect(sum(STYLE_RIG_HEAD_ONLY, TORSO, driver, axis)).toBeGreaterThan(0);
  });

  it('headOnlyCounter twists the torso AGAINST the head', () => {
    for (const [driver, axis] of HEAD_AXES)
      expect(
        sum(STYLE_RIG_HEAD_ONLY_COUNTER, TORSO, driver, axis)
      ).toBeLessThan(0);
  });

  it('headOnlyCounter compensates on head+neck like counter does', () => {
    for (const [driver, axis] of HEAD_AXES)
      expect(
        sum(STYLE_RIG_HEAD_ONLY_COUNTER, HEAD_CHAIN, driver, axis)
      ).toBeGreaterThan(DEFAULT_STYLE_RESPONSE.headRange);
  });

  it('headOnly shifts TURN and TILT onto the body vs follow', () => {
    // With no other signal the body has to carry more per unit of head movement,
    // or it reads as a bobbling head on a statue. The NOD is the deliberate
    // exception — see the next test.
    for (const [driver, axis] of HEAD_AXES) {
      if (driver === 'headPitch') continue;
      expect(sum(STYLE_RIG_HEAD_ONLY, TORSO, driver, axis)).toBeGreaterThan(
        sum(STYLE_RIG_FOLLOW, TORSO, driver, axis)
      );
      expect(sum(STYLE_RIG_HEAD_ONLY, HEAD_CHAIN, driver, axis)).toBeLessThan(
        sum(STYLE_RIG_FOLLOW, HEAD_CHAIN, driver, axis)
      );
    }
  });

  it('keeps the NOD on the head and off the body in both head-only rigs', () => {
    // Turning and tilting are whole-body gestures — you pivot from the hips to
    // look behind you. Nodding is not: spreading it down the spine the way a turn
    // is spread reads as BOWING, which is a different gesture from agreeing.
    for (const [name, rig] of HEAD_ONLY_RIGS) {
      const nodTorso = Math.abs(sum(rig, TORSO, 'headPitch', 0));
      const turnTorso = Math.abs(sum(rig, TORSO, 'headYaw', 1));
      const tiltTorso = Math.abs(sum(rig, TORSO, 'headRoll', 2));
      // The nod puts the least of all three axes into the torso…
      expect(nodTorso, `${name} nod vs turn`).toBeLessThan(turnTorso);
      expect(nodTorso, `${name} nod vs tilt`).toBeLessThan(tiltTorso);
      // …and the head+neck carry the clear majority of it.
      const nodHead = Math.abs(sum(rig, HEAD_CHAIN, 'headPitch', 0));
      expect(
        nodHead / (nodHead + nodTorso),
        `${name} nod head share`
      ).toBeGreaterThan(0.7);
    }
  });

  it('gives the nod MORE to the head than follow does, in both head-only rigs', () => {
    for (const [name, rig] of HEAD_ONLY_RIGS)
      expect(Math.abs(sum(rig, TORSO, 'headPitch', 0)), `${name}`).toBeLessThan(
        Math.abs(sum(STYLE_RIG_FOLLOW, TORSO, 'headPitch', 0))
      );
  });

  it('headOnly drops bones it has nothing left to drive', () => {
    // The forearms exist in follow only for body-driver follow-through.
    expect(STYLE_RIG_FOLLOW.leftLowerArm).toBeDefined();
    expect(STYLE_RIG_HEAD_ONLY.leftLowerArm).toBeUndefined();
    expect(STYLE_RIG_HEAD_ONLY.rightLowerArm).toBeUndefined();
    // The shoulders survive because they trade their terms for a head-turn lag.
    expect(STYLE_RIG_HEAD_ONLY.leftShoulder.drivers.headYaw).toBeDefined();
    expect(STYLE_RIG_HEAD_ONLY.leftShoulder.drivers.armL).toBeUndefined();
    // headOnlyCounter inherits the drop-outs from headOnly for free.
    expect(STYLE_RIG_HEAD_ONLY_COUNTER.leftLowerArm).toBeUndefined();
    // …and flips the shoulder lag with the torso it is following.
    expect(
      Math.sign(STYLE_RIG_HEAD_ONLY_COUNTER.leftShoulder.drivers.headYaw![1])
    ).toBe(-Math.sign(STYLE_RIG_HEAD_ONLY.leftShoulder.drivers.headYaw![1]));
  });

  // ── expressive: a response-level preset, not a rig-level one ─────────────

  it('expressive reuses follow’s rig and changes only the response and lag', () => {
    expect(STYLE_PRESETS.expressive.rig).toBe(STYLE_RIG_FOLLOW);
    expect(STYLE_PRESETS.expressive.response).toBeDefined();
    expect(STYLE_PRESETS.expressive.lag).toBeGreaterThan(DEFAULT_STYLE_LAG);
  });

  it('expressive AMPLIFIES — less performer movement, same avatar rotation', () => {
    // The rig is unchanged (~45° of avatar head rotation at driver = 1), but the
    // driver saturates at 30° of real movement, so the avatar out-rotates you.
    const chain = [...TORSO, ...HEAD_CHAIN];
    const avatarDeg = sum(STYLE_PRESETS.expressive.rig, chain, 'headYaw', 1);
    const performerDeg = resolveStyleResponse(
      undefined,
      'expressive'
    ).headRange;
    expect(avatarDeg / performerDeg).toBeGreaterThan(1.3);
    // Faithful presets stay ~1:1.
    expect(
      sum(STYLE_PRESETS.follow.rig, chain, 'headYaw', 1) /
        resolveStyleResponse(undefined, 'follow').headRange
    ).toBeLessThan(1.15);
  });

  it('expressive needs less movement for a full-strength driver', () => {
    const e = resolveStyleResponse(undefined, 'expressive');
    const f = resolveStyleResponse(undefined, 'follow');
    expect(e.headRange).toBeLessThan(f.headRange);
    expect(e.bodyRange).toBeLessThan(f.bodyRange);
    // Untouched fields still come from the global defaults.
    expect(e.maxRate).toBe(DEFAULT_STYLE_RESPONSE.maxRate);
  });

  it('resolveStyleResponse layers defaults → preset → user overrides', () => {
    const r = resolveStyleResponse({ headRange: 99 }, 'expressive');
    expect(r.headRange).toBe(99); // user wins over the preset
    expect(r.bodyRange).toBe(STYLE_PRESETS.expressive.response!.bodyRange);
    expect(r.smoothing).toBe(DEFAULT_STYLE_RESPONSE.smoothing);
  });

  it('omitting the preset name keeps the plain defaults (back-compat)', () => {
    expect(resolveStyleResponse()).toEqual(DEFAULT_STYLE_RESPONSE);
    expect(resolveStyleResponse({ maxRate: 1 }).headRange).toBe(
      DEFAULT_STYLE_RESPONSE.headRange
    );
  });

  it('styleRigPresetLag falls back to the global default', () => {
    expect(styleRigPresetLag('expressive')).toBe(STYLE_PRESETS.expressive.lag);
    expect(styleRigPresetLag('follow')).toBe(DEFAULT_STYLE_LAG);
    expect(styleRigPresetLag('nope')).toBe(DEFAULT_STYLE_LAG);
  });

  it('leaves the follow preset untouched when deriving the others', () => {
    expect(STYLE_RIG_FOLLOW.head.drivers.headYaw).toEqual([0, 20, 0]);
    expect(STYLE_RIG_COUNTER.head.drivers.headYaw).toEqual([0, 38, 0]);
    expect(STYLE_RIG_HEAD_ONLY.head.drivers.headYaw).toEqual([0, 10, 0]);
    expect(STYLE_RIG_HEAD_ONLY_COUNTER.head.drivers.headYaw).toEqual([
      0, 40, 0,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Simplified rig — section totals over the same per-bone rig
// ---------------------------------------------------------------------------

const cell = (rig: StyleRig, bone: string, driver: string, axis: number) =>
  (rig[bone]?.drivers as Record<string, number[] | undefined>)?.[driver]?.[
    axis
  ] ?? 0;

describe('simplified rig', () => {
  it('declares six channels, each bound to a driver, axis and section', () => {
    expect(SIMPLE_CHANNELS).toHaveLength(6);
    for (const c of SIMPLE_CHANNELS) {
      const spec = SIMPLE_CHANNEL_SPEC[c];
      expect(STYLE_DRIVER_NAMES).toContain(spec.driver);
      expect([0, 1, 2]).toContain(spec.axis);
      expect(Object.keys(SIMPLE_SECTION_BONES)).toContain(spec.section);
    }
  });

  it('derives a section total by summing that section only', () => {
    const simple = deriveSimpleRig(STYLE_RIG_FOLLOW);
    const expected = SIMPLE_SECTION_BONES.body.reduce(
      (sum, b) => sum + cell(STYLE_RIG_FOLLOW, b, 'bodyYaw', 1),
      0
    );
    expect(simple.bodyTurn!.bodyTurn).toBe(expected);
    // The head's counter-rotation shows up as an off-diagonal cell.
    expect(simple.headTilt!.bodySway).toBeLessThan(0);
  });

  // THE property the whole two-editor design rests on.
  it('round-trips EVERY preset exactly — switching editors cannot change the pose', () => {
    for (const name of STYLE_PRESET_NAMES) {
      const rig = STYLE_PRESETS[name].rig;
      expect(compileSimpleRig(rig, deriveSimpleRig(rig)), name).toEqual(rig);
    }
  });

  it('an empty or absent override is the identity', () => {
    expect(compileSimpleRig(STYLE_RIG_FOLLOW, {})).toBe(STYLE_RIG_FOLLOW);
    expect(compileSimpleRig(STYLE_RIG_FOLLOW, null)).toBe(STYLE_RIG_FOLLOW);
    expect(compileSimpleRig(STYLE_RIG_FOLLOW)).toBe(STYLE_RIG_FOLLOW);
  });

  it('rescales the whole chain, preserving the preset’s falloff', () => {
    const before = deriveSimpleRig(STYLE_RIG_FOLLOW).bodyTurn!.bodyTurn!;
    const out = compileSimpleRig(STYLE_RIG_FOLLOW, {
      bodyTurn: { bodyTurn: before * 2 },
    });
    for (const bone of SIMPLE_SECTION_BONES.body)
      expect(cell(out, bone, 'bodyYaw', 1)).toBeCloseTo(
        cell(STYLE_RIG_FOLLOW, bone, 'bodyYaw', 1) * 2,
        6
      );
    expect(deriveSimpleRig(out).bodyTurn!.bodyTurn).toBeCloseTo(before * 2, 6);
  });

  it('carries the arms with a body channel so the correction stays proportional', () => {
    const before = deriveSimpleRig(STYLE_RIG_FOLLOW).bodyTurn!.bodyTurn!;
    const out = compileSimpleRig(STYLE_RIG_FOLLOW, {
      bodyTurn: { bodyTurn: before * 2 },
    });
    for (const bone of ['leftUpperArm', 'rightUpperArm', 'leftShoulder'])
      expect(cell(out, bone, 'bodyYaw', 1), bone).toBeCloseTo(
        cell(STYLE_RIG_FOLLOW, bone, 'bodyYaw', 1) * 2,
        6
      );
  });

  it('does NOT carry the arms with a head channel', () => {
    const before = deriveSimpleRig(STYLE_RIG_FOLLOW).headTurn!.headTurn!;
    const out = compileSimpleRig(STYLE_RIG_FOLLOW, {
      headTurn: { headTurn: before * 2 },
    });
    expect(cell(out, 'leftUpperArm', 'headYaw', 1)).toBe(
      cell(STYLE_RIG_FOLLOW, 'leftUpperArm', 'headYaw', 1)
    );
  });

  it('leaves every channel the override does not name completely alone', () => {
    const out = compileSimpleRig(STYLE_RIG_FOLLOW, {
      headTurn: { headTurn: 90 },
    });
    const before = deriveSimpleRig(STYLE_RIG_FOLLOW);
    const after = deriveSimpleRig(out);
    for (const row of SIMPLE_CHANNELS)
      for (const col of SIMPLE_CHANNELS) {
        if (row === 'headTurn' && col === 'headTurn') continue;
        expect(after[row]?.[col], `${row}/${col}`).toBe(before[row]?.[col]);
      }
  });

  it('lays a total onto the fallback profile when the shape has nothing there', () => {
    // headOnly consumes no body DRIVERS, so the bodyTurn/bodyTurn diagonal is
    // empty — while the bodyTurn ROW is alive, fed from the headTurn column.
    // (That is exactly how the grid reveals a head-only rig at a glance.)
    const headOnlySimple = deriveSimpleRig(STYLE_RIG_HEAD_ONLY);
    expect(headOnlySimple.bodyTurn?.bodyTurn).toBeUndefined();
    expect(headOnlySimple.bodyTurn?.headTurn).toBeGreaterThan(0);
    const out = compileSimpleRig(STYLE_RIG_HEAD_ONLY, {
      bodyTurn: { bodyTurn: 20 },
    });
    expect(deriveSimpleRig(out).bodyTurn!.bodyTurn).toBeCloseTo(20, 6);
    for (const bone of SIMPLE_SECTION_BONES.body)
      expect(cell(out, bone, 'bodyYaw', 1), bone).toBeGreaterThan(0);
    // …and invents no arm correction it has no basis for.
    expect(cell(out, 'leftUpperArm', 'bodyYaw', 1)).toBe(0);
  });

  it('never mutates the shape rig', () => {
    const snapshot = JSON.stringify(STYLE_RIG_FOLLOW);
    compileSimpleRig(STYLE_RIG_FOLLOW, { bodyTurn: { bodyTurn: 99 } });
    expect(JSON.stringify(STYLE_RIG_FOLLOW)).toBe(snapshot);
  });

  it('can zero a channel out entirely', () => {
    const out = compileSimpleRig(STYLE_RIG_FOLLOW, {
      bodyTurn: { bodyTurn: 0 },
    });
    for (const bone of SIMPLE_SECTION_BONES.body)
      expect(cell(out, bone, 'bodyYaw', 1)).toBe(0);
  });
});

describe('resolveRigMode / resolveStyleRig', () => {
  it('normalizes the mode name and defaults to simple', () => {
    expect(RIG_MODES).toEqual(['simple', 'detailed']);
    expect(DEFAULT_RIG_MODE).toBe('simple');
    expect(resolveRigMode('detailed')).toBe('detailed');
    for (const bad of [undefined, null, '', 'nope'])
      expect(resolveRigMode(bad)).toBe('simple');
  });

  it('layers preset → per-bone overrides → section totals', () => {
    const out = resolveStyleRig(
      'follow',
      { head: { drivers: { headYaw: [0, 30, 0] } } },
      'simple',
      null
    );
    expect(cell(out, 'head', 'headYaw', 1)).toBe(30);
  });

  it('ignores section totals in detailed mode', () => {
    const args = [
      'follow',
      null,
      'detailed',
      { bodyTurn: { bodyTurn: 999 } },
    ] as const;
    expect(resolveStyleRig(...args)).toEqual(STYLE_RIG_FOLLOW);
  });

  it('applies section totals in simple mode', () => {
    const out = resolveStyleRig('follow', null, 'simple', {
      bodyTurn: { bodyTurn: 52 },
    });
    expect(deriveSimpleRig(out).bodyTurn!.bodyTurn).toBeCloseTo(52, 6);
  });

  it('is identical in both modes when nothing is overridden — seamless switching', () => {
    for (const name of STYLE_PRESET_NAMES) {
      const simple = resolveStyleRig(name, null, 'simple', null);
      const detailed = resolveStyleRig(name, null, 'detailed', null);
      expect(simple, name).toEqual(detailed);
    }
  });

  it('baking simple → detailed preserves the rig exactly (the UI mode switch)', () => {
    // What the panel does on switch: compile, store as per-bone overrides, drop
    // the section totals. The resulting rig must be byte-identical.
    const edited = { bodyTurn: { bodyTurn: 40 }, headNod: { headNod: 30 } };
    const running = resolveStyleRig('counter', null, 'simple', edited);
    const baked = resolveStyleRig('counter', running, 'detailed', null);
    expect(baked).toEqual(running);
  });
});
