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
 *     summary: List all scenes for a project, with their nodes, node-components and camera-effects
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
 *                     nodeComponents: { type: array, items: { type: object } }
 *                     cameraEffects:  { type: array, items: { type: object } }
 */
router.get('/projects/:projectId/scenes', (req, res) => {
  const db = getDb();
  const projectId = req.params.projectId;

  // Scenes are now scene_nodes with kind='scene'
  const sceneRows = db
    .prepare("SELECT * FROM scene_nodes WHERE project_id = ? AND kind = 'scene'")
    .all(projectId) as { id: string; name: string; properties: string }[];

  // Map scene_node rows to the shape the frontend expects (id, name, runtime_settings)
  const scenes = sceneRows.map((s) => ({
    id: s.id,
    name: s.name,
    runtime_settings: s.properties ?? '{}',
  }));

  const nodes: unknown[] = [];
  const nodeComponents: unknown[] = [];
  const cameraEffects: unknown[] = [];
  const trackClips: unknown[] = [];

  for (const s of sceneRows) {
    // Child nodes belong to this scene via root_scene_node_id (excludes the scene node itself)
    const sceneNodes = db
      .prepare("SELECT * FROM scene_nodes WHERE root_scene_node_id = ? AND kind != 'scene'")
      .all(s.id);
    nodes.push(...sceneNodes);

    for (const n of sceneNodes as { id: string }[]) {
      const comps = db.prepare('SELECT * FROM node_components WHERE node_id = ? ORDER BY sort_order').all(n.id);
      nodeComponents.push(...comps);
      const effects = db.prepare('SELECT * FROM camera_effects WHERE node_id = ?').all(n.id);
      cameraEffects.push(...effects);
    }

    // Track clips: include nested lanes + keyframes so the frontend gets a complete tree
    const clips = db
      .prepare('SELECT * FROM track_clips WHERE root_scene_node_id = ? ORDER BY created_at')
      .all(s.id) as { id: string }[];
    for (const c of clips) {
      const lanes = db.prepare('SELECT * FROM track_clip_lanes WHERE clip_id = ?').all(c.id) as { id: string }[];
      const lanesWithKfs = lanes.map((lane) => ({
        ...lane,
        keyframes: db.prepare('SELECT * FROM track_clip_keyframes WHERE lane_id = ? ORDER BY t').all(lane.id),
      }));
      trackClips.push({ ...c, lanes: lanesWithKfs });
    }
  }

  // Compose layers are now project-scoped, not scene-scoped
  const composeLayers = db
    .prepare('SELECT * FROM compose_layers WHERE project_id = ? ORDER BY scene_order DESC, camera_order ASC')
    .all(projectId);

  res.json({ ok: true, data: { scenes, nodes, nodeComponents, cameraEffects, composeLayers, trackClips } });
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
  if (!name) return res.status(400).json({ ok: false, error: { status: 400, message: 'name is required', code: 'VALIDATION_ERROR' } });

  const id = randomUUID();
  const projectId = req.params.projectId;

  // Create a kind='scene' node with root_scene_node_id pointing to itself
  getDb()
    .prepare(
      `INSERT INTO scene_nodes (id, root_scene_node_id, project_id, parent_id, name, kind, properties)
       VALUES (?, ?, ?, NULL, ?, 'scene', '{}')`
    )
    .run(id, id, projectId, name);

  res.status(201).json({ ok: true, data: { id, name, runtime_settings: '{}' } });
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
    .prepare("SELECT id, properties FROM scene_nodes WHERE id = ? AND kind = 'scene'")
    .get(sceneId) as { id: string; properties: string } | undefined;

  if (!row) {
    return res.status(404).json({ ok: false, error: { status: 404, message: 'scene not found', code: 'NOT_FOUND' } });
  }

  const { name, runtimeSettings } = req.body as { name?: string; runtimeSettings?: Record<string, unknown> };

  if (name != null) {
    db.prepare(`UPDATE scene_nodes SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(name, sceneId);
  }

  let settingsChanged = false;
  if (runtimeSettings && typeof runtimeSettings === 'object') {
    // Merge runtimeSettings into the node's properties JSON
    const currentProps = JSON.parse(row.properties || '{}') as Record<string, unknown>;
    const merged = { ...currentProps, ...runtimeSettings };
    db.prepare(`UPDATE scene_nodes SET properties = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(merged), sceneId);
    settingsChanged = true;
  }

  if (settingsChanged) broadcastBus.reloadSceneSettings(sceneId);

  const patch: Record<string, unknown> = { id: sceneId };
  if (name != null) patch.name = name;
  if (settingsChanged) {
    const updated = db.prepare('SELECT properties FROM scene_nodes WHERE id = ?').get(sceneId) as { properties: string };
    patch.runtimeSettings = JSON.parse(updated.properties || '{}');
  }
  _ws?.broadcast('scene_updated', patch);

  res.json({ ok: true, data: patch });
});

export default router;
