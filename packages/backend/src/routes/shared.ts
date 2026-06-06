import { randomUUID, createHash } from 'crypto';
import { mkdirSync, readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, extname, basename } from 'path';
import { getDb } from '../db/index.js';
import type { VmcManager } from '../behaviors/vmc_receiver/manager.js';
import type { BreathingManager } from '../behaviors/breathing/manager.js';
import type { LipsyncManager } from '../behaviors/lipsync/manager.js';
import type { TrackingManager } from '../behaviors/mediapipe_tracker/manager.js';
import type { ApiControllerManager } from '../behaviors/api_controller/manager.js';
import type { WSSync } from '../ws/index.js';
import type { TrackClipPlaybackManager } from '../track_clips/playback.js';

// --- Manager singletons + setters ---

export let _vmc: VmcManager | null = null;
export function setVmcManager(m: VmcManager) {
  _vmc = m;
}

export let _breathing: BreathingManager | null = null;
export function setBreathingManager(m: BreathingManager) {
  _breathing = m;
}

export let _lipsync: LipsyncManager | null = null;
export function setLipsyncManager(m: LipsyncManager) {
  _lipsync = m;
}

export let _tracking: TrackingManager | null = null;
export function setTrackingManager(m: TrackingManager) {
  _tracking = m;
}

export let _apiController: ApiControllerManager | null = null;
export function setApiControllerManager(m: ApiControllerManager) {
  _apiController = m;
}

export let _ws: WSSync | null = null;
export function setWsSync(w: WSSync) {
  _ws = w;
}

export let _trackClipPlayback: TrackClipPlaybackManager | null = null;
export function setTrackClipPlaybackManager(m: TrackClipPlaybackManager) {
  _trackClipPlayback = m;
}

// --- Component row mapping + refresh helpers ---

export function _mapBehaviorRow(r: Record<string, unknown>) {
  return {
    id: r.id as string,
    nodeId: r.node_id as string,
    kind: r.kind as string,
    enabled: (r.enabled as number) === 1,
    config: JSON.parse((r.config as string) || '{}'),
  };
}

export function refreshVmc() {
  if (!_vmc) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'vmc_receiver'")
    .all() as Record<string, unknown>[];
  _vmc.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshBreathing() {
  if (!_breathing) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'breathing'")
    .all() as Record<string, unknown>[];
  _breathing.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshLipsync() {
  if (!_lipsync) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'lipsync_processor'")
    .all() as Record<string, unknown>[];
  _lipsync.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshTracking() {
  if (!_tracking) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'mediapipe_tracker'")
    .all() as Record<string, unknown>[];
  _tracking.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshApiController() {
  if (!_apiController) return;
  const rows = getDb()
    .prepare("SELECT * FROM behaviors WHERE kind = 'api_controller'")
    .all() as Record<string, unknown>[];
  _apiController.syncBehaviors(rows.map(_mapBehaviorRow));
}

export function refreshAllBehaviorManagers() {
  refreshVmc();
  refreshBreathing();
  refreshLipsync();
  refreshTracking();
  refreshApiController();
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
          'INSERT INTO asset_files (id, project_id, original_name, stored_path, mime_type, size, hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          randomUUID(),
          projectId,
          file,
          storedPath,
          MIME_BY_EXT[ext] ?? 'application/octet-stream',
          stat.size,
          sha256File(absPath)
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
