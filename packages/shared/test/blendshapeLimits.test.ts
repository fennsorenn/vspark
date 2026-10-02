/**
 * blendshapeLimits.test.ts
 *
 * The expression-limit rule engine: name matching (case-insensitivity +
 * wildcards), exclusive groups in both modes, clamp rules with thresholds and
 * ramping, ordering between the two rule kinds, tolerant config parsing, and
 * the shipped defaults behaving as advertised on all three VRM naming flavours.
 */

import { describe, it, expect } from 'vitest';
import {
  applyBlendshapeLimits,
  defaultBlendshapeLimits,
  matchNames,
  matchesAnyPattern,
  normalizeBlendshapeLimits,
  DEFAULT_BLENDSHAPE_LIMITS,
  type BlendshapeLimitsConfig,
  type ExclusiveGroup,
} from '../src/blendshapeLimits.js';

// ─────────────────────────────────────────────────────────────────────────────
// Name matching
// ─────────────────────────────────────────────────────────────────────────────
describe('name matching', () => {
  it('matches case-insensitively and fully anchored', () => {
    expect(matchesAnyPattern('Joy', ['joy'])).toBe(true);
    expect(matchesAnyPattern('joy', ['Joy'])).toBe(true);
    // Anchored: a pattern must match the WHOLE name, not a fragment.
    expect(matchesAnyPattern('Fcl_ALL_Joy', ['joy'])).toBe(false);
    expect(matchesAnyPattern('happyish', ['happy'])).toBe(false);
  });

  it('supports * as a wildcard', () => {
    expect(matchesAnyPattern('Fcl_MTH_A', ['Fcl_MTH_*'])).toBe(true);
    expect(matchesAnyPattern('Fcl_EYE_Close_L', ['Fcl_MTH_*'])).toBe(false);
    expect(matchesAnyPattern('anything', ['*'])).toBe(true);
    expect(matchesAnyPattern('Fcl_EYE_Close_L', ['*_Close_*'])).toBe(true);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    expect(matchesAnyPattern('a.b', ['a.b'])).toBe(true);
    expect(matchesAnyPattern('axb', ['a.b'])).toBe(false);
  });

  it('ignores empty and non-string patterns', () => {
    expect(matchesAnyPattern('joy', [])).toBe(false);
    expect(matchesAnyPattern('joy', undefined)).toBe(false);
    expect(matchesAnyPattern('joy', ['', 'joy'])).toBe(true);
  });

  it('matchNames preserves the order of the name list', () => {
    expect(matchNames(['c', 'a', 'b'], ['*'])).toEqual(['c', 'a', 'b']);
    expect(matchNames(['aa', 'ih', 'ou'], ['ih', 'aa'])).toEqual(['aa', 'ih']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exclusive groups
// ─────────────────────────────────────────────────────────────────────────────
const twoWayGroup = (
  extra: Partial<ExclusiveGroup> = {}
): BlendshapeLimitsConfig => ({
  groups: [
    {
      id: 'g',
      members: [
        { id: 'joy', patterns: ['happy'] },
        { id: 'angry', patterns: ['angry'] },
      ],
      ...extra,
    },
  ],
});

describe('exclusive groups', () => {
  it('suppresses losers in proportion to the winner', () => {
    const out = applyBlendshapeLimits({ happy: 1, angry: 0.8 }, twoWayGroup());
    expect(out.happy).toBe(1);
    expect(out.angry).toBe(0); // full winner + strength 1 ⇒ loser fully suppressed
  });

  it('only partly suppresses while the winner is weak (cross-fade, not a pop)', () => {
    const out = applyBlendshapeLimits(
      { happy: 0.5, angry: 0.4 },
      twoWayGroup()
    );
    expect(out.happy).toBe(0.5);
    expect(out.angry).toBeCloseTo(0.2, 6); // 0.4 × (1 − 1×0.5)
  });

  it('scales the bite by strength', () => {
    const out = applyBlendshapeLimits(
      { happy: 1, angry: 0.8 },
      twoWayGroup({ strength: 0.5 })
    );
    expect(out.angry).toBeCloseTo(0.4, 6); // 0.8 × (1 − 0.5×1)
  });

  it('is a no-op at strength 0 or when disabled', () => {
    const raw = { happy: 1, angry: 0.8 };
    expect(applyBlendshapeLimits(raw, twoWayGroup({ strength: 0 }))).toEqual(
      raw
    );
    expect(applyBlendshapeLimits(raw, twoWayGroup({ enabled: false }))).toEqual(
      raw
    );
  });

  it('breaks ties by declaration order', () => {
    const out = applyBlendshapeLimits({ happy: 1, angry: 1 }, twoWayGroup());
    expect(out.happy).toBe(1);
    expect(out.angry).toBe(0);
  });

  it('does nothing when fewer than two members are active', () => {
    const raw = { happy: 0.7, angry: 0 };
    expect(applyBlendshapeLimits(raw, twoWayGroup())).toEqual(raw);
  });

  it('treats several spellings of one member as the same expression', () => {
    // Joy is driven under two names at once; neither may suppress the other.
    const config: BlendshapeLimitsConfig = {
      groups: [
        {
          id: 'g',
          members: [
            { id: 'joy', patterns: ['Joy', 'Fcl_ALL_Joy'] },
            { id: 'angry', patterns: ['Angry'] },
          ],
        },
      ],
    };
    const out = applyBlendshapeLimits(
      { Joy: 1, Fcl_ALL_Joy: 0.8, Angry: 0.9 },
      config
    );
    expect(out.Joy).toBe(1);
    expect(out.Fcl_ALL_Joy).toBe(0.8);
    expect(out.Angry).toBe(0);
  });

  it('normalize mode scales the whole group down to sum 1', () => {
    const out = applyBlendshapeLimits(
      { happy: 1, angry: 1 },
      twoWayGroup({ mode: 'normalize' })
    );
    expect(out.happy).toBeCloseTo(0.5, 6);
    expect(out.angry).toBeCloseTo(0.5, 6);
  });

  it('normalize mode leaves a group that already sums under 1 alone', () => {
    const raw = { happy: 0.4, angry: 0.3 };
    expect(
      applyBlendshapeLimits(raw, twoWayGroup({ mode: 'normalize' }))
    ).toEqual(raw);
  });

  it('applies groups in declaration order so overlapping groups compose', () => {
    const config: BlendshapeLimitsConfig = {
      groups: [
        {
          id: 'first',
          members: [
            { id: 'a', patterns: ['a'] },
            { id: 'b', patterns: ['b'] },
          ],
        },
        {
          id: 'second',
          members: [
            { id: 'b', patterns: ['b'] },
            { id: 'c', patterns: ['c'] },
          ],
        },
      ],
    };
    // 'a' beats 'b' (b → 0), so by the second group only 'c' is active and
    // nothing competes with it.
    const out = applyBlendshapeLimits({ a: 1, b: 0.9, c: 0.9 }, config);
    expect(out.b).toBe(0);
    expect(out.c).toBe(0.9);
  });

  it('ignores shapes the frame does not contain', () => {
    const out = applyBlendshapeLimits({ happy: 1 }, twoWayGroup());
    expect(out).toEqual({ happy: 1 });
    expect('angry' in out).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Clamp rules
// ─────────────────────────────────────────────────────────────────────────────
describe('clamp rules', () => {
  const clamp = (over: Partial<BlendshapeLimitsConfig> = {}) => ({
    clamps: [
      {
        id: 'c',
        when: ['happy'],
        threshold: 0,
        ramp: false,
        targets: ['aa'],
        max: 0.5,
      },
    ],
    ...over,
  });

  it('caps a target while the driver is active', () => {
    const out = applyBlendshapeLimits({ happy: 1, aa: 1 }, clamp());
    expect(out.aa).toBe(0.5);
  });

  it('leaves values already inside the range untouched', () => {
    const out = applyBlendshapeLimits({ happy: 1, aa: 0.2 }, clamp());
    expect(out.aa).toBe(0.2);
  });

  it('does nothing while the driver is inactive', () => {
    const out = applyBlendshapeLimits({ happy: 0, aa: 1 }, clamp());
    expect(out.aa).toBe(1);
  });

  it('is unconditional when no driver is configured', () => {
    const out = applyBlendshapeLimits(
      { aa: 1 },
      { clamps: [{ id: 'c', targets: ['aa'], max: 0.4 }] }
    );
    expect(out.aa).toBeCloseTo(0.4, 6);
  });

  it('honours the threshold', () => {
    const config: BlendshapeLimitsConfig = {
      clamps: [
        {
          id: 'c',
          when: ['happy'],
          threshold: 0.5,
          ramp: false,
          targets: ['aa'],
          max: 0.5,
        },
      ],
    };
    expect(applyBlendshapeLimits({ happy: 0.4, aa: 1 }, config).aa).toBe(1);
    expect(applyBlendshapeLimits({ happy: 0.6, aa: 1 }, config).aa).toBe(0.5);
  });

  it('ramps the cap in between threshold and a full driver', () => {
    const config: BlendshapeLimitsConfig = {
      clamps: [
        {
          id: 'c',
          when: ['happy'],
          threshold: 0,
          ramp: true,
          targets: ['aa'],
          max: 0.5,
        },
      ],
    };
    // activation 0.5 ⇒ effective max lerps from 1 toward 0.5 ⇒ 0.75
    expect(applyBlendshapeLimits({ happy: 0.5, aa: 1 }, config).aa).toBeCloseTo(
      0.75,
      6
    );
    expect(applyBlendshapeLimits({ happy: 1, aa: 1 }, config).aa).toBeCloseTo(
      0.5,
      6
    );
  });

  it('applies a floor via min', () => {
    const out = applyBlendshapeLimits(
      { aa: 0.1 },
      { clamps: [{ id: 'c', targets: ['aa'], min: 0.4 }] }
    );
    expect(out.aa).toBeCloseTo(0.4, 6);
  });

  it('keeps min from overtaking max when both are set', () => {
    const out = applyBlendshapeLimits(
      { aa: 1 },
      { clamps: [{ id: 'c', targets: ['aa'], min: 0.9, max: 0.3 }] }
    );
    expect(out.aa).toBeCloseTo(0.3, 6);
  });

  it('takes the strongest driver when several match', () => {
    const out = applyBlendshapeLimits(
      { happy: 0.2, Joy: 1, aa: 1 },
      {
        clamps: [
          {
            id: 'c',
            when: ['happy', 'joy'],
            ramp: false,
            targets: ['aa'],
            max: 0.5,
          },
        ],
      }
    );
    expect(out.aa).toBe(0.5);
  });

  it('is skipped when disabled', () => {
    const out = applyBlendshapeLimits(
      { happy: 1, aa: 1 },
      { clamps: [{ id: 'c', enabled: false, targets: ['aa'], max: 0.1 }] }
    );
    expect(out.aa).toBe(1);
  });

  it('reads its driver AFTER exclusive groups have run', () => {
    // Joy loses the group fight, so its clamp must not fire.
    const config: BlendshapeLimitsConfig = {
      groups: [
        {
          id: 'g',
          members: [
            { id: 'angry', patterns: ['angry'] },
            { id: 'joy', patterns: ['happy'] },
          ],
        },
      ],
      clamps: [
        {
          id: 'c',
          when: ['happy'],
          ramp: false,
          targets: ['aa'],
          max: 0.2,
        },
      ],
    };
    const out = applyBlendshapeLimits({ angry: 1, happy: 0.9, aa: 1 }, config);
    expect(out.happy).toBe(0);
    expect(out.aa).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Engine-level behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe('applyBlendshapeLimits', () => {
  it('never mutates its input', () => {
    const input = { happy: 1, angry: 1 };
    const snapshot = { ...input };
    applyBlendshapeLimits(input, twoWayGroup());
    expect(input).toEqual(snapshot);
  });

  it('passes everything through when disabled or unconfigured', () => {
    const raw = { happy: 1, angry: 1 };
    expect(applyBlendshapeLimits(raw, null)).toEqual(raw);
    expect(applyBlendshapeLimits(raw, undefined)).toEqual(raw);
    expect(applyBlendshapeLimits(raw, {})).toEqual(raw);
    expect(
      applyBlendshapeLimits(raw, { ...twoWayGroup(), enabled: false })
    ).toEqual(raw);
  });

  it('handles an empty frame', () => {
    expect(applyBlendshapeLimits({}, defaultBlendshapeLimits())).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tolerant parsing
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeBlendshapeLimits', () => {
  it('accepts garbage without throwing', () => {
    expect(() => normalizeBlendshapeLimits(null)).not.toThrow();
    expect(() => normalizeBlendshapeLimits('nope')).not.toThrow();
    expect(normalizeBlendshapeLimits(undefined)).toEqual({
      enabled: true,
      groups: [],
      clamps: [],
    });
  });

  it('drops members without patterns and groups left empty', () => {
    const out = normalizeBlendshapeLimits({
      groups: [
        { id: 'g', members: [{ id: 'a' }, { id: 'b', patterns: [] }] },
        { id: 'h', members: [{ id: 'c', patterns: ['happy'] }] },
      ],
    });
    expect(out.groups?.map((g) => g.id)).toEqual(['h']);
  });

  it('drops clamp rules with no targets', () => {
    const out = normalizeBlendshapeLimits({
      clamps: [{ id: 'a' }, { id: 'b', targets: ['aa'] }],
    });
    expect(out.clamps?.map((c) => c.id)).toEqual(['b']);
  });

  it('filters non-string entries out of name lists', () => {
    const out = normalizeBlendshapeLimits({
      clamps: [{ id: 'a', targets: ['aa', 3, null], when: ['happy', {}] }],
    });
    expect(out.clamps?.[0].targets).toEqual(['aa']);
    expect(out.clamps?.[0].when).toEqual(['happy']);
  });

  it('round-trips the shipped defaults unchanged', () => {
    expect(normalizeBlendshapeLimits(defaultBlendshapeLimits())).toEqual(
      normalizeBlendshapeLimits(DEFAULT_BLENDSHAPE_LIMITS)
    );
  });

  it('defaultBlendshapeLimits returns an independent copy', () => {
    const a = defaultBlendshapeLimits();
    a.groups![0].members[0].patterns.push('mutated');
    expect(
      DEFAULT_BLENDSHAPE_LIMITS.groups![0].members[0].patterns
    ).not.toContain('mutated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shipped defaults — the cases the feature exists for
// ─────────────────────────────────────────────────────────────────────────────
describe('shipped defaults', () => {
  const defaults = () => defaultBlendshapeLimits();

  it('lets only the strongest emotion through (VRM 1.0 names)', () => {
    const out = applyBlendshapeLimits(
      { happy: 1, angry: 0.7, sad: 0.6, relaxed: 0.5, surprised: 0.4 },
      defaults()
    );
    expect(out.happy).toBe(1);
    expect(out.angry).toBe(0);
    expect(out.sad).toBe(0);
    expect(out.relaxed).toBe(0);
    expect(out.surprised).toBe(0);
  });

  it('does the same for VRM 0.x and VRoid morph-target spellings', () => {
    expect(
      applyBlendshapeLimits({ Joy: 1, Angry: 0.9 }, defaults()).Angry
    ).toBe(0);
    expect(
      applyBlendshapeLimits({ Fcl_ALL_Joy: 1, Fcl_ALL_Sorrow: 0.9 }, defaults())
        .Fcl_ALL_Sorrow
    ).toBe(0);
  });

  it('holds back eye-close shapes while joy is full', () => {
    const out = applyBlendshapeLimits(
      { happy: 1, blink: 1, blinkLeft: 1, Fcl_EYE_Close_L: 1 },
      defaults()
    );
    expect(out.blink).toBeCloseTo(0.5, 6);
    expect(out.blinkLeft).toBeCloseTo(0.5, 6);
    expect(out.Fcl_EYE_Close_L).toBeCloseTo(0.5, 6);
  });

  it('holds back mouth-open shapes while joy is full', () => {
    const out = applyBlendshapeLimits(
      { Joy: 1, aa: 1, Fcl_MTH_A: 1, jawOpen: 1 },
      defaults()
    );
    expect(out.aa).toBeCloseTo(0.6, 6);
    expect(out.Fcl_MTH_A).toBeCloseTo(0.6, 6);
    expect(out.jawOpen).toBeCloseTo(0.6, 6);
  });

  it('leaves lipsync and blinking alone when joy is below the threshold', () => {
    const raw = { happy: 0.2, aa: 1, blink: 1 };
    const out = applyBlendshapeLimits(raw, defaults());
    expect(out.aa).toBe(1);
    expect(out.blink).toBe(1);
  });

  it('tightens the mouth cap gradually as joy grows', () => {
    const at = (joy: number) =>
      applyBlendshapeLimits({ happy: joy, aa: 1 }, defaults()).aa;
    expect(at(0.3)).toBe(1);
    expect(at(0.65)).toBeGreaterThan(at(1));
    expect(at(0.65)).toBeLessThan(1);
    expect(at(1)).toBeCloseTo(0.6, 6);
  });

  it('does not touch a neutral frame', () => {
    const raw = { aa: 0.8, blink: 1, happy: 0 };
    expect(applyBlendshapeLimits(raw, defaults())).toEqual(raw);
  });
});
