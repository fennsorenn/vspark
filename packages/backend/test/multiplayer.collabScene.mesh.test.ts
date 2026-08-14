import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';

/**
 * A3 (retire the legacy sync envelope): the collab MOUNT appliers
 * (applyCollabClips / applyCollabCameraEffects) now write through the mesh
 * store instead of doing a raw SQL insert + `sync.document.upsert`. The tap's
 * `save` performs the identical persistence and emits the canonical doc, so
 * this asserts the store is the source of truth (replica read-back + DB
 * read-back) for a mounted collab scene's clips and camera effects.
 *
 * NOTE: the full collaboration guarantee (an author's edit converging on a
 * receiver, single row) is a two-backend live check outside this harness; this
 * pins the local applier → store contract the fold rests on.
 */
async function setup() {
  process.env.VSPARK_DB_PATH = ':memory:';
  const { closeDb, runMigrations, getDb } = await import('../src/db/index.js');
  const { resetBackendMesh, initBackendMesh, getMeshCollection } = await import(
    '../src/mesh/index.js'
  );
  resetBackendMesh();
  closeDb();
  await runMigrations();
  initBackendMesh();
  const collab = await import('../src/multiplayer/collabScene.js');
  return { getDb, getMeshCollection, collab };
}

describe('collabScene mount appliers → mesh store', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let projectId: string;
  let sceneId: string;
  let ownerNodeId: string;

  beforeEach(async () => {
    ctx = await setup();
    projectId = randomUUID();
    sceneId = randomUUID();
    ownerNodeId = randomUUID();
    const db = ctx.getDb();
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES (?, 'P', datetime('now'), datetime('now'))`
    ).run(projectId);
    // Scene root + an owner node the clip / effect hang off (FK targets).
    db.prepare(
      `INSERT INTO scene_nodes (id, root_scene_node_id, project_id, parent_id, name, kind, properties)
       VALUES (?, ?, ?, NULL, 'S', 'scene', '{}')`
    ).run(sceneId, sceneId, projectId);
    db.prepare(
      `INSERT INTO scene_nodes (id, root_scene_node_id, project_id, parent_id, name, kind, components, properties)
       VALUES (?, ?, ?, NULL, 'Avatar', 'vrm', '{}', '{}')`
    ).run(ownerNodeId, sceneId, projectId);
  });

  it('applyCollabClips lands the clip in the store + DB', () => {
    const clipId = randomUUID();
    const laneId = randomUUID();
    ctx.collab.applyCollabClips(sceneId, [
      {
        id: clipId,
        ownerNodeId,
        ownerLayerId: null,
        name: 'Wave',
        duration: 2,
        loop: false,
        mode: 'absolute',
        autoplay: false,
        lanes: [
          {
            id: laneId,
            targetKind: 'scene_node',
            targetId: ownerNodeId,
            paramPath: 'transform.x',
            defaultValue: 0,
            keyframes: [
              {
                id: randomUUID(),
                t: 0,
                value: 0,
                easing: 'linear',
                inHandleTFraction: 0,
                inHandleVFraction: 0,
                outHandleTFraction: 0,
                outHandleVFraction: 0,
              },
            ],
          },
        ],
        events: [],
      },
    ] as never);

    const doc = ctx.getMeshCollection('track_clip')!.get(clipId) as
      | { name?: string; lanes?: unknown[] }
      | undefined;
    expect(doc?.name).toBe('Wave');
    expect(doc?.lanes).toHaveLength(1);

    const row = ctx
      .getDb()
      .prepare('SELECT name FROM track_clips WHERE id = ?')
      .get(clipId) as { name: string } | undefined;
    expect(row?.name).toBe('Wave');
    const lanes = ctx
      .getDb()
      .prepare('SELECT id FROM track_clip_lanes WHERE clip_id = ?')
      .all(clipId);
    expect(lanes).toHaveLength(1);
  });

  it('applyCollabCameraEffects lands the effect in the store + DB', () => {
    const effectId = randomUUID();
    ctx.collab.applyCollabCameraEffects(sceneId, [
      {
        id: effectId,
        nodeId: ownerNodeId,
        kind: 'bloom',
        enabled: true,
        config: { intensity: 0.5 },
      },
    ] as never);

    const doc = ctx.getMeshCollection('camera_effect')!.get(effectId) as
      | { kind?: string; enabled?: boolean }
      | undefined;
    expect(doc?.kind).toBe('bloom');
    expect(doc?.enabled).toBe(true);

    const row = ctx
      .getDb()
      .prepare('SELECT kind, enabled FROM camera_effects WHERE id = ?')
      .get(effectId) as { kind: string; enabled: number } | undefined;
    expect(row?.kind).toBe('bloom');
    expect(row?.enabled).toBe(1);
  });
});

/**
 * The mount stamp (migration 038).
 *
 * A mount is not a reconnect: the receiver has no history with the incoming
 * tree, and if it once held those ids and deleted them, its tombstones
 * out-stamp the author's live documents — the mount lands empty and, the
 * subscription being mutual, the tombstones propagate back and delete the
 * author's scene. So the mount records when it happened and the mesh peer
 * reconciles that scope against max(write stamp, mount stamp).
 *
 * These pin the LINK side: that the stamp is recorded on the share, reaches the
 * peer, survives a restart, and goes away with the share. The reconciliation
 * behaviour itself is pinned in packages/mesh/test/mount.test.ts.
 */
describe('collab scene mount stamp', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  const link = (sceneId: string) =>
    ctx
      .getDb()
      .prepare('SELECT * FROM collab_scenes WHERE scene_id = ?')
      .get(sceneId) as { mounted_at: number | null } | undefined;

  it('records the mount time on the share, not on the documents', async () => {
    const sceneId = randomUUID();
    ctx.collab.registerCollabScene(sceneId, 'PEER', 'mounted', 'proj', 1000);

    expect(link(sceneId)?.mounted_at).toBe(1000);
    const { getMeshPeer } = await import('../src/mesh/index.js');
    expect(getMeshPeer()!.mountStampFor(sceneId)?.t).toBe(1000);
  });

  it('leaves an author share unstamped — an author mounted nothing', () => {
    const sceneId = randomUUID();
    ctx.collab.registerCollabScene(sceneId, 'PEER', 'author', 'proj');
    expect(link(sceneId)?.mounted_at).toBeNull();
  });

  it('keeps the stamp when the link is updated for another reason', () => {
    const sceneId = randomUUID();
    ctx.collab.registerCollabScene(sceneId, 'PEER', 'mounted', 'proj', 1000);
    // A re-register that carries no mount time (a role/project correction)
    // must not silently un-mount the scene.
    ctx.collab.registerCollabScene(sceneId, 'PEER', 'mounted', 'proj2');
    expect(link(sceneId)?.mounted_at).toBe(1000);
  });

  it('restores stamps at boot — the links persist, the peer table does not', async () => {
    const sceneId = randomUUID();
    ctx.collab.registerCollabScene(sceneId, 'PEER', 'mounted', 'proj', 1000);

    const { resetBackendMesh, initBackendMesh, getMeshPeer } = await import(
      '../src/mesh/index.js'
    );
    resetBackendMesh();
    initBackendMesh();
    expect(getMeshPeer()!.mountStampFor(sceneId)).toBeUndefined();

    ctx.collab.restoreMountStamps();
    expect(getMeshPeer()!.mountStampFor(sceneId)?.t).toBe(1000);
  });

  it('drops the scope when the share goes', async () => {
    const sceneId = randomUUID();
    ctx.collab.registerCollabScene(sceneId, 'PEER', 'mounted', 'proj', 1000);
    ctx.collab.removeCollabScene(sceneId, 'PEER');

    const { getMeshPeer } = await import('../src/mesh/index.js');
    expect(getMeshPeer()!.mountStampFor(sceneId)).toBeUndefined();
  });
});
