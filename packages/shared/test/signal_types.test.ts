import { describe, it, expect } from 'vitest';
import { RT, isAssignable, transportOf } from '../src/signal_types.js';

describe('transportOf', () => {
  it('derives transport from the outermost type constructor', () => {
    expect(transportOf(RT.event(RT.primitive('Float')))).toBe('event');
    expect(transportOf(RT.list(RT.primitive('Float')))).toBe('list');
    expect(transportOf(RT.primitive('Float'))).toBe('value');
    expect(transportOf(RT.record({ a: RT.primitive('Float') }))).toBe('value');
    expect(transportOf(RT.unknown())).toBe('value');
  });
});

describe('isAssignable', () => {
  it('matches primitives by name', () => {
    expect(isAssignable(RT.primitive('Float'), RT.primitive('Float'))).toBe(true);
    expect(isAssignable(RT.primitive('Float'), RT.primitive('String'))).toBe(false);
  });

  it('treats unknown as a wildcard in both directions', () => {
    expect(isAssignable(RT.unknown(), RT.primitive('Float'))).toBe(true);
    expect(isAssignable(RT.primitive('Float'), RT.unknown())).toBe(true);
    expect(isAssignable(RT.unknown(), RT.unknown())).toBe(true);
  });

  describe('records (width subtyping)', () => {
    const wide = RT.record({
      a: RT.primitive('Float'),
      b: RT.primitive('Float'),
      c: RT.primitive('Float'),
    });
    const narrow = RT.record({ a: RT.primitive('Float'), b: RT.primitive('Float') });

    it('accepts a wider source into a narrower target', () => {
      // Source emitting {a,b,c} satisfies a target wanting {a,b}.
      expect(isAssignable(wide, narrow)).toBe(true);
    });

    it('rejects a narrower source into a wider target (missing field)', () => {
      expect(isAssignable(narrow, wide)).toBe(false);
    });

    it('rejects when a shared field has an incompatible type', () => {
      const mismatched = RT.record({ a: RT.primitive('String'), b: RT.primitive('Float') });
      expect(isAssignable(mismatched, narrow)).toBe(false);
    });
  });

  describe('list fan-in (asymmetric special case)', () => {
    const listOfFloat = RT.list(RT.primitive('Float'));

    it('accepts a bare element E into a List<E> target', () => {
      expect(isAssignable(RT.primitive('Float'), listOfFloat)).toBe(true);
    });

    it('accepts a List<E> into a List<E> target', () => {
      expect(isAssignable(listOfFloat, listOfFloat)).toBe(true);
    });

    it('rejects a mistyped element', () => {
      expect(isAssignable(RT.primitive('String'), listOfFloat)).toBe(false);
    });
  });

  it('widens concrete scene entities into SceneEntity, but not the reverse', () => {
    expect(isAssignable(RT.primitive('SceneNode'), RT.primitive('SceneEntity'))).toBe(true);
    expect(isAssignable(RT.primitive('ComposeLayer'), RT.primitive('SceneEntity'))).toBe(true);
    expect(isAssignable(RT.primitive('SceneEntity'), RT.primitive('SceneNode'))).toBe(false);
    // SceneNode and ComposeLayer stay mutually incompatible.
    expect(isAssignable(RT.primitive('SceneNode'), RT.primitive('ComposeLayer'))).toBe(false);
  });

  it('compares event payloads structurally', () => {
    expect(
      isAssignable(RT.event(RT.primitive('Float')), RT.event(RT.primitive('Float')))
    ).toBe(true);
    expect(
      isAssignable(RT.event(RT.primitive('Float')), RT.event(RT.primitive('String')))
    ).toBe(false);
  });

  it('rejects mismatched constructors', () => {
    expect(isAssignable(RT.event(RT.primitive('Float')), RT.primitive('Float'))).toBe(false);
    expect(isAssignable(RT.record({ a: RT.primitive('Float') }), RT.primitive('Float'))).toBe(
      false
    );
  });
});
