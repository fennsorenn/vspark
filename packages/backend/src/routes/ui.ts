import { Router } from 'express';
import { _ws } from './shared.js';

/**
 * UI-control channel REST surface. Lets the in-app assistant AND external MCP
 * clients drive a specific editor tab: list the active editor sessions, then
 * push a UI action (select an entity, open a panel/help/window, highlight a
 * control) to one of them. The action is delivered over that session's
 * WebSocket as a `ui_action` message; the frontend dispatches it to the store.
 */
const router: ReturnType<typeof Router> = Router();

/**
 * @openapi
 * /api/ui-sessions:
 *   get:
 *     tags: [ui]
 *     summary: List active editor sessions that can be driven via /api/ui-actions
 *     responses:
 *       200: { description: Array of { sessionId, projectId, connectedAt } }
 */
router.get('/ui-sessions', (_req, res) => {
  res.json({ ok: true, data: _ws ? _ws.listSessions() : [] });
});

/**
 * @openapi
 * /api/ui-actions:
 *   post:
 *     tags: [ui]
 *     summary: Push a UI-control action to one editor session
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionId: { type: string }
 *               action:    { type: object, additionalProperties: true }
 *     responses:
 *       200: { description: Delivered }
 *       404: { description: No such (open) session }
 */
router.post('/ui-actions', (req, res) => {
  const { sessionId, action } = (req.body ?? {}) as {
    sessionId?: string;
    action?: Record<string, unknown>;
  };
  if (!sessionId || !action || typeof action !== 'object')
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'sessionId and action are required',
        code: 'VALIDATION_ERROR',
      },
    });
  const delivered = _ws ? _ws.sendUiAction(sessionId, action) : false;
  if (!delivered)
    return res.status(404).json({
      ok: false,
      error: {
        status: 404,
        message: 'no open editor session with that id',
        code: 'NOT_FOUND',
      },
    });
  res.json({ ok: true, data: { delivered: true } });
});

export default router;
