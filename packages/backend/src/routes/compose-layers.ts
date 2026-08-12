import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { _ws } from './shared.js';
import { getMeshCollection } from '../mesh/index.js';
import { keyAfter } from '@vspark/shared/fracIndex';

const router: ReturnType<typeof Router> = Router();

/** Highest order_key among a layer's siblings — the set is scoped to
 *  (root_compose_scene_id, parent_id), so nesting a layer restarts the range.
 *  Null when the group is empty, which `keyAfter` reads as "first key". */
function lastSiblingKey(
  composeSceneId: string,
  parentId: string | null
): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(order_key) AS k FROM compose_layers
        WHERE root_compose_scene_id = ?
          AND parent_id IS ?`
    )
    .get(composeSceneId, parentId) as { k: string | null } | undefined;
  return row?.k ?? null;
}

/** Same, for the top-level compose_scene rows of a project (their own group:
 *  both root_compose_scene_id and parent_id are null). */
function lastComposeSceneKey(projectId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(order_key) AS k FROM compose_layers
        WHERE project_id = ? AND kind = 'compose_scene'`
    )
    .get(projectId) as { k: string | null } | undefined;
  return row?.k ?? null;
}

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
  order_key: string;
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
    orderKey: r.order_key,
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
    orderKey: keyAfter(lastComposeSceneKey(projectId)),
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
      'SELECT * FROM compose_layers WHERE root_compose_scene_id = ? ORDER BY order_key ASC, id ASC'
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
    orderKey,
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

  // A new layer lands at the FRONT of its sibling group (ascending order_key =
  // back→front), which is what a layer editor is expected to do.
  const resolvedOrderKey =
    typeof orderKey === 'string' && orderKey.length > 0
      ? orderKey
      : keyAfter(lastSiblingKey(composeSceneId, parentId ?? null));

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
    orderKey: resolvedOrderKey,
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
    'orderKey',
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
  if ('cameraNodeId' in patch) {
    next.cameraNodeId = patch.cameraNodeId ?? null;
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
 *     summary: Delete a compose layer
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted; broadcast as compose_layer_removed }
 */
router.delete('/compose-layers/:id', async (req, res) => {
  const id = req.params.id;
  const col = layersCol();
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });

  // Runtime overrides are cleared by the mesh persistence tap, so a remove
  // authored by a tab or a collab peer is cleaned up the same way.
  await col.remove(id).ack;
  res.json({ ok: true, data: { id } });
});

export default router;
