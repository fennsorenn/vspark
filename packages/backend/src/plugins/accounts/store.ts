/**
 * Plugin account store. Phase 2 stub: providers are recorded, no account can
 * exist yet (the table, OAuth routes and Accounts window arrive in phase 3).
 */
import type { AccountProviderDef, PluginAccountsApi } from './api.js';

export const PROVIDERS = new Map<string, AccountProviderDef & { pluginId: string }>();

export function createAccountsApi(
  pluginId: string,
  onDispose: (fn: () => void) => void
): PluginAccountsApi {
  return {
    defineProvider(def) {
      const id = `${pluginId}:${def.id}`;
      if (PROVIDERS.has(id)) throw new Error(`account provider "${id}" already exists`);
      PROVIDERS.set(id, { ...def, pluginId });
      onDispose(() => PROVIDERS.delete(id));
    },
    list: () => [],
    get: () => undefined,
    defaultFor: () => undefined,
    withToken: () => Promise.reject(new Error('no account connected')),
    invalidate: () => {},
    setStatus: () => {},
    onChanged: () => () => {},
  };
}
