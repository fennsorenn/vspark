import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { _ws } from './shared.js';

const router: ReturnType<typeof Router> = Router();

router.get('/scenes/:sceneId/nodes', (req, res) => {
  const data = getDb().prepare('SELECT * FROM scene_nodes WHERE scene_id = ?').all(req.params.sceneId);
  res.json({ ok: true, data });
});

router.post('/scenes/:sceneId/nodes', (req, res) => {
  const { name, parentId, boneAttachment, kind, filePath, components } = req.body;
  if (!name || !kind) return res.status(400).json({ ok: false, error: { status: 400, message: 'name and kind are required', code: 'VALIDATION_ERROR' } });
  const id = randomUUID();
  const sceneId = req.params.sceneId;
  getDb().prepare('INSERT INTO scene_nodes (id, scene_id, parent_id, bone_attachment, name, kind, file_path, components) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, sceneId, parentId ?? null, boneAttachment ?? null, name, kind, filePath ?? null, JSON.stringify(components ?? {}));
  const node = { id, sceneId, name, kind, parentId: parentId ?? null, boneAttachment: boneAttachment ?? null, filePath: filePath ?? null, components: components ?? {} };
  _ws?.broadcast('node_added', node);
  res.status(201).json({ ok: true, data: node });
});

router.put('/scene-nodes/:id', (req, res) => {
  const { name, kind, filePath, components } = req.body;
  const db = getDb();
  db.prepare(`UPDATE scene_nodes SET
      name = COALESCE(?, name),
      kind = COALESCE(?, kind),
      file_path = COALESCE(?, file_path),
      components = COALESCE(?, components),
      updated_at = datetime('now')
    WHERE id = ?`)
    .run(name ?? null, kind ?? null, filePath ?? null,
      components != null ? JSON.stringify(components) : null, req.params.id);

  // parentId and bone_attachment both support explicit null, so handle separately
  if ('parentId' in req.body) {
    db.prepare(`UPDATE scene_nodes SET parent_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(req.body.parentId ?? null, req.params.id);
  }
  if ('boneAttachment' in req.body) {
    db.prepare(`UPDATE scene_nodes SET bone_attachment = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(req.body.boneAttachment ?? null, req.params.id);
  }
  if ('hidden' in req.body) {
    db.prepare(`UPDATE scene_nodes SET hidden = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(req.body.hidden ? 1 : 0, req.params.id);
  }

  // Broadcast to all other connected clients (viewer pages, etc.)
  const patch: Record<string, unknown> = { id: req.params.id };
  if (name      != null) patch.name       = name;
  if ('parentId' in req.body) patch.parentId = req.body.parentId ?? null;
  if (kind      != null) patch.kind       = kind;
  if (filePath  != null) patch.filePath   = filePath;
  if (components != null) patch.components = components;
  if ('boneAttachment' in req.body) patch.boneAttachment = req.body.boneAttachment ?? null;
  if ('hidden' in req.body) patch.hidden = Boolean(req.body.hidden);
  _ws?.broadcast('node_updated', patch);

  res.json({ ok: true, data: { id: req.params.id } });
});

router.delete('/scene-nodes/:id', (req, res) => {
  getDb().prepare('DELETE FROM scene_nodes WHERE id = ?').run(req.params.id);
  _ws?.broadcast('node_removed', { id: req.params.id });
  res.json({ ok: true, data: {} });
});

// --- Animation Clips ---

router.get('/scene-nodes/:nodeId/clips', (req, res) => {
  const data = getDb().prepare('SELECT * FROM animation_clips WHERE source_node_id = ?').all(req.params.nodeId);
  res.json({ ok: true, data });
});

router.post('/scene-nodes/:nodeId/clips', (req, res) => {
  const { name, sourceFilePath, clipIndex, label, startTime, endTime, duration, fps } = req.body;
  const nodeId = req.params.nodeId;
  const db = getDb();
  // Upsert by (source_node_id, source_file_path, clip_index): refresh duration on re-probe.
  const existing = db.prepare(
    'SELECT id FROM animation_clips WHERE source_node_id = ? AND source_file_path = ? AND clip_index = ?'
  ).get(nodeId, sourceFilePath, clipIndex ?? 0) as { id: string } | undefined;
  if (existing) {
    db.prepare(`UPDATE animation_clips SET
        name = ?, label = ?, start_time = ?, end_time = ?, duration = ?, fps = ?
      WHERE id = ?`)
      .run(name, label ?? name, startTime ?? 0, endTime ?? duration, duration, fps ?? 30, existing.id);
    return res.json({ ok: true, data: { id: existing.id, name, updated: true } });
  }
  const id = randomUUID();
  db.prepare('INSERT INTO animation_clips (id, name, source_node_id, source_file_path, clip_index, label, start_time, end_time, duration, fps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, nodeId, sourceFilePath, clipIndex ?? 0, label ?? name, startTime ?? 0, endTime ?? duration, duration, fps ?? 30);
  res.status(201).json({ ok: true, data: { id, name } });
});

export default router;
