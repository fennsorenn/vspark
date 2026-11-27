/**
 * The `ctx` a plugin's `activate(ctx)` receives: the host services a plugin
 * may use. Everything a plugin registers through it is recorded on the
 * `Contributions` so the loader can roll it back when activation fails.
 * See dev-notes/modules/plugins.md.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import { mkEvent } from '@vspark/shared/signal';
import type { SignalNodeClass } from '@vspark/shared/signal';
import { getDb } from '../db/index.js';
import { logicManager } from '../logic/manager.js';
import { dataChannelManager, projectDataScope } from '../data_channels/manager.js';
import { getMeshCollection } from '../mesh/index.js';
import { registerNodeKinds } from '../signal/registry.js';
import { pluginDataDir } from './paths.js';
import { projectEvents } from './projectEvents.js';
import type { PluginAccountsApi } from './accounts/api.js';

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface StorageApi {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly version: string;
  readonly nodes: { register(...classes: SignalNodeClass[]): void };
  readonly accounts: PluginAccountsApi;
  readonly logic: {
    routeEvent(projectId: string, kind: string, port: string, payload: unknown, accountId?: string): void;
    hasConsumers(projectId: string, kinds: readonly string[]): boolean;
  };
  readonly data: {
    publish(projectId: string, fields: Record<string, unknown>): void;
    isReferenced(projectId: string, field: string): boolean;
  };
  readonly storage: StorageApi & { project(projectId: string): StorageApi };
  readonly projects: {
    loaded(): string[];
    onLoaded(fn: (projectId: string) => void): () => void;
    onUnloaded(fn: (projectId: string) => void): () => void;
  };
  readonly http: { router(): Router };
  readonly log: Logger;
  readonly config: Record<string, unknown>;
  readonly shared: unknown;
  onDispose(fn: () => void | Promise<void>): void;
}

/** What one plugin has registered, for rollback / shutdown. */
export interface Contributions {
  router?: Router;
  disposers: Array<() => void | Promise<void>>;
}

/** JSON key-value file in the plugin's data folder. Writes are atomic. */
function fileStore(file: string): Map<string, unknown> & { flush(): void } {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* first use */
  }
  const map = new Map(Object.entries(data)) as Map<string, unknown> & { flush(): void };
  map.flush = () => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(map)));
    renameSync(`${file}.tmp`, file);
  };
  return map;
}

function storageOf(store: ReturnType<typeof fileStore>, prefix: string): StorageApi {
  return {
    get: <T>(key: string) => store.get(prefix + key) as T | undefined,
    set: (key, value) => {
      store.set(prefix + key, value);
      store.flush();
    },
    delete: (key) => {
      if (store.delete(prefix + key)) store.flush();
    },
  };
}

function prefixed(pluginId: string, level: 'log' | 'warn' | 'error') {
  return (...args: unknown[]) => console[level](`[plugin:${pluginId}]`, ...args);
}

export function createContext(opts: {
  pluginId: string;
  version: string;
  config: Record<string, unknown>;
  shared: unknown;
  accounts: PluginAccountsApi;
  contributions: Contributions;
}): PluginContext {
  const { pluginId, contributions } = opts;
  const store = fileStore(join(pluginDataDir(pluginId), 'storage.json'));
  const onDispose = (fn: () => void | Promise<void>) => contributions.disposers.push(fn);
  const subscribe = (event: string, fn: (id: string) => void) => {
    projectEvents.on(event, fn);
    const off = () => {
      projectEvents.off(event, fn);
    };
    onDispose(off);
    return off;
  };

  return {
    pluginId,
    version: opts.version,
    nodes: {
      register: (...classes) => registerNodeKinds(pluginId, classes),
    },
    accounts: opts.accounts,
    logic: {
      routeEvent(projectId, kind, port, payload, accountId) {
        for (const { graphId, node, projectId: p } of logicManager.iterateNodes()) {
          if (p !== projectId || node.kind !== kind) continue;
          if (accountId !== undefined) {
            // A wired port wins, else the inline value; empty = any account
            // (the project's default — plugin accounts are one per provider
            // in practice, see plugins.md).
            const wired = logicManager.pullInput(graphId, node.id, 'account');
            const want =
              typeof wired === 'string' && wired !== ''
                ? wired
                : typeof node.defaultConfig?.account === 'string'
                  ? node.defaultConfig.account
                  : '';
            if (want !== '' && want !== accountId) continue;
          }
          logicManager.fire(graphId, node.id, port, mkEvent(payload));
        }
      },
      hasConsumers(projectId, kinds) {
        for (const { node, projectId: p } of logicManager.iterateNodes())
          if (p === projectId && kinds.includes(node.kind)) return true;
        return false;
      },
    },
    data: {
      // The project's scope: that project's feeds see the fields by bare
      // name, other projects never do (decided: user, 2026-11-27 — plugin
      // data is not shared between projects).
      publish: (projectId, fields) => dataChannelManager.set(projectDataScope(projectId), fields),
      isReferenced(projectId, field) {
        const layers = getMeshCollection('compose_layer')?.all() ?? [];
        return layers.some((l) => {
          const doc = l as { kind?: string; projectId?: string; config?: { template?: unknown } };
          return (
            doc.kind === 'feed' &&
            doc.projectId === projectId &&
            typeof doc.config?.template === 'string' &&
            doc.config.template.includes(field)
          );
        });
      },
    },
    storage: {
      ...storageOf(store, ''),
      project: (projectId) => storageOf(store, `project:${projectId}:`),
    },
    projects: {
      loaded: () =>
        (getDb().prepare('SELECT id FROM projects').all() as { id: string }[]).map((r) => r.id),
      onLoaded: (fn) => subscribe('created', fn),
      onUnloaded: (fn) => subscribe('deleted', fn),
    },
    http: {
      router() {
        if (!contributions.router) contributions.router = Router();
        return contributions.router;
      },
    },
    log: {
      info: prefixed(pluginId, 'log'),
      warn: prefixed(pluginId, 'warn'),
      error: prefixed(pluginId, 'error'),
    },
    config: opts.config,
    shared: opts.shared,
    onDispose,
  };
}
