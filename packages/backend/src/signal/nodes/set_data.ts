import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { dataChannelManager } from '../../data_channels/manager.js';

interface SetDataConfig {
  /** User-defined field NAMES (+ order). Each becomes a labeled value-in port and
   *  is published as a field of that name. Types are inferred from connections. */
  fields?: string[];
  /** Config fallback for the `scope` port when unconnected: a scene entity id
   *  (a layer/node id), or null/empty for the global scope. */
  scope?: string | null;
}

/**
 * Publishes a set of user-defined named FIELDS to the data-channel bus. Each
 * labeled input port becomes a field of that name (the dynamic-port mechanism is
 * shared with `pack_event` via `inferSetData`). On `fire`, every declared field's
 * current value is published; a template on the consuming side references each by
 * its bare name (`${chat.map(...)}`).
 *
 * The optional `scope` input (a `SceneEntity` — a compose layer / scene node id;
 * a `SceneNode` or `ComposeLayer` output widens into it) targets which consumer
 * the field-set is visible to: a consumer reads its own id scope plus the global
 * scope. Unwired → global (every consumer sees it).
 *
 * Whole-value republish per fire (no diffing); see DataChannelManager.
 */
@SignalNode({
  label: 'Set Data',
  description:
    'Publishes named fields (one per labeled input) to the data-channel bus for the feed/template layer. Optional scope targets a single layer/node.',
  tags: ["scene"],
  color: '#3a7a5a',
})
export class SetData extends Node {
  static readonly kind = 'set_data';

  @valueIn('scope', 'SceneEntity') scope!: () => string | undefined;

  /** Scope keys this instance has published/seeded into, so they can be cleared
   *  on teardown (otherwise stale entries linger in the bus and a feed layer's
   *  own-scope data shadows global — see dev-notes/modules/data-channels.md). */
  private readonly _published = new Set<string>();

  private _fieldNames(): string[] {
    const cfg = (this.config ?? {}) as SetDataConfig;
    return (cfg.fields ?? []).filter((f) => f.length > 0);
  }

  /** Resolve the scope input/config to a bus scope key ('' = global). */
  private _scopeKey(): string {
    const cfg = (this.config ?? {}) as SetDataConfig;
    const id = this.scope() ?? cfg.scope;
    return typeof id === 'string' ? id : '';
  }

  /** Pre-seed declared fields as null into the (config-resolved) scope so a
   *  template referencing a bare field name resolves before the first `fire`. */
  protected override onBind(): void {
    const fields = this._fieldNames();
    if (fields.length === 0) return;
    const cfg = (this.config ?? {}) as SetDataConfig;
    const scope = typeof cfg.scope === 'string' ? cfg.scope : '';
    const seed: Record<string, unknown> = {};
    for (const name of fields) seed[name] = null;
    this._published.add(scope);
    dataChannelManager.seed(scope, seed);
  }

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const fields = this._fieldNames();
    if (fields.length === 0) return;
    const out: Record<string, unknown> = {};
    for (const name of fields) out[name] = this.input(name) ?? null;
    const scope = this._scopeKey();
    this._published.add(scope);
    dataChannelManager.set(scope, out);
  }

  /** On teardown, clear this node's declared fields from every scope it touched
   *  so retired data doesn't persist on the bus after the graph stops. */
  protected override onUnbind(): void {
    const fields = this._fieldNames();
    for (const scope of this._published) {
      for (const name of fields) dataChannelManager.clear(scope, name);
    }
    this._published.clear();
  }
}
