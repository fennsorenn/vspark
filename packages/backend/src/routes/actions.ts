/**
 * Action routes — written THROUGH the mesh store like logic and behaviors: the
 * route builds the canonical DTO and writes the `action` collection; the
 * onCommitted tap persists it and keeps the action's graph in step
 * (actions/lifecycle.ts). See dev-notes/modules/actions.md.
 *
 * The read model adds derived graph state (graphId, modified,
 * templateUpdateAvailable, missingGraph) computed from the stored graph and the
 * kind's current template.
 */
import { Router, type Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  createActionSchema,
  updateActionSchema,
} from '@vspark/shared/schema';
import { ACTION_KINDS, actionKind } from '@vspark/shared/actions';
import { getDb } from '../db/index.js';
import { getMeshCollection } from '../mesh/index.js';
import { actionLifecycle, type ActionDoc } from '../actions/lifecycle.js';
import { rowToAction, type ActionRow } from '../sync/resources.js';

const router: ReturnType<typeof Router> = Router();

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ ok: false, error: { status, message } });

function readModel(r: ActionRow) {
  const doc = rowToAction(r) as ActionDoc;
  return {
    ...doc,
    updatedAt: r.updated_at,
    ...actionLifecycle.status(doc),
  };
}

const rowOf = (id: string) =>
  getDb().prepare('SELECT * FROM actions WHERE id = ?').get(id) as unknown as
    | ActionRow
    | undefined;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge key by key; anything else replaces. */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch))
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

function parseOr400<T>(
  schema: z.ZodType<T>,
  body: unknown,
  res: Response
): T | null {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  res.status(400).json({
    ok: false,
    error: {
      status: 400,
      message: z.prettifyError(parsed.error),
      code: 'VALIDATION_ERROR',
    },
  });
  return null;
}

/**
 * @openapi
 * /api/action-kinds:
 *   get:
 *     tags: [actions]
 *     summary: List the Action kinds with their settings fields (value vs shape) and defaults
 *     responses:
 *       200: { description: Array of kind metadata }
 */
router.get('/action-kinds', (_req, res) => {
  res.json({
    ok: true,
    data: ACTION_KINDS.map((k) => ({
      kind: k.kind,
      label: k.label,
      icon: k.icon,
      fields: k.fields,
      defaults: k.defaults(),
    })),
  });
});

/**
 * @openapi
 * /api/projects/{projectId}/actions:
 *   get:
 *     tags: [actions]
 *     summary: List a project's Actions with derived graph state (modified, templateUpdateAvailable)
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of actions ordered by creation }
 */
router.get('/projects/:projectId/actions', (req, res) => {
  const rows = getDb()
    .prepare(
      'SELECT * FROM actions WHERE project_id = ? ORDER BY created_at, id'
    )
    .all(req.params.projectId) as unknown as ActionRow[];
  res.json({ ok: true, data: rows.map(readModel) });
});

/**
 * @openapi
 * /api/projects/{projectId}/actions:
 *   post:
 *     tags: [actions]
 *     summary: Create an Action; its Logic graph is generated from the kind's template
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateAction' }
 *     responses:
 *       201: { description: Action created with its graph }
 *       400: { description: Invalid body or unknown kind, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/projects/:projectId/actions', async (req, res) => {
  const body = parseOr400(createActionSchema, req.body, res);
  if (!body) return;
  const def = actionKind(body.kind);
  if (!def) return fail(res, 400, `unknown action kind "${body.kind}"`);
  if (!getMeshCollection('action')) return fail(res, 500, 'store not ready');
  const id = body.id ?? randomUUID();
  const refused = await actionLifecycle.create({
    id,
    projectId: req.params.projectId,
    kind: body.kind,
    name: body.name ?? def.label,
    enabled: body.enabled ?? true,
    settings: { ...def.defaults(), ...(body.settings ?? {}) },
    templateFingerprint: null,
  });
  if (refused) return fail(res, 400, refused);
  const row = rowOf(id);
  if (!row) return fail(res, 500, 'action was not persisted');
  res.status(201).json({ ok: true, data: readModel(row) });
});

/**
 * @openapi
 * /api/actions/{id}:
 *   get:
 *     tags: [actions]
 *     summary: Read one Action with derived graph state
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The action }
 *       404: { description: Not found }
 */
router.get('/actions/:id', (req, res) => {
  const row = rowOf(req.params.id);
  if (!row) return fail(res, 404, 'action not found');
  res.json({ ok: true, data: readModel(row) });
});

/**
 * @openapi
 * /api/actions/{id}:
 *   put:
 *     tags: [actions]
 *     summary: Update name / enabled / settings. A shape-setting change rebuilds an unmodified graph; a modified graph is kept (use reset)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/UpdateAction' }
 *     responses:
 *       200: { description: The updated action }
 *       404: { description: Not found }
 */
router.put('/actions/:id', async (req, res) => {
  const body = parseOr400(updateActionSchema, req.body, res);
  if (!body) return;
  const col = getMeshCollection('action');
  const cur = col?.get(req.params.id);
  if (!col || !cur) return fail(res, 404, 'action not found');
  const doc = {
    ...cur,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.settings !== undefined
      ? {
          settings: deepMerge(
            (isObj(cur.settings) ? cur.settings : {}) as Record<
              string,
              unknown
            >,
            body.settings
          ),
        }
      : {}),
  };
  const out = await col.set(req.params.id, '', doc).ack;
  if (out.status === 'rejected') return fail(res, 400, out.reason ?? 'rejected');
  const row = rowOf(req.params.id);
  if (!row) return fail(res, 404, 'action not found');
  res.json({ ok: true, data: readModel(row) });
});

/**
 * @openapi
 * /api/actions/{id}/reset:
 *   post:
 *     tags: [actions]
 *     summary: Regenerate the Action's graph from its template, discarding graph edits
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The action, graph regenerated }
 *       404: { description: Not found }
 */
router.post('/actions/:id/reset', async (req, res) => {
  if (!getMeshCollection('action')?.get(req.params.id))
    return fail(res, 404, 'action not found');
  if (!(await actionLifecycle.reset(req.params.id)))
    return fail(res, 400, 'reset refused');
  const row = rowOf(req.params.id);
  if (!row) return fail(res, 404, 'action not found');
  res.json({ ok: true, data: readModel(row) });
});

/**
 * @openapi
 * /api/actions/{id}:
 *   delete:
 *     tags: [actions]
 *     summary: Delete an Action and its graph
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted }
 *       404: { description: Not found }
 */
router.delete('/actions/:id', async (req, res) => {
  const col = getMeshCollection('action');
  if (!col?.get(req.params.id)) return fail(res, 404, 'action not found');
  // The graph is a child document: removing the action removes it too (the
  // tap's removeTree), each with its tombstone.
  const out = await col.remove(req.params.id).ack;
  if (out.status === 'rejected') return fail(res, 400, out.reason ?? 'rejected');
  res.json({ ok: true, data: {} });
});

export default router;
