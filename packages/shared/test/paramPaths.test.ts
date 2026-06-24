import { describe, it, expect } from 'vitest';
import {
  getParamPathSpec,
  isParamPathValid,
  listAnimatableParamPaths,
  listAllParamPaths,
  coerceParamValue,
  type ParamPathSpec,
} from '../src/paramPaths.js';

describe('getParamPathSpec', () => {
  it('resolves a registered path per target kind', () => {
    expect(getParamPathSpec('scene_node', 'position.x')?.type).toBe('Float');
    expect(getParamPathSpec('compose_layer', 'width')?.defaultValue).toBe(100);
  });

  it('returns undefined for an unregistered path', () => {
    expect(getParamPathSpec('scene_node', 'nope')).toBeUndefined();
    // A compose-layer path is not valid under scene_node.
    expect(getParamPathSpec('scene_node', 'width')).toBeUndefined();
  });
});

describe('isParamPathValid', () => {
  it('is true for a registered path with no kind restriction', () => {
    expect(isParamPathValid('scene_node', 'position.x')).toBe(true);
  });

  it('is false for an unregistered path', () => {
    expect(isParamPathValid('scene_node', 'bogus')).toBe(false);
  });

  it('enforces the kinds restriction only when an entityKind is given', () => {
    // text.content is restricted to text_troika / text_canvas.
    expect(isParamPathValid('scene_node', 'text.content', 'text_troika')).toBe(
      true
    );
    expect(isParamPathValid('scene_node', 'text.content', 'mesh')).toBe(false);
    // Without an entityKind the restriction is not applied.
    expect(isParamPathValid('scene_node', 'text.content')).toBe(true);
  });
});

describe('listAnimatableParamPaths', () => {
  it('returns only Float + animatable paths', () => {
    const paths = listAnimatableParamPaths('scene_node');
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.type === 'Float' && p.animatable)).toBe(true);
    // text.content (String, non-animatable) is excluded.
    expect(paths.some((p) => p.path === 'text.content')).toBe(false);
  });
});

describe('listAllParamPaths', () => {
  it('returns every registered path including non-animatable', () => {
    const all = listAllParamPaths('scene_node');
    expect(all.some((p) => p.path === 'text.content')).toBe(true);
    expect(all.length).toBeGreaterThan(
      listAnimatableParamPaths('scene_node').length
    );
  });
});

describe('coerceParamValue', () => {
  const floatSpec: ParamPathSpec = {
    path: 'x',
    type: 'Float',
    defaultValue: 0,
    animatable: true,
  };
  const strSpec: ParamPathSpec = {
    path: 's',
    type: 'String',
    defaultValue: '',
    animatable: false,
  };
  const boolSpec: ParamPathSpec = {
    path: 'b',
    type: 'Bool',
    defaultValue: false,
    animatable: false,
  };

  it('Float: numbers, numeric strings, booleans → number; else null', () => {
    expect(coerceParamValue(floatSpec, 3.5)).toBe(3.5);
    expect(coerceParamValue(floatSpec, '2.5')).toBe(2.5);
    expect(coerceParamValue(floatSpec, true)).toBe(1);
    expect(coerceParamValue(floatSpec, false)).toBe(0);
    expect(coerceParamValue(floatSpec, 'abc')).toBeNull();
    expect(coerceParamValue(floatSpec, NaN)).toBeNull();
    expect(coerceParamValue(floatSpec, Infinity)).toBeNull();
    expect(coerceParamValue(floatSpec, {})).toBeNull();
  });

  it('String: strings pass; numbers/booleans stringify; else null', () => {
    expect(coerceParamValue(strSpec, 'hi')).toBe('hi');
    expect(coerceParamValue(strSpec, 42)).toBe('42');
    expect(coerceParamValue(strSpec, true)).toBe('true');
    expect(coerceParamValue(strSpec, null)).toBeNull();
    expect(coerceParamValue(strSpec, {})).toBeNull();
  });

  it('Bool: booleans pass; numbers by nonzero; strings by token; else null', () => {
    expect(coerceParamValue(boolSpec, true)).toBe(true);
    expect(coerceParamValue(boolSpec, 0)).toBe(false);
    expect(coerceParamValue(boolSpec, 2)).toBe(true);
    expect(coerceParamValue(boolSpec, 'true')).toBe(true);
    expect(coerceParamValue(boolSpec, '1')).toBe(true);
    expect(coerceParamValue(boolSpec, 'yes')).toBe(true);
    expect(coerceParamValue(boolSpec, 'false')).toBe(false);
    expect(coerceParamValue(boolSpec, 'nope')).toBe(false);
    expect(coerceParamValue(boolSpec, {})).toBeNull();
  });
});
