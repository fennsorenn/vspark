import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

export interface ComponentConfigNodeConfig {
  /** Dot-notation path into the component config, e.g. "host" or "nodeConfig.arkit_fcl_cfg.enabled" */
  field?: string;
  /** Returned when the resolved path is undefined (no stored value yet). */
  defaultValue?: unknown;
  /** Injected by the manager at resolve time — the full live component config. */
  _componentConfig?: Record<string, unknown>;
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
 * Reads one field from the owning component's live config and exposes it as a
 * value port. Use one instance per config field you want visible in the graph.
 *
 * Set `field` in defaultConfig to a dot-notation path (e.g. "host",
 * "nodeConfig.arkit_fcl_cfg.enabled"). `defaultValue` is returned when no
 * stored config value exists at that path yet.
 *
 * The output port is typed ComponentConfig (a raw-value escape hatch) and is
 * compatible with any typed value port — the engine does no runtime type check.
 */
@SignalNode({
  label: 'Component Config',
  tags: ['config'],
  color: '#2a2a4a',
  internal: true,
})
export class ComponentConfigNode extends Node {
  static readonly kind = 'component_config';

  // Wired `field` port takes precedence; the engine falls back to config.field.
  @valueIn('field', 'String') field!: () => string | null | undefined;

  @valueOut('value', 'ComponentConfig')
  value = (): Record<string, unknown> => {
    const cfg = this.config as ComponentConfigNodeConfig;
    const path = this.field() ?? '';
    const data = cfg._componentConfig ?? {};
    const resolved = path ? resolvePath(data, path) : data;
    const value =
      resolved !== undefined ? resolved : (cfg.defaultValue ?? null);
    return value as Record<string, unknown>;
  };
}
