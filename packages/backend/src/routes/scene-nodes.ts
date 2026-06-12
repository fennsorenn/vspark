import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { _ws } from './shared.js';
import { getMeshCollection } from '../mesh/index.js';
import { runtimeOverrideManager } from '../runtime_overrides/manager.js';

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
    .prepare(
      "SELECT * FROM scene_nodes WHERE root_scene_node_id = ? AND kind != 'scene'"
    )
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
router.post('/scenes/:sceneId/nodes', async (req, res) => {
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
    return res.status(400).json({
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
    .prepare(
      "SELECT project_id FROM scene_nodes WHERE id = ? AND kind = 'scene'"
    )
    .get(rootSceneNodeId) as { project_id: string } | undefined;
  if (!sceneRow)
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'scene not found', code: 'NOT_FOUND' },
    });

  // Validate scene_instance: sourceSceneId must exist and not create a cycle
  if (kind === 'scene_instance') {
    const sourceSceneId = (properties as Record<string, unknown>)
      ?.sourceSceneId as string | undefined;
    if (!sourceSceneId)
      return res.status(400).json({
        ok: false,
        error: {
          status: 400,
          message: 'scene_instance requires properties.sourceSceneId',
          code: 'VALIDATION_ERROR',
        },
      });
    const source = db
      .prepare(
        "SELECT id, project_id FROM scene_nodes WHERE id = ? AND kind = 'scene'"
      )
      .get(sourceSceneId) as { id: string; project_id: string } | undefined;
    if (!source || source.project_id !== sceneRow.project_id)
      return res.status(400).json({
        ok: false,
        error: {
          status: 400,
          message: 'sourceSceneId must reference a scene in the same project',
          code: 'VALIDATION_ERROR',
        },
      });
    if (sourceSceneId === rootSceneNodeId)
      return res.status(400).json({
        ok: false,
        error: {
          status: 400,
          message: 'a scene cannot instance itself',
          code: 'VALIDATION_ERROR',
        },
      });
    // Cycle detection: walk instances in sourceScene to check they don't reference rootSceneNodeId
    const visited = new Set<string>([rootSceneNodeId]);
    const queue = [sourceSceneId];
    while (queue.length > 0) {
      const sid = queue.shift()!;
      if (visited.has(sid))
        return res.status(400).json({
          ok: false,
          error: {
            status: 400,
            message: 'circular scene instance detected',
            code: 'VALIDATION_ERROR',
          },
        });
      visited.add(sid);
      const instances = db
        .prepare(
          "SELECT properties FROM scene_nodes WHERE root_scene_node_id = ? AND kind = 'scene_instance'"
        )
        .all(sid) as { properties: string }[];
      for (const inst of instances) {
        const props = JSON.parse(inst.properties || '{}') as {
          sourceSceneId?: string;
        };
        if (props.sourceSceneId) queue.push(props.sourceSceneId);
      }
    }
  }

  // Write through the mesh store (§10): the onCommitted tap persists +
  // emits the canonical sync.document upsert; the write fans out to mesh
  // subscribers (collab peers, tabs) with one stamp.
  const col = getMeshCollection('scene_node');
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
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
  const outcome = await col.set(id, '', {
    ...node,
    projectId: sceneRow.project_id,
    hidden: false,
  }).ack;
  if (outcome.status === 'rejected')
    return res
      .status(500)
      .json({ ok: false, error: { message: outcome.reason } });
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
router.put('/scene-nodes/:id', async (req, res) => {
  const { name, kind, filePath, components } = req.body;
  const col = getMeshCollection('scene_node');
  const cur = col?.get(req.params.id) as Record<string, unknown> | undefined;
  if (!col || !cur)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'scene node not found' } });

  // Field-presence semantics preserved from the SQL version: name/kind/
  // filePath/components only when non-null; parentId/boneAttachment/hidden
  // when the key is present (explicit null/false allowed); properties
  // shallow-merge onto the current bag.
  const next: Record<string, unknown> = { ...cur };
  if (name != null) next.name = name;
  if (kind != null) next.kind = kind;
  if (filePath != null) next.filePath = filePath;
  if (components != null) next.components = components;
  if ('parentId' in req.body) next.parentId = req.body.parentId ?? null;
  if ('boneAttachment' in req.body)
    next.boneAttachment = req.body.boneAttachment ?? null;
  if ('hidden' in req.body) next.hidden = Boolean(req.body.hidden);
  let mergedProperties: Record<string, unknown> | undefined;
  if (req.body.properties != null && typeof req.body.properties === 'object') {
    mergedProperties = {
      ...((cur.properties as Record<string, unknown>) ?? {}),
      ...(req.body.properties as Record<string, unknown>),
    };
    next.properties = mergedProperties;
  }

  const outcome = await col.set(req.params.id, '', next).ack;
  if (outcome.status === 'rejected')
    return res
      .status(500)
      .json({ ok: false, error: { message: outcome.reason } });

  // Broadcast the patch to all other connected clients (viewer pages, etc.) —
  // local + smoothing-aware; the canonical doc re-sync rides the store tap.
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
router.delete('/scene-nodes/:id', async (req, res) => {
  // Mesh remove: the tap deletes the row (FK cascade takes the subtree),
  // persists the HLC tombstone, and emits sync.document.remove. The old
  // ancestor-route capture fed the deleted legacy share fan-out — the mesh
  // resolves remove routing from its containment index before the entry dies.
  const col = getMeshCollection('scene_node');
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  await col.remove(req.params.id).ack;
  runtimeOverrideManager.clearAllForTarget('scene_node', req.params.id);
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
