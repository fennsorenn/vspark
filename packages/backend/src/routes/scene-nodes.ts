import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { _ws } from './shared.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/scenes/{sceneId}/nodes:
 *   get:
 *     tags: [scene_nodes]
 *     summary: List all nodes within a scene
 *     parameters:
 *       - { in: path, name: sceneId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of scene_node rows }
 */
router.get('/scenes/:sceneId/nodes', (req, res) => {
  const data = getDb()
    .prepare("SELECT * FROM scene_nodes WHERE root_scene_node_id = ? AND kind != 'scene'")
    .all(req.params.sceneId);
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/scenes/{sceneId}/nodes:
 *   post:
 *     tags: [scene_nodes]
 *     summary: Create a new node within a scene
 *     parameters:
 *       - { in: path, name: sceneId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateSceneNode' }
 *     responses:
 *       201: { description: Node created; broadcast as node_added over WebSocket }
 *       400: { description: Missing name or kind, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/scenes/:sceneId/nodes', (req, res) => {
  const {
    name,
    parentId,
    boneAttachment,
    kind,
    filePath,
    components,
    properties,
  } = req.body;
  if (!name || !kind)
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
  const id = randomUUID();
  const rootSceneNodeId = req.params.sceneId;
  const db = getDb();
  const sceneRow = db
    .prepare("SELECT project_id FROM scene_nodes WHERE id = ? AND kind = 'scene'")
    .get(rootSceneNodeId) as { project_id: string } | undefined;
  if (!sceneRow)
    return res
      .status(404)
      .json({
        ok: false,
        error: { status: 404, message: 'scene not found', code: 'NOT_FOUND' },
      });
  db.prepare(
    'INSERT INTO scene_nodes (id, project_id, root_scene_node_id, parent_id, bone_attachment, name, kind, file_path, components, properties) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    sceneRow.project_id,
    rootSceneNodeId,
    parentId ?? null,
    boneAttachment ?? null,
    name,
    kind,
    filePath ?? null,
    JSON.stringify(components ?? {}),
    JSON.stringify(properties ?? {})
  );
  const node = {
    id,
    rootSceneNodeId,
    name,
    kind,
    parentId: parentId ?? null,
    boneAttachment: boneAttachment ?? null,
    filePath: filePath ?? null,
    components: components ?? {},
    properties: properties ?? {},
  };
  _ws?.broadcast('node_added', node);
  res.status(201).json({ ok: true, data: node });
});

/**
 * @openapi
 * /api/scene-nodes/{id}:
 *   put:
 *     tags: [scene_nodes]
 *     summary: Patch a scene node; only fields present in the body are updated
 *     description: |
 *       `parentId`, `boneAttachment`, and `hidden` support explicit null/false values
 *       and are only touched when the key is present in the request body.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateSceneNode' }
 *     responses:
 *       200: { description: Updated; patch broadcast as node_updated over WebSocket }
 */
router.put('/scene-nodes/:id', (req, res) => {
  const { name, kind, filePath, components } = req.body;
  const db = getDb();
  db.prepare(
    `UPDATE scene_nodes SET
      name = COALESCE(?, name),
      kind = COALESCE(?, kind),
      file_path = COALESCE(?, file_path),
      components = COALESCE(?, components),
      updated_at = datetime('now')
    WHERE id = ?`
  ).run(
    name ?? null,
    kind ?? null,
    filePath ?? null,
    components != null ? JSON.stringify(components) : null,
    req.params.id
  );

  // parentId and bone_attachment both support explicit null, so handle separately
  if ('parentId' in req.body) {
    db.prepare(
      `UPDATE scene_nodes SET parent_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(req.body.parentId ?? null, req.params.id);
  }
  if ('boneAttachment' in req.body) {
    db.prepare(
      `UPDATE scene_nodes SET bone_attachment = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(req.body.boneAttachment ?? null, req.params.id);
  }
  if ('hidden' in req.body) {
    db.prepare(
      `UPDATE scene_nodes SET hidden = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(req.body.hidden ? 1 : 0, req.params.id);
  }

  // Properties: shallow-merged JSON column.
  let mergedProperties: Record<string, unknown> | undefined;
  if (req.body.properties != null && typeof req.body.properties === 'object') {
    const row = db
      .prepare('SELECT properties FROM scene_nodes WHERE id = ?')
      .get(req.params.id) as { properties: string } | undefined;
    const current = row
      ? (JSON.parse(row.properties || '{}') as Record<string, unknown>)
      : {};
    mergedProperties = {
      ...current,
      ...(req.body.properties as Record<string, unknown>),
    };
    db.prepare(
      `UPDATE scene_nodes SET properties = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(mergedProperties), req.params.id);
  }

  // Broadcast to all other connected clients (viewer pages, etc.)
  const patch: Record<string, unknown> = { id: req.params.id };
  if (name != null) patch.name = name;
  if ('parentId' in req.body) patch.parentId = req.body.parentId ?? null;
  if (kind != null) patch.kind = kind;
  if (filePath != null) patch.filePath = filePath;
  if (components != null) patch.components = components;
  if ('boneAttachment' in req.body)
    patch.boneAttachment = req.body.boneAttachment ?? null;
  if ('hidden' in req.body) patch.hidden = Boolean(req.body.hidden);
  if (mergedProperties != null) patch.properties = mergedProperties;
  _ws?.broadcast('node_updated', patch);

  res.json({ ok: true, data: { id: req.params.id } });
});

/**
 * @openapi
 * /api/scene-nodes/{id}:
 *   delete:
 *     tags: [scene_nodes]
 *     summary: Delete a scene node (cascades to its components and effects)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted; broadcast as node_removed over WebSocket }
 */
router.delete('/scene-nodes/:id', (req, res) => {
  getDb().prepare('DELETE FROM scene_nodes WHERE id = ?').run(req.params.id);
  _ws?.broadcast('node_removed', { id: req.params.id });
  res.json({ ok: true, data: {} });
});

// --- Animation Clips ---

/**
 * @openapi
 * /api/scene-nodes/{nodeId}/clips:
 *   get:
 *     tags: [scene_nodes]
 *     summary: List animation clips imported from this node's source file
 *     parameters:
 *       - { in: path, name: nodeId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of animation_clip rows }
 */
router.get('/scene-nodes/:nodeId/clips', (req, res) => {
  const data = getDb()
    .prepare('SELECT * FROM animation_clips WHERE source_node_id = ?')
    .all(req.params.nodeId);
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/scene-nodes/{nodeId}/clips:
 *   post:
 *     tags: [scene_nodes]
 *     summary: Register (or refresh) an animation clip imported from an FBX/BVH file
 *     description: Upsert by (sourceNodeId, sourceFilePath, clipIndex) — re-probing updates the duration in place.
 *     parameters:
 *       - { in: path, name: nodeId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateAnimationClip' }
 *     responses:
 *       200: { description: Existing clip updated }
 *       201: { description: New clip registered }
 */
router.post('/scene-nodes/:nodeId/clips', (req, res) => {
  const {
    name,
    sourceFilePath,
    clipIndex,
    label,
    startTime,
    endTime,
    duration,
    fps,
  } = req.body;
  const nodeId = req.params.nodeId;
  const db = getDb();
  // Upsert by (source_node_id, source_file_path, clip_index): refresh duration on re-probe.
  const existing = db
    .prepare(
      'SELECT id FROM animation_clips WHERE source_node_id = ? AND source_file_path = ? AND clip_index = ?'
    )
    .get(nodeId, sourceFilePath, clipIndex ?? 0) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE animation_clips SET
        name = ?, label = ?, start_time = ?, end_time = ?, duration = ?, fps = ?
      WHERE id = ?`
    ).run(
      name,
      label ?? name,
      startTime ?? 0,
      endTime ?? duration,
      duration,
      fps ?? 30,
      existing.id
    );
    return res.json({
      ok: true,
      data: { id: existing.id, name, updated: true },
    });
  }
  const id = randomUUID();
  db.prepare(
    'INSERT INTO animation_clips (id, name, source_node_id, source_file_path, clip_index, label, start_time, end_time, duration, fps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    name,
    nodeId,
    sourceFilePath,
    clipIndex ?? 0,
    label ?? name,
    startTime ?? 0,
    endTime ?? duration,
    duration,
    fps ?? 30
  );
  res.status(201).json({ ok: true, data: { id, name } });
});

export default router;
