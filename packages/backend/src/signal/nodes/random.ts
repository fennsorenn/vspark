import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut, valueOut } from '@vspark/shared/node_decorators';

interface RandomState {
  lastValue: number;
}

/**
 * Generates a random value when fired. The value is recomputed on each fire
 * and cached for downstream pulls so the same value is observed everywhere
 * between fires (deterministic per event).
 */
@SignalNode({
  label: 'Random',
  description:
    'Picks a random value in [min, max] on each fire. Same value seen by all downstream pulls until the next fire.',
  tags: ["math"],
  color: '#7f5fb0',
})
export class Random extends Node {
  static readonly kind = 'random';

  @valueIn('min', 'Float') min!: () => number | undefined;
  @valueIn('max', 'Float') max!: () => number | undefined;
  @valueIn('mode', 'String') mode!: () => string | undefined;

  @eventOut('fire', 'Trigger') fireOut!: Emitter<void>;

  @valueOut('value', 'Float')
  value = (): number => {
    const min = this.min() ?? 0;
    const max = this.max() ?? 1;
    // Pull path: return last cached value (or the midpoint if never fired).
    const state = this.getState<RandomState | undefined>();
    return state?.lastValue ?? (min + max) / 2;
  };

  @eventIn('fire', 'Trigger')
  onFire(): void {
    const min = this.min() ?? 0;
    const max = this.max() ?? 1;
    const mode = (this.mode() ?? 'float') === 'int' ? 'int' : 'float';

    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    const v =
      mode === 'int'
        ? Math.floor(lo) + Math.floor(Math.random() * (Math.floor(hi) - Math.floor(lo) + 1))
        : lo + Math.random() * (hi - lo);
    this.setState({ lastValue: v } satisfies RandomState);
    this.fireOut.emit(undefined);
  }
}
