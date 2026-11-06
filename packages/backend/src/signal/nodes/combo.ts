import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import {
  eventIn,
  eventOut,
  valueIn,
  valueOut,
} from '@vspark/shared/node_decorators';

/**
 * Combo counters: count events that arrive close together. Two kinds, meant
 * to be wired from the same trigger:
 *  - `combo_threshold` fires `reached` once when the count reaches a threshold;
 *  - `combo_timeout` fires `ended` when the combo runs out, with its final count.
 *
 * Shared semantics:
 *  - Each counted event restarts the timer (`window` / `timeout`, seconds).
 *  - `key` (optional): when it reads non-empty, an event whose key was already
 *    counted in this combo neither counts nor restarts the timer — wire a
 *    chatter's username in to count unique chatters. Empty or unwired, every
 *    event counts.
 *  - A missing or non-positive duration makes the node inert (nothing counts).
 *
 * The count and the counted keys are scratch state; the pending timer is
 * cleared on graph teardown (`onUnbind`), so a stopped or rebuilt graph never
 * fires late.
 */

interface ComboState {
  count: number;
  keys: string[];
  /** threshold: `reached` already fired in this combo.
   *  timeout: a combo is running (count held after it ends, until the next). */
  flag: boolean;
}

const FRESH: ComboState = { count: 0, keys: [], flag: false };

function seconds(v: unknown): number | null {
  const n = Number(v);
  return v !== undefined &&
    v !== null &&
    v !== '' &&
    Number.isFinite(n) &&
    n > 0
    ? n * 1000
    : null;
}

function keyOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s === '' ? null : s;
}

/** One pending timer, cleared on teardown. Composition rather than a shared
 *  base class: ports are harvested per class (see variable.ts). */
class ComboTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  restart(ms: number, onExpire: () => void): void {
    this.clear();
    if (this.disposed) return;
    this.handle = setTimeout(() => {
      this.handle = null;
      if (!this.disposed) onExpire();
    }, ms);
  }

  clear(): void {
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}

@SignalNode({
  label: 'Combo Threshold',
  description:
    'Counts events that arrive within the window of each other and fires "reached" once when the count hits the threshold. Wire a key (e.g. the chatter’s name) to count each key only once.',
  tags: ['flow'],
  color: '#5a4a2a',
})
export class ComboThreshold extends Node {
  static readonly kind = 'combo_threshold';

  @valueIn('threshold', 'Float') threshold!: () => unknown;
  @valueIn('window', 'Float') window!: () => unknown;
  @valueIn('key', 'String') key!: () => unknown;

  @eventOut('reached', 'Trigger') reached!: Emitter<void>;
  @valueOut('count', 'Float') count = (): number => this.state().count;

  private readonly timer = new ComboTimer();

  private state(): ComboState {
    return this.getState<ComboState | undefined>() ?? FRESH;
  }

  @eventIn('in', 'Any')
  onIn(): void {
    const ms = seconds(this.window());
    if (ms === null) return;
    const key = keyOf(this.key());
    const s = this.state();
    if (key !== null && s.keys.includes(key)) return;
    const next: ComboState = {
      count: s.count + 1,
      keys: key === null ? s.keys : [...s.keys, key],
      flag: s.flag,
    };
    this.timer.restart(ms, () => this.setState(FRESH));
    const t = Number(this.threshold());
    const need = Number.isFinite(t) ? Math.max(1, Math.ceil(t)) : null;
    const fire = need !== null && !next.flag && next.count >= need;
    if (fire) next.flag = true;
    this.setState(next);
    if (fire) this.reached.emit(undefined);
  }

  protected override onUnbind(): void {
    this.timer.dispose();
  }
}

@SignalNode({
  label: 'Combo Timeout',
  description:
    'Counts events that arrive within the timeout of each other and fires "ended" when no new one arrives in time; "count" is then the final count. Fires on every combo end — gate it with If / Else for a minimum.',
  tags: ['flow'],
  color: '#5a4a2a',
})
export class ComboTimeout extends Node {
  static readonly kind = 'combo_timeout';

  @valueIn('timeout', 'Float') timeout!: () => unknown;
  @valueIn('key', 'String') key!: () => unknown;

  @eventOut('ended', 'Trigger') ended!: Emitter<void>;
  /** The running count; after `ended`, the final count, held until the next
   *  counted event starts a new combo. */
  @valueOut('count', 'Float') count = (): number => this.state().count;

  private readonly timer = new ComboTimer();

  private state(): ComboState {
    return this.getState<ComboState | undefined>() ?? FRESH;
  }

  @eventIn('in', 'Any')
  onIn(): void {
    const ms = seconds(this.timeout());
    if (ms === null) return;
    const key = keyOf(this.key());
    // A finished combo's count is held for readers of `ended`; the first
    // counted event after it starts from zero.
    const s = this.state().flag ? this.state() : FRESH;
    if (key !== null && s.keys.includes(key)) return;
    this.setState({
      count: s.count + 1,
      keys: key === null ? s.keys : [...s.keys, key],
      flag: true,
    } satisfies ComboState);
    this.timer.restart(ms, () => {
      this.setState({ ...this.state(), keys: [], flag: false });
      this.ended.emit(undefined);
    });
  }

  protected override onUnbind(): void {
    this.timer.dispose();
  }
}
