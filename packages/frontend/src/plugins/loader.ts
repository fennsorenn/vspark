/**
 * Editor side of the plugin host. The tab learns which plugins its server
 * loaded from `plugin` mesh documents (mesh principle 7) — status, locales and
 * help travel in the document; the code (`shared.mjs`) is fetched as a static
 * file from the server (decided: user, 2026-11-27). For each active plugin of
 * our own server: its i18n bundle becomes namespace `plugin-<id>`, its help
 * pages topics `plugin-<id>` / `plugin-<id>-<page>`, and its shared module's
 * Action kinds, response types and composite types are registered like the
 * backend registers them. Documents of other servers (a peer we share with)
 * carry only a name and are used for "plugin missing" notes.
 * A broken plugin is reported and skipped; it never blocks the editor.
 * See dev-notes/modules/plugins.md.
 */
import i18n from '../i18n';
import {
  PLUGIN_ACTIONS_SDK,
  RESPONSE_TYPES,
  actionKind,
  registerActionKind,
  registerResponseType,
  type ActionKindDef,
  type ResponseTypeDef,
} from '@vspark/shared/actions';
import {
  COMPOSITE_TYPES,
  registerCompositeType,
  type CompositeTypeDef,
} from '@vspark/shared/composites';
import type { PluginDoc } from '@vspark/shared/types';
import { registerDocTopic } from '../help/docs';
import { COMPOSITE_DEFS, registerCompositeDef } from '../components/editor/composites/compositeModel';

interface SharedOutput {
  responseTypes?: Record<string, ResponseTypeDef>;
  actionKinds?: ActionKindDef[];
  compositeTypes?: CompositeTypeDef[];
  compositePresets?: Array<{ type: string; name: string }>;
}

/** Where plugin documents come from (the tab's replica in the app). */
export interface PluginSource {
  serverPeerId: string;
  ready(): Promise<void>;
  all(): PluginDoc[];
  /** Calls back on every change; returns an unsubscribe. */
  observe(cb: () => void): () => void;
}

export type ImportModule = (url: string) => Promise<{ default?: unknown }>;

const defaultImport: ImportModule = (url) => import(/* @vite-ignore */ url);

/** The SDK handed to a plugin's shared factory in the editor (same surface
 *  as the backend's, minus the backend-only parts). */
export const EDITOR_SHARED_SDK = Object.freeze({ apiVersion: 1, actions: PLUGIN_ACTIONS_SDK });

/** Outcome per plugin id, for the Plugins window. */
export const editorPluginStatus = new Map<string, { ok: boolean; error?: string; version: string }>();

/** Help topic of a plugin page: `index` is the plugin's main topic. */
export const pluginHelpTopic = (id: string, page: string) => {
  const name = page.replace(/\.md$/, '');
  return name === 'index' ? `plugin-${id}` : `plugin-${id}-${name}`;
};

async function loadOne(d: PluginDoc, importModule: ImportModule): Promise<void> {
  const id = d.pluginId;
  const ns = `plugin-${id}`;
  for (const [lng, bundle] of Object.entries(d.locales ?? {}))
    i18n.addResourceBundle(lng, ns, bundle, true, true);
  for (const [lng, pages] of Object.entries(d.help ?? {}))
    for (const [page, md] of Object.entries(pages)) registerDocTopic(pluginHelpTopic(id, page), lng, md);

  if (!d.entries?.shared) return;
  const mod = await importModule(`${d.baseUrl}/${d.entries.shared}?v=${encodeURIComponent(d.version)}`);
  if (typeof mod.default !== 'function') throw new Error('shared entry: default export must be a factory');
  const out = ((mod.default as (sdk: unknown) => unknown)(EDITOR_SHARED_SDK) ?? {}) as SharedOutput;
  // Idempotent: a re-run skips what is registered.
  for (const [typeId, def] of Object.entries(out.responseTypes ?? {}))
    if (!RESPONSE_TYPES[typeId]) registerResponseType(id, typeId, def);
  for (const def of out.actionKinds ?? []) if (!actionKind(def.kind)) registerActionKind(id, def);
  for (const def of out.compositeTypes ?? []) if (!COMPOSITE_TYPES[def.type]) registerCompositeType(id, def);
  for (const preset of out.compositePresets ?? []) {
    if (COMPOSITE_DEFS.some((c) => c.type === preset.type)) continue;
    registerCompositeDef(id, {
      type: preset.type,
      presetId: `plugin:${id}:${preset.type}`,
      rootRtype: COMPOSITE_TYPES[preset.type]?.rootRtype ?? 'compose_layer',
      label: i18n.t(`${ns}:${preset.name}`, { defaultValue: preset.type }),
    });
  }
}

/** Load the active plugins of our server that are not loaded yet. */
async function loadNew(src: PluginSource, importModule: ImportModule): Promise<void> {
  for (const d of src.all()) {
    if (d.server !== src.serverPeerId || d.status !== 'active') continue;
    if (editorPluginStatus.get(d.pluginId)?.version === d.version) continue;
    try {
      await loadOne(d, importModule);
      editorPluginStatus.set(d.pluginId, { ok: true, version: d.version });
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      editorPluginStatus.set(d.pluginId, { ok: false, error, version: d.version });
      console.warn(`[plugins] ${d.pluginId}: editor part failed to load:`, error);
    }
  }
}

/**
 * Load every active plugin's editor parts, then keep watching: a plugin that
 * becomes active later (installed or enabled while the editor is open) is
 * loaded then. Waits at most `timeoutMs` for the subscription so a slow server
 * never blocks the first render. Never throws.
 */
export async function loadPlugins(
  src: PluginSource,
  opts: { importModule?: ImportModule; timeoutMs?: number } = {}
): Promise<() => void> {
  const importModule = opts.importModule ?? defaultImport;
  await Promise.race([
    src.ready(),
    new Promise<void>((r) => setTimeout(r, opts.timeoutMs ?? 3000)),
  ]).catch(() => {});
  await loadNew(src, importModule);
  return src.observe(() => void loadNew(src, importModule));
}

/** Which plugin (by name) a node / object kind belongs to, from the plugin
 *  documents this tab can see — ours (also failed / incompatible ones) and
 *  the name-only documents of servers we share with. Kinds are
 *  `<pluginId>_…`; the longest matching id wins. */
export function pluginForKind(docs: readonly PluginDoc[], kind: string, lng = 'en'): string | undefined {
  let best: PluginDoc | undefined;
  for (const d of docs) {
    const pid = d.pluginId ?? d.id.slice(d.id.lastIndexOf(':') + 1);
    if (kind.startsWith(`${pid}_`) && (!best || pid.length > (best.pluginId ?? '').length)) best = { ...d, pluginId: pid };
  }
  if (!best) return undefined;
  return best.name?.[lng] ?? best.name?.en ?? best.pluginId;
}
