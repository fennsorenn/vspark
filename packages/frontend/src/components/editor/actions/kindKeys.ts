/**
 * i18n keys for an Action kind's label / description. Built-in kinds live in
 * the `actions` namespace (`kinds.<kind>.label`); plugin kinds in the plugin's
 * namespace (`plugin-<id>:kinds.<kind>.label`).
 */
import { actionKind, pluginKey } from '@vspark/shared/actions';

export function kindKey(kind: string, part: 'label' | 'description'): string {
  const plugin = actionKind(kind)?.plugin;
  const key = `kinds.${kind}.${part}`;
  return plugin ? pluginKey(plugin, key) : key;
}

/** Built-in kinds have a section on the Actions help page; plugin kinds'
 *  help is registered with the plugin (plugin-system phase 2). */
export function hasActionsHelp(kind: string): boolean {
  return !actionKind(kind)?.plugin;
}
