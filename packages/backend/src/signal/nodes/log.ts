import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn, valueIn, listIn } from '@vspark/shared/node_decorators';

/**
 * Prints whatever fires into `trigger` (and the current values wired into
 * `inputs`) to the backend console. Useful while authoring project graphs —
 * drop one after any node to confirm payloads flow as expected. Multiple
 * sources can be wired into `inputs`; each is logged in connection order.
 *
 * Set `label` to disambiguate multiple log nodes in the same graph; it
 * prefixes every log line.
 */
@SignalNode({
  label: 'Log',
  description:
    'Logs the trigger event payload and the current value-input to the backend console.',
  tags: ["utility"],
  color: '#3a3a3a',
})
export class LogNode extends Node {
  static readonly kind = 'log';

  @valueIn('label', 'String') label!: () => string | undefined;
  @listIn('inputs', 'Any') inputs!: () => unknown[];

  @eventIn('trigger', 'Any')
  onTrigger(ev: Event<unknown>): void {
    const label = (typeof this.label() === 'string' ? this.label()! : '').trim();
    const prefix = label ? `[log:${label}]` : '[log]';
    // Print the event payload and every value wired into `inputs` (a list
    // port, so multiple sources can be logged at once in connection order).
    const values = this.inputs() ?? [];
    console.log(prefix, 'event payload:', ev?.payload, '| inputs:', ...values);
  }
}
