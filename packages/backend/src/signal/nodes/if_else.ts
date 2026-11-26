import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, eventOut, valueIn } from '@vspark/shared/node_decorators';

/**
 * The generic gate: on each `in` event, pulls `condition` and forwards the
 * event — payload unchanged — on `then` when it is `true`, otherwise on `else`.
 * Only the boolean `true` counts as true; anything else (false, unwired, a
 * non-boolean) takes `else`. Both outputs mirror the `in` payload type (see
 * `inferIfElse`).
 */
@SignalNode({
  label: 'If / Else',
  description:
    'Routes each incoming event to "then" when the condition is true, otherwise to "else". The payload passes through unchanged.',
  tags: ['flow'],
  color: '#5a4a2a',
})
export class IfElse extends Node {
  static readonly kind = 'if_else';

  @valueIn('condition', 'Bool') condition!: () => unknown;

  @eventOut('then', 'Any') then!: Emitter<unknown>;
  @eventOut('else', 'Any') otherwise!: Emitter<unknown>;

  @eventIn('in', 'Any')
  onIn(ev: Event<unknown>): void {
    if (this.condition() === true) this.then.emit(ev?.payload);
    else this.otherwise.emit(ev?.payload);
  }
}
