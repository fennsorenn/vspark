/**
 * Plugin management commands: `plugin_command` requests on the control
 * channel, addressed to this tab's server, answered with `{ ok, error? }`
 * (backend plugins/manager.ts). Mesh principle 7 — no REST.
 */
import type { PluginCommand } from '@vspark/shared/types';
import { collectionOf } from './docs';
import { getMeshHandles } from './peer';

export interface CommandReply {
  ok: boolean;
  /** An error code (see `plugins:error.*`) or a message. */
  error?: string;
}

let seq = 0;

/** Send one command to our server and wait for its answer. Installing can
 *  take a while (download), hence the long timeout. */
export async function sendPluginCommand(cmd: PluginCommand, timeoutMs = 180_000): Promise<CommandReply> {
  const handles = getMeshHandles();
  if (!handles) return { ok: false, error: 'offline' };
  const id = `cmd-${Date.now().toString(36)}-${(seq++).toString(36)}`;
  const out = await collectionOf<{ id: string }>('plugin_command').request(
    id,
    { id, ...cmd },
    { to: handles.serverPeerId, timeoutMs }
  );
  if (out.status === 'replied') {
    const data = out.data as { ok?: boolean; error?: string } | undefined;
    return { ok: data?.ok === true, ...(data?.error ? { error: data.error } : {}) };
  }
  return { ok: false, error: out.status === 'error' ? (out.reason ?? 'error') : out.status };
}
