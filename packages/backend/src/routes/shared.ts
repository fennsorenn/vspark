import { randomUUID, createHash } from 'crypto';
import { mkdirSync, readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, extname, basename } from 'path';
import { getDb } from '../db/index.js';
import { extractVrmMetadata } from '../vrm/metadata.js';
import type { WSSync } from '../ws/index.js';
// Behavior managers live in behaviors/refresh.ts (the mesh tap needs them and
// cannot import a routes module). Re-exported here so existing importers of
// routes/shared keep working.
export * from '../behaviors/refresh.js';
import { _apiController } from '../behaviors/refresh.js';

export let _ws: WSSync | null = null;
export function setWsSync(w: WSSync) {
  _ws = w;
}

// --- Uploads + asset helpers ---

export const UPLOADS_DIR = join(process.cwd(), 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

// Extension → subfolder name
export const SUBFOLDER_BY_EXT: Record<string, string> = {
  '.vrm': 'avatars',
  '.glb': 'avatars',
  '.gltf': 'avatars',
  '.fbx': 'animations',
  '.bvh': 'animations',
  '.jpg': 'images',
  '.jpeg': 'images',
  '.png': 'images',
  '.webp': 'images',
  '.gif': 'images',
  '.avif': 'images',
  '.mp4': 'videos',
  '.webm': 'videos',
  '.mov': 'videos',
  '.m4v': 'videos',
  '.ogv': 'videos',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
};
// Extension → MIME type (used when registering manually dropped files)
export const MIME_BY_EXT: Record<string, string> = {
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.bvh': 'text/plain',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

export function assetSubfolder(ext: string): string {
  return SUBFOLDER_BY_EXT[ext.toLowerCase()] ?? 'other';
}

/** Sanitize originalName → safe filename stem (no path traversal, no spaces). */
export function sanitizeStem(originalName: string): string {
  const stem = basename(originalName, extname(originalName));
  return (
    stem
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '') || 'file'
  );
}

/**
 * Find a non-colliding filename in dir for the given originalName.
 * Returns just the filename (not a full path). Creates dir if needed.
 */
export function allocateFilename(dir: string, originalName: string): string {
  mkdirSync(dir, { recursive: true });
  const ext = extname(originalName).toLowerCase() || '.bin';
  const stem = sanitizeStem(originalName);
  let candidate = `${stem}${ext}`;
  let n = 2;
  while (existsSync(join(dir, candidate))) {
    candidate = `${stem}_${n}${ext}`;
    n++;
  }
  return candidate;
}

/**
 * Scan uploads/<projectId>/ for files not yet registered in the DB and insert them.
 * Handles any subfolder found on disk, not just the known ones.
 */
/** sha256 of a file on disk, or '' if unreadable. */
function sha256File(absPath: string): string {
  try {
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch {
    return '';
  }
}

/** Model file extensions we pre-extract UI metadata from. */
const MODEL_EXTS = new Set(['.vrm', '.glb', '.gltf']);

/**
 * Extract metadata JSON for a model file, or null for non-model / unparseable
 * files. Returns a JSON string ready to store in asset_files.metadata.
 */
function modelMetadataJson(absPath: string, ext: string): string | null {
  if (!MODEL_EXTS.has(ext)) return null;
  const meta = extractVrmMetadata(absPath);
  return meta ? JSON.stringify(meta) : null;
}

export function discoverAssets(projectId: string): void {
  const projectDir = join(UPLOADS_DIR, projectId);
  if (!existsSync(projectDir)) return;
  const db = getDb();
  const existing = new Set<string>(
    (
      db
        .prepare('SELECT stored_path FROM asset_files WHERE project_id = ?')
        .all(projectId) as { stored_path: string }[]
    ).map((r) => r.stored_path)
  );
  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // `thumbnails/` holds generated asset previews keyed by asset id, not
    // user assets — never register those as asset_files.
    if (entry.name === 'thumbnails') continue;
    const subDir = join(projectDir, entry.name);
    for (const file of readdirSync(subDir)) {
      const storedPath = `/uploads/${projectId}/${entry.name}/${file}`;
      if (existing.has(storedPath)) continue;
      try {
        const absPath = join(subDir, file);
        const stat = statSync(absPath);
        if (!stat.isFile()) continue;
        const ext = extname(file).toLowerCase();
        db.prepare(
          'INSERT INTO asset_files (id, project_id, original_name, stored_path, mime_type, size, hash, metadata, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          randomUUID(),
          projectId,
          file,
          storedPath,
          MIME_BY_EXT[ext] ?? 'application/octet-stream',
          stat.size,
          sha256File(absPath),
          modelMetadataJson(absPath, ext),
          stat.mtimeMs.toString()
        );
      } catch {
        /* skip unreadable */
      }
    }
  }

  // Backfill content hashes for rows that predate hashing (older uploads stored
  // an empty hash). Without this, preset asset re-matching by hash always
  // misses and instantiated nodes lose their model/animation file. Self-heals
  // once: after the update these rows no longer match the empty-hash filter.
  const unhashed = db
    .prepare(
      "SELECT id, stored_path FROM asset_files WHERE project_id = ? AND (hash IS NULL OR hash = '')"
    )
    .all(projectId) as { id: string; stored_path: string }[];
  for (const r of unhashed) {
    const h = sha256File(join(UPLOADS_DIR, '..', r.stored_path));
    if (h)
      db.prepare('UPDATE asset_files SET hash = ? WHERE id = ?').run(h, r.id);
  }

  // Freshness self-heal: re-hash + re-extract metadata for files whose content
  // changed on disk (overwritten in place), and backfill metadata for model
  // rows that predate this column. Cheap gate first: a sha256 only runs when
  // size/mtime drift or the row is missing metadata, so listing stays fast even
  // with large VRMs. Keeping hash current also fixes preset re-linking by hash.
  const rows = db
    .prepare(
      'SELECT id, stored_path, size, hash, metadata, file_mtime FROM asset_files WHERE project_id = ?'
    )
    .all(projectId) as {
    id: string;
    stored_path: string;
    size: number;
    hash: string;
    metadata: string | null;
    file_mtime: string | null;
  }[];
  for (const r of rows) {
    const absPath = join(UPLOADS_DIR, '..', r.stored_path);
    const ext = extname(r.stored_path).toLowerCase();
    let st;
    try {
      st = statSync(absPath);
    } catch {
      continue; // file gone; leave row (deletion is handled elsewhere)
    }
    const mtime = st.mtimeMs.toString();
    const isModel = MODEL_EXTS.has(ext);
    const sizeMtimeUnchanged = st.size === r.size && r.file_mtime === mtime;
    const metadataMissing = isModel && r.metadata === null;
    if (sizeMtimeUnchanged && !metadataMissing) continue;

    const h = sha256File(absPath);
    if (sizeMtimeUnchanged && metadataMissing) {
      // Content is unchanged — only the metadata column needs backfilling.
      db.prepare(
        'UPDATE asset_files SET metadata = ?, file_mtime = ? WHERE id = ?'
      ).run(modelMetadataJson(absPath, ext), mtime, r.id);
      continue;
    }
    // Content (or stat) changed: refresh size/mtime/hash, and re-extract
    // metadata when the hash actually moved (or it was never populated).
    const contentChanged = h !== r.hash;
    db.prepare(
      'UPDATE asset_files SET size = ?, file_mtime = ?, hash = ?' +
        (contentChanged || metadataMissing ? ', metadata = ?' : '') +
        ' WHERE id = ?'
    ).run(
      ...(contentChanged || metadataMissing
        ? [st.size, mtime, h, modelMetadataJson(absPath, ext), r.id]
        : [st.size, mtime, h, r.id])
    );
  }
}

// --- api_controller resolver ---

/** Resolve (projectId, nodeId) → active api_controller component id. 404 if none. */
export function _resolveApiController(
  projectId: string,
  nodeId: string
):
  | { behaviorId: string }
  | { error: { status: number; message: string; code: string } } {
  if (!_apiController)
    return {
      error: {
        status: 503,
        message: 'API controller manager not ready',
        code: 'NOT_READY',
      },
    };
  const row = getDb()
    .prepare(
      `
    SELECT id FROM scene_nodes WHERE id = ? AND project_id = ?
  `
    )
    .get(nodeId, projectId) as { id: string } | undefined;
  if (!row)
    return {
      error: {
        status: 404,
        message: 'node not found in project',
        code: 'NOT_FOUND',
      },
    };
  const found = _apiController.findByNode(nodeId);
  if (!found)
    return {
      error: {
        status: 404,
        message: 'no api_controller component on node',
        code: 'NOT_FOUND',
      },
    };
  return { behaviorId: found.behaviorId };
}
