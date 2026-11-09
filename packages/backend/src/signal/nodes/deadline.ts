import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import {
  eventIn,
  eventOut,
  valueIn,
  valueOut,
} from '@vspark/shared/node_decorators';
import {
  readVariable,
  variableRef,
  writeVariable,
  type VariableRef,
} from '../../variables/store.js';

/**
 * Timer state — and nothing else. The state is one project variable (named by
 * `name` / `scope` like the variable nodes; `persistent` keeps it across
 * restarts), so other graphs can read it and a restart resumes a running
 * timer where its end time says.
 *
 * Nothing ticks here: the node changes the state on its events and fires
 * `changed`; displays count down on their own from `endsAt` (the feed
 * template's `<Countdown>`). The one timeout it holds is for `finished`, re-armed
 * whenever the end time moves and when the graph starts.
 *
 * Caps and rates are not its business — work out the seconds to add upstream
 * (Math / Clamp / Step Lookup) and hand them to `add`.
 */

export interface DeadlineState {
  /** Epoch seconds the timer ends at while running; null when not running. */
  endsAt: number | null;
  /** Seconds left while paused / before start (frozen). */
  remaining: number;
  /** Total length so far: the start duration plus everything added. */
  total: number;
  running: boolean;
  /** Set once it ran out; cleared by start / reset. */
  finished: boolean;
}

const IDLE: DeadlineState = {
  endsAt: null,
  remaining: 0,
  total: 0,
  running: false,
  finished: false,
};

const nowS = () => Date.now() / 1000;

function stateOf(raw: unknown): DeadlineState {
  if (!raw || typeof raw !== 'object') return IDLE;
  const r = raw as Partial<DeadlineState>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const running = r.running === true && typeof r.endsAt === 'number';
  return {
    endsAt: running ? n(r.endsAt) : null,
    remaining: Math.max(0, n(r.remaining)),
    total: Math.max(0, n(r.total)),
    running,
    finished: r.finished === true,
  };
}

/** Seconds left at `now`. */
export function remainingOf(s: DeadlineState, now = nowS()): number {
  return s.running && s.endsAt !== null
    ? Math.max(0, s.endsAt - now)
    : s.remaining;
}

/** Pure transitions, exported for tests. A negative `add` takes time off
 *  (never below zero left; total shrinks by what was actually taken). */
export const deadlineOps = {
  start(seconds: number, now = nowS()): DeadlineState {
    const d = Math.max(0, seconds);
    return { endsAt: now + d, remaining: d, total: d, running: true, finished: false };
  },
  pause(s: DeadlineState, now = nowS()): DeadlineState {
    if (!s.running) return s;
    return { ...s, endsAt: null, remaining: remainingOf(s, now), running: false };
  },
  resume(s: DeadlineState, now = nowS()): DeadlineState {
    if (s.running || s.finished || s.remaining <= 0) return s;
    return { ...s, endsAt: now + s.remaining, running: true };
  },
  add(s: DeadlineState, seconds: number, now = nowS()): DeadlineState {
    if (s.finished || !Number.isFinite(seconds) || seconds === 0) return s;
    const left = remainingOf(s, now);
    const next = Math.max(0, left + seconds);
    const applied = next - left;
    return {
      ...s,
      remaining: next,
      endsAt: s.running ? now + next : null,
      total: Math.max(0, s.total + applied),
    };
  },
  finish(s: DeadlineState): DeadlineState {
    return { ...s, endsAt: null, remaining: 0, running: false, finished: true };
  },
};

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
    writeVariable(ref, next, this.persistent() === true);
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
        if (ref) writeVariable(ref, deadlineOps.finish(s), this.persistent() === true);
      } else this.arm(s);
      this.changed.emit(undefined);
    }, 0);
  }

  protected override onUnbind(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.boot !== null) clearTimeout(this.boot);
    this.timer = null;
    this.boot = null;
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
    this.commit(IDLE);
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
