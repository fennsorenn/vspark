import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/projects:
 *   get:
 *     tags: [projects]
 *     summary: List all projects, most recently updated first
 *     responses:
 *       200:
 *         description: Array of project rows
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:   { type: boolean, enum: [true] }
 *                 data: { type: array, items: { type: object } }
 */
router.get('/projects', (_req, res) => {
  const data = getDb().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/projects:
 *   post:
 *     tags: [projects]
 *     summary: Create a new project
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateProject' }
 *     responses:
 *       201: { description: Project created }
 *       400: { description: Missing name, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/projects', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: { status: 400, message: 'name is required', code: 'VALIDATION_ERROR' } });
  const id = randomUUID();
  getDb().prepare('INSERT INTO projects (id, name, description) VALUES (?, ?, ?)').run(id, name, description ?? null);
  res.status(201).json({ ok: true, data: { id, name, description } });
});

/**
 * @openapi
 * /api/projects/{id}:
 *   put:
 *     tags: [projects]
 *     summary: Update a project's name or description
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateProject' }
 *     responses:
 *       200: { description: Updated }
 *       404: { description: Project not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
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

/**
 * @openapi
 * /api/projects/{id}:
 *   delete:
 *     tags: [projects]
 *     summary: Delete a project (and cascade-delete its scenes, nodes, components)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Deleted, content: { application/json: { schema: { $ref: '#/components/schemas/EmptyOk' } } } }
 */
router.delete('/projects/:id', (req, res) => {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true, data: {} });
});

export default router;
