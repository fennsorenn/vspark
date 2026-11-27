/**
 * The Plugins window over the mesh: `plugin_catalog` documents (runtime
 * channel, written by this server, read by our tabs) and `plugin_command`
 * requests (control channel) that our tabs send and this server answers.
 * Nothing here is granted to remote peers.
 */
import type { Collection, MeshPeer } from '@vspark/mesh';
import type { PluginCatalogDoc, PluginCommand, PluginHostStatus } from '@vspark/shared/types';
import { publishStatus } from './status.js';

export const PLUGIN_CATALOG_RTYPE = 'plugin_catalog';
export const PLUGIN_COMMAND_RTYPE = 'plugin_command';

let _catalog: Collection<PluginCatalogDoc> | null = null;
let _commands: Collection<{ id: string } & Record<string, unknown>> | null = null;
let _handler: ((cmd: PluginCommand) => Promise<{ ok: boolean; error?: string }>) | null = null;

export function initMeshPluginCatalog(peer: MeshPeer): void {
  if (_catalog) return;
  _catalog = peer.collection<PluginCatalogDoc>(PLUGIN_CATALOG_RTYPE);
  _commands = peer.collection(PLUGIN_COMMAND_RTYPE);
  peer.grants.grant({
    grantee: peer.id,
    entityRtype: PLUGIN_CATALOG_RTYPE,
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true },
  });
  // Our tabs may send commands (a request is a write on the control channel).
  peer.grants.grant({
    grantee: peer.id,
    entityRtype: PLUGIN_COMMAND_RTYPE,
    entityId: '*',
    includeDescendants: false,
    pathPrefix: '',
    rights: { read: true, create: true, update: true },
  });
  const commands = _commands;
  commands.observe('**', (change) => {
    if (!change.request) return;
    const cmd = change.doc as unknown as PluginCommand | undefined;
    const run = _handler && cmd ? _handler(cmd) : Promise.resolve({ ok: false, error: 'not_ready' });
    void run.then((reply) => commands.reply(change, { id: change.id, ...reply }));
  });
}

export function resetMeshPluginCatalog(): void {
  _catalog = null;
  _commands = null;
}

/** Who answers commands (the plugin manager, set at boot). */
export function setPluginCommandHandler(
  fn: ((cmd: PluginCommand) => Promise<{ ok: boolean; error?: string }>) | null
): void {
  _handler = fn;
}

/** Bring the catalog documents and the host status in line. */
export function publishCatalog(docs: PluginCatalogDoc[], status: PluginHostStatus): void {
  if (_catalog) {
    const want = new Set(docs.map((d) => d.id));
    for (const d of _catalog.all()) if (!want.has(d.id)) _catalog.remove(d.id, { channel: 'runtime' });
    for (const d of docs) _catalog.set(d.id, '', d, { channel: 'runtime' });
  }
  publishStatus('plugins', 'main', status as unknown as Record<string, unknown>);
}

export function pluginCatalogCollection(): Collection<PluginCatalogDoc> | null {
  return _catalog;
}
