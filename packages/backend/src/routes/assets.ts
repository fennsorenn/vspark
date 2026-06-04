import { Router } from 'express';
import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, extname } from 'path';
import { getDb } from '../db/index.js';
import {
  UPLOADS_DIR,
  allocateFilename,
  assetSubfolder,
  discoverAssets,
} from './shared.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/projects/{projectId}/assets:
 *   get:
 *     tags: [assets]
 *     summary: List assets for a project (auto-discovers files dropped into uploads/ on disk)
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of asset_file rows, newest first }
 */
router.get('/projects/:projectId/assets', (req, res) => {
  discoverAssets(req.params.projectId);
  const data = getDb()
    .prepare(
      'SELECT * FROM asset_files WHERE project_id = ? ORDER BY created_at DESC'
    )
    .all(req.params.projectId);
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/projects/{projectId}/assets:
 *   post:
 *     tags: [assets]
 *     summary: Upload an asset (base64-encoded) into the project's uploads subfolder
 *     description: |
 *       The asset is filed into a subfolder by extension (avatars/, animations/, images/, other/).
 *       Filename collisions get a numeric suffix.
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateAsset' }
 *     responses:
 *       201: { description: Asset stored and registered in the DB }
 *       400: { description: Missing name or data, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/projects/:projectId/assets', (req, res) => {
  const { name, mimeType, data } = req.body;
  if (!name || !data)
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'name and data are required',
        code: 'VALIDATION_ERROR',
      },
    });
  const buffer = Buffer.from(data, 'base64');
  const ext = extname(name).toLowerCase() || '.bin';
  const sub = assetSubfolder(ext);
  const assetDir = join(UPLOADS_DIR, req.params.projectId, sub);
  const filename = allocateFilename(assetDir, name);
  const storedPath = `/uploads/${req.params.projectId}/${sub}/${filename}`;
  writeFileSync(join(assetDir, filename), buffer);
  const id = randomUUID();
  getDb()
    .prepare(
      'INSERT INTO asset_files (id, project_id, original_name, stored_path, mime_type, size, hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      req.params.projectId,
      name,
      storedPath,
      mimeType ?? 'application/octet-stream',
      buffer.length,
      ''
    );
  res.status(201).json({
    ok: true,
    data: {
      id,
      project_id: req.params.projectId,
      original_name: name,
      stored_path: storedPath,
      mime_type: mimeType,
      size: buffer.length,
    },
  });
});

/**
 * @openapi
 * /api/assets/{id}/thumbnail:
 *   put:
 *     tags: [assets]
 *     summary: Store a generated preview thumbnail (base64 PNG) for an asset
 *     description: |
 *       Thumbnails are generated client-side (WebGL) and persisted here so they
 *       only need to be rendered once. Served back as a static file at
 *       /uploads/{projectId}/thumbnails/{id}.png.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Stored; returns the thumbnail url }
 *       404: { description: Asset not found }
 */
router.put('/assets/:id/thumbnail', (req, res) => {
  const { data } = req.body ?? {};
  if (!data)
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'data (base64 png) is required',
        code: 'VALIDATION_ERROR',
      },
    });
  const row = getDb()
    .prepare('SELECT project_id FROM asset_files WHERE id = ?')
    .get(req.params.id) as { project_id: string } | undefined;
  if (!row)
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'asset not found', code: 'NOT_FOUND' },
    });
  const dir = join(UPLOADS_DIR, row.project_id, 'thumbnails');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${req.params.id}.png`), Buffer.from(data, 'base64'));
  res.json({
    ok: true,
    data: { url: `/uploads/${row.project_id}/thumbnails/${req.params.id}.png` },
  });
});

/**
 * @openapi
 * /api/assets/{id}:
 *   delete:
 *     tags: [assets]
 *     summary: Delete an asset row and unlink its underlying file from disk (best-effort)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted, content: { application/json: { schema: { $ref: '#/components/schemas/EmptyOk' } } } }
 */
router.delete('/assets/:id', (req, res) => {
  const db = getDb();
  const row = db
    .prepare('SELECT stored_path, project_id FROM asset_files WHERE id = ?')
    .get(req.params.id) as
    | { stored_path: string; project_id: string }
    | undefined;
  if (row?.stored_path) {
    try {
      unlinkSync(join(process.cwd(), row.stored_path));
    } catch {
      /* file may not exist */
    }
  }
  if (row?.project_id) {
    try {
      unlinkSync(
        join(UPLOADS_DIR, row.project_id, 'thumbnails', `${req.params.id}.png`)
      );
    } catch {
      /* no cached thumbnail */
    }
  }
  db.prepare('DELETE FROM asset_files WHERE id = ?').run(req.params.id);
  res.json({ ok: true, data: {} });
});

export default router;
