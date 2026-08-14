/**
 * REST surface for per-project obs-websocket connections (the OBS power tier).
 * CRUD over the `obs_connections` table, a `/test` reconnect trigger, and a
 * live `GetInputList` proxy that feeds the node-editor input picker.
 *
 * Each mutation calls `getObsWsManager().refreshProject()` to reconcile the
 * live connection. See dev-notes/plans/obs-websocket-tier.md.
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { getObsWsManager } from '../obs/ws_manager.js';

const router: ReturnType<typeof Router> = Router();

interface ConnectionRow {
  id: string;
  project_id: string;
  label: string;
  host: string;
  port: number;
  password: string;
  enabled: number;
  status: string;
  status_reason: string | null;
  status_message: string | null;
  created_at: string;
  updated_at: string;
}

function mapConnection(r: ConnectionRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    host: r.host,
    port: r.port,
    password: r.password,
    enabled: r.enabled === 1,
    status: r.status,
    statusReason: r.status_reason,
    statusMessage: r.status_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getRow(id: string): ConnectionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM obs_connections WHERE id = ?')
    .get(id) as ConnectionRow | undefined;
}

/**
 * @openapi
 * /api/projects/{projectId}/obs-connections:
 *   get:
 *     tags: [obs]
 *     summary: List obs-websocket connections for a project
 */
router.get('/projects/:projectId/obs-connections', (req, res) => {
  const rows = getDb()
    .prepare(
      'SELECT * FROM obs_connections WHERE project_id = ? ORDER BY created_at'
    )
    .all(req.params.projectId) as unknown as ConnectionRow[];
  res.json({ ok: true, data: rows.map(mapConnection) });
});

/**
 * @openapi
 * /api/projects/{projectId}/obs-connections:
 *   post:
 *     tags: [obs]
 *     summary: Create an obs-websocket connection (host/port/password)
 */
router.post('/projects/:projectId/obs-connections', (req, res) => {
  const { projectId } = req.params;
  const body = (req.body ?? {}) as {
    label?: string;
    host?: string;
    port?: number;
    password?: string;
    enabled?: boolean;
  };
  const id = randomUUID();
  getDb()
    .prepare(
      'INSERT INTO obs_connections (id, project_id, label, host, port, password, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      projectId,
      body.label ?? 'OBS',
      body.host ?? 'localhost',
      body.port ?? 4455,
      body.password ?? '',
      body.enabled === false ? 0 : 1
    );
  getObsWsManager().refreshProject(projectId);
  res.json({ ok: true, data: mapConnection(getRow(id)!) });
});

/**
 * @openapi
 * /api/obs-connections/{id}:
 *   put:
 *     tags: [obs]
 *     summary: Update an obs-websocket connection
 */
router.put('/obs-connections/:id', (req, res) => {
  const existing = getRow(req.params.id);
  if (!existing) {
    res.status(404).json({ ok: false, error: 'not found' });
    return;
  }
  const body = (req.body ?? {}) as Partial<{
    label: string;
    host: string;
    port: number;
    password: string;
    enabled: boolean;
  }>;
  const next = {
    label: body.label ?? existing.label,
    host: body.host ?? existing.host,
    port: body.port ?? existing.port,
    password: body.password ?? existing.password,
    enabled: body.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0,
  };
  getDb()
    .prepare(
      "UPDATE obs_connections SET label = ?, host = ?, port = ?, password = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(
      next.label,
      next.host,
      next.port,
      next.password,
      next.enabled,
      req.params.id
    );
  getObsWsManager().refreshProject(existing.project_id);
  res.json({ ok: true, data: mapConnection(getRow(req.params.id)!) });
});

/**
 * @openapi
 * /api/obs-connections/{id}:
 *   delete:
 *     tags: [obs]
 *     summary: Delete an obs-websocket connection
 */
router.delete('/obs-connections/:id', (req, res) => {
  const existing = getRow(req.params.id);
  if (!existing) {
    res.status(404).json({ ok: false, error: 'not found' });
    return;
  }
  getDb().prepare('DELETE FROM obs_connections WHERE id = ?').run(req.params.id);
  getObsWsManager().refreshProject(existing.project_id);
  res.json({ ok: true });
});

/**
 * @openapi
 * /api/obs-connections/{id}/test:
 *   post:
 *     tags: [obs]
 *     summary: Reconnect and report the resulting status
 */
router.post('/obs-connections/:id/test', (req, res) => {
  const existing = getRow(req.params.id);
  if (!existing) {
    res.status(404).json({ ok: false, error: 'not found' });
    return;
  }
  getObsWsManager().refreshProject(existing.project_id);
  res.json({ ok: true, data: { status: getRow(req.params.id)!.status } });
});

/**
 * @openapi
 * /api/projects/{projectId}/obs/inputs:
 *   get:
 *     tags: [obs]
 *     summary: List OBS inputs (for the node input picker); empty when disconnected
 */
router.get('/projects/:projectId/obs/inputs', async (req, res) => {
  const inputs = await getObsWsManager().listInputs(req.params.projectId);
  res.json({ ok: true, data: inputs });
});

export default router;
