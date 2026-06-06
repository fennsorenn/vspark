import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import {
  serializeSceneNodeSubtree,
  serializeComposeLayerSubtree,
} from '../presets/serialize.js';
import { instantiatePreset } from '../presets/deserialize.js';
import { BUILTIN_PRESETS, getBuiltinPreset } from '../presets/builtins.js';
import { rowToLayer, type LayerRow } from './compose-layers.js';
import { loadClip } from './track-clips.js';
import { _ws } from './shared.js';

const router: ReturnType<typeof Router> = Router();

interface SceneNodeRow {
  id: string;
  project_id: string;
  root_scene_node_id: string;
  parent_id: string | null;
  bone_attachment: string | null;
  name: string;
  kind: string;
  file_path: string | null;
  components: string;
  properties: string;
  hidden: number;
}

/** Map a raw scene_nodes row to the camelCase shape the frontend's
 *  `node_added` WS handler expects (it casts the payload directly without
 *  running it through a mapper, unlike compose layers). Mirrors the object
 *  built by the regular POST /scenes/:sceneId/nodes route. */
function rowToNode(r: SceneNodeRow) {
  return {
    id: r.id,
    rootSceneNodeId: r.root_scene_node_id,
    projectId: r.project_id,
    parentId: r.parent_id,
    boneAttachment: r.bone_attachment,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    components: JSON.parse(r.components || '{}'),
    properties: JSON.parse(r.properties || '{}'),
    hidden: r.hidden === 1,
  };
}

interface PresetRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  root_kind: string;
  payload: string;
  thumbnail_path: string | null;
  created_at: string;
  updated_at: string;
}

function mapPresetRow(r: PresetRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description,
    rootKind: r.root_kind,
    payload: JSON.parse(r.payload),
    thumbnailPath: r.thumbnail_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapPresetSummary(r: PresetRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description,
    rootKind: r.root_kind,
    thumbnailPath: r.thumbnail_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get('/projects/:projectId/presets', (req, res) => {
  const rows = getDb()
    .prepare(
      'SELECT * FROM presets WHERE project_id = ? ORDER BY created_at DESC'
    )
    .all(req.params.projectId) as unknown as PresetRow[];
  res.json({ ok: true, data: rows.map(mapPresetSummary) });
});

router.post('/projects/:projectId/presets', (req, res) => {
  const { name, description, rootKind, rootId, embedAssets } = req.body ?? {};
  if (!name || !rootKind || !rootId) {
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'name, rootKind, rootId required',
        code: 'VALIDATION_ERROR',
      },
    });
  }

  let payload: unknown;
  if (rootKind === 'scene_node') {
    payload = serializeSceneNodeSubtree(rootId, {
      embedAssets: embedAssets ?? false,
    });
  } else if (rootKind === 'compose_layer') {
    payload = serializeComposeLayerSubtree(rootId, {
      embedAssets: embedAssets ?? false,
    });
  } else {
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'rootKind must be scene_node or compose_layer',
        code: 'VALIDATION_ERROR',
      },
    });
  }

  const id = randomUUID();
  getDb()
    .prepare(
      'INSERT INTO presets (id, project_id, name, description, root_kind, payload) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      req.params.projectId,
      name,
      description ?? '',
      rootKind,
      JSON.stringify(payload)
    );

  const row = getDb()
    .prepare('SELECT * FROM presets WHERE id = ?')
    .get(id) as unknown as PresetRow;
  res.status(201).json({ ok: true, data: mapPresetRow(row) });
});

// Built-in (shipped, read-only) presets. Registered before /presets/:id so
// the literal "builtin" segment isn't captured as an :id.
router.get('/presets/builtin', (_req, res) => {
  res.json({
    ok: true,
    data: BUILTIN_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      rootKind: p.rootKind,
      builtin: true,
    })),
  });
});

router.get('/presets/builtin/:id', (req, res) => {
  const p = getBuiltinPreset(req.params.id);
  if (!p)
    return res.status(404).json({
      ok: false,
      error: {
        status: 404,
        message: 'builtin preset not found',
        code: 'NOT_FOUND',
      },
    });
  res.json({
    ok: true,
    data: {
      id: p.id,
      name: p.name,
      description: p.description,
      rootKind: p.rootKind,
      payload: p.payload,
      builtin: true,
    },
  });
});

router.get('/presets/:id', (req, res) => {
  const row = getDb()
    .prepare('SELECT * FROM presets WHERE id = ?')
    .get(req.params.id) as unknown as PresetRow | undefined;
  if (!row)
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'preset not found', code: 'NOT_FOUND' },
    });
  res.json({ ok: true, data: mapPresetRow(row) });
});

router.delete('/presets/:id', (req, res) => {
  getDb().prepare('DELETE FROM presets WHERE id = ?').run(req.params.id);
  res.json({ ok: true, data: { id: req.params.id } });
});

router.post('/presets/serialize', (req, res) => {
  const { rootKind, rootId, embedAssets } = req.body ?? {};
  if (!rootKind || !rootId) {
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'rootKind, rootId required',
        code: 'VALIDATION_ERROR',
      },
    });
  }

  let payload: unknown;
  if (rootKind === 'scene_node') {
    payload = serializeSceneNodeSubtree(rootId, {
      embedAssets: embedAssets ?? false,
    });
  } else if (rootKind === 'compose_layer') {
    payload = serializeComposeLayerSubtree(rootId, {
      embedAssets: embedAssets ?? false,
    });
  } else {
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'rootKind must be scene_node or compose_layer',
        code: 'VALIDATION_ERROR',
      },
    });
  }

  res.json({ ok: true, data: payload });
});

router.post('/presets/instantiate', (req, res) => {
  const {
    payload,
    projectId,
    rootSceneNodeId,
    rootComposeSceneId,
    parentId,
    boneAttachment,
  } = req.body ?? {};
  if (!payload || !projectId) {
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'payload and projectId required',
        code: 'VALIDATION_ERROR',
      },
    });
  }
  if (
    payload.format !== 'vspark.preset.v1' &&
    payload.format !== 'vspark.preset.v2'
  ) {
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'unsupported preset format',
        code: 'VALIDATION_ERROR',
      },
    });
  }

  try {
    const result = instantiatePreset(payload, {
      projectId,
      rootSceneNodeId: rootSceneNodeId ?? undefined,
      rootComposeSceneId: rootComposeSceneId ?? undefined,
      parentId: parentId ?? null,
      boneAttachment:
        typeof boneAttachment === 'string' ? boneAttachment : null,
    });

    // Broadcast every newly-created entity so other connected clients update
    // their scene graph live. The initiating client refetches on its own and
    // the receiving handlers dedupe by id, so broadcasting to everyone is safe.
    // `result.idMap` maps preset ids → freshly minted real ids for every
    // inserted entity, so its values are exactly the rows we just created.
    // Order matters: parent entities (nodes/layers) first so the renderer can
    // mount them, then their attached behaviours/effects, then track clips
    // (whose lanes reference the entity ids). Logic graphs and animation clips
    // are loaded on demand by each client when they open the relevant editor,
    // so they need no live broadcast.
    const db = getDb();
    const createdIds = new Set(Object.values(result.idMap));

    // `column` is a fixed literal, never user input — safe to interpolate.
    const broadcastClipsFor = (
      column: 'owner_node_id' | 'owner_layer_id',
      ownerId: string
    ) => {
      const clipRows = db
        .prepare(`SELECT id FROM track_clips WHERE ${column} = ?`)
        .all(ownerId) as { id: string }[];
      for (const { id } of clipRows) {
        if (!createdIds.has(id)) continue;
        const clip = loadClip(id);
        if (clip)
          _ws?.broadcast('track_clip_added', clip as Record<string, unknown>);
      }
    };

    if (payload.rootKind === 'scene_node' && rootSceneNodeId) {
      const nodeRows = (
        db
          .prepare('SELECT * FROM scene_nodes WHERE root_scene_node_id = ?')
          .all(rootSceneNodeId) as unknown as SceneNodeRow[]
      ).filter((r) => createdIds.has(r.id));

      for (const row of nodeRows) {
        _ws?.broadcast('node_added', rowToNode(row));
      }
      // Behaviours and camera effects ride on the raw row shape — their
      // frontend handlers map node_id/config themselves (mapBehavior /
      // the inline camera_effect_added mapper).
      for (const row of nodeRows) {
        const behaviorRows = db
          .prepare(
            'SELECT * FROM behaviors WHERE node_id = ? ORDER BY sort_order'
          )
          .all(row.id) as Record<string, unknown>[];
        for (const b of behaviorRows) {
          if (createdIds.has(b.id as string))
            _ws?.broadcast('behavior_added', b);
        }
        const effectRows = db
          .prepare('SELECT * FROM camera_effects WHERE node_id = ?')
          .all(row.id) as Record<string, unknown>[];
        for (const e of effectRows) {
          if (createdIds.has(e.id as string))
            _ws?.broadcast('camera_effect_added', e);
        }
      }
      for (const row of nodeRows) {
        broadcastClipsFor('owner_node_id', row.id);
      }
    } else if (payload.rootKind === 'compose_layer' && rootComposeSceneId) {
      const layerRows = (
        db
          .prepare(
            'SELECT * FROM compose_layers WHERE root_compose_scene_id = ?'
          )
          .all(rootComposeSceneId) as unknown as LayerRow[]
      ).filter((r) => createdIds.has(r.id));

      for (const row of layerRows) {
        _ws?.broadcast('compose_layer_added', rowToLayer(row));
      }
      for (const row of layerRows) {
        broadcastClipsFor('owner_layer_id', row.id);
      }
    }

    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: e instanceof Error ? e.message : String(e),
        code: 'INSTANTIATE_ERROR',
      },
    });
  }
});

export default router;
