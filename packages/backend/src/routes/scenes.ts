import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { loadClip } from './track-clips.js';
import { keyAfter } from '@vspark/shared/fracIndex';
import { getMeshCollection, getMeshPeer } from '../mesh/index.js';
import { multiplayerManager } from '../multiplayer/manager.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/projects/{projectId}/scenes:
 *   get:
 *     tags: [scenes]
 *     summary: List all scenes for a project, with their nodes, behaviors and camera-effects
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Bundle of scenes + every nested row
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:   { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     scenes:         { type: array, items: { type: object } }
 *                     nodes:          { type: array, items: { type: object } }
 *                     behaviors: { type: array, items: { type: object } }
 *                     cameraEffects:  { type: array, items: { type: object } }
 */
router.get('/projects/:projectId/scenes', (req, res) => {
  const db = getDb();
  const projectId = req.params.projectId;

  // Scenes are now scene_nodes with kind='scene'.
  //
  // Two sources, deliberately: this project's own scenes, and the scenes
  // MOUNTED into it. A mounted scene keeps its author's project_id — the
  // documents are theirs and are not rewritten (mesh.md principle 2, migration
  // 039) — so "project_id = mine" no longer finds it. The share link is what
  // says it belongs here, which is the honest relationship: we render it, we do
  // not own it.
  const sceneRows = db
    .prepare(
      `SELECT * FROM scene_nodes
       WHERE kind = 'scene'
         AND (project_id = ?
              OR id IN (SELECT scene_id FROM collab_scenes
                        WHERE project_id = ? AND role = 'mounted'))`
    )
    .all(projectId, projectId) as {
    id: string;
    name: string;
    properties: string;
  }[];

  // Map scene_node rows to the shape the frontend expects (id, name, runtime_settings)
  const scenes = sceneRows.map((s) => ({
    id: s.id,
    name: s.name,
    runtime_settings: s.properties ?? '{}',
  }));

  const nodes: unknown[] = [];
  const behaviors: unknown[] = [];
  const cameraEffects: unknown[] = [];
  const trackClips: unknown[] = [];

  for (const s of sceneRows) {
    // Child nodes belong to this scene via root_scene_node_id (excludes the scene node itself)
    const sceneNodes = db
      .prepare(
        "SELECT * FROM scene_nodes WHERE root_scene_node_id = ? AND kind != 'scene'"
      )
      .all(s.id);
    nodes.push(...sceneNodes);

    for (const n of sceneNodes as { id: string }[]) {
      const comps = db
        .prepare(
          'SELECT * FROM behaviors WHERE node_id = ? ORDER BY sort_order'
        )
        .all(n.id);
      behaviors.push(...comps);
      const effects = db
        .prepare('SELECT * FROM camera_effects WHERE node_id = ?')
        .all(n.id);
      cameraEffects.push(...effects);
    }
  }

  // Track clips are owned by a scene node or a compose layer (project-wide, no
  // longer scene-scoped). Gather all clips whose owner belongs to this project.
  {
    // Owner nodes of a mounted scene carry the author's project id, so match on
    // the scenes gathered above rather than on project_id alone.
    const sceneIds = sceneRows.map((r) => r.id);
    const placeholders = sceneIds.map(() => '?').join(',') || "''";
    const clips = db
      .prepare(
        `SELECT tc.* FROM track_clips tc
         LEFT JOIN scene_nodes sn ON sn.id = tc.owner_node_id
         LEFT JOIN compose_layers cl ON cl.id = tc.owner_layer_id
         WHERE sn.project_id = ? OR cl.project_id = ?
            OR sn.root_scene_node_id IN (${placeholders})
         ORDER BY tc.created_at`
      )
      .all(projectId, projectId, ...sceneIds) as { id: string }[];
    // One clip shape, one mapping: loadClip is what the mesh document and the
    // per-owner GET routes are built from, and it is what the frontend mappers
    // expect (id-keyed lanes/keyframes/events). This used to re-query the rows
    // by hand, which is how the bundle came to drop clip events once already.
    for (const c of clips) {
      const clip = loadClip(c.id);
      if (clip) trackClips.push(clip);
    }
  }

  // Compose layers are now project-scoped, not scene-scoped
  const composeLayers = db
    .prepare(
      'SELECT * FROM compose_layers WHERE project_id = ? ORDER BY order_key ASC, id ASC'
    )
    .all(projectId);

  res.json({
    ok: true,
    data: {
      scenes,
      nodes,
      behaviors,
      cameraEffects,
      composeLayers,
      trackClips,
    },
  });
});

/**
 * @openapi
 * /api/projects/{projectId}/scenes:
 *   post:
 *     tags: [scenes]
 *     summary: Create a new scene inside a project
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateScene' }
 *     responses:
 *       201: { description: Scene created }
 *       400: { description: Missing name, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/projects/:projectId/scenes', async (req, res) => {
  const { name } = req.body;
  if (!name)
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'name is required',
        code: 'VALIDATION_ERROR',
      },
    });

  const id = randomUUID();
  const projectId = req.params.projectId;
  // Scenes are EMPTY by default: creating a scene and furnishing it are separate
  // acts, and seeding surprised callers who then added their own camera/lights on
  // top (the agent duplicating "Key Light" was the visible symptom). Seeding is
  // opt-in and belongs to first-run onboarding — see Home.tsx, the only caller
  // that asks for it.
  const populate = req.body.populate === true;

  // Every document is committed through the mesh store (the persistence tap
  // writes the rows), scene root first so the rest hangs off it in the
  // containment tree. Same document shapes a tab writes.
  const nodes = getMeshCollection('scene_node');
  const layers = getMeshCollection('compose_layer');
  if (!nodes || !layers)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  const node = (fields: Record<string, unknown>) => ({
    rootSceneNodeId: id,
    projectId,
    parentId: null,
    boneAttachment: null,
    filePath: null,
    components: {},
    properties: {},
    hidden: false,
    ...fields,
  });
  const transform = (x: number, y: number, z: number) => ({
    type: 'transform',
    x,
    y,
    z,
    rx: 0,
    ry: 0,
    rz: 0,
    sx: 1,
    sy: 1,
    sz: 1,
  });
  const layer = (fields: Record<string, unknown>) => ({
    projectId,
    rootComposeSceneId: null,
    cameraNodeId: null,
    parentId: null,
    assetId: null,
    config: {},
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    anchorH: 'left',
    anchorV: 'top',
    orderKey: keyAfter(null),
    visible: true,
    ...fields,
  });

  const writes = [
    nodes.set(id, '', node({ id, rootSceneNodeId: id, name, kind: 'scene' })),
  ];
  if (populate) {
    const camId = randomUUID();
    const composeSceneId = randomUUID();
    const cameraViewId = randomUUID();
    writes.push(
      nodes.set(
        camId,
        '',
        node({
          id: camId,
          name: 'Camera',
          kind: 'camera',
          components: {
            transform: transform(0, 1.3, 2),
            // Matches a manually created camera (createKinds.ts):
            // orthographic, which suits 2D-style avatar framing.
            camera: {
              type: 'camera',
              projection: 'orthographic',
              fov: 50,
              orthoSize: 2,
              near: 0.1,
              far: 1000,
            },
          },
        })
      )
    );
    for (const [lightName, pos, intensity] of [
      ['Key Light', [2, 3, 1], 1],
      ['Fill Light', [-2, 2, 1], 0.5],
    ] as const) {
      const lightId = randomUUID();
      writes.push(
        nodes.set(
          lightId,
          '',
          node({
            id: lightId,
            name: lightName,
            kind: 'light',
            components: {
              transform: transform(pos[0], pos[1], pos[2]),
              light: {
                type: 'light',
                lightType: 'directional',
                color: '#ffffff',
                intensity,
              },
            },
          })
        )
      );
    }
    // Default compose scene with the camera's view in it.
    writes.push(
      layers.set(
        composeSceneId,
        '',
        layer({
          id: composeSceneId,
          name: name + ' Output',
          kind: 'compose_scene',
        })
      ),
      layers.set(
        cameraViewId,
        '',
        layer({
          id: cameraViewId,
          rootComposeSceneId: composeSceneId,
          cameraNodeId: camId,
          name: 'Camera View',
          kind: 'camera_view',
        })
      )
    );
  }
  const outcomes = await Promise.all(writes.map((w) => w.ack));
  const refused = outcomes.find((o) => o.status === 'rejected');
  if (refused && refused.status === 'rejected')
    return res
      .status(500)
      .json({ ok: false, error: { message: refused.reason } });

  res
    .status(201)
    .json({ ok: true, data: { id, name, runtime_settings: '{}' } });
});

/**
 * @openapi
 * /api/scenes/{sceneId}:
 *   put:
 *     tags: [scenes]
 *     summary: Update a scene's name or runtime settings (broadcast tick rate, etc.)
 *     parameters:
 *       - in: path
 *         name: sceneId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateScene' }
 *     responses:
 *       200: { description: Updated; runtimeSettings merge is shallow }
 *       404: { description: Scene not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.put('/scenes/:sceneId', (req, res) => {
  const db = getDb();
  const sceneId = req.params.sceneId;

  // The sceneId is now a scene_node ID with kind='scene'
  const row = db
    .prepare(
      "SELECT id, properties FROM scene_nodes WHERE id = ? AND kind = 'scene'"
    )
    .get(sceneId) as { id: string; properties: string } | undefined;

  if (!row) {
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'scene not found', code: 'NOT_FOUND' },
    });
  }

  const { name, runtimeSettings } = req.body as {
    name?: string;
    runtimeSettings?: Record<string, unknown>;
  };

  // Write through the mesh: the persistence tap stores the row, reloads the
  // scene's runtime settings, and every tab hears it through its
  // subscription (scene roots feed the `scenes` slice).
  const col = getMeshCollection('scene_node');
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  if (name != null) col.set(sceneId, 'name', name);
  // runtimeSettings merge into `properties` key by key (a shallow merge, as
  // before): each top-level setting is replaced, the others are kept.
  if (runtimeSettings && typeof runtimeSettings === 'object')
    for (const [k, v] of Object.entries(runtimeSettings))
      col.set(sceneId, `properties.${k}`, v);

  const doc = col.get(sceneId) as Record<string, unknown> | undefined;
  const patch: Record<string, unknown> = { id: sceneId };
  if (name != null) patch.name = name;
  if (runtimeSettings) patch.runtimeSettings = doc?.properties ?? {};
  res.json({ ok: true, data: patch });
});

/**
 * @openapi
 * /api/scenes/{sceneId}:
 *   delete:
 *     tags: [scenes]
 *     summary: Delete a scene and everything scoped to it (nodes, components, effects, clips, its compose scene + layers)
 *     parameters:
 *       - in: path
 *         name: sceneId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Deleted }
 *       404: { description: Scene not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.delete('/scenes/:sceneId', (req, res) => {
  const db = getDb();
  const sceneId = req.params.sceneId;

  const scene = db
    .prepare("SELECT id FROM scene_nodes WHERE id = ? AND kind = 'scene'")
    .get(sceneId) as { id: string } | undefined;
  if (!scene) {
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'scene not found', code: 'NOT_FOUND' },
    });
  }

  // If this scene is collaboratively shared/mounted, disconnect the collab
  // links FIRST (revoke the mesh grants + drop the subscriptions) so the
  // node deletions below stay local — deleting a mounted scene must remove
  // only the local copy, leaving every peer's copy intact.
  multiplayerManager.unmountCollabScene(sceneId);

  // Every node in the scene (the scene node itself + its descendants) shares
  // root_scene_node_id = sceneId. Collect them so we can clean up the rows that
  // reference them (components, effects, camera_view compose layers).
  const nodeIds = (
    db
      .prepare('SELECT id FROM scene_nodes WHERE root_scene_node_id = ?')
      .all(sceneId) as { id: string }[]
  ).map((r) => r.id);

  // FKs are stripped of ON DELETE CASCADE for root_scene_node_id (see the
  // 018 migration rebuild), so delete explicitly with enforcement off.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    // Everything hangs off the scene root in the containment tree — nodes,
    // behaviors, effects, clips, graphs — and goes as one removal, children
    // first, each document with its own tombstone; camera_view layers that
    // show one of the scene's cameras go with it (scene_node binding,
    // onRemoving). FK enforcement is off, so a parent row's delete can't
    // cascade a dependent out from under its own remove.
    getMeshPeer()?.removeTree(sceneId);

    // Safety net for a bare context with no mesh store: drop the rows the
    // removal above would have.
    for (const { table, column } of [
      { table: 'behaviors', column: 'node_id' },
      { table: 'camera_effects', column: 'node_id' },
      { table: 'compose_layers', column: 'camera_node_id' },
      { table: 'track_clips', column: 'owner_node_id' },
    ])
      for (const nid of nodeIds)
        db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(nid);
    // Safety net: drop any scene_nodes row the store remove missed (e.g. the
    // mesh store not yet initialised in a bare context).
    db.prepare('DELETE FROM scene_nodes WHERE root_scene_node_id = ?').run(
      sceneId
    );
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  res.json({ ok: true, data: {} });
});

export default router;
