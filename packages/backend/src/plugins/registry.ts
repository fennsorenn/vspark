/**
 * Plugin registry manifests: a JSON file in a git repository (raw URL) listing
 * plugins and their released versions. See dev-notes/modules/plugins.md.
 */
import { PLUGIN_API_VERSION, compareVersions, satisfies } from './manifest.js';

/** The official registry (decided: user, 2026-11-26 — in the vspark repo for
 *  now; the URL is configurable in the app). */
export const OFFICIAL_REGISTRY =
  'https://raw.githubusercontent.com/fennsorenn/vspark/main/plugins/registry.json';

export type ReleaseChannel = 'stable' | 'recent' | 'experimental';

export interface RegistryVersion {
  version: string;
  apiVersion: number;
  vspark: string;
  channel: ReleaseChannel;
  url: string;
  sha256: string;
  notes?: Record<string, string>;
}

export interface RegistryPlugin {
  id: string;
  name: Record<string, string>;
  description: Record<string, string>;
  author: string;
  homepage?: string;
  icon?: string;
  tags?: string[];
  /** Hosts the plugin talks to (shown before installing). */
  network?: string[];
  versions: RegistryVersion[];
}

export interface Registry {
  schema: 1;
  plugins: RegistryPlugin[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const ID_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const CHANNELS: ReleaseChannel[] = ['stable', 'recent', 'experimental'];

/** Validate a registry document; drops (and reports) malformed entries
 *  instead of rejecting the whole registry. */
export function parseRegistry(raw: unknown): { registry: Registry; problems: string[] } {
  const problems: string[] = [];
  if (!isObj(raw) || raw.schema !== 1 || !Array.isArray(raw.plugins))
    throw new Error('not a vspark plugin registry (schema 1)');
  const plugins: RegistryPlugin[] = [];
  for (const p of raw.plugins as unknown[]) {
    if (!isObj(p) || typeof p.id !== 'string' || !ID_RE.test(p.id) || !Array.isArray(p.versions)) {
      problems.push(`skipped an entry without a valid id / versions`);
      continue;
    }
    const versions: RegistryVersion[] = [];
    for (const v of p.versions as unknown[]) {
      if (
        isObj(v) &&
        typeof v.version === 'string' &&
        typeof v.apiVersion === 'number' &&
        typeof v.vspark === 'string' &&
        typeof v.url === 'string' &&
        /^https:\/\//.test(v.url) &&
        typeof v.sha256 === 'string' &&
        /^[0-9a-f]{64}$/i.test(v.sha256)
      )
        versions.push({
          version: v.version,
          apiVersion: v.apiVersion,
          vspark: v.vspark,
          channel: CHANNELS.includes(v.channel as ReleaseChannel) ? (v.channel as ReleaseChannel) : 'stable',
          url: v.url,
          sha256: v.sha256.toLowerCase(),
          ...(isObj(v.notes) ? { notes: v.notes as Record<string, string> } : {}),
        });
      else problems.push(`${p.id}: skipped a malformed version (needs version, apiVersion, vspark, https url, sha256)`);
    }
    plugins.push({
      id: p.id,
      name: isObj(p.name) ? (p.name as Record<string, string>) : { en: p.id },
      description: isObj(p.description) ? (p.description as Record<string, string>) : {},
      author: typeof p.author === 'string' ? p.author : '',
      ...(typeof p.homepage === 'string' ? { homepage: p.homepage } : {}),
      ...(typeof p.icon === 'string' ? { icon: p.icon } : {}),
      ...(Array.isArray(p.tags) ? { tags: (p.tags as unknown[]).filter((t): t is string => typeof t === 'string') } : {}),
      ...(Array.isArray(p.network) ? { network: (p.network as unknown[]).filter((t): t is string => typeof t === 'string') } : {}),
      versions: versions.sort((a, b) => compareVersions(b.version, a.version)),
    });
  }
  return { registry: { schema: 1, plugins }, problems };
}

/** Channels a user on `channel` is offered (same idea as self-update). */
export function channelsFor(channel: ReleaseChannel): ReleaseChannel[] {
  return channel === 'experimental' ? CHANNELS : channel === 'recent' ? ['stable', 'recent'] : ['stable'];
}

/** Can this vspark run that version? `0.0.0` (dev) skips the range check. */
export function isCompatible(v: RegistryVersion, hostVersion: string): boolean {
  return v.apiVersion === PLUGIN_API_VERSION && (hostVersion === '0.0.0' || satisfies(hostVersion, v.vspark));
}

/** The newest compatible version on the user's channels. */
export function pickVersion(
  p: RegistryPlugin,
  hostVersion: string,
  channel: ReleaseChannel
): RegistryVersion | undefined {
  const allowed = channelsFor(channel);
  return p.versions.find((v) => allowed.includes(v.channel) && isCompatible(v, hostVersion));
}

export async function fetchRegistry(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ registry: Registry; problems: string[] }> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`registry ${url}: HTTP ${res.status}`);
  return parseRegistry(await res.json());
}
