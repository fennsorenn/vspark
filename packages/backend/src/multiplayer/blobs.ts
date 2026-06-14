/**
 * Content-addressed asset resolution + receiver-side blob cache (asset-transfer
 * slice). Assets are immutable blobs identified by sha256. The owner resolves a
 * hash to its local file; the receiver caches fetched blobs under
 * `uploads/_shared/<hash><ext>` — served by the existing `/uploads` static mount
 * and shared across the receiver's tabs/reloads, content-addressed so identical
 * assets transfer once. See dev-notes/plans/live-mesh.md (asset transfer).
 */
import { join } from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'fs';
import { getDb } from '../db/index.js';

const UPLOADS_DIR = join(process.cwd(), 'uploads');
const SHARED_DIR = join(UPLOADS_DIR, '_shared');

export interface AssetMeta {
  hash: string;
  ext: string;
  mime: string;
  size: number;
}

/** Trailing extension (with dot) of a path, '' if none. */
export function extOf(filePath: string): string {
  const m = /\.[a-z0-9]+$/i.exec(filePath);
  return m ? m[0] : '';
}

/** Owner side: resolve an asset hash to an on-disk file + metadata. */
export function resolveByHash(
  hash: string
): { absPath: string; meta: AssetMeta } | null {
  const row = getDb()
    .prepare(
      'SELECT stored_path, mime_type, size FROM asset_files WHERE hash = ? LIMIT 1'
    )
    .get(hash) as
    | { stored_path: string; mime_type: string; size: number }
    | undefined;
  if (!row?.stored_path) return null;
  const absPath = join(process.cwd(), row.stored_path);
  if (!existsSync(absPath)) return null;
  return {
    absPath,
    meta: {
      hash,
      ext: extOf(row.stored_path),
      mime: row.mime_type,
      size: row.size,
    },
  };
}

/** Look up the asset metadata for an owner file path (for snapshot/forwarding). */
export function assetForPath(filePath: string): AssetMeta | null {
  const row = getDb()
    .prepare(
      'SELECT hash, mime_type, size FROM asset_files WHERE stored_path = ? LIMIT 1'
    )
    .get(filePath) as
    | { hash: string; mime_type: string; size: number }
    | undefined;
  if (!row?.hash) return null;
  return { hash: row.hash, ext: extOf(filePath), mime: row.mime_type, size: row.size };
}

/** Receiver side: the cache path + public URL for a hash. */
export function cachedPath(hash: string, ext: string): string {
  return join(SHARED_DIR, `${hash}${ext}`);
}
export function cachedUrl(hash: string, ext: string): string {
  return `/uploads/_shared/${hash}${ext}`;
}
export function hasCached(hash: string, ext: string): boolean {
  return existsSync(cachedPath(hash, ext));
}

/** Read a blob file (owner side). */
export function readBlob(absPath: string): Buffer {
  return readFileSync(absPath);
}

/** Write a fetched blob into the shared cache (receiver side). */
export function writeCached(hash: string, ext: string, data: Buffer): string {
  mkdirSync(SHARED_DIR, { recursive: true });
  const p = cachedPath(hash, ext);
  writeFileSync(p, data);
  return cachedUrl(hash, ext);
}

/** Size of a cached blob, or 0 if absent. */
export function cachedSize(hash: string, ext: string): number {
  const p = cachedPath(hash, ext);
  return existsSync(p) ? statSync(p).size : 0;
}
