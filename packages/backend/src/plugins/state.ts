import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { statePath } from './paths.js';

/** Install state of one plugin (per installation, not per project). */
export interface InstalledPlugin {
  version: string;
  enabled: boolean;
  /** Registry URL it was installed from. */
  registry?: string;
  /** SHA-256 of the zip it was installed from. */
  sha256?: string;
  installedAt?: string;
  /** Takes effect at the next start (disable / update / uninstall). */
  pending?: { action: 'disable' | 'enable' | 'uninstall' | 'update'; version?: string };
}

export interface PluginState {
  installed: Record<string, InstalledPlugin>;
}

export function readState(): PluginState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<PluginState>;
    return { installed: raw.installed && typeof raw.installed === 'object' ? raw.installed : {} };
  } catch {
    return { installed: {} };
  }
}

/** Atomic write (temp file + rename) so a crash never leaves half a file. */
export function writeState(state: PluginState): void {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}
