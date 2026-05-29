import {
  SignalNode,
  eventPort,
  valuePort,
  mkEvent,
} from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';

interface RandomConfig {
  min?: number;
  max?: number;
  /** 'float' (default) — uniform; 'int' — uniform integer in [min, max]. */
  mode?: 'float' | 'int';
}

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
  tags: ['logic'],
  color: '#7f5fb0',
})
export class Random {
  static readonly kind = 'random';
  static readonly inputPorts = [
    eventPort('fire', 'Trigger'),
    valuePort('min', 'Float'),
    valuePort('max', 'Float'),
    valuePort('mode', 'String'),
  ] as const;
  static readonly outputPorts = [
    eventPort('fire', 'Trigger'),
    valuePort('value', 'Float'),
  ] as const;

  static execute(
    inputs: InputsOf<typeof Random>,
    config: RandomConfig,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof Random> {
    const min = (inputs.min as number | undefined) ?? config.min ?? 0;
    const max = (inputs.max as number | undefined) ?? config.max ?? 1;
    const mode =
      ((inputs.mode as string | undefined) ?? config.mode ?? 'float') === 'int'
        ? 'int'
        : 'float';

    if (ctx.triggeredPort !== 'fire') {
      // Pull path: return last cached value (or the midpoint if never fired).
      const state = ctx.getState<RandomState | undefined>();
      const cached = state?.lastValue ?? (min + max) / 2;
      return { fire: mkEvent(undefined), value: cached } as OutputsOf<
        typeof Random
      >;
    }

    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    const v =
      mode === 'int'
        ? Math.floor(lo) + Math.floor(Math.random() * (Math.floor(hi) - Math.floor(lo) + 1))
        : lo + Math.random() * (hi - lo);
    ctx.setState({ lastValue: v } satisfies RandomState);
    return { fire: mkEvent(undefined), value: v } as OutputsOf<typeof Random>;
  }
}
