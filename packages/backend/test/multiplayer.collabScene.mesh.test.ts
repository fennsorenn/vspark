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
