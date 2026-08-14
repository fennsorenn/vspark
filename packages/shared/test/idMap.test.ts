import { describe, it, expect } from 'vitest';
import { byId, itemOf, itemsOf, sortedBy, type IdMap } from '../src/idMap.js';

/**
 * Id-keyed document collections.
 *
 * The reason these exist is upstream of anything here: an array field is ONE
 * mesh path, so two peers editing different elements write the same path and
 * one edit is thrown away. Keyed by id they never collide. What this file pins
 * is the consequence — a deleted element is a `null`, and every read has to
 * skip it, or a delete surfaces downstream as a null element.
 */
describe('idMap', () => {
  const kf = (id: string, t: number) => ({ id, t });

  it('skips tombstones when reading', () => {
    const map: IdMap<{ id: string; t: number }> = {
      a: kf('a', 0),
      b: null,
      c: kf('c', 1),
    };
    expect(itemsOf(map).map((k) => k.id)).toEqual(['a', 'c']);
    expect(itemOf(map, 'b')).toBeUndefined();
    expect(itemOf(map, 'a')).toEqual(kf('a', 0));
  });

  it('treats a missing map as empty', () => {
    expect(itemsOf(undefined)).toEqual([]);
    expect(itemsOf(null)).toEqual([]);
    expect(itemOf(undefined, 'a')).toBeUndefined();
  });

  it('sorts by the field that carries order, not by key', () => {
    // The map has no order of its own — that is the point. Keyframes carry
    // theirs in `t`, so two peers inserting concurrently still agree.
    const map = byId([kf('z', 2), kf('a', 5), kf('m', 1)]);
    expect(sortedBy(map, (k) => k.t).map((k) => k.id)).toEqual(['m', 'z', 'a']);
  });

  it('sorts around tombstones', () => {
    const map: IdMap<{ id: string; t: number }> = {
      ...byId([kf('a', 1), kf('b', 2)]),
      c: null,
    };
    expect(sortedBy(map, (k) => k.t)).toHaveLength(2);
  });

  it('keys by id when converting from a list', () => {
    const map = byId([kf('a', 0), kf('b', 1)]);
    expect(Object.keys(map).sort()).toEqual(['a', 'b']);
    expect(map.a).toEqual(kf('a', 0));
  });

  it('byId drops tombstones, so it must not round-trip a live map', () => {
    // Documented sharp edge: byId(itemsOf(map)) loses the deletes, which on a
    // replicated doc means resurrecting them for any peer that had not applied
    // them yet.
    const withDelete: IdMap<{ id: string; t: number }> = {
      a: kf('a', 0),
      b: null,
    };
    expect('b' in byId(itemsOf(withDelete))).toBe(false);
  });
});
