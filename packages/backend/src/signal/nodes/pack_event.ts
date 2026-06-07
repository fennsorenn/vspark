import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut } from '@vspark/shared/node_decorators';

interface PackEventConfig {
  /** User-defined field NAMES (+ order). Types are inferred from connections. */
  fields?: string[];
}

/**
 * Packs the values wired into its user-named input fields into a single record and
 * emits it as `Event<{ field: T }>` on `fire`. Field names live in `config.fields`;
 * the resolved field types and the dynamic input ports are computed by the shared
 * `inferPackEvent` (see infer_nodes.ts) — including the always-present trailing empty
 * slot the editor uses to add the next field.
 *
 * The named-field inputs are DYNAMIC (no decorated member): read via `this.input(name)`.
 */
@SignalNode({
  label: 'Pack Event',
  description:
    'Combine multiple inputs into one event payload. Connect into the empty slot to add a named field.',
  tags: ["utility"],
  color: '#3a3a5a',
})
export class PackEvent extends Node {
  static readonly kind = 'pack_event';

  @eventOut('event', 'Any') event!: Emitter<Record<string, unknown>>;

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const cfg = (this.config ?? {}) as PackEventConfig;
    const fields = (cfg.fields ?? []).filter((f) => f.length > 0);
    const payload: Record<string, unknown> = {};
    for (const name of fields) {
      const v = this.input(name);
      if (v !== undefined) payload[name] = v;
    }
    this.event.emit(payload);
  }
}
