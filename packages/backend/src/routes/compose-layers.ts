import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { _ws } from './shared.js';
import { getMeshCollection } from '../mesh/index.js';
import { runtimeOverrideManager } from '../runtime_overrides/manager.js';

const router: ReturnType<typeof Router> = Router();

// Write-through (§10): routes keep their validation + ordering computation,
// then write full canonical DTOs into the mesh collection; the onCommitted
// tap persists (resource registry) + emits sync.document. The replica doc
// lacks the DB-generated created/updated timestamps (display-only — the tap's
// sync envelopes re-load the row, so legacy tabs still get them).
type LayerDto = Record<string, unknown>;
const layersCol = () => getMeshCollection('compose_layer');

export type LayerRow = {
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

export function rowToLayer(r: LayerRow) {
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
router.post('/projects/:projectId/compose-scenes', async (req, res) => {
  const projectId = req.params.projectId;
  const { id, name, config, width, height, visible } = req.body ?? {};
  if (!name) {
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'name is required',
        code: 'VALIDATION_ERROR',
      },
    });
  }
  const layerId = id ?? randomUUID();
  const col = layersCol();
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  const outcome = await col.set(layerId, '', {
    id: layerId,
    projectId,
    rootComposeSceneId: null,
    cameraNodeId: null,
    parentId: null,
    name,
    kind: 'compose_scene',
    assetId: null,
    config: config ?? {},
    x: 0,
    y: 0,
    width: width ?? 1920,
    height: height ?? 1080,
    rotation: 0,
    anchorH: 'left',
    anchorV: 'top',
    sceneOrder: 0,
    cameraOrder: 0,
    visible: visible !== false,
  } as LayerDto).ack;
  if (outcome.status === 'rejected')
    return res
      .status(500)
      .json({ ok: false, error: { message: outcome.reason } });

  const row = getDb()
    .prepare('SELECT * FROM compose_layers WHERE id = ?')
    .get(layerId) as LayerRow;
  res.status(201).json({ ok: true, data: rowToLayer(row) });
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
router.post('/compose-scenes/:composeSceneId/layers', async (req, res) => {
  const composeSceneId = req.params.composeSceneId;
  const db = getDb();

  // Look up the compose_scene row to derive project_id
  const composeScene = db
    .prepare('SELECT * FROM compose_layers WHERE id = ?')
    .get(composeSceneId) as LayerRow | undefined;
  if (!composeScene) {
    return res.status(404).json({
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
    return res.status(400).json({
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

  const col = layersCol();
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  const outcome = await col.set(layerId, '', {
    id: layerId,
    projectId: composeScene.project_id,
    rootComposeSceneId: composeSceneId,
    cameraNodeId: cameraNodeId ?? null,
    parentId: parentId ?? null,
    name,
    kind,
    assetId: assetId ?? null,
    config: config ?? {},
    x: x ?? 0,
    y: y ?? 0,
    width: width ?? 320,
    height: height ?? 180,
    rotation: rotation ?? 0,
    anchorH: anchorH ?? 'left',
    anchorV: anchorV ?? 'top',
    sceneOrder: resolvedSceneOrder,
    cameraOrder: resolvedCameraOrder,
    visible: visible !== false,
  } as LayerDto).ack;
  if (outcome.status === 'rejected')
    return res
      .status(500)
      .json({ ok: false, error: { message: outcome.reason } });

  const row = db
    .prepare('SELECT * FROM compose_layers WHERE id = ?')
    .get(layerId) as LayerRow;
  res.status(201).json({ ok: true, data: rowToLayer(row) });
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
router.put('/compose-layers/:id', async (req, res) => {
  const id = req.params.id;
  const patch = req.body ?? {};
  const col = layersCol();
  const cur = col?.get(id) as LayerDto | undefined;
  if (!col || !cur)
    return res.status(404).json({
      ok: false,
      error: {
        status: 404,
        message: 'compose layer not found',
        code: 'NOT_FOUND',
      },
    });

  // Field-presence semantics preserved from the dynamic-UPDATE version: most
  // fields only when !== undefined; parentId/rootComposeSceneId honor an
  // explicit null when the key is present.
  const next: LayerDto = { ...cur };
  let changed = false;
  for (const k of [
    'name',
    'assetId',
    'x',
    'y',
    'width',
    'height',
    'rotation',
    'anchorH',
    'anchorV',
    'sceneOrder',
    'cameraOrder',
    'config',
  ]) {
    if (patch[k] !== undefined) {
      next[k] = patch[k];
      changed = true;
    }
  }
  if ('parentId' in patch) {
    next.parentId = patch.parentId ?? null;
    changed = true;
  }
  if ('rootComposeSceneId' in patch) {
    next.rootComposeSceneId = patch.rootComposeSceneId ?? null;
    changed = true;
  }
  if (patch.visible !== undefined) {
    next.visible = !!patch.visible;
    changed = true;
  }
  if (!changed) return res.json({ ok: true, data: { id } });

  const outcome = await col.set(id, '', next).ack;
  if (outcome.status === 'rejected')
    return res
      .status(500)
      .json({ ok: false, error: { message: outcome.reason } });

  const row = getDb()
    .prepare('SELECT * FROM compose_layers WHERE id = ?')
    .get(id) as LayerRow;
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
router.delete('/compose-layers/:id', async (req, res) => {
  const id = req.params.id;
  const db = getDb();
  const col = layersCol();
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });

  const row = db
    .prepare('SELECT * FROM compose_layers WHERE id = ?')
    .get(id) as LayerRow | undefined;
  if (!row) return res.json({ ok: true, data: {} });

  await col.remove(id).ack;

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
        .get(row.root_compose_scene_id, row.scene_order) as {
        s: number | null;
      };
      const higher = db
        .prepare(
          `SELECT MIN(scene_order) AS s FROM compose_layers
         WHERE root_compose_scene_id = ? AND camera_node_id IS NULL AND scene_order > ?`
        )
        .get(row.root_compose_scene_id, row.scene_order) as {
        s: number | null;
      };
      const newSceneOrder = lower?.s ?? higher?.s ?? 0; // 0 = SCENE_RENDER_SLOT fallback
      for (const cr of camRows) {
        const cur = col.get(cr.id) as LayerDto | undefined;
        if (cur) await col.set(cr.id, '', { ...cur, sceneOrder: newSceneOrder }).ack;
        reanchored.push({
          id: cr.id,
          sceneOrder: newSceneOrder,
          cameraOrder: cr.camera_order,
        });
      }
    }
  }

  runtimeOverrideManager.clearAllForTarget('compose_layer', id);
  if (reanchored.length > 0)
    _ws?.broadcast('compose_layer_reordered', { updates: reanchored });
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
router.post('/compose-layers/reorder', async (req, res) => {
  const updates = (req.body?.updates ?? []) as {
    id: string;
    sceneOrder: number;
    cameraOrder: number;
  }[];
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'updates required',
        code: 'VALIDATION_ERROR',
      },
    });
  }
  const col = layersCol();
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  for (const u of updates) {
    const cur = col.get(u.id) as LayerDto | undefined;
    if (!cur) continue; // unknown id — skip, mirroring the old UPDATE no-op
    await col.set(u.id, '', {
      ...cur,
      sceneOrder: u.sceneOrder,
      cameraOrder: u.cameraOrder,
    }).ack;
  }
  _ws?.broadcast('compose_layer_reordered', { updates });
  res.json({ ok: true, data: { updates } });
});

export default router;
