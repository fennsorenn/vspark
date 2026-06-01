import { Router } from 'express';
import { getDb } from '../db/index.js';
import { _apiController } from './shared.js';

const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/projects/{projectId}/nodes/{nodeId}/expressions:
 *   get:
 *     tags: [expressions]
 *     summary: List VRM expression names exposed by this avatar
 *     description: |
 *       The frontend reports the avatar's available expressions on VRM load.
 *       Until the frontend has loaded the avatar at least once, `reported` will be false.
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: nodeId,    required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Expression list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:   { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     expressions: { type: array, items: { type: string } }
 *                     reported:    { type: boolean }
 *       404: { description: Node not in project, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       503: { description: Manager not ready,   content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/projects/:projectId/nodes/:nodeId/expressions', (req, res) => {
  const { projectId, nodeId } = req.params;
  const owns = getDb()
    .prepare(
      `
    SELECT id FROM scene_nodes WHERE id = ? AND project_id = ?
  `
    )
    .get(nodeId, projectId) as { id: string } | undefined;
  if (!owns)
    return res
      .status(404)
      .json({
        ok: false,
        error: {
          status: 404,
          message: 'node not found in project',
          code: 'NOT_FOUND',
        },
      });
  if (!_apiController)
    return res
      .status(503)
      .json({
        ok: false,
        error: {
          status: 503,
          message: 'API controller manager not ready',
          code: 'NOT_READY',
        },
      });
  const expressions = _apiController.getExpressionsForNode(nodeId);
  res.json({
    ok: true,
    data: { expressions: expressions ?? [], reported: expressions != null },
  });
});

/**
 * @openapi
 * /api/projects/{projectId}/nodes/{nodeId}/animations:
 *   get:
 *     tags: [expressions]
 *     summary: List animation clips registered for this avatar node
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: nodeId,    required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Animation list with playback metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:   { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     animations:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:        { type: string }
 *                           name:      { type: string }
 *                           label:     { type: string }
 *                           duration:  { type: number }
 *                           fps:       { type: number }
 *                           sourceUrl: { type: string }
 *       404: { description: Node not in project, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/projects/:projectId/nodes/:nodeId/animations', (req, res) => {
  const { projectId, nodeId } = req.params;
  const owns = getDb()
    .prepare(
      `
    SELECT id FROM scene_nodes WHERE id = ? AND project_id = ?
  `
    )
    .get(nodeId, projectId) as { id: string } | undefined;
  if (!owns)
    return res
      .status(404)
      .json({
        ok: false,
        error: {
          status: 404,
          message: 'node not found in project',
          code: 'NOT_FOUND',
        },
      });
  const rows = getDb()
    .prepare(
      'SELECT id, name, label, duration, fps, source_file_path FROM animation_clips WHERE source_node_id = ? ORDER BY name'
    )
    .all(nodeId) as Array<{
    id: string;
    name: string;
    label: string;
    duration: number;
    fps: number;
    source_file_path: string;
  }>;
  res.json({
    ok: true,
    data: {
      animations: rows.map((r) => ({
        id: r.id,
        name: r.name,
        label: r.label,
        duration: r.duration,
        fps: r.fps,
        sourceUrl: r.source_file_path,
      })),
    },
  });
});

export default router;
