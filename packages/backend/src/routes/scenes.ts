import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { broadcastBus } from '../broadcast/bus.js';
import { _ws } from './shared.js';

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

  // Scenes are now scene_nodes with kind='scene'
  const sceneRows = db
    .prepare(
      "SELECT * FROM scene_nodes WHERE project_id = ? AND kind = 'scene'"
    )
    .all(projectId) as { id: string; name: string; properties: string }[];

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
          'SELECT * FROM node_components WHERE node_id = ? ORDER BY sort_order'
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
    const clips = db
      .prepare(
        `SELECT tc.* FROM track_clips tc
         LEFT JOIN scene_nodes sn ON sn.id = tc.owner_node_id
         LEFT JOIN compose_layers cl ON cl.id = tc.owner_layer_id
         WHERE sn.project_id = ? OR cl.project_id = ?
         ORDER BY tc.created_at`
      )
      .all(projectId, projectId) as { id: string }[];
    for (const c of clips) {
      const lanes = db
        .prepare('SELECT * FROM track_clip_lanes WHERE clip_id = ?')
        .all(c.id) as { id: string }[];
      const lanesWithKfs = lanes.map((lane) => ({
        ...lane,
        keyframes: db
          .prepare(
            'SELECT * FROM track_clip_keyframes WHERE lane_id = ? ORDER BY t'
          )
          .all(lane.id),
      }));
      // Event/marker lane (media-command triggers) — without this the scene
      // bundle would drop clip events, so an instantiated alert preset's
      // play/restart markers would silently vanish on the post-import refetch.
      const events = (
        db
          .prepare(
            'SELECT * FROM track_clip_events WHERE clip_id = ? ORDER BY t'
          )
          .all(c.id) as Record<string, unknown>[]
      ).map((e) => {
        let payload: Record<string, unknown> | null = null;
        if (e.payload) {
          try {
            payload = JSON.parse(e.payload as string) as Record<
              string,
              unknown
            >;
          } catch {
            payload = null;
          }
        }
        return { ...e, payload };
      });
      trackClips.push({ ...c, lanes: lanesWithKfs, events });
    }
  }

  // Compose layers are now project-scoped, not scene-scoped
  const composeLayers = db
    .prepare(
      'SELECT * FROM compose_layers WHERE project_id = ? ORDER BY scene_order DESC, camera_order ASC'
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
router.post('/projects/:projectId/scenes', (req, res) => {
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
  const db = getDb();
  const populate = req.body.populate !== false;

  // Create a kind='scene' node with root_scene_node_id pointing to itself
  db.prepare(
    `INSERT INTO scene_nodes (id, root_scene_node_id, project_id, parent_id, name, kind, properties)
     VALUES (?, ?, ?, NULL, ?, 'scene', '{}')`
  ).run(id, id, projectId, name);

  if (populate) {
    // Default camera
    const camId = randomUUID();
    db.prepare(
      `INSERT INTO scene_nodes (id, root_scene_node_id, project_id, parent_id, name, kind, components, properties)
       VALUES (?, ?, ?, NULL, 'Camera', 'camera', ?, '{}')`
    ).run(
      camId,
      id,
      projectId,
      JSON.stringify({
        transform: {
          type: 'transform',
          x: 0,
          y: 1.3,
          z: 2,
          rx: 0,
          ry: 0,
          rz: 0,
          sx: 1,
          sy: 1,
          sz: 1,
        },
      })
    );

    // Default key light
    db.prepare(
      `INSERT INTO scene_nodes (id, root_scene_node_id, project_id, parent_id, name, kind, components, properties)
       VALUES (?, ?, ?, NULL, 'Key Light', 'light', ?, ?)`
    ).run(
      randomUUID(),
      id,
      projectId,
      JSON.stringify({
        transform: {
          type: 'transform',
          x: 2,
          y: 3,
          z: 1,
          rx: 0,
          ry: 0,
          rz: 0,
          sx: 1,
          sy: 1,
          sz: 1,
        },
        light: {
          type: 'light',
          lightType: 'directional',
          color: '#ffffff',
          intensity: 1,
        },
      }),
      '{}'
    );

    // Default fill light
    db.prepare(
      `INSERT INTO scene_nodes (id, root_scene_node_id, project_id, parent_id, name, kind, components, properties)
       VALUES (?, ?, ?, NULL, 'Fill Light', 'light', ?, ?)`
    ).run(
      randomUUID(),
      id,
      projectId,
      JSON.stringify({
        transform: {
          type: 'transform',
          x: -2,
          y: 2,
          z: 1,
          rx: 0,
          ry: 0,
          rz: 0,
          sx: 1,
          sy: 1,
          sz: 1,
        },
        light: {
          type: 'light',
          lightType: 'directional',
          color: '#ffffff',
          intensity: 0.5,
        },
      }),
      '{}'
    );

    // Default compose scene
    const composeSceneId = randomUUID();
    db.prepare(
      `INSERT INTO compose_layers (id, project_id, root_compose_scene_id, camera_node_id, parent_id, name, kind, config,
         x, y, width, height, rotation, anchor_h, anchor_v, scene_order, camera_order, visible)
       VALUES (?, ?, NULL, NULL, NULL, ?, 'compose_scene', '{}', 0, 0, 1920, 1080, 0, 'left', 'top', 0, 0, 1)`
    ).run(composeSceneId, projectId, name + ' Output');

    // Default camera_view layer inside the compose scene
    db.prepare(
      `INSERT INTO compose_layers (id, project_id, root_compose_scene_id, camera_node_id, parent_id, name, kind, config,
         x, y, width, height, rotation, anchor_h, anchor_v, scene_order, camera_order, visible)
       VALUES (?, ?, ?, ?, NULL, 'Camera View', 'camera_view', '{}', 0, 0, 1920, 1080, 0, 'left', 'top', 0, 0, 1)`
    ).run(randomUUID(), projectId, composeSceneId, camId);
  }

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

  if (name != null) {
    db.prepare(
      `UPDATE scene_nodes SET name = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(name, sceneId);
  }

  let settingsChanged = false;
  if (runtimeSettings && typeof runtimeSettings === 'object') {
    // Merge runtimeSettings into the node's properties JSON
    const currentProps = JSON.parse(row.properties || '{}') as Record<
      string,
      unknown
    >;
    const merged = { ...currentProps, ...runtimeSettings };
    db.prepare(
      `UPDATE scene_nodes SET properties = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(merged), sceneId);
    settingsChanged = true;
  }

  if (settingsChanged) broadcastBus.reloadSceneSettings(sceneId);

  const patch: Record<string, unknown> = { id: sceneId };
  if (name != null) patch.name = name;
  if (settingsChanged) {
    const updated = db
      .prepare('SELECT properties FROM scene_nodes WHERE id = ?')
      .get(sceneId) as { properties: string };
    patch.runtimeSettings = JSON.parse(updated.properties || '{}');
  }
  _ws?.broadcast('scene_updated', patch);

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
    for (const nid of nodeIds) {
      db.prepare('DELETE FROM node_components WHERE node_id = ?').run(nid);
      db.prepare('DELETE FROM camera_effects WHERE node_id = ?').run(nid);
      // Drop camera_view compose layers that targeted this scene's cameras.
      db.prepare('DELETE FROM compose_layers WHERE camera_node_id = ?').run(
        nid
      );
      // Track clips owned by this node (scene root included).
      db.prepare('DELETE FROM track_clips WHERE owner_node_id = ?').run(nid);
    }
    // All nodes belonging to this scene (descendants + the scene node itself).
    db.prepare('DELETE FROM scene_nodes WHERE root_scene_node_id = ?').run(
      sceneId
    );
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  _ws?.broadcast('scene_removed', { id: sceneId });
  res.json({ ok: true, data: {} });
});

export default router;
