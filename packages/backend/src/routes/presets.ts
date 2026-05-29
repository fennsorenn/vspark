import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import {
  serializeSceneNodeSubtree,
  serializeComposeLayerSubtree,
} from '../presets/serialize.js';
import { instantiatePreset } from '../presets/deserialize.js';
import { _ws } from './shared.js';

const router: ReturnType<typeof Router> = Router();

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
  const { payload, projectId, rootSceneNodeId, rootComposeSceneId, parentId } =
    req.body ?? {};
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
    });

    if (payload.rootKind === 'scene_node' && rootSceneNodeId) {
      const nodes = getDb()
        .prepare('SELECT * FROM scene_nodes WHERE root_scene_node_id = ?')
        .all(rootSceneNodeId);
      for (const node of nodes) {
        if (
          result.idMap[
            Object.keys(result.idMap).find(
              (k) => result.idMap[k] === (node as Record<string, unknown>).id
            ) ?? ''
          ]
        ) {
          _ws?.broadcast('node_added', node as Record<string, unknown>);
        }
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
