import { Router } from 'express';
import { getDb } from '../db/index.js';
import { _apiController } from './shared.js';

const router: ReturnType<typeof Router> = Router();

/** List the VRM expression names available on this avatar (populated by the frontend on VRM load). */
router.get('/projects/:projectId/nodes/:nodeId/expressions', (req, res) => {
  const { projectId, nodeId } = req.params;
  const owns = getDb().prepare(`
    SELECT n.id FROM scene_nodes n
    INNER JOIN scenes s ON s.id = n.scene_id
    WHERE n.id = ? AND s.project_id = ?
  `).get(nodeId, projectId) as { id: string } | undefined;
  if (!owns) return res.status(404).json({ ok: false, error: { status: 404, message: 'node not found in project', code: 'NOT_FOUND' } });
  if (!_apiController) return res.status(503).json({ ok: false, error: { status: 503, message: 'API controller manager not ready', code: 'NOT_READY' } });
  const expressions = _apiController.getExpressionsForNode(nodeId);
  res.json({ ok: true, data: { expressions: expressions ?? [], reported: expressions != null } });
});

/** List animation clips registered for this avatar node. */
router.get('/projects/:projectId/nodes/:nodeId/animations', (req, res) => {
  const { projectId, nodeId } = req.params;
  const owns = getDb().prepare(`
    SELECT n.id FROM scene_nodes n
    INNER JOIN scenes s ON s.id = n.scene_id
    WHERE n.id = ? AND s.project_id = ?
  `).get(nodeId, projectId) as { id: string } | undefined;
  if (!owns) return res.status(404).json({ ok: false, error: { status: 404, message: 'node not found in project', code: 'NOT_FOUND' } });
  const rows = getDb().prepare(
    'SELECT id, name, label, duration, fps, source_file_path FROM animation_clips WHERE source_node_id = ? ORDER BY name'
  ).all(nodeId) as Array<{ id: string; name: string; label: string; duration: number; fps: number; source_file_path: string }>;
  res.json({
    ok: true,
    data: {
      animations: rows.map((r) => ({
        id:        r.id,
        name:      r.name,
        label:     r.label,
        duration:  r.duration,
        fps:       r.fps,
        sourceUrl: r.source_file_path,
      })),
    },
  });
});

export default router;
