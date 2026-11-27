/**
 * Editor side of the plugin host. Before the app renders, every active
 * plugin's browser parts are loaded from the server: its i18n bundles (as
 * namespace `plugin-<id>`), its help pages (topics `plugin-<id>` and
 * `plugin-<id>-<page>`) and its shared module, whose Action kinds, response
 * types and composite types are registered like the backend registers them.
 * A broken plugin is reported and skipped; it never blocks the editor.
 * See dev-notes/modules/plugins.md.
 */
import i18n from '../i18n';
import {
  PLUGIN_ACTIONS_SDK,
  registerActionKind,
  registerResponseType,
  actionKind,
  RESPONSE_TYPES,
  type ActionKindDef,
  type ResponseTypeDef,
} from '@vspark/shared/actions';
import {
  COMPOSITE_TYPES,
  registerCompositeType,
  type CompositeTypeDef,
} from '@vspark/shared/composites';
import { registerDocTopic } from '../help/docs';
import { COMPOSITE_DEFS, registerCompositeDef } from '../components/editor/composites/compositeModel';

export interface ActivePlugin {
  id: string;
  version: string;
  name: Record<string, string>;
  baseUrl: string;
  entries: { shared: string | null; ui: string | null };
  locales: Record<string, string[]>;
  help: Record<string, string[]>;
}

interface SharedOutput {
  responseTypes?: Record<string, ResponseTypeDef>;
  actionKinds?: ActionKindDef[];
  compositeTypes?: CompositeTypeDef[];
  compositePresets?: Array<{ type: string; name: string }>;
}

export interface LoaderDeps {
  fetchJson(url: string): Promise<unknown>;
  fetchText(url: string): Promise<string>;
  importModule(url: string): Promise<{ default?: unknown }>;
}

const defaultDeps: LoaderDeps = {
  fetchJson: async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  },
  fetchText: async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.text();
  },
  importModule: (url) => import(/* @vite-ignore */ url),
};

/** The SDK handed to a plugin's shared factory in the editor (same surface
 *  as the backend's, minus the backend-only parts). */
export const EDITOR_SHARED_SDK = Object.freeze({ apiVersion: 1, actions: PLUGIN_ACTIONS_SDK });

/** Outcome per plugin, for the Plugins window. */
export const editorPluginStatus = new Map<string, { ok: boolean; error?: string }>();

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function deepMerge(into: Record<string, unknown>, from: Record<string, unknown>) {
  for (const [k, v] of Object.entries(from)) {
    if (isObj(v) && isObj(into[k])) deepMerge(into[k] as Record<string, unknown>, v);
    else into[k] = v;
  }
  return into;
}

/** Help topic of a plugin page: `index.md` is the plugin's main topic. */
export const pluginHelpTopic = (id: string, page: string) => {
  const name = page.replace(/\.md$/, '');
  return name === 'index' ? `plugin-${id}` : `plugin-${id}-${name}`;
};

async function loadOne(p: ActivePlugin, deps: LoaderDeps): Promise<void> {
  const ns = `plugin-${p.id}`;
  for (const [lng, files] of Object.entries(p.locales)) {
    const bundle: Record<string, unknown> = {};
    for (const f of files) {
      const json = await deps.fetchJson(`${p.baseUrl}/locales/${lng}/${f}`);
      if (isObj(json)) deepMerge(bundle, json);
    }
    i18n.addResourceBundle(lng, ns, bundle, true, true);
  }
  for (const [lng, pages] of Object.entries(p.help))
    for (const page of pages)
      registerDocTopic(pluginHelpTopic(p.id, page), lng, await deps.fetchText(`${p.baseUrl}/help/${lng}/${page}`));

  if (!p.entries.shared) return;
  const mod = await deps.importModule(`${p.baseUrl}/${p.entries.shared}?v=${encodeURIComponent(p.version)}`);
  if (typeof mod.default !== 'function') throw new Error('shared entry: default export must be a factory');
  const out = ((mod.default as (sdk: unknown) => unknown)(EDITOR_SHARED_SDK) ?? {}) as SharedOutput;
  // Idempotent: a second load (HMR, a re-run) skips what is registered.
  for (const [id, def] of Object.entries(out.responseTypes ?? {}))
    if (!RESPONSE_TYPES[id]) registerResponseType(p.id, id, def);
  for (const def of out.actionKinds ?? []) if (!actionKind(def.kind)) registerActionKind(p.id, def);
  for (const def of out.compositeTypes ?? []) if (!COMPOSITE_TYPES[def.type]) registerCompositeType(p.id, def);
  for (const preset of out.compositePresets ?? []) {
    if (COMPOSITE_DEFS.some((d) => d.type === preset.type)) continue;
    const def = COMPOSITE_TYPES[preset.type];
    registerCompositeDef(p.id, {
      type: preset.type,
      presetId: `plugin:${p.id}:${preset.type}`,
      rootRtype: def?.rootRtype ?? 'compose_layer',
      label: i18n.t(`${ns}:${preset.name}`, { defaultValue: preset.type }),
    });
  }
}

/** Load every active plugin's browser parts. Never throws. */
export async function loadPlugins(deps: LoaderDeps = defaultDeps): Promise<void> {
  let list: ActivePlugin[];
  try {
    const res = (await deps.fetchJson('/api/plugins/active')) as { data?: ActivePlugin[] };
    list = res.data ?? [];
  } catch (e) {
    console.warn('[plugins] could not list active plugins:', e);
    return;
  }
  for (const p of list) {
    try {
      await loadOne(p, deps);
      editorPluginStatus.set(p.id, { ok: true });
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      editorPluginStatus.set(p.id, { ok: false, error });
      console.warn(`[plugins] ${p.id}: editor part failed to load:`, error);
    }
  }
}
