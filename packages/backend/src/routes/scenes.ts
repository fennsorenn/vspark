import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { broadcastBus } from '../broadcast/bus.js';
import { _ws } from './shared.js';

const router: ReturnType<typeof Router> = Router();

router.get('/projects/:projectId/scenes', (req, res) => {
  const db = getDb();
  const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ?').all(req.params.projectId);
  const nodes: unknown[] = [];
  const nodeComponents: unknown[] = [];
  const cameraEffects: unknown[] = [];
  for (const s of scenes as { id: string }[]) {
    const sceneNodes = db.prepare('SELECT * FROM scene_nodes WHERE scene_id = ?').all(s.id);
    nodes.push(...sceneNodes);
    for (const n of sceneNodes as { id: string }[]) {
      const comps = db.prepare('SELECT * FROM node_components WHERE node_id = ? ORDER BY sort_order').all(n.id);
      nodeComponents.push(...comps);
      const effects = db.prepare('SELECT * FROM camera_effects WHERE node_id = ?').all(n.id);
      cameraEffects.push(...effects);
    }
  }
  res.json({ ok: true, data: { scenes, nodes, nodeComponents, cameraEffects } });
});

router.post('/projects/:projectId/scenes', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: { status: 400, message: 'name is required', code: 'VALIDATION_ERROR' } });
  const id = randomUUID();
  getDb().prepare('INSERT INTO scenes (id, project_id, name) VALUES (?, ?, ?)').run(id, req.params.projectId, name);
  res.status(201).json({ ok: true, data: { id, name, runtime_settings: '{}' } });
});

router.put('/scenes/:sceneId', (req, res) => {
  const db = getDb();
  const sceneId = req.params.sceneId;
  const row = db.prepare('SELECT id, runtime_settings FROM scenes WHERE id = ?').get(sceneId) as
    | { id: string; runtime_settings: string }
    | undefined;
  if (!row) {
    return res.status(404).json({ ok: false, error: { status: 404, message: 'scene not found', code: 'NOT_FOUND' } });
  }
  const { name, runtimeSettings } = req.body as { name?: string; runtimeSettings?: Record<string, unknown> };

  if (name != null) {
    db.prepare(`UPDATE scenes SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(name, sceneId);
  }

  let settingsChanged = false;
  if (runtimeSettings && typeof runtimeSettings === 'object') {
    const merged = { ...(JSON.parse(row.runtime_settings || '{}') as Record<string, unknown>), ...runtimeSettings };
    db.prepare(`UPDATE scenes SET runtime_settings = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(merged), sceneId);
    settingsChanged = true;
  }

  if (settingsChanged) broadcastBus.reloadSceneSettings(sceneId);

  const patch: Record<string, unknown> = { id: sceneId };
  if (name != null) patch.name = name;
  if (settingsChanged) {
    const updated = db.prepare('SELECT runtime_settings FROM scenes WHERE id = ?').get(sceneId) as { runtime_settings: string };
    patch.runtimeSettings = JSON.parse(updated.runtime_settings || '{}');
  }
  _ws?.broadcast('scene_updated', patch);

  res.json({ ok: true, data: patch });
});

export default router;
