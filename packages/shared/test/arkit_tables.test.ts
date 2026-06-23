import { describe, it, expect } from 'vitest';
import {
  ARKIT_SHAPES,
  ARKIT_TO_VRM,
  ARKIT_TO_FCL,
} from '../src/arkit_tables.js';

describe('ARKit tables', () => {
  it('declares the 52 canonical ARKit shapes, all unique', () => {
    expect(ARKIT_SHAPES).toHaveLength(52);
    expect(new Set(ARKIT_SHAPES).size).toBe(52);
    expect(ARKIT_SHAPES).toContain('jawOpen');
    expect(ARKIT_SHAPES).toContain('tongueOut');
  });

  it('mappings key off valid ARKit shapes and hold [name, weight] pairs', () => {
    const valid = new Set<string>(ARKIT_SHAPES);
    for (const table of [ARKIT_TO_VRM, ARKIT_TO_FCL]) {
      const entries = Object.entries(table);
      expect(entries.length).toBeGreaterThan(0);
      for (const [shape, pairs] of entries) {
        expect(valid.has(shape)).toBe(true);
        for (const [target, weight] of pairs!) {
          expect(typeof target).toBe('string');
          expect(typeof weight).toBe('number');
        }
      }
    }
  });
});
