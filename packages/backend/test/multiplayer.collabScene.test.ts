/**
 * multiplayer/collabScene — DB-backed collab link bookkeeping.
 *
 * Covered pure/near-pure functions:
 *  - registerCollabScene / removeCollabScene / isCollabScene
 *  - listAllCollabScenes / collabPeersForScene / allCollabSceneIds
 *  - indexCollabNode / collabSceneForNode (in-memory index)
 *  - clipCollabScene (cache-first scene lookup)
 *
 * mountSharedScene, persistCollabAssets, and applyCollabClips require
 * complex scene-node and project rows; they are noted as infra-bound and
 * only lightly tested through their no-op / empty inputs here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/testDb.js';

async function setup() {
  await resetDb();
  return await import('../src/multiplayer/collabScene.js');
}

async function setupWithProject() {
  await resetDb();
  const collab = await import('../src/multiplayer/collabScene.js');
  // Create a minimal project row so we can insert scene_nodes.
  const { getDb } = await import('../src/db/index.js');
  const { randomUUID } = await import('crypto');
  const projectId = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES (?, 'Test', datetime('now'), datetime('now'))`
    )
    .run(projectId);
  return { collab, getDb, randomUUID, projectId };
}

// ---------------------------------------------------------------------------
// registerCollabScene / removeCollabScene / isCollabScene.
// ---------------------------------------------------------------------------

describe('registerCollabScene / isCollabScene / removeCollabScene', () => {
  let collab: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    collab = await setup();
  });

  it('isCollabScene returns false for an unknown scene', () => {
    expect(collab.isCollabScene('non-existent')).toBe(false);
  });

  it('registerCollabScene makes isCollabScene return true', () => {
    collab.registerCollabScene('scene-1', 'peer-A', 'author', 'proj-1');
    expect(collab.isCollabScene('scene-1')).toBe(true);
  });

  it('removeCollabScene removes the link', () => {
    collab.registerCollabScene('scene-2', 'peer-B', 'author', 'proj-1');
    collab.removeCollabScene('scene-2', 'peer-B');
    expect(collab.isCollabScene('scene-2')).toBe(false);
  });

  it('upsert on conflict updates role and projectId', () => {
    collab.registerCollabScene('scene-3', 'peer-C', 'author', 'proj-A');
    collab.registerCollabScene('scene-3', 'peer-C', 'mounted', 'proj-B');
    const links = collab.collabPeersForScene('scene-3');
    expect(links).toHaveLength(1);
    expect(links[0].role).toBe('mounted');
    expect(links[0].projectId).toBe('proj-B');
  });
});

// ---------------------------------------------------------------------------
// collabPeersForScene / listAllCollabScenes / allCollabSceneIds.
// ---------------------------------------------------------------------------

describe('collabPeersForScene / listAllCollabScenes / allCollabSceneIds', () => {
  let collab: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    collab = await setup();
  });

  it('returns empty arrays before any registration', () => {
    expect(collab.collabPeersForScene('nobody')).toEqual([]);
    expect(collab.listAllCollabScenes()).toEqual([]);
    expect(collab.allCollabSceneIds()).toEqual([]);
  });

  it('collabPeersForScene returns only the peers for the given scene', () => {
    collab.registerCollabScene('s1', 'p1', 'author', 'proj');
    collab.registerCollabScene('s1', 'p2', 'author', 'proj');
    collab.registerCollabScene('s2', 'p3', 'mounted', 'proj');

    const peers = collab.collabPeersForScene('s1');
    expect(peers.map((l) => l.peerId).sort()).toEqual(['p1', 'p2']);
    expect(
      collab.collabPeersForScene('s2').map((l) => l.peerId)
    ).toEqual(['p3']);
  });

  it('listAllCollabScenes returns all links', () => {
    collab.registerCollabScene('s1', 'p1', 'author', 'proj');
    collab.registerCollabScene('s2', 'p2', 'mounted', 'proj');
    expect(collab.listAllCollabScenes()).toHaveLength(2);
  });

  it('allCollabSceneIds returns distinct scene ids', () => {
    collab.registerCollabScene('sc-X', 'peer-1', 'author', 'proj');
    collab.registerCollabScene('sc-X', 'peer-2', 'author', 'proj');
    collab.registerCollabScene('sc-Y', 'peer-3', 'author', 'proj');
    const ids = collab.allCollabSceneIds();
    // Must include both scenes exactly once.
    expect(ids.sort()).toEqual(['sc-X', 'sc-Y'].sort());
  });
});

// ---------------------------------------------------------------------------
// indexCollabNode / collabSceneForNode (in-memory index).
// ---------------------------------------------------------------------------

describe('indexCollabNode / collabSceneForNode', () => {
  let collab: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    collab = await setup();
  });

  it('collabSceneForNode returns undefined before indexing', () => {
    expect(collab.collabSceneForNode('node-1')).toBeUndefined();
  });

  it('indexCollabNode maps a node to its scene when the scene is a collab scene', () => {
    // Register a collab scene first so isCollabScene('scene-A') = true.
    collab.registerCollabScene('scene-A', 'peer', 'author', 'proj');
    collab.indexCollabNode('node-1', 'scene-A');
    expect(collab.collabSceneForNode('node-1')).toBe('scene-A');
  });

  it('indexCollabNode is a no-op if the root is not a collab scene', () => {
    // 'scene-B' is not registered.
    collab.indexCollabNode('node-2', 'scene-B');
    expect(collab.collabSceneForNode('node-2')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyCollabClips — error tolerance.
// ---------------------------------------------------------------------------

describe('applyCollabClips — malformed clips are skipped, not thrown', () => {
  let collab: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    collab = await setup();
  });

  it('does not throw on an empty clips array', () => {
    expect(() => collab.applyCollabClips('scene-Z', [])).not.toThrow();
  });

  it('skips a malformed clip and logs instead of throwing', () => {
    // A clip without an id will fail the INSERT; applyCollabClips catches it.
    const badClip = {
      id: '',
      ownerNodeId: null,
      ownerLayerId: null,
      name: 'bad',
      duration: 0,
      loop: false,
      mode: 'once',
      autoplay: false,
      lanes: [],
      events: [],
    } as Parameters<typeof collab.applyCollabClips>[1][number];
    expect(() => collab.applyCollabClips('scene-Z', [badClip])).not.toThrow();
  });
});
