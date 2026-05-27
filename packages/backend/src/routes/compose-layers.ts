import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { _ws } from './shared.js';

const router: ReturnType<typeof Router> = Router();

type LayerRow = {
  id: string;
  project_id: string;
  root_compose_scene_id: string | null;
  camera_node_id: string | null;
  parent_id: string | null;
  name: string;
  kind: string;
  asset_id: string | null;
  config: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  anchor_h: string;
  anchor_v: string;
  scene_order: number;
  camera_order: number;
  visible: number;
  created_at: string;
  updated_at: string;
};

function rowToLayer(r: LayerRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    rootComposeSceneId: r.root_compose_scene_id,
    cameraNodeId: r.camera_node_id,
    parentId: r.parent_id,
    name: r.name,
    kind: r.kind,
    assetId: r.asset_id,
    config: JSON.parse(r.config || '{}'),
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    rotation: r.rotation,
    anchorH: r.anchor_h,
    anchorV: r.anchor_v,
    sceneOrder: r.scene_order,
    cameraOrder: r.camera_order,
    visible: r.visible === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Compose-scene CRUD (top-level containers: kind = 'compose_scene')
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/projects/{projectId}/compose-scenes:
 *   get:
 *     tags: [compose_layers]
 *     summary: List all compose_scene layers for a project
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of compose_scene rows }
 */
router.get('/projects/:projectId/compose-scenes', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT * FROM compose_layers
       WHERE project_id = ? AND kind = 'compose_scene'
       ORDER BY created_at ASC`
    )
    .all(req.params.projectId) as LayerRow[];
  res.json({ ok: true, data: rows.map(rowToLayer) });
});

/**
 * @openapi
 * /api/projects/{projectId}/compose-scenes:
 *   post:
 *     tags: [compose_layers]
 *     summary: Create a new compose_scene layer for a project
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateComposeScene' }
 *     responses:
 *       201: { description: Created; broadcast as compose_layer_added }
 */
router.post('/projects/:projectId/compose-scenes', (req, res) => {
  const projectId = req.params.projectId;
  const {
    id,
    name,
    config,
    width,
    height,
    visible,
  } = req.body ?? {};
  if (!name) {
    return res
      .status(400)
      .json({
        ok: false,
        error: {
          status: 400,
          message: 'name is required',
          code: 'VALIDATION_ERROR',
        },
      });
  }
  const layerId = id ?? randomUUID();
  const db = getDb();

  db.prepare(
    `INSERT INTO compose_layers
       (id, project_id, root_compose_scene_id, camera_node_id, parent_id,
        name, kind, asset_id, config,
        x, y, width, height, rotation, anchor_h, anchor_v,
        scene_order, camera_order, visible)
     VALUES (?, ?, NULL, NULL, NULL, ?, 'compose_scene', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    layerId,
    projectId,
    name,
    JSON.stringify(config ?? {}),
    0,
    0,
    width ?? 1920,
    height ?? 1080,
    0,
    'left',
    'top',
    0,
    0,
    visible === false ? 0 : 1
  );

  const row = db
    .prepare('SELECT * FROM compose_layers WHERE id = ?')
    .get(layerId) as LayerRow;
  const data = rowToLayer(row);
  _ws?.broadcast('compose_layer_added', data);
  res.status(201).json({ ok: true, data });
});

// ---------------------------------------------------------------------------
// Layers within a compose scene
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/compose-scenes/{composeSceneId}/layers:
 *   get:
 *     tags: [compose_layers]
 *     summary: List all layers within a compose scene
 *     parameters:
 *       - { in: path, name: composeSceneId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of compose_layer rows }
 */
router.get('/compose-scenes/:composeSceneId/layers', (req, res) => {
  const rows = getDb()
    .prepare(
      'SELECT * FROM compose_layers WHERE root_compose_scene_id = ? ORDER BY scene_order DESC, camera_order ASC'
    )
    .all(req.params.composeSceneId) as LayerRow[];
  res.json({ ok: true, data: rows.map(rowToLayer) });
});

/**
 * @openapi
 * /api/compose-scenes/{composeSceneId}/layers:
 *   post:
 *     tags: [compose_layers]
 *     summary: Create a new layer within a compose scene
 *     parameters:
 *       - { in: path, name: composeSceneId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateComposeLayer' }
 *     responses:
 *       201: { description: Created; broadcast as compose_layer_added }
 */
router.post('/compose-scenes/:composeSceneId/layers', (req, res) => {
  const composeSceneId = req.params.composeSceneId;
  const db = getDb();

  // Look up the compose_scene row to derive project_id
  const composeScene = db
    .prepare('SELECT * FROM compose_layers WHERE id = ?')
    .get(composeSceneId) as LayerRow | undefined;
  if (!composeScene) {
    return res
      .status(404)
      .json({
        ok: false,
        error: {
          status: 404,
          message: 'compose scene not found',
          code: 'NOT_FOUND',
        },
      });
  }

  const {
    id,
    cameraNodeId,
    parentId,
    name,
    kind,
    assetId,
    config,
    x,
    y,
    width,
    height,
    rotation,
    anchorH,
    anchorV,
    sceneOrder,
    cameraOrder,
    visible,
  } = req.body ?? {};
  if (!kind || !name) {
    return res
      .status(400)
      .json({
        ok: false,
        error: {
          status: 400,
          message: 'name and kind are required',
          code: 'VALIDATION_ERROR',
        },
      });
  }
  const layerId = id ?? randomUUID();

  // Default ordering: append to the back of the stack so new layers don't unexpectedly cover existing content.
  // sceneOrder is signed; "back" means the largest positive value currently in use, +1.
  let resolvedSceneOrder = sceneOrder;
  let resolvedCameraOrder = cameraOrder;
  if (resolvedSceneOrder == null) {
    const max = db
      .prepare(
        'SELECT MAX(scene_order) AS m FROM compose_layers WHERE root_compose_scene_id = ?'
      )
      .get(composeSceneId) as { m: number | null };
    resolvedSceneOrder = (max?.m ?? 0) + 1;
  }
  if (resolvedCameraOrder == null) {
    resolvedCameraOrder = cameraNodeId ? 1 : 0;
  }

  db.prepare(
    `INSERT INTO compose_layers
       (id, project_id, root_compose_scene_id, camera_node_id, parent_id,
        name, kind, asset_id, config,
        x, y, width, height, rotation, anchor_h, anchor_v,
        scene_order, camera_order, visible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    layerId,
    composeScene.project_id,
    composeSceneId,
    cameraNodeId ?? null,
    parentId ?? null,
    name,
    kind,
    assetId ?? null,
    JSON.stringify(config ?? {}),
    x ?? 0,
    y ?? 0,
    width ?? 320,
    height ?? 180,
    rotation ?? 0,
    anchorH ?? 'left',
    anchorV ?? 'top',
    resolvedSceneOrder,
    resolvedCameraOrder,
    visible === false ? 0 : 1
  );

  const row = db
    .prepare('SELECT * FROM compose_layers WHERE id = ?')
    .get(layerId) as LayerRow;
  const data = rowToLayer(row);
  _ws?.broadcast('compose_layer_added', data);
  res.status(201).json({ ok: true, data });
});

// ---------------------------------------------------------------------------
// Single-layer operations
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/compose-layers/{id}:
 *   put:
 *     tags: [compose_layers]
 *     summary: Patch a compose layer's properties
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateComposeLayer' }
 *     responses:
 *       200: { description: Updated; broadcast as compose_layer_updated }
 */
router.put('/compose-layers/:id', (req, res) => {
  const id = req.params.id;
  const patch = req.body ?? {};
  const db = getDb();

  // Build a dynamic UPDATE. Only set columns whose patch field is present.
  const cols: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = {
    name: 'name',
    assetId: 'asset_id',
    x: 'x',
    y: 'y',
    width: 'width',
    height: 'height',
    rotation: 'rotation',
    anchorH: 'anchor_h',
    anchorV: 'anchor_v',
    sceneOrder: 'scene_order',
    cameraOrder: 'camera_order',
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) {
      cols.push(`${col} = ?`);
      vals.push(patch[k]);
    }
  }
  if ('parentId' in patch) {
    cols.push('parent_id = ?');
    vals.push(patch.parentId ?? null);
  }
  if ('rootComposeSceneId' in patch) {
    cols.push('root_compose_scene_id = ?');
    vals.push(patch.rootComposeSceneId ?? null);
  }
  if (patch.config !== undefined) {
    cols.push('config = ?');
    vals.push(JSON.stringify(patch.config));
  }
  if (patch.visible !== undefined) {
    cols.push('visible = ?');
    vals.push(patch.visible ? 1 : 0);
  }

  if (cols.length === 0) {
    return res.json({ ok: true, data: { id } });
  }
  cols.push("updated_at = datetime('now')");
  vals.push(id);

  db.prepare(`UPDATE compose_layers SET ${cols.join(', ')} WHERE id = ?`).run(
    ...vals
  );

  const row = db
    .prepare('SELECT * FROM compose_layers WHERE id = ?')
    .get(id) as LayerRow | undefined;
  if (!row)
    return res
      .status(404)
      .json({
        ok: false,
        error: {
          status: 404,
          message: 'compose layer not found',
          code: 'NOT_FOUND',
        },
      });
  const data = rowToLayer(row);
  _ws?.broadcast('compose_layer_updated', data);
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/compose-layers/{id}:
 *   delete:
 *     tags: [compose_layers]
 *     summary: Delete a compose layer (re-anchors dependent camera layers if scene-wide)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted; broadcast as compose_layer_removed }
 */
router.delete('/compose-layers/:id', (req, res) => {
  const id = req.params.id;
  const db = getDb();

  const row = db
    .prepare('SELECT * FROM compose_layers WHERE id = ?')
    .get(id) as LayerRow | undefined;
  if (!row) return res.json({ ok: true, data: {} });

  db.prepare('DELETE FROM compose_layers WHERE id = ?').run(id);

  // If this was a scene-wide layer, re-anchor camera layers that sat in its scene_order slot.
  const reanchored: { id: string; sceneOrder: number; cameraOrder: number }[] =
    [];
  if (row.camera_node_id == null && row.root_compose_scene_id != null) {
    const camRows = db
      .prepare(
        `SELECT id, camera_order FROM compose_layers
       WHERE root_compose_scene_id = ? AND camera_node_id IS NOT NULL AND scene_order = ?`
      )
      .all(row.root_compose_scene_id, row.scene_order) as {
      id: string;
      camera_order: number;
    }[];
    if (camRows.length > 0) {
      const lower = db
        .prepare(
          `SELECT MAX(scene_order) AS s FROM compose_layers
         WHERE root_compose_scene_id = ? AND camera_node_id IS NULL AND scene_order < ?`
        )
        .get(row.root_compose_scene_id, row.scene_order) as { s: number | null };
      const higher = db
        .prepare(
          `SELECT MIN(scene_order) AS s FROM compose_layers
         WHERE root_compose_scene_id = ? AND camera_node_id IS NULL AND scene_order > ?`
        )
        .get(row.root_compose_scene_id, row.scene_order) as { s: number | null };
      const newSceneOrder = lower?.s ?? higher?.s ?? 0; // 0 = SCENE_RENDER_SLOT fallback
      for (const cr of camRows) {
        db.prepare(
          `UPDATE compose_layers SET scene_order = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(newSceneOrder, cr.id);
        reanchored.push({
          id: cr.id,
          sceneOrder: newSceneOrder,
          cameraOrder: cr.camera_order,
        });
      }
    }
  }

  _ws?.broadcast('compose_layer_removed', { id });
  if (reanchored.length > 0) {
    _ws?.broadcast('compose_layer_reordered', { updates: reanchored });
  }
  res.json({ ok: true, data: { id, reanchored } });
});

/**
 * @openapi
 * /api/compose-layers/reorder:
 *   post:
 *     tags: [compose_layers]
 *     summary: Bulk-update (sceneOrder, cameraOrder) for multiple layers
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ReorderComposeLayers' }
 *     responses:
 *       200: { description: Updated; broadcast as compose_layer_reordered }
 */
router.post('/compose-layers/reorder', (req, res) => {
  const updates = (req.body?.updates ?? []) as {
    id: string;
    sceneOrder: number;
    cameraOrder: number;
  }[];
  if (!Array.isArray(updates) || updates.length === 0) {
    return res
      .status(400)
      .json({
        ok: false,
        error: {
          status: 400,
          message: 'updates required',
          code: 'VALIDATION_ERROR',
        },
      });
  }
  const db = getDb();
  for (const u of updates) {
    db.prepare(
      `UPDATE compose_layers SET scene_order = ?, camera_order = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(u.sceneOrder, u.cameraOrder, u.id);
  }
  _ws?.broadcast('compose_layer_reordered', { updates });
  res.json({ ok: true, data: { updates } });
});

export default router;
