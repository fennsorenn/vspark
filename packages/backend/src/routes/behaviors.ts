/**
 * Behavior routes — the first rtype written THROUGH the mesh store (§10 of
 * dev-notes/plans/mesh-sync-refactor.md): the route validates + builds the
 * canonical DTO and writes the collection; the collection's onCommitted tap
 * persists (resource registry save/remove) and emits sync.document for
 * legacy tabs, and the write fans out to mesh subscribers with ONE stamp.
 * No direct SQL writes, no route-side sync emissions.
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { getMeshCollection } from '../mesh/index.js';
import { getAllBehaviorKindMeta } from '../behaviors/registry.js';
import {
  behaviorGraphLifecycle,
  behaviorGraphStatus,
  type BehaviorDoc,
} from '../behaviors/graphLifecycle.js';
import {
  behaviorTemplate,
  behaviorTemplateFingerprint,
  behaviorTemplateGraph,
} from '../behaviors/templates.js';
import { toDescriptorDoc } from '@vspark/shared/signal';

const router: ReturnType<typeof Router> = Router();

/** The kind's registered `defaultConfig`, so a behavior created without one
 *  arrives configured rather than inert — the editor's add-menu already seeds
 *  it client-side; this makes the REST path match. An explicitly supplied
 *  config (even `{}`) is always honoured as-is. */
function _defaultConfigFor(kind: string): Record<string, unknown> {
  const meta = getAllBehaviorKindMeta().find((m) => m.kind === kind);
  return meta ? structuredClone(meta.defaultConfig) : {};
}

/**
 * @openapi
 * /api/scene-nodes/{nodeId}/behaviors:
 *   get:
 *     tags: [behaviors]
 *     summary: List behavioural components attached to a node (vmc_receiver, breathing, lipsync, api_controller, ...)
 *     parameters:
 *       - { in: path, name: nodeId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of behaviors rows ordered by sort_order }
 */
router.get('/scene-nodes/:nodeId/behaviors', (req, res) => {
  const data = getDb()
    .prepare('SELECT * FROM behaviors WHERE node_id = ? ORDER BY sort_order')
    .all(req.params.nodeId);
  res.json({ ok: true, data });
});

/**
 * @openapi
 * /api/scene-nodes/{nodeId}/behaviors:
 *   post:
 *     tags: [behaviors]
 *     summary: Attach a new component to a node; triggers signal-graph manager refresh
 *     parameters:
 *       - { in: path, name: nodeId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateBehavior' }
 *     responses:
 *       201: { description: Behavior attached; all behavior managers re-synced }
 *       400: { description: Missing kind, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/scene-nodes/:nodeId/behaviors', async (req, res) => {
  const { id, kind, enabled, config, sortOrder } = req.body;
  if (!kind)
    return res
      .status(400)
      .json({ ok: false, error: { message: 'kind is required' } });
  const col = getMeshCollection('behavior');
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  const compId = id ?? randomUUID();
  const resolvedConfig = config ?? _defaultConfigFor(kind);
  const outcome = await col.set(compId, '', {
    id: compId,
    nodeId: req.params.nodeId,
    kind,
    enabled: enabled ?? true,
    config: resolvedConfig,
    sortOrder: sortOrder ?? 0,
  }).ack;
  if (outcome.status === 'rejected')
    return res.status(500).json({ ok: false, error: { message: outcome.reason } });
  // The tap creates the behavior's graph on the next tick; do it now so the
  // caller can read it back as soon as this returns.
  behaviorGraphLifecycle.ensureGraph(compId);
  res.status(201).json({
    ok: true,
    data: {
      id: compId,
      node_id: req.params.nodeId,
      kind,
      enabled: enabled ?? true,
      config: resolvedConfig,
      sort_order: sortOrder ?? 0,
    },
  });
});

/**
 * @openapi
 * /api/behaviors/{id}:
 *   put:
 *     tags: [behaviors]
 *     summary: Update a component's enabled flag or config; triggers manager refresh
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateBehavior' }
 *     responses:
 *       200: { description: Updated; all behavior managers re-synced }
 */
router.put('/behaviors/:id', async (req, res) => {
  const { enabled, config } = req.body;
  const col = getMeshCollection('behavior');
  const cur = col?.get(req.params.id);
  if (!col || !cur)
    return res
      .status(404)
      .json({ ok: false, error: { message: 'behavior not found' } });
  const outcome = await col.set(req.params.id, '', {
    ...cur,
    ...(enabled != null ? { enabled: !!enabled } : {}),
    ...(config != null ? { config } : {}),
  }).ack;
  if (outcome.status === 'rejected')
    return res.status(500).json({ ok: false, error: { message: outcome.reason } });
  res.json({ ok: true, data: { id: req.params.id } });
});

/**
 * @openapi
 * /api/behaviors/{id}:
 *   delete:
 *     tags: [behaviors]
 *     summary: Detach a component; triggers manager refresh which tears down its signal graph
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted; managers re-synced, content: { application/json: { schema: { $ref: '#/components/schemas/EmptyOk' } } } }
 */
router.delete('/behaviors/:id', async (req, res) => {
  const col = getMeshCollection('behavior');
  if (!col)
    return res
      .status(500)
      .json({ ok: false, error: { message: 'store not ready' } });
  await col.remove(req.params.id).ack;
  res.json({ ok: true, data: {} });
});


const notFound = (res: import('express').Response) =>
  res.status(404).json({ ok: false, error: { message: 'behavior not found' } });

const behaviorDoc = (id: string): BehaviorDoc | undefined =>
  getMeshCollection('behavior')?.get(id) as unknown as BehaviorDoc | undefined;

/**
 * @openapi
 * /api/behaviors/{id}/graph:
 *   get:
 *     tags: [behaviors]
 *     summary: The behavior's stored graph status — graph id, modified (differs from the template output it was generated from), template update available, missing
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ graphId, missingGraph, modified, templateUpdateAvailable, templateFingerprint }" }
 *       404: { description: Unknown behavior or a kind without a graph, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/behaviors/:id/graph', (req, res) => {
  const b = behaviorDoc(req.params.id);
  if (!b || !behaviorTemplate(b.kind)) return notFound(res);
  res.json({
    ok: true,
    data: {
      ...behaviorGraphStatus(b),
      templateFingerprint: b.templateFingerprint ?? null,
    },
  });
});

/**
 * @openapi
 * /api/behaviors/{id}/template:
 *   get:
 *     tags: [behaviors]
 *     summary: The template graph the behavior's graph is generated from (for its current config), its fingerprint, and the config fields that change its structure
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ graphId, label, descriptor (document form), fingerprint, shapeFields }" }
 *       404: { description: Unknown behavior or a kind without a graph, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/behaviors/:id/template', (req, res) => {
  const b = behaviorDoc(req.params.id);
  const t = b ? behaviorTemplate(b.kind) : undefined;
  const g = b ? behaviorTemplateGraph(b.kind, b.id, b.config) : null;
  if (!b || !t || !g) return notFound(res);
  res.json({
    ok: true,
    data: {
      graphId: g.id,
      label: g.label,
      descriptor: toDescriptorDoc(g),
      fingerprint: behaviorTemplateFingerprint(b.kind, b.config),
      shapeFields: t.shapeFields,
    },
  });
});

/**
 * @openapi
 * /api/behaviors/{id}/reset-graph:
 *   post:
 *     tags: [behaviors]
 *     summary: Regenerate the behavior's graph from its template, discarding graph edits (creates it when missing)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Reset; returns the graph status }
 *       404: { description: Unknown behavior or a kind without a graph, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/behaviors/:id/reset-graph', async (req, res) => {
  const b = behaviorDoc(req.params.id);
  if (!b || !behaviorTemplate(b.kind)) return notFound(res);
  if (!(await behaviorGraphLifecycle.reset(b.id)))
    return res
      .status(500)
      .json({ ok: false, error: { message: 'graph reset was refused' } });
  res.json({ ok: true, data: behaviorGraphStatus(behaviorDoc(b.id)!) });
});

export default router;
