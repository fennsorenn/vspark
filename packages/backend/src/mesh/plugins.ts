/**
 * Plugins as mesh documents (`plugin` rtype, runtime channel): what this
 * server loaded, for its tabs (the editor's plugin loader and Plugins window
 * read them — mesh principle 7, no REST) and, name only, for the peers this
 * server shares content with.
 *
 * - Our tabs: read everything (status, locales, help, contributions).
 * - A peer we share a collab scene or an object with: read `name` only
 *   (decided: user, 2026-11-27), so its editor can say which plugin a node or
 *   object it cannot run needs. Granted while at least one share exists.
 * - Plugin code is not here: it is served as static files (`/plugin-files`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Collection, MeshPeer } from '@vspark/mesh';
import type { PluginDoc } from '@vspark/shared/types';
import type { LoadedPlugin } from '../plugins/loader.js';
import { PROVIDERS } from '../plugins/accounts/store.js';
import { oauthRedirectUri } from '../plugins/accounts/oauth.js';

export const PLUGIN_RTYPE = 'plugin';

let _col: Collection<PluginDoc> | null = null;
let _peer: MeshPeer | null = null;

export function initMeshPlugins(peer: MeshPeer): void {
  if (_col) return;
  _peer = peer;
  _col = peer.collection<PluginDoc>(PLUGIN_RTYPE);
  peer.grants.grant({
    grantee: peer.id, // our tabs read; only we write
    entityRtype: PLUGIN_RTYPE,
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true },
  });
}

export function resetMeshPlugins(): void {
  _col = null;
  _peer = null;
  nameGrants.clear();
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(into: Record<string, unknown>, from: unknown) {
  if (!isObj(from)) return into;
  for (const [k, v] of Object.entries(from)) {
    if (isObj(v) && isObj(into[k])) merge(into[k] as Record<string, unknown>, v);
    else into[k] = v;
  }
  return into;
}

/** The document for one loaded plugin. */
export function pluginDoc(serverPeerId: string, p: LoadedPlugin): PluginDoc {
  const m = p.manifest;
  const locales: PluginDoc['locales'] = {};
  for (const [lng, files] of Object.entries(p.locales)) {
    const bundle: Record<string, unknown> = {};
    for (const f of files) {
      try {
        merge(bundle, JSON.parse(readFileSync(join(p.dir, 'locales', lng, f), 'utf8')));
      } catch (e) {
        console.warn(`[plugins] ${m.id}: locales/${lng}/${f}: ${(e as Error).message}`);
      }
    }
    locales[lng] = bundle;
  }
  const help: PluginDoc['help'] = {};
  for (const [lng, pages] of Object.entries(p.help)) {
    help[lng] = {};
    for (const page of pages)
      help[lng]![page.replace(/\.md$/, '')] = readFileSync(join(p.dir, 'help', lng, page), 'utf8');
  }
  return {
    id: `${serverPeerId}:${m.id}`,
    name: m.name,
    pluginId: m.id,
    server: serverPeerId,
    version: m.version,
    description: m.description,
    author: m.author,
    homepage: m.homepage ?? null,
    network: m.network ?? [],
    source: p.source,
    status: p.status,
    error: p.error ?? null,
    contributes: p.summary,
    baseUrl: `/plugin-files/${m.id}`,
    entries: { shared: m.entries.shared ?? null, ui: m.entries.ui ?? null },
    locales,
    help,
    providers: [...PROVIDERS.values()]
      .filter((pr) => pr.pluginId === m.id)
      .map((pr) => ({
        id: pr.fullId,
        label: pr.label,
        appFields: pr.auth.appFields.map((f) => ({ path: f.path, label: f.label, ...(f.hint ? { hint: f.hint } : {}) })),
        ...(pr.setupHelp ? { setupHelp: pr.setupHelp } : {}),
        redirectUri: oauthRedirectUri(),
      })),
  };
}

/** Bring the collection in line with what the host has loaded. */
export function publishPlugins(plugins: LoadedPlugin[]): void {
  if (!_col || !_peer) return;
  const want = new Map(plugins.map((p) => [`${_peer!.id}:${p.manifest.id}`, p]));
  for (const d of _col.all())
    if (d.server === _peer.id && !want.has(d.id)) _col.remove(d.id, { channel: 'runtime' });
  for (const [id, p] of want) _col.set(id, '', pluginDoc(_peer.id, p), { channel: 'runtime' });
}

// ── name-only grants to the peers we share with ──────────────────────────────

/** grantee → { grant id, the shares that hold it }. */
const nameGrants = new Map<string, { gid: string; holders: Set<string> }>();

/** A share with `grantee` exists (`holder` names it, e.g. `collab:<scene>`):
 *  let that peer read the names of our plugins. Idempotent. */
export function holdPluginNameGrant(peer: MeshPeer, grantee: string, holder: string): void {
  const cur = nameGrants.get(grantee);
  if (cur) {
    cur.holders.add(holder);
    return;
  }
  const gid = peer.grants.grant({
    grantee,
    entityRtype: PLUGIN_RTYPE,
    entityId: '*',
    includeDescendants: false,
    pathPrefix: 'name',
    rights: { read: true },
  });
  nameGrants.set(grantee, { gid, holders: new Set([holder]) });
}

/** That share ended; the grant goes with the last one. */
export function releasePluginNameGrant(peer: MeshPeer, grantee: string, holder: string): void {
  const cur = nameGrants.get(grantee);
  if (!cur) return;
  cur.holders.delete(holder);
  if (cur.holders.size) return;
  peer.grants.revoke(cur.gid);
  nameGrants.delete(grantee);
}

/** The collection, or null before the mesh is up. */
export function pluginCollection(): Collection<PluginDoc> | null {
  return _col;
}
