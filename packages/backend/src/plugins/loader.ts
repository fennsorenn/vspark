/**
 * Plugin host: discovers, validates, loads and unloads plugins.
 *
 * Sources: installed plugins (`<plugins dir>/<id>/<version>/`, enabled in
 * state.json) and dev folders (config.json `plugins.dev`). Each entry module
 * default-exports a factory that receives the host SDK — plugins never bundle
 * vspark's modules (node metadata lives in module state; a copy would be
 * invisible to the engine). Activation is all-or-nothing: a throwing
 * `activate` rolls back everything the plugin registered, and the plugin shows
 * as failed instead of blocking boot. See dev-notes/modules/plugins.md.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Router } from 'express';
import {
  PLUGIN_ACTIONS_SDK,
  registerActionKind,
  registerResponseType,
  unregisterActionContributions,
  type ActionKindDef,
  type ResponseTypeDef,
} from '@vspark/shared/actions';
import {
  registerCompositeType,
  unregisterCompositeContributions,
  type CompositeTypeDef,
} from '@vspark/shared/composites';
import { SignalNode, mkEvent } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import {
  eventIn,
  eventOut,
  listIn,
  valueIn,
  valueOut,
} from '@vspark/shared/node_decorators';
import {
  NODE_REGISTRY,
  pluginOfNodeKind,
  unregisterNodeKinds,
} from '../signal/registry.js';
import {
  registerBuiltinComposite,
  unregisterBuiltinComposites,
} from '../presets/builtins.js';
import { feedCompositePayload, type FeedCompositePreset } from './compositePreset.js';
import { createContext, type Contributions } from './context.js';
import { createAccountsApi } from './accounts/store.js';
import { PLUGIN_API_VERSION, parseManifest, satisfies, type PluginManifest } from './manifest.js';
import { pluginVersionDir } from './paths.js';
import { getInstallDir } from '../routes/update.js';
import { readState } from './state.js';

export type PluginSource = 'installed' | 'dev';

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  source: PluginSource;
  status: 'active' | 'failed' | 'incompatible';
  error?: string;
  contributions: Contributions;
  /** What the plugin registered, for the Plugins window. */
  summary: { nodes: string[]; actionKinds: string[]; responseTypes: string[]; composites: string[] };
  /** Locale files (`locales/<lng>/<ns>.json`) and help pages (`help/<lng>/<page>.md`). */
  locales: Record<string, string[]>;
  help: Record<string, string[]>;
}

interface SharedOutput {
  responseTypes?: Record<string, ResponseTypeDef>;
  actionKinds?: ActionKindDef[];
  compositeTypes?: CompositeTypeDef[];
  compositePresets?: FeedCompositePreset[];
}

/** The SDK object handed to the backend and shared factories. */
export const BACKEND_SDK = Object.freeze({
  apiVersion: PLUGIN_API_VERSION,
  actions: PLUGIN_ACTIONS_SDK,
  signal: Object.freeze({ Node, SignalNode, eventIn, eventOut, valueIn, valueOut, listIn, mkEvent }),
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
});

function listDir(dir: string, ext: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!existsSync(dir)) return out;
  for (const lng of readdirSync(dir)) {
    const sub = join(dir, lng);
    if (!statSync(sub).isDirectory()) continue;
    const files = readdirSync(sub).filter((f) => f.endsWith(ext));
    if (files.length) out[lng] = files.sort();
  }
  return out;
}

/** English strings of a plugin, flattened (`a.b` → text), for backend labels. */
function englishStrings(dir: string, files: string[] = []): Record<string, string> {
  const flat: Record<string, string> = {};
  const walk = (o: unknown, prefix: string) => {
    if (typeof o === 'string') flat[prefix] = o;
    else if (o && typeof o === 'object')
      for (const [k, v] of Object.entries(o)) walk(v, prefix ? `${prefix}.${k}` : k);
  };
  for (const f of files) {
    try {
      walk(JSON.parse(readFileSync(join(dir, 'locales', 'en', f), 'utf8')), '');
    } catch {
      /* ignore a broken locale file here; the editor reports it */
    }
  }
  return flat;
}

async function importFactory(file: string): Promise<(sdk: unknown) => unknown> {
  // Cache-busting query: a dev plugin re-imported after a rebuild is fresh.
  const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as { default?: unknown };
  if (typeof mod.default !== 'function')
    throw new Error(`${file}: the default export must be a factory function (sdk) => …`);
  return mod.default as (sdk: unknown) => unknown;
}

export class PluginHost {
  private readonly plugins = new Map<string, LoadedPlugin>();
  /** Running vspark version (for `vspark` ranges); `0.0.0` in dev. */
  constructor(private readonly hostVersion: string = '0.0.0') {}

  get version(): string {
    return this.hostVersion;
  }

  list(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  get(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  /** The router of an active plugin (mounted at `/api/plugin/<id>/`). */
  routerOf(id: string): Router | undefined {
    const p = this.plugins.get(id);
    return p?.status === 'active' ? p.contributions.router : undefined;
  }

  /** Load every enabled installed plugin plus the dev folders. Never throws:
   *  each plugin's outcome is recorded on it. */
  async loadAll(opts: { dev?: string[]; settings?: Record<string, Record<string, unknown>> } = {}): Promise<void> {
    const state = readState();
    const dirs: Array<{ dir: string; source: PluginSource }> = [];
    for (const [id, inst] of Object.entries(state.installed))
      if (inst.enabled) dirs.push({ dir: pluginVersionDir(id, inst.version), source: 'installed' });
    for (const d of opts.dev ?? []) dirs.push({ dir: resolve(d), source: 'dev' });
    for (const { dir, source } of dirs) await this.load(dir, source, opts.settings);
  }

  /** Load one unpacked plugin folder. Returns the recorded outcome. */
  async load(
    dir: string,
    source: PluginSource,
    settings: Record<string, Record<string, unknown>> = {}
  ): Promise<LoadedPlugin | undefined> {
    let manifest: PluginManifest;
    try {
      manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')));
    } catch (e) {
      console.error(`[plugins] ${dir}: ${(e as Error).message}`);
      return undefined;
    }
    const id = manifest.id;
    if (this.plugins.get(id)?.status === 'active') {
      console.warn(`[plugins] ${id} is already loaded; ${dir} skipped`);
      return this.plugins.get(id);
    }
    const plugin: LoadedPlugin = {
      manifest,
      dir,
      source,
      status: 'failed',
      contributions: { disposers: [] },
      summary: { nodes: [], actionKinds: [], responseTypes: [], composites: [] },
      locales: listDir(join(dir, 'locales'), '.json'),
      help: listDir(join(dir, 'help'), '.md'),
    };
    this.plugins.set(id, plugin);

    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      plugin.status = 'incompatible';
      plugin.error = `plugin API ${manifest.apiVersion}, this vspark provides ${PLUGIN_API_VERSION}`;
      return plugin;
    }
    if (this.hostVersion !== '0.0.0' && !satisfies(this.hostVersion, manifest.vspark)) {
      plugin.status = 'incompatible';
      plugin.error = `needs vspark ${manifest.vspark}, this is ${this.hostVersion}`;
      return plugin;
    }

    try {
      let shared: SharedOutput = {};
      if (manifest.entries.shared) {
        const factory = await importFactory(join(dir, manifest.entries.shared));
        shared = (factory(BACKEND_SDK) ?? {}) as SharedOutput;
        this.registerShared(plugin, shared);
      }
      if (manifest.entries.backend) {
        const factory = await importFactory(join(dir, manifest.entries.backend));
        const backend = factory(BACKEND_SDK) as { activate?: (ctx: unknown) => unknown };
        if (typeof backend?.activate !== 'function')
          throw new Error('backend factory must return { activate(ctx) }');
        const ctx = createContext({
          pluginId: id,
          version: manifest.version,
          config: settings[id] ?? {},
          shared,
          accounts: createAccountsApi(id, (fn) => plugin.contributions.disposers.push(fn)),
          contributions: plugin.contributions,
        });
        const before = new Set(nodeKindsOf(id));
        await backend.activate(ctx);
        plugin.summary.nodes = nodeKindsOf(id).filter((k) => !before.has(k));
      }
      plugin.status = 'active';
      console.log(`[plugins] ${id} ${manifest.version} active (${source})`);
    } catch (e) {
      plugin.error = (e as Error)?.message ?? String(e);
      console.error(`[plugins] ${id} failed to activate: ${plugin.error}`);
      await this.rollback(plugin);
      plugin.status = 'failed';
    }
    return plugin;
  }

  private registerShared(plugin: LoadedPlugin, shared: SharedOutput): void {
    const id = plugin.manifest.id;
    for (const [typeId, def] of Object.entries(shared.responseTypes ?? {})) {
      registerResponseType(id, typeId, def);
      plugin.summary.responseTypes.push(typeId);
    }
    for (const def of shared.actionKinds ?? []) {
      registerActionKind(id, def);
      plugin.summary.actionKinds.push(def.kind);
    }
    for (const def of shared.compositeTypes ?? []) {
      registerCompositeType(id, def);
      plugin.summary.composites.push(def.type);
    }
    const en = englishStrings(plugin.dir, plugin.locales.en);
    const text = (key: string) => en[key] ?? key;
    for (const preset of shared.compositePresets ?? [])
      registerBuiltinComposite(id, feedCompositePayload(id, preset, text));
  }

  /** Undo everything a plugin registered (failed activation, shutdown). */
  private async rollback(plugin: LoadedPlugin): Promise<void> {
    const id = plugin.manifest.id;
    for (const fn of plugin.contributions.disposers.reverse()) {
      try {
        await fn();
      } catch (e) {
        console.warn(`[plugins] ${id} dispose failed:`, e);
      }
    }
    plugin.contributions.disposers = [];
    plugin.contributions.router = undefined;
    unregisterNodeKinds(id);
    unregisterActionContributions(id);
    unregisterCompositeContributions(id);
    unregisterBuiltinComposites(id);
  }

  /** Dispose every active plugin (server shutdown, tests). */
  async closeAll(): Promise<void> {
    for (const p of this.plugins.values()) if (p.status === 'active') await this.rollback(p);
    this.plugins.clear();
  }

  /** Is `file` (relative) a file of plugin `id` the browser may fetch? The
   *  backend entry and anything outside the plugin folder are refused. */
  browserFile(id: string, file: string): string | undefined {
    const p = this.plugins.get(id);
    if (!p || p.status !== 'active') return undefined;
    const abs = resolve(p.dir, file);
    if (!abs.startsWith(p.dir + sep)) return undefined;
    if (p.manifest.entries.backend && abs === resolve(p.dir, p.manifest.entries.backend)) return undefined;
    return existsSync(abs) && statSync(abs).isFile() ? abs : undefined;
  }
}

function nodeKindsOf(pluginId: string): string[] {
  return [...NODE_REGISTRY.keys()].filter((k) => pluginOfNodeKind(k) === pluginId);
}

/** The running vspark version from the release's version.json; `0.0.0` in
 *  dev (version ranges are then not enforced). */
function hostVersion(): string {
  try {
    const v = (JSON.parse(readFileSync(join(getInstallDir(), 'version.json'), 'utf8')) as { version?: string }).version;
    return typeof v === 'string' ? v.replace(/^v/, '') : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

let host: PluginHost | undefined;
/** The process-wide host (created on first use). */
export function getPluginHost(): PluginHost {
  return (host ??= new PluginHost(hostVersion()));
}
/** Tests: replace the host. */
export function setPluginHost(h: PluginHost | undefined): void {
  host = h;
}
