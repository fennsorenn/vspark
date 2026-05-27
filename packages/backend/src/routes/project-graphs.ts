import { Router } from 'express';
import { randomUUID } from 'crypto';
import { projectGraphManager } from '../project_graphs/manager.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/projects/{projectId}/graphs:
 *   get:
 *     tags: [project_graphs]
 *     summary: List standalone signal graphs for a project
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 */
router.get('/projects/:projectId/graphs', (req, res) => {
  const rows = projectGraphManager.list(req.params.projectId);
  const data = rows.map((r) => ({
    id: r.id,
    projectId: r.owner_id,
    name: r.name,
    enabled: r.enabled === 1,
    descriptor: JSON.parse(r.descriptor),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/projects/{projectId}/graphs:
 *   post:
 *     tags: [project_graphs]
 *     summary: Create a new standalone graph (empty by default; edit via PUT)
 */
router.post('/projects/:projectId/graphs', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'name is required' } });
  const id = randomUUID();
  const row = projectGraphManager.create({
    id,
    projectId: req.params.projectId,
    name,
  });
  projectGraphManager.reconcile(id);
  res.status(201).json({
    ok: true,
    data: {
      id: row.id,
      projectId: row.owner_id,
      name: row.name,
      enabled: row.enabled === 1,
      descriptor: JSON.parse(row.descriptor),
    },
  });
});

/**
 * @openapi
 * /api/project-graphs/{id}:
 *   put:
 *     tags: [project_graphs]
 *     summary: Update name / enabled / descriptor (each field optional)
 */
router.put('/project-graphs/:id', (req, res) => {
  const { name, enabled, descriptor } = req.body as {
    name?: string;
    enabled?: boolean;
    descriptor?: unknown;
  };
  try {
    const row = projectGraphManager.update(req.params.id, {
      ...(name !== undefined ? { name } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(descriptor !== undefined
        ? {
            descriptor: descriptor as Parameters<
              typeof projectGraphManager.update
            >[1]['descriptor'],
          }
        : {}),
    });
    if (!row)
      return res
        .status(404)
        .json({ ok: false, error: { message: 'project graph not found' } });
    res.json({
      ok: true,
      data: {
        id: row.id,
        projectId: row.owner_id,
        name: row.name,
        enabled: row.enabled === 1,
        descriptor: JSON.parse(row.descriptor),
      },
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: { message: e instanceof Error ? e.message : String(e) },
    });
  }
});

/**
 * @openapi
 * /api/project-graphs/{id}:
 *   delete:
 *     tags: [project_graphs]
 *     summary: Delete a standalone graph and stop its runtime instance
 */
router.delete('/project-graphs/:id', (req, res) => {
  projectGraphManager.remove(req.params.id);
  res.json({ ok: true, data: {} });
});

export default router;
