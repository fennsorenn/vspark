import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import {
  UPLOADS_DIR,
  SUBFOLDER_BY_EXT,
  MIME_BY_EXT,
  allocateFilename,
} from '../routes/shared.js';

export function hashFile(absPath: string): string {
  try {
    const data = readFileSync(absPath);
    return createHash('sha256').update(data).digest('hex');
  } catch {
    return '';
  }
}

export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function resolveAbsPath(storedPath: string): string {
  if (storedPath.startsWith('/uploads/')) {
    return join(UPLOADS_DIR, '..', storedPath);
  }
  return storedPath;
}

export function fileToBase64(absPath: string): string | null {
  try {
    return readFileSync(absPath).toString('base64');
  } catch {
    return null;
  }
}

export interface ResolvedAsset {
  assetFileId: string | null;
  storedPath: string | null;
  absPath: string | null;
}

export function matchAssetByHash(
  projectId: string,
  sha256: string
): ResolvedAsset | null {
  if (!sha256) return null;
  const db = getDb();
  const row = db
    .prepare(
      'SELECT id, stored_path FROM asset_files WHERE project_id = ? AND hash = ? LIMIT 1'
    )
    .get(projectId, sha256) as { id: string; stored_path: string } | undefined;
  if (!row) return null;
  return {
    assetFileId: row.id,
    storedPath: row.stored_path,
    absPath: resolveAbsPath(row.stored_path),
  };
}

export function materializeAsset(
  projectId: string,
  name: string,
  mime: string,
  dataBase64: string
): { assetFileId: string; storedPath: string } {
  const buf = Buffer.from(dataBase64, 'base64');
  const sha256 = hashBuffer(buf);

  const existing = matchAssetByHash(projectId, sha256);
  if (existing?.assetFileId)
    return {
      assetFileId: existing.assetFileId,
      storedPath: existing.storedPath!,
    };

  const ext = extname(name).toLowerCase() || '.bin';
  const sub = SUBFOLDER_BY_EXT[ext] ?? 'other';
  const dir = join(UPLOADS_DIR, projectId, sub);
  mkdirSync(dir, { recursive: true });
  const filename = allocateFilename(dir, name);
  const absPath = join(dir, filename);
  writeFileSync(absPath, buf);

  const storedPath = `/uploads/${projectId}/${sub}/${filename}`;
  const assetFileId = randomUUID();
  getDb()
    .prepare(
      'INSERT INTO asset_files (id, project_id, original_name, stored_path, mime_type, size, hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      assetFileId,
      projectId,
      name,
      storedPath,
      mime || MIME_BY_EXT[ext] || 'application/octet-stream',
      buf.length,
      sha256
    );

  return { assetFileId, storedPath };
}
