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
 *       200: { description: 'Array of { sessionId, projectId, connectedAt }' }
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

/**
 * @openapi
 * /api/feed-preview:
 *   post:
 *     tags: [ui]
 *     summary: Render a feed template to a PNG in a connected editor (real renderer)
 *     description: |
 *       Asks one editor session to rasterize a hypothetical feed template + CSS +
 *       sample data offscreen (using the same renderer the live feed layer uses)
 *       and returns the resulting PNG as base64. Powers the assistant's
 *       render_feed_template tool without a server-side headless browser.
 *     responses:
 *       200: { description: '{ pngBase64 }' }
 *       400: { description: Missing sessionId or template }
 *       502: { description: No editor session / render failed / timed out }
 */
router.post('/feed-preview', async (req, res) => {
  const { sessionId, template, css, data, width, height, background } =
    (req.body ?? {}) as {
      sessionId?: string;
      template?: string;
      css?: string;
      data?: Record<string, unknown>;
      width?: number;
      height?: number;
      background?: string;
    };
  if (!sessionId || typeof template !== 'string')
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'sessionId and template are required',
        code: 'VALIDATION_ERROR',
      },
    });
  if (!_ws)
    return res
      .status(502)
      .json({ ok: false, error: { status: 502, message: 'ws not ready' } });
  try {
    const pngBase64 = await _ws.requestFeedPreview(sessionId, {
      template,
      css,
      data,
      width,
      height,
      background,
    });
    res.json({ ok: true, data: { pngBase64 } });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: {
        status: 502,
        message: e instanceof Error ? e.message : String(e),
        code: 'PREVIEW_FAILED',
      },
    });
  }
});

/**
 * @openapi
 * /api/viewport-screenshot:
 *   post:
 *     tags: [ui]
 *     summary: Screenshot the 3D viewport of a connected editor session
 *     description: |
 *       Asks one editor session to render its 3D viewport and return the PNG as
 *       base64. Powers the assistant's screenshot_viewport tool so the agent can
 *       see and verify scene/lighting/framing changes.
 *     responses:
 *       200: { description: '{ pngBase64 }' }
 *       400: { description: Missing sessionId }
 *       502: { description: No editor session / capture failed / timed out }
 */
router.post('/viewport-screenshot', async (req, res) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  if (!sessionId)
    return res.status(400).json({
      ok: false,
      error: {
        status: 400,
        message: 'sessionId is required',
        code: 'VALIDATION_ERROR',
      },
    });
  if (!_ws)
    return res
      .status(502)
      .json({ ok: false, error: { status: 502, message: 'ws not ready' } });
  try {
    const pngBase64 = await _ws.requestViewportScreenshot(sessionId);
    res.json({ ok: true, data: { pngBase64 } });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: {
        status: 502,
        message: e instanceof Error ? e.message : String(e),
        code: 'SCREENSHOT_FAILED',
      },
    });
  }
});

export default router;
