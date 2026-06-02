import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut } from '@vspark/shared/node_decorators';

interface UnpackState {
  /** Last received payload, keyed for per-field pulls. */
  payload: unknown;
}

/**
 * Splits an incoming event into a `trigger` event plus per-field PULL outputs.
 *
 * On each event: stores the payload and fires `trigger` (push). Downstream consumers
 * react to `trigger` and then PULL the field outputs — this is the same push→pull bridge
 * the VMC/lipsync/mediapipe pipelines rely on (a broadcast node fires on `trigger`, then
 * pulls `value`/field chains). The field outputs are DYNAMIC (see inferUnpackEvent): when
 * the wired event resolves to `Event<record>`, one pull output per record field; otherwise
 * a single `value` pull output carrying the whole payload (pre-Phase-2 behaviour).
 */
@SignalNode({
  label: 'Unpack Event',
  description:
    'Split an event into a trigger plus one pull output per payload field. Falls back to a single value output for non-record payloads.',
  tags: ['utility'],
  color: '#3a3a5a',
})
export class UnpackEvent extends Node {
  static readonly kind = 'unpack_event';

  @eventOut('trigger', 'Trigger') trigger!: Emitter<void>;

  protected override onBind(): void {
    // Per-field pulls resolve from the last stored payload. For a record payload,
    // `port` is a field name; otherwise the single `value` port returns the whole payload.
    this.setDynamicOutputs((port) => {
      const payload = this.getState<UnpackState>()?.payload ?? null;
      if (port === 'value') return payload;
      if (payload !== null && typeof payload === 'object') {
        return (payload as Record<string, unknown>)[port];
      }
      return undefined;
    });
  }

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    this.setState({ payload: ev?.payload ?? null } satisfies UnpackState);
    this.trigger.emit(undefined);
  }
}
