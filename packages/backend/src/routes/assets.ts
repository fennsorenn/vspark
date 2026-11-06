import { Router } from 'express';
import { randomUUID, createHash } from 'crypto';
import { writeFileSync, unlinkSync, mkdirSync, statSync, existsSync } from 'fs';
import { join, extname, dirname, basename } from 'path';
import { getDb } from '../db/index.js';
import { extractVrmMetadata } from '../vrm/metadata.js';
import {
  checkLive2dBundle,
  isLive2dBundleBlocked,
  type Live2dBundleReport,
} from '@vspark/shared/live2d';
import {
  UPLOADS_DIR,
  allocateFilename,
  assetSubfolder,
  discoverAssets,
  sanitizeStem,
  isLive2dManifest,
  isSafeRelPath,
  LIVE2D_SUBFOLDER,
  LIVE2D_MODEL_MIME,
} from './shared.js';

function badReq(message: string) {
  return {
    ok: false as const,
    error: { status: 400, message, code: 'VALIDATION_ERROR' },
  };
}

/** How many missing paths to name inline before the message says "and N more". */
const MAX_LISTED = 5;

/**
 * A bundle whose manifest references files the upload does not contain, or
 * whose manifest is itself malformed. Carries the full report as `details` so
 * the UI can list what to supply — the message alone can't, and a bundle that
 * uploads "successfully" and then renders nothing is the failure this check
 * exists to replace.
 */
function incompleteBundle(report: Live2dBundleReport) {
  const message = report.errors.length
    ? `invalid ${report.manifest}: ${report.errors.join('; ')}`
    : (() => {
        const paths = report.missingRequired.map((r) => r.relPath);
        const shown = paths.slice(0, MAX_LISTED).join(', ');
        const rest = paths.length - MAX_LISTED;
        return `bundle is missing ${paths.length} required file(s) referenced by ${report.manifest}: ${shown}${rest > 0 ? `, and ${rest} more` : ''}`;
      })();
  return {
    ok: false as const,
    error: {
      status: 400,
      message,
      code: 'LIVE2D_BUNDLE_INCOMPLETE',
      details: report,
    },
  };
}

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
  const absPath = join(assetDir, filename);
  writeFileSync(absPath, buffer);
  const id = randomUUID();
  // Store the content hash so presets can re-link this file by hash on
  // instantiate (without it, non-embedded presets lose the model/animation).
  const hash = createHash('sha256').update(buffer).digest('hex');
  // Pre-extract VRM/GLB metadata (bones/materials/blendshapes/expressions) so
  // the frontend can populate UI lists without loading the model in the
  // viewport. Non-model files / non-GLB just store null. (See vrm/metadata.ts.)
  const meta = ext === '.vrm' || ext === '.glb' || ext === '.gltf'
    ? extractVrmMetadata(absPath)
    : null;
  const mtime = statSync(absPath).mtimeMs.toString();
  getDb()
    .prepare(
      'INSERT INTO asset_files (id, project_id, original_name, stored_path, mime_type, size, hash, metadata, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      req.params.projectId,
      name,
      storedPath,
      mimeType ?? 'application/octet-stream',
      buffer.length,
      hash,
      meta ? JSON.stringify(meta) : null,
      mtime
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
 * /api/projects/{projectId}/assets/bundle:
 *   post:
 *     tags: [assets]
 *     summary: Upload a multi-file asset bundle (e.g. a Live2D model) preserving its layout
 *     description: |
 *       Files are written under uploads/{projectId}/live2d/{model}/… keeping their
 *       relative paths so the manifest's relative references resolve when served
 *       statically. One asset row is registered, pointing at the *.model3.json manifest.
 *
 *       The manifest's FileReferences are resolved against the uploaded file set
 *       before anything is written. Missing `Moc`/`Textures` are load-blocking and
 *       reject the upload with `LIVE2D_BUNDLE_INCOMPLETE`, whose `error.details`
 *       carries the full report (`missingRequired`, `missingOptional`, `errors`).
 *       Missing motions/expressions/physics still render, so the upload succeeds
 *       and the report's `missingOptional` is returned alongside the asset row.
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateAssetBundle' }
 *     responses:
 *       201: { description: "Bundle stored; manifest registered in the DB. `data.missingOptional` lists non-blocking references with no file." }
 *       400: { description: "Invalid, incomplete, or ambiguous bundle (`VALIDATION_ERROR`, `LIVE2D_BUNDLE_INCOMPLETE`, `LIVE2D_MULTIPLE_MANIFESTS`)", content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/projects/:projectId/assets/bundle', (req, res) => {
  const { rootName, kind, files } = req.body ?? {};
  if (kind !== 'live2d')
    return res.status(400).json(badReq('only live2d bundles are supported'));
  if (
    typeof rootName !== 'string' ||
    !rootName ||
    !Array.isArray(files) ||
    files.length === 0
  )
    return res.status(400).json(badReq('rootName and a non-empty files[] are required'));

  for (const f of files) {
    if (typeof f?.relPath !== 'string' || typeof f?.data !== 'string')
      return res.status(400).json(badReq('each file needs string relPath + data'));
    if (!isSafeRelPath(f.relPath))
      return res.status(400).json(badReq(`unsafe relPath: ${f.relPath}`));
  }
  const manifests = files.filter((f: { relPath: string }) =>
    isLive2dManifest(f.relPath)
  );
  if (manifests.length === 0)
    return res
      .status(400)
      .json(badReq('bundle must contain a *.model3.json manifest'));
  // One bundle directory registers exactly one manifest as its asset row, so an
  // archive holding several models is ambiguous. Silently taking the first would
  // store the others as dead weight and register a model the user didn't pick.
  if (manifests.length > 1)
    return res.status(400).json({
      ok: false as const,
      error: {
        status: 400,
        message: `bundle contains ${manifests.length} model manifests; upload one model at a time: ${manifests
          .map((f: { relPath: string }) => f.relPath)
          .join(', ')}`,
        code: 'LIVE2D_MULTIPLE_MANIFESTS',
        details: {
          manifests: manifests.map((f: { relPath: string }) => f.relPath),
        },
      },
    });
  const manifestEntry = manifests[0];

  // Check the manifest's FileReferences against what actually arrived, BEFORE
  // writing anything: a bundle missing its moc3 or a texture cannot render, and
  // storing it would just recreate the silent-blank-model failure on disk.
  const report = checkLive2dBundle(
    manifestEntry.relPath,
    Buffer.from(manifestEntry.data, 'base64').toString('utf8'),
    files.map((f: { relPath: string }) => f.relPath)
  );
  if (isLive2dBundleBlocked(report))
    return res.status(400).json(incompleteBundle(report));

  // Allocate a non-colliding bundle directory under live2d/.
  const stem = sanitizeStem(rootName) || 'model';
  const live2dDir = join(UPLOADS_DIR, req.params.projectId, LIVE2D_SUBFOLDER);
  mkdirSync(live2dDir, { recursive: true });
  let dirName = stem;
  let n = 2;
  while (existsSync(join(live2dDir, dirName))) dirName = `${stem}_${n++}`;
  const bundleDir = join(live2dDir, dirName);

  // Write every file, preserving its relative layout. Total size = sum of bytes.
  let totalSize = 0;
  for (const f of files) {
    const buf = Buffer.from(f.data, 'base64');
    const dest = join(bundleDir, f.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    totalSize += buf.length;
  }

  const manifestRel: string = manifestEntry.relPath;
  const storedPath = `/uploads/${req.params.projectId}/${LIVE2D_SUBFOLDER}/${dirName}/${manifestRel}`;
  const id = randomUUID();
  const hash = createHash('sha256')
    .update(Buffer.from(manifestEntry.data, 'base64'))
    .digest('hex');
  getDb()
    .prepare(
      'INSERT INTO asset_files (id, project_id, original_name, stored_path, mime_type, size, hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      req.params.projectId,
      basename(manifestRel),
      storedPath,
      LIVE2D_MODEL_MIME,
      totalSize,
      hash
    );
  res.status(201).json({
    ok: true,
    data: {
      id,
      project_id: req.params.projectId,
      original_name: basename(manifestRel),
      stored_path: storedPath,
      mime_type: LIVE2D_MODEL_MIME,
      size: totalSize,
      // The model renders, but these manifest references had no file — motions,
      // expressions, physics. Attached so the UI can say so instead of leaving
      // the user to discover a puppet that never moves.
      missingOptional: report.missingOptional,
    },
  });
});

/**
 * @openapi
 * /api/assets/{id}:
 *   get:
 *     tags: [assets]
 *     summary: Fetch a single asset's metadata row by id
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The asset row }
 *       404: { description: Asset not found }
 */
router.get('/assets/:id', (req, res) => {
  const row = getDb()
    .prepare('SELECT * FROM asset_files WHERE id = ?')
    .get(req.params.id);
  if (!row)
    return res.status(404).json({
      ok: false,
      error: { status: 404, message: 'asset not found', code: 'NOT_FOUND' },
    });
  res.json({ ok: true, data: row });
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
