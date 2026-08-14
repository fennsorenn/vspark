import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { loadClip } from './track-clips.js';
import { broadcastBus } from '../broadcast/bus.js';
import { keyAfter } from '@vspark/shared/fracIndex';
import { _ws } from './shared.js';
import { getMeshCollection } from '../mesh/index.js';
import { getResource } from '../sync/registry.js';
import { multiplayerManager } from '../multiplayer/manager.js';

/** Mirror a freshly-persisted row into the mesh store (§10 write-through): the
 *  onCommitted tap re-persists (idempotent upsert) + emits the canonical
 *  sync.document upsert, and the write fans out to mesh subscribers (tabs,
 *  collab peers) with one HLC stamp. Replaces the old `sync.document.touch`. */
function mirrorRow(rtype: string, id: string): void {
  const col = getMeshCollection(rtype);
  const dto = getResource(rtype)?.load?.(id);
  if (col && dto) col.set(id, '', dto);
}

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

  const createdNodeIds: string[] = [id];
  const createdLayerIds: string[] = [];
  if (populate) {
    // Default camera
    const camId = randomUUID();
    createdNodeIds.push(camId);
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
    const keyLightId = randomUUID();
    db.prepare(
      `INSERT INTO scene_nodes (id, root_scene_node_id, project_id, parent_id, name, kind, components, properties)
       VALUES (?, ?, ?, NULL, 'Key Light', 'light', ?, ?)`
    ).run(
      keyLightId,
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
    const fillLightId = randomUUID();
    db.prepare(
      `INSERT INTO scene_nodes (id, root_scene_node_id, project_id, parent_id, name, kind, components, properties)
       VALUES (?, ?, ?, NULL, 'Fill Light', 'light', ?, ?)`
    ).run(
      fillLightId,
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

    createdNodeIds.push(keyLightId, fillLightId);
    // Default compose scene
    const composeSceneId = randomUUID();
    const cameraViewId = randomUUID();
    createdLayerIds.push(composeSceneId, cameraViewId);
    db.prepare(
      `INSERT INTO compose_layers (id, project_id, root_compose_scene_id, camera_node_id, parent_id, name, kind, config,
         x, y, width, height, rotation, anchor_h, anchor_v, order_key, visible)
       VALUES (?, ?, NULL, NULL, NULL, ?, 'compose_scene', '{}', 0, 0, 1920, 1080, 0, 'left', 'top', ?, 1)`
    ).run(composeSceneId, projectId, name + ' Output', keyAfter(null));

    // Default camera_view layer inside the compose scene
    db.prepare(
      `INSERT INTO compose_layers (id, project_id, root_compose_scene_id, camera_node_id, parent_id, name, kind, config,
         x, y, width, height, rotation, anchor_h, anchor_v, order_key, visible)
       VALUES (?, ?, ?, ?, NULL, 'Camera View', 'camera_view', '{}', 0, 0, 1920, 1080, 0, 'left', 'top', ?, 1)`
    ).run(cameraViewId, projectId, composeSceneId, camId, keyAfter(null));
  }

  // Write the created rows through the mesh store so they fan out to tabs +
  // collab/share subscribers and the containment index/collab routing stay
  // current. Scene root is first in createdNodeIds, so its containment entry
  // exists before the camera/lights that hang off it.
  for (const nid of createdNodeIds) mirrorRow('scene_node', nid);
  for (const lid of createdLayerIds) mirrorRow('compose_layer', lid);

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
  // Load-bearing, and NOT a smoothing lane (useWsSync's `scene_updated` branch
  // is a plain updateSceneItem). A Scene is a scene_nodes row, so the mesh
  // mirror below does reach every tab — but meshStoreFeeder's scene_node
  // observer writes only the `nodes` slice, and nothing feeds the `scenes`
  // slice at runtime (setScenes/updateSceneItem are otherwise only called from
  // REST loads and this handler). Dropping this broadcast would leave
  // scenes[].runtimeSettings stale on other tabs until a reload.
  _ws?.broadcast('scene_updated', patch);
  // Mirror the canonical doc through the mesh store (keeps the replica +
  // fan-out in sync).
  mirrorRow('scene_node', sceneId);

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
    // Remove every scene node through the mesh store FIRST (while the rows
    // still exist, so the persist tap's `persists` guard doesn't early-return):
    // the tap deletes each row, persists its HLC tombstone, and emits the
    // canonical remove so the replica + containment index + collab/share
    // fan-out drop the scene. FK enforcement is off, so a parent remove can't
    // cascade-delete a sibling out from under a later remove.
    const nodeCol = getMeshCollection('scene_node');
    for (const nid of nodeIds) nodeCol?.remove(nid);

    // The dependent rows go through their collections too, for the same reason
    // the nodes do. A raw DELETE removes the row but leaves the DOCUMENT alive
    // in the replica with no tombstone, so a tab that subscribes afterwards
    // gets a snapshot full of behaviors / effects / layers / clips whose rows
    // are gone. Only col.remove() writes the tombstone that suppresses them.
    const dependents: { table: string; column: string; rtype: string }[] = [
      { table: 'behaviors', column: 'node_id', rtype: 'behavior' },
      { table: 'camera_effects', column: 'node_id', rtype: 'camera_effect' },
      // camera_view compose layers that targeted this scene's cameras.
      {
        table: 'compose_layers',
        column: 'camera_node_id',
        rtype: 'compose_layer',
      },
      // Track clips owned by this node (scene root included).
      { table: 'track_clips', column: 'owner_node_id', rtype: 'track_clip' },
    ];
    for (const { table, column, rtype } of dependents) {
      const col = getMeshCollection(rtype);
      for (const nid of nodeIds) {
        // Read the ids BEFORE deleting: the persist tap's `persists` guard
        // early-returns once the row is gone, so a remove issued after the
        // DELETE would never write its tombstone.
        const ids = (
          db
            .prepare(`SELECT id FROM ${table} WHERE ${column} = ?`)
            .all(nid) as { id: string }[]
        ).map((r) => r.id);
        for (const id of ids) col?.remove(id);
        // Safety net for the same reason as the scene_nodes sweep below: the
        // mesh store may not be initialised in a bare context.
        db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(nid);
      }
    }
    // Safety net: drop any scene_nodes row the store remove missed (e.g. the
    // mesh store not yet initialised in a bare context).
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
