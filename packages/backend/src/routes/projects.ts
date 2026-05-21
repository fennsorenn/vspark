import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';

const router: ReturnType<typeof Router> = Router();

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

export default router;
