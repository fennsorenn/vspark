/**
 * Plugin host REST surface. Management routes live under `/api/plugins`;
 * a plugin's own routes are mounted at `/api/plugin/<id>/` (app.ts) and its
 * browser files are served from `/plugin-files/<id>/` (app.ts).
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

/**
 * @openapi
 * /api/plugins/active:
 *   get:
 *     tags: [plugins]
 *     summary: What the editor loads at start — browser entries, locales and help pages of the active plugins
 *     responses:
 *       200: { description: Active plugin descriptors }
 */
router.get('/plugins/active', (_req, res) => {
  res.json({
    ok: true,
    data: getPluginHost()
      .list()
      .filter((p) => p.status === 'active')
      .map((p) => ({
        id: p.manifest.id,
        version: p.manifest.version,
        name: p.manifest.name,
        baseUrl: `/plugin-files/${p.manifest.id}`,
        entries: { shared: p.manifest.entries.shared ?? null, ui: p.manifest.entries.ui ?? null },
        locales: p.locales,
        help: p.help,
      })),
  });
});

export default router;
