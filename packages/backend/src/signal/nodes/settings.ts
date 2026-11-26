import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

export interface SettingsNodeConfig {
  /** Dot-notation path into the owner's settings, e.g. "host" or
   *  "nodeConfig.arkit_fcl_cfg.enabled" or "responses.0.clipId". */
  field?: string;
  /** Returned when the resolved path is undefined (no stored value yet). */
  defaultValue?: unknown;
  /** Injected by whoever runs the graph, at resolve time — the full live
   *  settings of the graph's owner: a Behavior's config (its behavior manager)
   *  or an Action's settings (LogicManager, `owner_kind = 'action'`). */
  _settings?: Record<string, unknown>;
}

function resolvePath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object')
      return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Reads one field from the settings of whatever owns the graph and exposes it
 * as a value port. Use one instance per settings field you want visible in the
 * graph. The owner is a Behavior (its config) or an Action (its settings); the
 * process running the graph injects them as `_settings`, so the node itself
 * does not know which. (Formerly `behavior_config` — renamed when Actions
 * started sharing it.)
 *
 * Set `field` in defaultConfig to a dot-notation path (e.g. "host",
 * "nodeConfig.arkit_fcl_cfg.enabled"). `defaultValue` is returned when no
 * stored value exists at that path yet.
 *
 * The output port is typed BehaviorConfig (a raw-value escape hatch) and is
 * compatible with any typed value port — the engine does no runtime type check.
 */
@SignalNode({
  label: 'Settings',
  tags: ['utility'],
  color: '#2a2a4a',
  internal: true,
})
export class SettingsNode extends Node {
  static readonly kind = 'settings';

  // Wired `field` port takes precedence; the engine falls back to config.field.
  @valueIn('field', 'String') field!: () => string | null | undefined;

  @valueOut('value', 'BehaviorConfig')
  value = (): Record<string, unknown> => {
    const cfg = this.config as SettingsNodeConfig;
    const path = this.field() ?? '';
    const data = cfg._settings ?? {};
    const resolved = path ? resolvePath(data, path) : data;
    const value =
      resolved !== undefined ? resolved : (cfg.defaultValue ?? null);
    return value as Record<string, unknown>;
  };
}
