import { describe, it, expect } from 'vitest';
import {
  RT,
  describeResolvedType,
  typeTagToResolved,
} from '../src/signal_types.js';

describe('describeResolvedType', () => {
  it('renders each constructor', () => {
    expect(describeResolvedType(RT.primitive('Float'))).toBe('Float');
    expect(describeResolvedType(RT.event(RT.primitive('Float')))).toBe(
      'Event<Float>'
    );
    expect(describeResolvedType(RT.list(RT.primitive('Float')))).toBe(
      'List<Float>'
    );
    expect(describeResolvedType(RT.unknown())).toBe('any');
    expect(
      describeResolvedType(
        RT.record({ a: RT.primitive('Float'), b: RT.primitive('String') })
      )
    ).toBe('{ a: Float, b: String }');
  });
});

describe('typeTagToResolved', () => {
  it('lifts a leaf tag, wrapping by transport', () => {
    expect(typeTagToResolved('Float', 'value')).toEqual(RT.primitive('Float'));
    expect(typeTagToResolved('Float', 'event')).toEqual(
      RT.event(RT.primitive('Float'))
    );
    expect(typeTagToResolved('Float', 'list')).toEqual(
      RT.list(RT.primitive('Float'))
    );
  });

  it('maps the Any / BehaviorConfig wildcards to unknown', () => {
    expect(typeTagToResolved('Any', 'value')).toEqual(RT.unknown());
    expect(typeTagToResolved('BehaviorConfig', 'value')).toEqual(RT.unknown());
  });
});
