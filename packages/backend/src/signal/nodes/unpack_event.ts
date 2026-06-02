import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn } from '@vspark/shared/node_decorators';

/**
 * Splits an incoming event into per-field outputs plus a bare `trigger`.
 *
 * The output ports are DYNAMIC (see inferUnpackEvent in infer_nodes.ts): when the
 * wired event resolves to `Event<record>`, one typed output port is generated per
 * record field; otherwise a single `value` output carries the whole payload (the
 * pre-Phase-2 behaviour). Because the outputs are generated, this node emits them
 * by name via `this.emitOn(...)` rather than through decorated emitter fields.
 */
@SignalNode({
  label: 'Unpack Event',
  description:
    'Split an event into a trigger plus one output per payload field. Falls back to a single value output for non-record payloads.',
  tags: ['utility'],
  color: '#3a3a5a',
})
export class UnpackEvent extends Node {
  static readonly kind = 'unpack_event';

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload ?? null;
    if (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload)
    ) {
      for (const [name, value] of Object.entries(
        payload as Record<string, unknown>
      )) {
        this.emitOn(name, value);
      }
    } else {
      // Non-record payload → single `value` output (fallback shape).
      this.emitOn('value', payload);
    }
    this.emitOn('trigger', undefined);
  }
}
