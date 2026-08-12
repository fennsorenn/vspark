import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { eventIn } from '@vspark/shared/node_decorators';

interface CycleState {
  /** Index of the output to fire on the NEXT `in` event. */
  index: number;
}

interface CycleConfig {
  /** Number of outputs to round-robin through (>= 2). N = 2 is a toggle. */
  count?: number;
}

/** Clamp a config count to a sane integer >= 2. */
function cycleCount(cfg: unknown): number {
  const raw = Math.floor(Number((cfg as CycleConfig)?.count ?? 2));
  return Number.isFinite(raw) && raw >= 2 ? raw : 2;
}

/**
 * Routes a single incoming `Event<T>` to one of N outgoing `Event<T>` ports,
 * advancing the active output on each fire (round-robin). `N = 2` is a toggle —
 * press → `out0`, press again → `out1`, and so on. The payload passes through
 * unchanged, so the output type mirrors the input (see `inferCycle`).
 *
 * The active index lives in `getState/setState` so it survives `reconcile()`.
 * Outputs are DYNAMIC (count from `config.count`, no decorated members) and
 * emitted by name via `this.emitOn('out<i>', payload)`.
 */
@SignalNode({
  label: 'Cycle',
  description:
    'Route one incoming event to N outputs in turn, advancing each fire (N=2 is a toggle). The payload passes through unchanged.',
  tags: ['utility'],
  color: '#3a3a5a',
})
export class Cycle extends Node {
  static readonly kind = 'cycle';

  @eventIn('in', 'Any')
  onIn(ev: Event<unknown>): void {
    const n = cycleCount(this.config);
    const prev = this.getState<CycleState>()?.index ?? 0;
    // Guard against a shrunk `count` leaving a stale out-of-range index.
    const index = ((prev % n) + n) % n;
    this.emitOn(`out${index}`, ev?.payload);
    this.setState({ index: (index + 1) % n } satisfies CycleState);
  }
}
