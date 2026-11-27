/**
 * Plugin management: registries → catalog, install / update / enable /
 * disable / uninstall, pending changes, restart. Driven by `plugin_command`
 * mesh requests from the editor (mesh principle 7 — no REST), reported as
 * `plugin_catalog` documents plus a `server_status` document (kind
 * `plugins`, key `main`). See dev-notes/modules/plugins.md#managing.
 *
 * What takes effect when (decided: user, 2026-11-26 — restart is fine where
 * live activation would be hacky):
 * - install / enable of a plugin that is not running: live.
 * - disable / uninstall / update of a running plugin: at the next start
 *   (ESM modules cannot be unloaded; running graphs hold its classes).
 */
import type { PluginCatalogDoc, PluginCommand, PluginHostStatus } from '@vspark/shared/types';
import type { AppConfig } from '@vspark/shared/types';
import { readConfig, writeConfig } from '../routes/config.js';
import { getInstallDir } from '../routes/update.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logicManager } from '../logic/manager.js';
import { getPluginHost, type PluginHost } from './loader.js';
import { pluginVersionDir } from './paths.js';
import { readState, writeState, type PluginState } from './state.js';
import { downloadAndUnpack, removeInstalled } from './installer.js';
import {
  OFFICIAL_REGISTRY,
  fetchRegistry,
  isCompatible,
  pickVersion,
  type RegistryPlugin,
  type ReleaseChannel,
} from './registry.js';

export interface RegistryConfig {
  url: string;
  /** Plugins of an untrusted registry are listed but cannot be installed
   *  (decided: user, 2026-11-26 — third-party registries need an opt-in). */
  trusted: boolean;
}

interface RegistryResult {
  url: string;
  trusted: boolean;
  official: boolean;
  ok: boolean;
  error: string | null;
  problems: string[];
  checkedAt: string | null;
  plugins: RegistryPlugin[];
}

type Job = NonNullable<PluginCatalogDoc['job']>;

export interface ManagerDeps {
  host?: PluginHost;
  fetch?: typeof fetch;
  /** Publish the catalog and host status (mesh/pluginCatalog.ts). */
  publish?: (docs: PluginCatalogDoc[], status: PluginHostStatus) => void;
  /** Re-publish `plugin` documents after the host changed. */
  publishPlugins?: () => void;
  /** Exit for a restart (exit code 42: the release start script relaunches). */
  exit?: (code: number) => void;
  hostVersion?: string;
}

export function defaultRegistries(cfg: AppConfig): RegistryConfig[] {
  const list = (cfg.plugins as { registries?: RegistryConfig[] } | undefined)?.registries;
  return Array.isArray(list) && list.length
    ? list.filter((r) => typeof r?.url === 'string').map((r) => ({ url: r.url, trusted: r.url === OFFICIAL_REGISTRY || r.trusted === true }))
    : [{ url: OFFICIAL_REGISTRY, trusted: true }];
}

/** Is this a packaged build whose start script relaunches on exit code 42? */
function canRestart(): boolean {
  return existsSync(join(getInstallDir(), 'version.json'));
}

/**
 * Apply what was scheduled for the next start (disable / uninstall / update)
 * before plugins load. Called at boot.
 */
export function applyPendingChanges(): void {
  const state = readState();
  let changed = false;
  for (const [id, inst] of Object.entries(state.installed)) {
    const p = inst.pending;
    if (!p) continue;
    changed = true;
    delete inst.pending;
    if (p.action === 'uninstall') {
      removeInstalled(id);
      delete state.installed[id];
    } else if (p.action === 'disable') inst.enabled = false;
    else if (p.action === 'enable') inst.enabled = true;
    else if (p.action === 'update' && p.version && existsSync(pluginVersionDir(id, p.version))) {
      const old = inst.version;
      inst.version = p.version;
      if (old !== p.version) removeInstalled(id, old);
    }
  }
  if (changed) writeState(state);
}

export class PluginManager {
  private readonly host: PluginHost;
  private readonly fetchImpl: typeof fetch;
  private registries: RegistryResult[] = [];
  private readonly jobs = new Map<string, Job>();
  private restartRequired = false;
  private channel: ReleaseChannel = 'stable';
  private readonly hostVersion: string;

  constructor(private readonly deps: ManagerDeps = {}) {
    this.host = deps.host ?? getPluginHost();
    this.fetchImpl = deps.fetch ?? fetch;
    this.hostVersion = deps.hostVersion ?? '0.0.0';
  }

  /** Read the configured registries and fetch them (never throws). */
  async refresh(): Promise<void> {
    const cfg = await readConfig();
    this.channel = (cfg.channel as ReleaseChannel) ?? 'stable';
    const list = defaultRegistries(cfg);
    this.registries = list.map((r) => ({
      url: r.url,
      trusted: r.trusted,
      official: r.url === OFFICIAL_REGISTRY,
      ok: false,
      error: null,
      problems: [],
      checkedAt: null,
      plugins: [],
    }));
    this.publish();
    await Promise.all(
      this.registries.map(async (r) => {
        try {
          const { registry, problems } = await fetchRegistry(r.url, this.fetchImpl);
          Object.assign(r, { ok: true, plugins: registry.plugins, problems });
        } catch (e) {
          r.error = (e as Error).message;
        }
        r.checkedAt = new Date().toISOString();
      })
    );
    this.publish();
  }

  /** Where plugin `id` is offered: the first registry listing it wins. */
  private offer(id: string): { reg: RegistryResult; plugin: RegistryPlugin } | undefined {
    for (const reg of this.registries) {
      const plugin = reg.plugins.find((p) => p.id === id);
      if (plugin) return { reg, plugin };
    }
    return undefined;
  }

  catalog(): PluginCatalogDoc[] {
    const state = readState();
    const ids = new Set<string>([
      ...this.registries.flatMap((r) => r.plugins.map((p) => p.id)),
      ...Object.keys(state.installed),
      ...this.host.list().map((p) => p.manifest.id),
    ]);
    const docs: PluginCatalogDoc[] = [];
    for (const id of ids) {
      const offer = this.offer(id);
      const loaded = this.host.get(id);
      const inst = state.installed[id];
      const m = loaded?.manifest;
      const latest = offer ? pickVersion(offer.plugin, this.hostVersion, this.channel) : undefined;
      docs.push({
        id,
        pluginId: id,
        name: offer?.plugin.name ?? m?.name ?? { en: id },
        description: offer?.plugin.description ?? m?.description ?? {},
        author: offer?.plugin.author ?? m?.author ?? '',
        homepage: offer?.plugin.homepage ?? m?.homepage ?? null,
        tags: offer?.plugin.tags ?? [],
        network: offer?.plugin.network ?? m?.network ?? [],
        registry: offer ? { url: offer.reg.url, trusted: offer.reg.trusted, official: offer.reg.official } : null,
        versions: (offer?.plugin.versions ?? []).map((v) => ({
          version: v.version,
          channel: v.channel,
          compatible: isCompatible(v, this.hostVersion),
          notes: v.notes ?? {},
        })),
        latest: latest?.version ?? null,
        installed: inst
          ? { version: inst.version, enabled: inst.enabled, source: 'installed' }
          : loaded?.source === 'dev'
            ? { version: loaded.manifest.version, enabled: true, source: 'dev' }
            : null,
        running: loaded ? { version: loaded.manifest.version, status: loaded.status, error: loaded.error ?? null } : null,
        pending: inst?.pending ?? null,
        job: this.jobs.get(id) ?? null,
      });
    }
    return docs.sort((a, b) => a.id.localeCompare(b.id));
  }

  hostStatus(): PluginHostStatus {
    return {
      registries: this.registries.map((r) => ({
        url: r.url,
        trusted: r.trusted,
        official: r.official,
        ok: r.ok,
        error: r.error,
        problems: r.problems,
        checkedAt: r.checkedAt,
        count: r.plugins.length,
      })),
      restartRequired: this.restartRequired || Object.values(readState().installed).some((i) => !!i.pending),
      canRestart: canRestart(),
      hostVersion: this.hostVersion,
      channel: this.channel,
    };
  }

  publish(): void {
    this.deps.publish?.(this.catalog(), this.hostStatus());
  }

  private setJob(id: string, job: Job | null): void {
    if (job) this.jobs.set(id, job);
    else this.jobs.delete(id);
    this.publish();
  }

  private update(fn: (s: PluginState) => void): void {
    const s = readState();
    fn(s);
    writeState(s);
  }

  /** Load an installed plugin now and restart the graphs that use its nodes. */
  private async loadLive(id: string, version: string): Promise<void> {
    const cfg = await readConfig();
    const p = await this.host.load(pluginVersionDir(id, version), 'installed', cfg.plugins?.settings ?? {});
    this.deps.publishPlugins?.();
    if (p?.status !== 'active') return;
    const kinds = new Set(p.summary.nodes);
    if (!kinds.size) return;
    const graphs = new Set<string>();
    for (const { graphId, node } of logicManager.iterateNodes()) if (kinds.has(node.kind)) graphs.add(graphId);
    for (const g of graphs) logicManager.reconcile(g);
  }

  /** Handle one editor command. Resolves with the reply (never throws). */
  async handle(cmd: PluginCommand): Promise<{ ok: boolean; error?: string }> {
    try {
      switch (cmd.action) {
        case 'refresh':
          await this.refresh();
          return { ok: true };
        case 'install':
        case 'update':
          return await this.install(cmd.pluginId, cmd.version, cmd.action);
        case 'enable':
          return await this.enable(cmd.pluginId);
        case 'disable':
          return this.schedule(cmd.pluginId, 'disable');
        case 'uninstall':
          return this.schedule(cmd.pluginId, 'uninstall');
        case 'cancel_pending':
          this.update((s) => {
            if (s.installed[cmd.pluginId]) delete s.installed[cmd.pluginId]!.pending;
          });
          this.publish();
          return { ok: true };
        case 'set_registries':
          return await this.setRegistries(cmd.registries);
        case 'restart':
          if (!canRestart()) return { ok: false, error: 'not_packaged' };
          setTimeout(() => (this.deps.exit ?? process.exit)(42), 500);
          return { ok: true };
        default:
          return { ok: false, error: 'unknown_action' };
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async install(id: string, version: string | undefined, action: 'install' | 'update') {
    if (this.jobs.get(id)?.state === 'running') return { ok: false, error: 'busy' };
    const offer = this.offer(id);
    if (!offer) return { ok: false, error: 'not_in_registry' };
    if (!offer.reg.trusted) return { ok: false, error: 'untrusted_registry' };
    const v = version
      ? offer.plugin.versions.find((x) => x.version === version)
      : pickVersion(offer.plugin, this.hostVersion, this.channel);
    if (!v) return { ok: false, error: 'no_compatible_version' };
    if (!isCompatible(v, this.hostVersion)) return { ok: false, error: 'incompatible' };
    const inst = readState().installed[id];
    if (inst?.version === v.version && action === 'install') return { ok: false, error: 'already_installed' };

    this.setJob(id, { action, state: 'running', version: v.version, error: null, progress: 0 });
    try {
      let last = 0;
      await downloadAndUnpack(id, v, this.fetchImpl, (got, total) => {
        const progress = total ? Math.min(1, got / total) : 0;
        if (progress - last >= 0.1) {
          last = progress;
          this.setJob(id, { action, state: 'running', version: v.version, error: null, progress });
        }
      });
    } catch (e) {
      this.setJob(id, { action, state: 'failed', version: v.version, error: (e as Error).message, progress: null });
      return { ok: false, error: (e as Error).message };
    }
    const running = this.host.get(id)?.status === 'active';
    this.update((s) => {
      const cur = s.installed[id];
      if (running && cur) {
        // A running plugin is swapped at the next start.
        cur.pending = { action: 'update', version: v.version };
      } else {
        s.installed[id] = {
          version: v.version,
          enabled: true,
          registry: offer.reg.url,
          sha256: v.sha256,
          installedAt: new Date().toISOString(),
        };
      }
    });
    if (running) this.restartRequired = true;
    else await this.loadLive(id, v.version);
    this.setJob(id, { action, state: 'done', version: v.version, error: null, progress: 1 });
    return { ok: true };
  }

  private async enable(id: string) {
    const inst = readState().installed[id];
    if (!inst) return { ok: false, error: 'not_installed' };
    this.update((s) => {
      s.installed[id]!.enabled = true;
      delete s.installed[id]!.pending;
    });
    if (this.host.get(id)?.status !== 'active') await this.loadLive(id, inst.version);
    this.publish();
    return { ok: true };
  }

  private schedule(id: string, action: 'disable' | 'uninstall') {
    const inst = readState().installed[id];
    if (!inst) return { ok: false, error: this.host.get(id)?.source === 'dev' ? 'dev_plugin' : 'not_installed' };
    const running = this.host.get(id)?.status === 'active';
    if (!running) {
      // Not running: nothing to unload, so do it now.
      if (action === 'uninstall') {
        removeInstalled(id);
        this.update((s) => void delete s.installed[id]);
      } else this.update((s) => void (s.installed[id]!.enabled = false));
    } else {
      this.update((s) => void (s.installed[id]!.pending = { action }));
      this.restartRequired = true;
    }
    this.publish();
    return { ok: true };
  }

  private async setRegistries(list: unknown) {
    if (!Array.isArray(list)) return { ok: false, error: 'invalid' };
    const registries: RegistryConfig[] = [];
    for (const r of list as Array<Record<string, unknown>>) {
      if (typeof r?.url !== 'string' || !/^https:\/\/\S+$/.test(r.url)) return { ok: false, error: 'invalid_url' };
      if (!registries.some((x) => x.url === r.url)) registries.push({ url: r.url, trusted: r.trusted === true });
    }
    const cfg = await readConfig();
    await writeConfig({ ...cfg, plugins: { ...cfg.plugins, registries } as AppConfig['plugins'] });
    await this.refresh();
    return { ok: true };
  }
}

let manager: PluginManager | undefined;
export function getPluginManager(): PluginManager | undefined {
  return manager;
}
export function setPluginManager(m: PluginManager | undefined): void {
  manager = m;
}
