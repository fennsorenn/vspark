import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import {
  eventIn,
  eventOut,
  valueIn,
  valueOut,
} from '@vspark/shared/node_decorators';
import {
  DEADLINE_IDLE as IDLE,
  deadlineOps,
  deadlineStateOf as stateOf,
  remainingOf,
  type DeadlineState,
} from '@vspark/shared/variables';
import {
  onVariableChange,
  readVariable,
  sameRef,
  variableRef,
  writeVariable,
  type VariableRef,
} from '../../variables/store.js';

// The state and its transitions live in @vspark/shared/variables (the
// editor's Start / Pause buttons apply the same ones to the same document).
export { deadlineOps, remainingOf };
export type { DeadlineState };

/**
 * Timer state — and nothing else. The state is one project variable (named by
 * `name` / `scope` like the variable nodes; `persistent` keeps it across
 * restarts), so other graphs can read it and a restart resumes a running
 * timer where its end time says.
 *
 * Nothing ticks here: the node changes the state on its events — or sees it
 * changed by someone else (a tab's Start button writes the variable) — and
 * fires `changed`; displays count down on their own from `endsAt` (the feed
 * template's `<Countdown>`). The one timeout it holds is for `finished`, re-armed
 * whenever the end time moves and when the graph starts.
 *
 * Caps and rates are not its business — work out the seconds to add upstream
 * (Math / Clamp / Step Lookup) and hand them to `add`.
 */

const nowS = () => Date.now() / 1000;

function secondsOf(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

@SignalNode({
  label: 'Deadline',
  description:
    'Timer state kept in a project variable: start, pause, resume, reset and add time. Outputs the end time for displays to count down to; fires "finished" when it runs out. Tick "persistent" to keep it across restarts.',
  tags: ['variables'],
  color: '#6a4a8a',
})
export class Deadline extends Node {
  static readonly kind = 'deadline';

  @valueIn('name', 'String') name!: () => unknown;
  @valueIn('scope', 'String') scope!: () => unknown;
  @valueIn('persistent', 'Bool') persistent!: () => unknown;
  /** Seconds for `start`. */
  @valueIn('duration', 'Float') duration!: () => unknown;
  /** Seconds for `add` (negative takes time off). */
  @valueIn('by', 'Float') by!: () => unknown;

  /** Fired after every change of state (and once when the graph starts, so
   *  displays pick up a resumed timer). */
  @eventOut('changed', 'Trigger') changed!: Emitter<void>;
  @eventOut('finished', 'Trigger') finishedOut!: Emitter<void>;

  /** Epoch seconds the timer ends at; 0 when not running. */
  @valueOut('endsAt', 'Float') endsAt = (): number => this.read().endsAt ?? 0;
  @valueOut('remaining', 'Float') remaining = (): number =>
    remainingOf(this.read());
  @valueOut('total', 'Float') total = (): number => this.read().total;
  @valueOut('running', 'Bool') running = (): boolean => this.read().running;
  /** The whole state, for publishing in one field. */
  @valueOut('state', 'Any') stateOut = (): DeadlineState & { now: number } => ({
    ...this.read(),
    now: nowS(),
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private boot: ReturnType<typeof setTimeout> | null = null;
  private unwatch: (() => void) | null = null;
  /** Set around this node's own writes, so the watcher skips them. */
  private writing = false;

  private ref(): VariableRef | null {
    return variableRef(this.config._projectId, this.scope(), this.name());
  }

  private read(): DeadlineState {
    const ref = this.ref();
    return ref ? stateOf(readVariable(ref)) : IDLE;
  }

  private commit(next: DeadlineState): void {
    const ref = this.ref();
    if (!ref) return;
    this.writing = true;
    try {
      writeVariable(ref, next, this.persistent() === true);
    } finally {
      this.writing = false;
    }
    this.arm(next);
    this.changed.emit(undefined);
  }

  /** One timeout for the end; cleared on every change. */
  private arm(s: DeadlineState): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!s.running || s.endsAt === null) return;
    const ms = Math.max(0, (s.endsAt - nowS()) * 1000);
    // setTimeout overflows past ~24.8 days; re-check then.
    const wait = Math.min(ms, 2 ** 31 - 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      const cur = this.read();
      if (!cur.running || cur.endsAt === null) return;
      if (cur.endsAt - nowS() > 0.05) {
        this.arm(cur);
        return;
      }
      this.commit(deadlineOps.finish(cur));
      this.finishedOut.emit(undefined);
    }, wait);
  }

  protected override onBind(): void {
    // After the graph is wired: resume the timer from its stored state. A
    // timer that ran out while the backend was down is marked finished
    // without firing `finished` — a stale end shouldn't set anything off.
    this.boot = setTimeout(() => {
      this.boot = null;
      const s = this.read();
      if (s.running && s.endsAt !== null && s.endsAt <= nowS()) {
        const ref = this.ref();
        if (ref) {
          this.writing = true;
          try {
            writeVariable(ref, deadlineOps.finish(s), this.persistent() === true);
          } finally {
            this.writing = false;
          }
        }
      } else this.arm(s);
      this.changed.emit(undefined);
    }, 0);
    // Someone else changed the state (a tab's button, another graph): follow
    // its end time.
    this.unwatch = onVariableChange((ref) => {
      if (this.writing || !sameRef(ref, this.ref())) return;
      this.arm(this.read());
      this.changed.emit(undefined);
    });
  }

  protected override onUnbind(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.boot !== null) clearTimeout(this.boot);
    this.unwatch?.();
    this.timer = null;
    this.boot = null;
    this.unwatch = null;
  }

  @eventIn('start', 'Trigger')
  onStart(): void {
    const d = secondsOf(this.duration());
    if (d === null) return;
    this.commit(deadlineOps.start(d));
  }

  @eventIn('pause', 'Trigger')
  onPause(): void {
    const s = this.read();
    if (s.running) this.commit(deadlineOps.pause(s));
  }

  @eventIn('resume', 'Trigger')
  onResume(): void {
    const s = this.read();
    const next = deadlineOps.resume(s);
    if (next !== s) this.commit(next);
  }

  @eventIn('reset', 'Trigger')
  onReset(): void {
    this.commit(deadlineOps.reset());
  }

  @eventIn('add', 'Trigger')
  onAdd(): void {
    const by = secondsOf(this.by());
    if (by === null) return;
    const s = this.read();
    const next = deadlineOps.add(s, by);
    if (next !== s) this.commit(next);
  }
}
