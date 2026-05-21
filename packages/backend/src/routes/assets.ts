import { Router } from 'express';
import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { getDb } from '../db/index.js';
import {
  UPLOADS_DIR,
  allocateFilename,
  assetSubfolder,
  discoverAssets,
} from './shared.js';

const router: ReturnType<typeof Router> = Router();

router.get('/projects/:projectId/assets', (req, res) => {
  discoverAssets(req.params.projectId);
  const data = getDb().prepare('SELECT * FROM asset_files WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  res.json({ ok: true, data });
});

router.post('/projects/:projectId/assets', (req, res) => {
  const { name, mimeType, data } = req.body;
  if (!name || !data) return res.status(400).json({ ok: false, error: { status: 400, message: 'name and data are required', code: 'VALIDATION_ERROR' } });
  const buffer   = Buffer.from(data, 'base64');
  const ext      = extname(name).toLowerCase() || '.bin';
  const sub      = assetSubfolder(ext);
  const assetDir = join(UPLOADS_DIR, req.params.projectId, sub);
  const filename = allocateFilename(assetDir, name);
  const storedPath = `/uploads/${req.params.projectId}/${sub}/${filename}`;
  writeFileSync(join(assetDir, filename), buffer);
  const id = randomUUID();
  getDb().prepare('INSERT INTO asset_files (id, project_id, original_name, stored_path, mime_type, size, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.params.projectId, name, storedPath, mimeType ?? 'application/octet-stream', buffer.length, '');
  res.status(201).json({ ok: true, data: { id, project_id: req.params.projectId, original_name: name, stored_path: storedPath, mime_type: mimeType, size: buffer.length } });
});

router.delete('/assets/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT stored_path FROM asset_files WHERE id = ?').get(req.params.id) as { stored_path: string } | undefined;
  if (row?.stored_path) {
    try { unlinkSync(join(process.cwd(), row.stored_path)); } catch { /* file may not exist */ }
  }
  db.prepare('DELETE FROM asset_files WHERE id = ?').run(req.params.id);
  res.json({ ok: true, data: {} });
});

export default router;
