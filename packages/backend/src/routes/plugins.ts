/**
 * Plugin host REST surface — for OUTSIDE callers (MCP, scripts) only. The
 * editor reads `plugin` mesh documents (mesh principle 7). A plugin's own
 * routes are mounted at `/api/plugin/<id>/` (app.ts; for outside callers such
 * as OAuth redirects) and its code is served from `/plugin-files/<id>/`.
 * See dev-notes/modules/plugins.md.
 */
import { Router } from 'express';
import { getPluginHost, type LoadedPlugin } from '../plugins/loader.js';

const router = Router();

/** The list row of a plugin (Plugins window, MCP). */
export function pluginRow(p: LoadedPlugin) {
  const m = p.manifest;
  return {
    id: m.id,
    version: m.version,
    name: m.name,
    description: m.description,
    author: m.author,
    homepage: m.homepage ?? null,
    network: m.network ?? [],
    source: p.source,
    status: p.status,
    error: p.error ?? null,
    contributes: p.summary,
  };
}

/**
 * @openapi
 * /api/plugins:
 *   get:
 *     tags: [plugins]
 *     summary: Plugins this server loaded (active, failed or incompatible)
 *     responses:
 *       200: { description: Plugin rows }
 */
router.get('/plugins', (_req, res) => {
  res.json({ ok: true, data: getPluginHost().list().map(pluginRow) });
});

export default router;
