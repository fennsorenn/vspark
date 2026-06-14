import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import {
  serializeSceneNodeSubtree,
  serializeComposeLayerSubtree,
} from '../presets/serialize.js';
import { instantiatePreset } from '../presets/deserialize.js';
import { BUILTIN_PRESETS, getBuiltinPreset } from '../presets/builtins.js';
import { sync } from '../sync/index.js';

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

    // Broadcast every newly-created entity through the unified sync layer so
    // other clients (and collab peers) update live. `result.idMap` values are
    // exactly the rows we just created across every table, so we emit by id
    // membership per table — NOT by re-querying a root column, which depended
    // on the (sometimes-falsy / mis-passed) rootSceneNodeId/rootComposeSceneId
    // and silently skipped all emissions when it didn't match. Order: parent
    // entities first (nodes/layers), then attached behaviours/effects, then
    // track clips (lanes/keyframes/events ride the track_clip aggregate).
    // Logic graphs have no sync rtype yet — still local-only.
    const db = getDb();
    const createdIds = [...new Set(Object.values(result.idMap))];
    // table/rtype are fixed literals (never user input) — safe to interpolate.
    const emitTable = (table: string, rtype: string) => {
      for (let i = 0; i < createdIds.length; i += 400) {
        const batch = createdIds.slice(i, i + 400);
        const ph = batch.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT id FROM ${table} WHERE id IN (${ph})`)
          .all(...batch) as { id: string }[];
        for (const { id } of rows)
          // Resilient: one entity's emit failing (a doc listener throwing)
          // must not abort the rest or fail the already-committed instantiate.
          try {
            sync.document.upsert(rtype, id);
          } catch (e) {
            console.error(`[presets] sync emit failed for ${rtype}:${id}:`, e);
          }
      }
    };
    if (createdIds.length > 0) {
      emitTable('scene_nodes', 'scene_node');
      emitTable('compose_layers', 'compose_layer');
      emitTable('behaviors', 'behavior');
      emitTable('camera_effects', 'camera_effect');
      emitTable('track_clips', 'track_clip');
      emitTable('animation_clips', 'animation_clip');
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
