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

describe('graph descriptor document form', () => {
  const node = (id: string) => ({ id, kind: 'clock', position: { x: 0, y: 0 } });
  const edge = (from: string, to: string) => ({
    fromNodeId: from,
    fromPort: 'out',
    toNodeId: to,
    toPort: 'in',
  });

  it('round-trips runtime → document → runtime', async () => {
    const { toDescriptorDoc, toGraphDescriptor } = await import(
      '../src/signal.js'
    );
    const d = {
      id: 'g',
      label: 'G',
      readonly: false,
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'b')],
    };
    expect(toGraphDescriptor(toDescriptorDoc(d))).toEqual(d);
  });

  it('keys edges by their endpoints, since they carry no id', async () => {
    const { toDescriptorDoc, edgeKey } = await import('../src/signal.js');
    const e = edge('a', 'b');
    const doc = toDescriptorDoc({
      id: 'g',
      label: 'G',
      readonly: false,
      nodes: [],
      edges: [e, { ...e }],
    });
    // Two peers drawing the same connection converge on ONE element rather
    // than minting two ids and leaving a duplicate edge behind.
    expect(Object.keys(doc.edges)).toEqual([edgeKey(e)]);
  });

  it('still reads a descriptor stored before the keying', async () => {
    const { toGraphDescriptor } = await import('../src/signal.js');
    // The list form, as every existing row holds it. Without this a graph
    // saved yesterday would come back empty — and the empty program would be
    // written straight back over it.
    const legacy = {
      id: 'g',
      label: 'G',
      readonly: false,
      nodes: [node('a')],
      edges: [edge('a', 'b')],
    };
    expect(toGraphDescriptor(legacy).nodes).toHaveLength(1);
    expect(toGraphDescriptor(legacy).edges).toHaveLength(1);
  });

  it('skips deleted elements', async () => {
    const { toGraphDescriptor } = await import('../src/signal.js');
    const d = toGraphDescriptor({
      id: 'g',
      label: 'G',
      readonly: false,
      nodes: { a: node('a'), b: null },
      edges: {},
    });
    expect(d.nodes.map((n) => n.id)).toEqual(['a']);
  });
});
