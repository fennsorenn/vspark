import { describe, it, expect } from 'vitest';
import {
  keyBetween,
  keyAfter,
  keyBefore,
  keysBetween,
} from '../src/fracIndex.js';

/** The whole contract: generated keys sort lexicographically into the intended
 *  order, every gap can be subdivided, and no key ends in the lowest digit. */
describe('keyBetween', () => {
  it('returns a key strictly between two neighbours', () => {
    const k = keyBetween('a', 'b');
    expect('a' < k && k < 'b').toBe(true);
  });

  it('handles open ends (null = before-first / after-last)', () => {
    const first = keyBetween(null, 'V');
    expect(first < 'V').toBe(true);
    const last = keyBetween('V', null);
    expect(last > 'V').toBe(true);
    // Both open → a valid mid key exists.
    expect(typeof keyBetween(null, null)).toBe('string');
  });

  it('subdivides repeatedly into the same gap (degenerate but valid)', () => {
    let lo: string | null = null;
    const hi = 'Z';
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const k = keyBetween(lo, hi);
      expect(lo === null ? true : lo < k).toBe(true);
      expect(k < hi).toBe(true);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      lo = k;
    }
  });

  it('never produces a key ending in the lowest digit', () => {
    for (const [a, b] of [
      [null, null],
      ['a', 'b'],
      [null, 'b'],
      ['y', null],
    ] as [string | null, string | null][]) {
      expect(keyBetween(a, b).endsWith('0')).toBe(false);
    }
  });

  it('throws when the bounds are disordered or equal', () => {
    expect(() => keyBetween('b', 'a')).toThrow(/disordered/);
    expect(() => keyBetween('a', 'a')).toThrow(/disordered/);
  });
});

describe('keyAfter / keyBefore', () => {
  it('append/prepend relative to a bound', () => {
    expect(keyAfter('m') > 'm').toBe(true);
    expect(keyBefore('m') < 'm').toBe(true);
    // Empty list: both produce a usable first key.
    expect(typeof keyAfter(null)).toBe('string');
    expect(typeof keyBefore(null)).toBe('string');
  });

  it('a run of monotonic appends stays strictly increasing', () => {
    let last: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      last = keyAfter(last);
      keys.push(last);
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('keysBetween', () => {
  it('returns n distinct, ordered keys', () => {
    const ks = keysBetween(null, null, 10);
    expect(ks).toHaveLength(10);
    expect([...ks].sort()).toEqual(ks);
    expect(new Set(ks).size).toBe(10);
  });

  it('edge counts: 0 → empty, 1 → single mid key', () => {
    expect(keysBetween(null, null, 0)).toEqual([]);
    expect(keysBetween(null, null, -5)).toEqual([]);
    expect(keysBetween('a', 'b', 1)).toHaveLength(1);
  });

  it('respects explicit bounds', () => {
    const ks = keysBetween('a', 'z', 5);
    expect(ks.every((k) => k > 'a' && k < 'z')).toBe(true);
  });
});
