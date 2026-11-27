/**
 * `plugin.json` — what a plugin package declares about itself. Validated
 * before anything of the plugin is imported.
 */
export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: number;
  /** Semver range of vspark versions the plugin supports. */
  vspark: string;
  name: Record<string, string>;
  description: Record<string, string>;
  author: string;
  homepage?: string;
  icon?: string;
  entries: { backend?: string; shared?: string; ui?: string };
  /** Hosts the plugin talks to (shown before installing). */
  network?: string[];
}

const ID_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ENTRY_RE = /^[\w.-]+\.mjs$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strMap = (v: unknown): v is Record<string, string> =>
  isObj(v) && Object.values(v).every((x) => typeof x === 'string');

/** Validate a parsed `plugin.json`; throws with every problem listed. */
export function parseManifest(raw: unknown): PluginManifest {
  const errors: string[] = [];
  if (!isObj(raw)) throw new Error('plugin.json: not an object');
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !ID_RE.test(m.id))
    errors.push('id must be lowercase snake case (e.g. "spotify")');
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version))
    errors.push('version must be semver (x.y.z)');
  if (typeof m.apiVersion !== 'number') errors.push('apiVersion must be a number');
  if (typeof m.vspark !== 'string') errors.push('vspark must be a semver range');
  if (!strMap(m.name) || !m.name.en) errors.push('name must map locales to text (with "en")');
  if (!strMap(m.description)) errors.push('description must map locales to text');
  if (typeof m.author !== 'string') errors.push('author must be a string');
  const entries = isObj(m.entries) ? m.entries : null;
  if (!entries) errors.push('entries must be an object');
  else
    for (const k of ['backend', 'shared', 'ui'] as const) {
      const e = entries[k];
      if (e !== undefined && (typeof e !== 'string' || !ENTRY_RE.test(e)))
        errors.push(`entries.${k} must be a file name ending in .mjs`);
    }
  if (m.network !== undefined && (!Array.isArray(m.network) || m.network.some((h) => typeof h !== 'string')))
    errors.push('network must be a list of host names');
  if (errors.length) throw new Error(`plugin.json: ${errors.join('; ')}`);
  return m as unknown as PluginManifest;
}

// ── semver (enough for "x.y.z" versions and simple ranges) ───────────────────

function parts(v: string): [number, number, number, string] {
  const [core, pre = ''] = v.trim().replace(/^v/, '').split('-', 2) as [string, string?];
  const [a = 0, b = 0, c = 0] = core.split('.').map((n) => Number(n));
  return [a, b, c, pre];
}

/** -1 / 0 / 1; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] as number) < (pb[i] as number) ? -1 : 1;
  if (pa[3] === pb[3]) return 0;
  if (!pa[3]) return 1;
  if (!pb[3]) return -1;
  return pa[3] < pb[3] ? -1 : 1;
}

/**
 * Does `version` satisfy `range`? Supports space-separated comparators
 * (`>=0.13.0 <1.0.0`), `^x.y.z`, `~x.y.z`, an exact version and `*`.
 * Pre-release tags of the running build are ignored for range checks.
 */
export function satisfies(version: string, range: string): boolean {
  const v = version.replace(/-.*$/, '');
  return range
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((c) => {
      if (c === '*' || c === 'x') return true;
      const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(c);
      if (!m) return false;
      const [, op = '=', target] = m as unknown as [string, string, string];
      const cmp = compareVersions(v, target);
      const [ta, tb] = parts(target);
      switch (op) {
        case '>=': return cmp >= 0;
        case '<=': return cmp <= 0;
        case '>': return cmp > 0;
        case '<': return cmp < 0;
        case '^': return cmp >= 0 && (ta > 0 ? parts(v)[0] === ta : parts(v)[1] === tb);
        case '~': return cmp >= 0 && parts(v)[0] === ta && parts(v)[1] === tb;
        default: return cmp === 0;
      }
    });
}
