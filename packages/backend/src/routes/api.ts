import { Router } from 'express';
import { getDb } from '../db/index.js';
import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import { networkInterfaces } from 'os';
import type { VmcManager } from '../vmc/manager.js';
import { getAllNodeKindMeta } from '../signal/registry.js';

let _vmc: VmcManager | null = null;
export function setVmcManager(m: VmcManager) { _vmc = m; }

import type { WSSync } from '../ws/index.js';
let _ws: WSSync | null = null;
export function setWsSync(w: WSSync) { _ws = w; }

function refreshVmc() {
  if (!_vmc) return;
  const rows = getDb().prepare("SELECT * FROM node_components WHERE kind = 'vmc_receiver'").all() as Record<string, unknown>[];
  _vmc.syncComponents(rows.map((r) => ({
    id:      r.id as string,
    nodeId:  r.node_id as string,
    kind:    r.kind as string,
    enabled: (r.enabled as number) === 1,
    config:  JSON.parse((r.config as string) || '{}'),
  })));
}

const UPLOADS_DIR = join(process.cwd(), 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

// Extension → subfolder name
const SUBFOLDER_BY_EXT: Record<string, string> = {
  '.vrm': 'avatars', '.glb': 'avatars', '.gltf': 'avatars',
  '.fbx': 'animations', '.bvh': 'animations',
}
// Extension → MIME type (used when registering manually dropped files)
const MIME_BY_EXT: Record<string, string> = {
  '.vrm': 'model/gltf-binary', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream', '.bvh': 'text/plain',
}

function assetSubfolder(ext: string): string {
  return SUBFOLDER_BY_EXT[ext.toLowerCase()] ?? 'other'
}

/** Sanitize originalName → safe filename stem (no path traversal, no spaces). */
function sanitizeStem(originalName: string): string {
  const stem = basename(originalName, extname(originalName))
  return stem.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '') || 'file'
}

/**
 * Find a non-colliding filename in dir for the given originalName.
 * Returns just the filename (not a full path). Creates dir if needed.
 */
function allocateFilename(dir: string, originalName: string): string {
  mkdirSync(dir, { recursive: true })
  const ext  = extname(originalName).toLowerCase() || '.bin'
  const stem = sanitizeStem(originalName)
  let candidate = `${stem}${ext}`
  let n = 2
  while (existsSync(join(dir, candidate))) {
    candidate = `${stem}_${n}${ext}`
    n++
  }
  return candidate
}

/**
 * Scan uploads/<projectId>/ for files not yet registered in the DB and insert them.
 * Handles any subfolder found on disk, not just the known ones.
 */
function discoverAssets(projectId: string): void {
  const projectDir = join(UPLOADS_DIR, projectId)
  if (!existsSync(projectDir)) return
  const db = getDb()
  const existing = new Set<string>(
    (db.prepare('SELECT stored_path FROM asset_files WHERE project_id = ?').all(projectId) as { stored_path: string }[])
      .map(r => r.stored_path)
  )
  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const subDir = join(projectDir, entry.name)
    for (const file of readdirSync(subDir)) {
      const storedPath = `/uploads/${projectId}/${entry.name}/${file}`
      if (existing.has(storedPath)) continue
      try {
        const stat = statSync(join(subDir, file))
        if (!stat.isFile()) continue
        const ext = extname(file).toLowerCase()
        db.prepare('INSERT INTO asset_files (id, project_id, original_name, stored_path, mime_type, size, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), projectId, file, storedPath, MIME_BY_EXT[ext] ?? 'application/octet-stream', stat.size, '')
      } catch { /* skip unreadable */ }
    }
  }
}

const router: ReturnType<typeof Router> = Router();

// --- Projects ---

router.get('/projects', (_req, res) => {
  const data = getDb().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
  res.json({ ok: true, data });
});

router.post('/projects', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: { status: 400, message: 'name is required', code: 'VALIDATION_ERROR' } });
  const id = randomUUID();
  getDb().prepare('INSERT INTO projects (id, name, description) VALUES (?, ?, ?)').run(id, name, description ?? null);
  res.status(201).json({ ok: true, data: { id, name, description } });
});

router.put('/projects/:id', (req, res) => {
  const { name, description } = req.body;
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ ok: false, error: { status: 404, message: 'not found', code: 'NOT_FOUND' } });
  }
  db.prepare(`UPDATE projects SET name = COALESCE(?, name), description = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name ?? null, description ?? null, req.params.id);
  res.json({ ok: true, data: { id: req.params.id } });
});

router.delete('/projects/:id', (req, res) => {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true, data: {} });
});

// --- Scenes ---

router.get('/projects/:projectId/scenes', (req, res) => {
  const db = getDb();
  const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ?').all(req.params.projectId);
  const nodes: unknown[] = [];
  const nodeComponents: unknown[] = [];
  for (const s of scenes as { id: string }[]) {
    const sceneNodes = db.prepare('SELECT * FROM scene_nodes WHERE scene_id = ?').all(s.id);
    nodes.push(...sceneNodes);
    for (const n of sceneNodes as { id: string }[]) {
      const comps = db.prepare('SELECT * FROM node_components WHERE node_id = ? ORDER BY sort_order').all(n.id);
      nodeComponents.push(...comps);
    }
  }
  res.json({ ok: true, data: { scenes, nodes, nodeComponents } });
});

router.post('/projects/:projectId/scenes', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: { status: 400, message: 'name is required', code: 'VALIDATION_ERROR' } });
  const id = randomUUID();
  getDb().prepare('INSERT INTO scenes (id, project_id, name) VALUES (?, ?, ?)').run(id, req.params.projectId, name);
  res.status(201).json({ ok: true, data: { id, name } });
});

// --- Scene Nodes ---

router.get('/scenes/:sceneId/nodes', (req, res) => {
  const data = getDb().prepare('SELECT * FROM scene_nodes WHERE scene_id = ?').all(req.params.sceneId);
  res.json({ ok: true, data });
});

router.post('/scenes/:sceneId/nodes', (req, res) => {
  const { name, parentId, kind, filePath, components } = req.body;
  if (!name || !kind) return res.status(400).json({ ok: false, error: { status: 400, message: 'name and kind are required', code: 'VALIDATION_ERROR' } });
  const id = randomUUID();
  const sceneId = req.params.sceneId;
  getDb().prepare('INSERT INTO scene_nodes (id, scene_id, parent_id, name, kind, file_path, components) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, sceneId, parentId ?? null, name, kind, filePath ?? null, JSON.stringify(components ?? {}));
  const node = { id, sceneId, name, kind, parentId: parentId ?? null, filePath: filePath ?? null, components: components ?? {} };
  _ws?.broadcast('node_added', node);
  res.status(201).json({ ok: true, data: node });
});

router.put('/scene-nodes/:id', (req, res) => {
  const { name, parentId, kind, filePath, components } = req.body;
  getDb().prepare(`UPDATE scene_nodes SET
      name = COALESCE(?, name),
      parent_id = COALESCE(?, parent_id),
      kind = COALESCE(?, kind),
      file_path = COALESCE(?, file_path),
      components = COALESCE(?, components),
      updated_at = datetime('now')
    WHERE id = ?`)
    .run(name ?? null, parentId ?? null, kind ?? null, filePath ?? null,
      components != null ? JSON.stringify(components) : null, req.params.id);

  // Broadcast to all other connected clients (viewer pages, etc.)
  const patch: Record<string, unknown> = { id: req.params.id };
  if (name      != null) patch.name       = name;
  if (parentId  != null) patch.parentId   = parentId;
  if (kind      != null) patch.kind       = kind;
  if (filePath  != null) patch.filePath   = filePath;
  if (components != null) patch.components = components;
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
  const id = randomUUID();
  getDb().prepare('INSERT INTO animation_clips (id, name, source_node_id, source_file_path, clip_index, label, start_time, end_time, duration, fps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, req.params.nodeId, sourceFilePath, clipIndex ?? 0, label ?? name, startTime ?? 0, endTime ?? duration, duration, fps ?? 30);
  res.status(201).json({ ok: true, data: { id, name } });
});

// --- Assets ---

router.get('/projects/:projectId/assets', (req, res) => {
  discoverAssets(req.params.projectId);
  const data = getDb().prepare('SELECT * FROM asset_files WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  res.json({ ok: true, data });
});

router.post('/projects/:projectId/assets', (req, res) => {
  const { name, mimeType, data } = req.body;
  if (!name || !data) return res.status(400).json({ ok: false, error: { status: 400, message: 'name and data are required', code: 'VALIDATION_ERROR' } });
  const buffer   = Buffer.from(data, 'base64');
  const ext      = extname(name).toLowerCase() || '.bin'
  const sub      = assetSubfolder(ext)
  const assetDir = join(UPLOADS_DIR, req.params.projectId, sub)
  const filename = allocateFilename(assetDir, name)
  const storedPath = `/uploads/${req.params.projectId}/${sub}/${filename}`
  writeFileSync(join(assetDir, filename), buffer)
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

// --- Node Components ---

router.get('/scene-nodes/:nodeId/components', (req, res) => {
  const data = getDb().prepare('SELECT * FROM node_components WHERE node_id = ? ORDER BY sort_order').all(req.params.nodeId);
  res.json({ ok: true, data });
});

router.post('/scene-nodes/:nodeId/components', (req, res) => {
  const { id, kind, enabled, config, sortOrder } = req.body;
  if (!kind) return res.status(400).json({ ok: false, error: { message: 'kind is required' } });
  const compId = id ?? randomUUID();
  getDb().prepare('INSERT INTO node_components (id, node_id, kind, enabled, config, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(compId, req.params.nodeId, kind, enabled ? 1 : 0, JSON.stringify(config ?? {}), sortOrder ?? 0);
  refreshVmc();
  res.status(201).json({ ok: true, data: { id: compId, node_id: req.params.nodeId, kind, enabled: enabled ?? true, config: config ?? {}, sort_order: sortOrder ?? 0 } });
});

router.put('/node-components/:id', (req, res) => {
  const { enabled, config } = req.body;
  getDb().prepare(`UPDATE node_components SET
      enabled = COALESCE(?, enabled),
      config  = COALESCE(?, config),
      updated_at = datetime('now')
    WHERE id = ?`)
    .run(enabled != null ? (enabled ? 1 : 0) : null, config != null ? JSON.stringify(config) : null, req.params.id);
  refreshVmc();
  res.json({ ok: true, data: { id: req.params.id } });
});

router.delete('/node-components/:id', (req, res) => {
  getDb().prepare('DELETE FROM node_components WHERE id = ?').run(req.params.id);
  refreshVmc();
  res.json({ ok: true, data: {} });
});

// Returns the uncalibrated NormalizedPose currently at the body_calibration
// node's input for this VMC receiver component.  The client uses this to
// populate bodyOffsets without needing to read raw VMC data itself.
router.get('/node-components/:id/body-calib-state', (req, res) => {
  if (!_vmc) return res.status(503).json({ ok: false, error: { status: 503, message: 'VMC manager not ready', code: 'NOT_READY' } });
  const pose = _vmc.peekBodyCalibInput(req.params.id);
  if (!pose) return res.status(404).json({ ok: false, error: { status: 404, message: 'No active receiver or no data yet', code: 'NOT_FOUND' } });
  res.json({ ok: true, data: { bones: pose.toRecord() } });
});

// --- Signal graph ---

// All active graph descriptors (implicit + future explicit).
router.get('/signal/graphs', (_req, res) => {
  const implicit = _vmc?.getAllGraphDescriptors() ?? [];
  res.json({ ok: true, data: implicit });
});

// Single graph descriptor by id.
router.get('/signal/graphs/:id', (req, res) => {
  const all = _vmc?.getAllGraphDescriptors() ?? [];
  const graph = all.find((g) => g.id === req.params.id);
  if (!graph) return res.status(404).json({ ok: false, error: { status: 404, message: 'not found', code: 'NOT_FOUND' } });
  res.json({ ok: true, data: graph });
});

// Live node states for a graph — polled by the canvas for monitoring.
// Graph IDs are formatted as `vmc-pipeline:<componentId>`.
router.get('/signal/graphs/:id/node-states', (req, res) => {
  const graphId = req.params.id;
  const componentId = graphId.startsWith('vmc-pipeline:') ? graphId.slice('vmc-pipeline:'.length) : graphId;
  const states = _vmc?.getStates(componentId);
  if (!states) return res.status(404).json({ ok: false, error: { status: 404, message: 'not found', code: 'NOT_FOUND' } });
  res.json({ ok: true, data: states });
});

// Fire a trigger event into a specific node port.
// Body: { nodeId: string, port: string }
// Graph IDs formatted as `vmc-pipeline:<componentId>`.
router.post('/signal/graphs/:id/fire', (req, res) => {
  const graphId = req.params.id;
  const componentId = graphId.startsWith('vmc-pipeline:') ? graphId.slice('vmc-pipeline:'.length) : graphId;
  const { nodeId, port } = req.body as { nodeId?: string; port?: string };
  if (!nodeId || !port) {
    return res.status(400).json({ ok: false, error: { status: 400, message: 'nodeId and port are required', code: 'VALIDATION_ERROR' } });
  }
  if (!_vmc) return res.status(503).json({ ok: false, error: { status: 503, message: 'VMC manager not ready', code: 'NOT_READY' } });
  _vmc.fireGraphEvent(componentId, nodeId, port);
  res.json({ ok: true });
});

// All registered node kinds with display metadata (drives the node palette).
router.get('/signal/node-kinds', (_req, res) => {
  res.json({ ok: true, data: getAllNodeKindMeta() });
});

// --- System ---

router.get('/system/local-ips', (_req, res) => {
  const ifaces = networkInterfaces();
  const ips: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' || (addr.family as unknown) === 4) ips.push(addr.address);
    }
  }
  res.json({ ok: true, data: { ips } });
});

export { router as apiRoutes };
