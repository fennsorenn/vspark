import { describe, it, expect } from 'vitest';
import {
  ContainmentIndex,
  type ContainmentSchema,
  type SchemaProvider,
} from '../src/containment.js';

// scene_node → scene_node (or root), ordered + scoped; behaviour → scene_node only.
const SCHEMAS: Record<string, ContainmentSchema> = {
  scene_node: {
    parentField: 'parentId',
    parentTypes: ['scene_node'],
    canBeRoot: true,
    orderField: 'order',
    scopeField: 'scope',
  },
  behaviour: {
    parentField: 'nodeId',
    parentTypes: ['scene_node'],
    canBeRoot: false,
  },
};
const provider: SchemaProvider = (rtype) => SCHEMAS[rtype];

function seed(): ContainmentIndex {
  const idx = new ContainmentIndex(provider);
  idx.upsert('scene_node', 'root', { order: 'a', scope: 'S1' });
  idx.upsert('scene_node', 'childB', { parentId: 'root', order: 'b' });
  idx.upsert('scene_node', 'childA', { parentId: 'root', order: 'a' });
  idx.upsert('scene_node', 'grand', { parentId: 'childA', order: 'a' });
  idx.upsert('behaviour', 'bhv', { nodeId: 'childB' });
  return idx;
}

describe('ContainmentIndex queries', () => {
  it('byId / has / rtypeOf / parentOf', () => {
    const idx = seed();
    expect(idx.has('root')).toBe(true);
    expect(idx.has('nope')).toBe(false);
    expect(idx.rtypeOf('bhv')).toBe('behaviour');
    expect(idx.parentOf('childA')).toBe('root');
    expect(idx.parentOf('root')).toBeNull();
    expect(idx.parentOf('nope')).toBeUndefined();
    expect(idx.byId('childB')).toMatchObject({ order: 'b' });
  });

  it('childrenOf is ordered by (order, id) and filterable by rtype', () => {
    const idx = seed();
    expect(idx.childrenOf('root')).toEqual(['childA', 'childB']); // a before b
    expect(idx.childrenOf('childB', 'scene_node')).toEqual([]);
    expect(idx.childrenOf('childB', 'behaviour')).toEqual(['bhv']);
  });

  it('roots, optionally scoped', () => {
    const idx = seed();
    expect(idx.roots()).toEqual(['root']);
    expect(idx.roots('S1')).toEqual(['root']);
    expect(idx.roots('other')).toEqual([]);
  });

  it('subtree is the cross-type BFS closure', () => {
    const idx = seed();
    // BFS, cross-type: behaviour 'bhv' (child of childB) is included.
    expect(idx.subtree('root')).toEqual([
      'root',
      'childA',
      'childB',
      'grand',
      'bhv',
    ]);
    expect(idx.subtree('childB')).toEqual(['childB', 'bhv']);
    expect(idx.subtree('missing')).toEqual([]);
  });

  it('isDescendant walks ancestors and guards cycles', () => {
    const idx = seed();
    expect(idx.isDescendant('scene_node', 'grand', 'root')).toBe(true);
    expect(idx.isDescendant('scene_node', 'childB', 'childA')).toBe(false);
    expect(idx.isDescendant('scene_node', 'root', 'grand')).toBe(false);
  });
});

describe('ContainmentIndex mutations', () => {
  it('re-parents in the children map on parent change', () => {
    const idx = seed();
    idx.upsert('scene_node', 'grand', { parentId: 'childB', order: 'a' });
    expect(idx.childrenOf('childA')).toEqual([]);
    expect(idx.childrenOf('childB', 'scene_node')).toEqual(['grand']);
  });

  it('remove drops the node and its child-link; remove of unknown is a no-op', () => {
    const idx = seed();
    idx.remove('grand');
    expect(idx.has('grand')).toBe(false);
    expect(idx.childrenOf('childA')).toEqual([]);
    expect(() => idx.remove('ghost')).not.toThrow();
  });
});

describe('checkStructural', () => {
  it('passes when the rtype has no containment schema', () => {
    const idx = seed();
    expect(idx.checkStructural('unknown_rtype', 'x', null)).toEqual({
      ok: true,
    });
  });

  it('root placement honours canBeRoot', () => {
    const idx = seed();
    expect(idx.checkStructural('scene_node', 'x', null)).toEqual({ ok: true });
    const r = idx.checkStructural('behaviour', 'x', null);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/requires a parent/);
  });

  it('rejects a missing parent and a disallowed parent type', () => {
    const idx = seed();
    expect(idx.checkStructural('scene_node', 'x', 'ghost').ok).toBe(false);
    // behaviour's parent must be a scene_node, not another behaviour
    const r = idx.checkStructural('behaviour', 'x', 'bhv');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not allowed/);
  });

  it('rejects self-parenting and cycles', () => {
    const idx = seed();
    expect(idx.checkStructural('scene_node', 'childA', 'childA').ok).toBe(
      false
    );
    // making root a child of its own descendant would cycle
    const r = idx.checkStructural('scene_node', 'root', 'grand');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cycle/);
  });

  it('accepts a valid reparent', () => {
    const idx = seed();
    expect(idx.checkStructural('scene_node', 'grand', 'childB')).toEqual({
      ok: true,
    });
  });
});

/**
 * Multi-field parents: an entity that can hang off more than one kind of owner.
 *
 * A track clip belongs to a scene node OR a compose layer, and its DTO says so
 * with `ownerNodeId` / `ownerLayerId`. The backend schema used to give it
 * `parentField: 'nodeId'` — a field no clip has ever carried — so every clip
 * indexed with a NULL parent and looked like a root. Nothing errored; owning-
 * root resolution and the isDescendant checks behind object-share grants simply
 * never saw a clip as owned by anything.
 */
describe('parentField with several candidates', () => {
  const schemas: Record<string, ContainmentSchema> = {
    scene_node: { parentField: 'parentId', parentTypes: ['scene_node'], canBeRoot: true },
    compose_layer: { parentField: 'parentId', parentTypes: ['compose_layer'], canBeRoot: true },
    track_clip: {
      parentField: ['ownerNodeId', 'ownerLayerId'],
      parentTypes: ['scene_node', 'compose_layer'],
      canBeRoot: false,
    },
  };
  const idx = () => new ContainmentIndex((rt) => schemas[rt]);

  it('takes the first field present — node-owned', () => {
    const i = idx();
    i.upsert('scene_node', 'n1', {});
    i.upsert('track_clip', 'c1', { ownerNodeId: 'n1', ownerLayerId: null });
    expect(i.childrenOf('n1')).toContain('c1');
  });

  it('falls through to the next field — layer-owned', () => {
    const i = idx();
    i.upsert('compose_layer', 'l1', {});
    i.upsert('track_clip', 'c1', { ownerNodeId: null, ownerLayerId: 'l1' });
    expect(i.childrenOf('l1')).toContain('c1');
  });

  it('a clip with neither owner is parentless, not crashed', () => {
    const i = idx();
    i.upsert('track_clip', 'c1', {});
    expect(i.parentOf('c1')).toBeNull();
  });

  it('re-parents when the owner changes kind', () => {
    const i = idx();
    i.upsert('scene_node', 'n1', {});
    i.upsert('compose_layer', 'l1', {});
    i.upsert('track_clip', 'c1', { ownerNodeId: 'n1' });
    i.upsert('track_clip', 'c1', { ownerNodeId: null, ownerLayerId: 'l1' });
    expect(i.childrenOf('n1')).not.toContain('c1');
    expect(i.childrenOf('l1')).toContain('c1');
  });

  it('a single-string parentField still behaves exactly as before', () => {
    const i = idx();
    i.upsert('scene_node', 'root', {});
    i.upsert('scene_node', 'kid', { parentId: 'root' });
    expect(i.childrenOf('root')).toContain('kid');
  });
});
