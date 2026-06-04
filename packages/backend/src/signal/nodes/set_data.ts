import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn } from '@vspark/shared/node_decorators';
import { dataChannelManager } from '../../data_channels/manager.js';

interface SetDataConfig {
  /** User-defined field NAMES (+ order). Each becomes a labeled value-in port and
   *  is published as a field of that name. Types are inferred from connections. */
  fields?: string[];
  /** Config fallback for the `scope` port when unconnected: a scene entity ref. */
  scope?: { kind: 'scene_node' | 'compose_layer'; id: string } | null;
}

type SceneEntity = { kind: 'scene_node' | 'compose_layer'; id: string } | null;

/**
 * Publishes a set of user-defined named FIELDS to the data-channel bus. Each
 * labeled input port becomes a field of that name (the dynamic-port mechanism is
 * shared with `pack_event` via `inferSetData`). On `fire`, every declared field's
 * current value is published; a template on the consuming side references each by
 * its bare name (`${chat.map(...)}`).
 *
 * The optional `scope` input (a `SceneEntity` — a compose layer or scene node)
 * targets which consumer the field-set is visible to: a consumer reads its own id
 * scope plus the global scope. Unwired → global (every consumer sees it).
 *
 * Whole-value republish per fire (no diffing); see DataChannelManager.
 */
@SignalNode({
  label: 'Set Data',
  description:
    'Publishes named fields (one per labeled input) to the data-channel bus for the feed/template layer. Optional scope targets a single layer/node.',
  tags: ['output', 'compose'],
  color: '#3a7a5a',
})
export class SetData extends Node {
  static readonly kind = 'set_data';

  @valueIn('scope', 'SceneEntity') scope!: () => SceneEntity;

  /** Resolve the scope input/config to a bus scope key ('' = global). */
  private _scopeKey(): string {
    const cfg = (this.config ?? {}) as SetDataConfig;
    const ent = (this.scope() ?? cfg.scope) as SceneEntity;
    return ent && typeof ent.id === 'string' ? ent.id : '';
  }

  /** Pre-seed declared fields as null into the (config-resolved) scope so a
   *  template referencing a bare field name resolves before the first `fire`. */
  protected override onBind(): void {
    const cfg = (this.config ?? {}) as SetDataConfig;
    const fields = (cfg.fields ?? []).filter((f) => f.length > 0);
    if (fields.length === 0) return;
    const scope = cfg.scope?.id ?? '';
    const seed: Record<string, unknown> = {};
    for (const name of fields) seed[name] = null;
    dataChannelManager.seed(scope, seed);
  }

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as SetDataConfig;
    const fields = (cfg.fields ?? []).filter((f) => f.length > 0);
    if (fields.length === 0) return;
    const out: Record<string, unknown> = {};
    for (const name of fields) out[name] = this.input(name) ?? null;
    dataChannelManager.set(this._scopeKey(), out);
  }
}
