import { join } from 'node:path';
import { getInstallDir } from '../routes/update.js';

/** Where installed plugins live: `<install dir>/plugins` (next to the DB and
 *  config.json, so self-updates leave it alone). VSPARK_PLUGINS_DIR overrides
 *  it (tests, custom installs). */
export function pluginsDir(): string {
  return process.env.VSPARK_PLUGINS_DIR ?? join(getInstallDir(), 'plugins');
}

/** The unpacked package of one installed plugin version. */
export function pluginVersionDir(id: string, version: string): string {
  return join(pluginsDir(), id, version);
}

/** A plugin's own data folder (kept across versions; `ctx.storage`). */
export function pluginDataDir(id: string): string {
  return join(pluginsDir(), id, 'data');
}

export function statePath(): string {
  return join(pluginsDir(), 'state.json');
}
