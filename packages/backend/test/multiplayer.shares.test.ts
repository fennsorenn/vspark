/**
 * multiplayer/shares — grant-based share helpers.
 *
 * Covered:
 *  - addShare / removeShare (grant upsert/delete + mesh mirror no-op when no peer)
 *  - listObjectGrantees
 *  - isSharedWith
 *  - listSharedByMe (requires a scene_node row in the DB)
 *  - listSharesForPeer
 *  - findOwningRoot (in-memory containment index path + DB-walk fallback)
 *
 * mirrorShareGrant / dropShareGrant rely on getMeshPeer() returning null on
 * a freshly-reset backend (no initBackendMesh()), so mesh mirroring is a no-op
 * and safe to call in unit tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/testDb.js';

async function setup() {
  await resetDb();
  const shares = await import('../src/multiplayer/shares.js');
  return shares;
}

async function setupWithNode() {
  await resetDb();
  const { getDb } = await import('../src/db/index.js');
  const { randomUUID } = await import('crypto');

  const projectId = randomUUID();
  const sceneNodeId = randomUUID();

  getDb()
    .prepare(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES (?, 'Test', datetime('now'), datetime('now'))`
    )
    .run(projectId);
  getDb()
    .prepare(
      `INSERT INTO scene_nodes
         (id, project_id, root_scene_node_id, parent_id, name, kind, components, properties, hidden)
       VALUES (?, ?, ?, NULL, 'TestNode', 'avatar', '{}', '{}', 0)`
    )
    .run(sceneNodeId, projectId, sceneNodeId);

  const shares = await import('../src/multiplayer/shares.js');
  return { shares, projectId, sceneNodeId, getDb };
}

// ---------------------------------------------------------------------------
// addShare / removeShare / listObjectGrantees / isSharedWith.
// ---------------------------------------------------------------------------

describe('addShare / removeShare / listObjectGrantees / isSharedWith', () => {
  let shares: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    shares = await setup();
  });

  it('listObjectGrantees is empty before any share', () => {
    expect(shares.listObjectGrantees('node-X')).toEqual([]);
  });

  it('addShare makes the grantee appear in listObjectGrantees', () => {
    shares.addShare('object', 'node-A', 'peer-1');
    expect(shares.listObjectGrantees('node-A')).toContain('peer-1');
  });

  it('addShare with two grantees lists both', () => {
    shares.addShare('object', 'node-B', 'peer-1');
    shares.addShare('object', 'node-B', 'peer-2');
    expect(shares.listObjectGrantees('node-B').sort()).toEqual(['peer-1', 'peer-2']);
  });

  it('removeShare removes the grantee', () => {
    shares.addShare('object', 'node-C', 'peer-1');
    shares.removeShare('node-C', 'peer-1');
    expect(shares.listObjectGrantees('node-C')).not.toContain('peer-1');
  });

  it('isSharedWith returns true after addShare', () => {
    shares.addShare('object', 'node-D', 'peer-X');
    expect(shares.isSharedWith('node-D', 'peer-X')).toBe(true);
  });

  it('isSharedWith returns false before any share', () => {
    expect(shares.isSharedWith('node-E', 'peer-Y')).toBe(false);
  });

  it('isSharedWith returns false after removeShare', () => {
    shares.addShare('object', 'node-F', 'peer-Z');
    shares.removeShare('node-F', 'peer-Z');
    expect(shares.isSharedWith('node-F', 'peer-Z')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listSharedByMe — requires real scene_node rows.
// ---------------------------------------------------------------------------

describe('listSharedByMe', () => {
  it('returns an empty list when there are no shares', async () => {
    const { shares } = await setupWithNode();
    expect(shares.listSharedByMe()).toEqual([]);
  });

  it('returns an entry for an objectId that has a scene_node row', async () => {
    const { shares, sceneNodeId } = await setupWithNode();
    shares.addShare('object', sceneNodeId, 'peer-1');
    const list = shares.listSharedByMe();
    const entry = list.find((e) => e.objectId === sceneNodeId);
    expect(entry).toBeDefined();
    expect(entry?.grantees).toContain('peer-1');
    expect(entry?.name).toBe('TestNode');
  });

  it('omits objectIds whose scene_node row no longer exists', async () => {
    const { shares } = await setupWithNode();
    // Add a grant for a non-existent node id.
    shares.addShare('object', 'ghost-node', 'peer-1');
    const list = shares.listSharedByMe();
    expect(list.find((e) => e.objectId === 'ghost-node')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listSharesForPeer.
// ---------------------------------------------------------------------------

describe('listSharesForPeer', () => {
  it('returns an empty array when no shares are granted to the peer', async () => {
    const { shares } = await setupWithNode();
    expect(shares.listSharesForPeer('peer-nobody')).toEqual([]);
  });

  it('returns the share for an object when the peer has a read grant', async () => {
    const { shares, sceneNodeId } = await setupWithNode();
    shares.addShare('object', sceneNodeId, 'peer-Q');
    const list = shares.listSharesForPeer('peer-Q');
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].objectId).toBe(sceneNodeId);
    expect(list[0].granteePeerId).toBe('peer-Q');
  });
});

// ---------------------------------------------------------------------------
// findOwningRoot — in-memory containment index fallback.
// ---------------------------------------------------------------------------

describe('findOwningRoot', () => {
  it('returns the nodeId itself if it is one of the candidate roots', async () => {
    const { shares } = await setupWithNode();
    const roots = new Set(['node-R1', 'node-R2']);
    expect(shares.findOwningRoot('node-R1', roots)).toBe('node-R1');
  });

  it('returns null when the nodeId is not in the roots and the DB has no row', async () => {
    const { shares } = await setupWithNode();
    const roots = new Set(['root-A', 'root-B']);
    // 'unknown-id' has no DB row, so the walk bottoms out.
    expect(shares.findOwningRoot('unknown-id', roots)).toBeNull();
  });
});
