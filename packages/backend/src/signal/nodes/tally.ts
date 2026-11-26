import { SignalNode } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import {
  eventIn,
  eventOut,
  valueIn,
  valueOut,
} from '@vspark/shared/node_decorators';
import {
  TALLY_EMPTY as EMPTY,
  tallyAdd,
  tallyStateOf as stateOf,
  tallyTop,
  type TallyEntry,
  type TallyRecent,
  type TallyState,
} from '@vspark/shared/variables';
import {
  onVariableChange,
  readVariable,
  sameRef,
  variableRef,
  writeVariable,
  type VariableRef,
} from '../../variables/store.js';

export { tallyAdd, tallyTop };

/**
 * Per-viewer totals and the latest entries, kept in one project variable
 * (`name` / `scope` like the variable nodes; `persistent` keeps it across
 * restarts — leave it off and reset it on stream start for per-stream lists).
 *
 * On `add`, `amount` (default 1) is added under `user`, and the entry joins
 * the recent list. Outputs are read straight from the variable, so another
 * graph's tally of the same name shows the same lists.
 */

function countOf(v: unknown, fallback: number): number {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n)
    ? fallback
    : Math.max(0, Math.floor(n));
}

@SignalNode({
  label: 'Tally',
  description:
    'Adds an amount under a viewer’s name and keeps the latest entries, in a project variable. Outputs the recent list, the top list and the last entry. Tick "persistent" to keep it across restarts; fire "reset" (e.g. on stream start) to clear it.',
  tags: ['variables'],
  color: '#6a4a8a',
})
export class Tally extends Node {
  static readonly kind = 'tally';

  @valueIn('name', 'String') name!: () => unknown;
  @valueIn('scope', 'String') scope!: () => unknown;
  @valueIn('persistent', 'Bool') persistent!: () => unknown;
  /** Who the entry is for (display name). Empty → not counted. */
  @valueIn('user', 'String') user!: () => unknown;
  /** Default 1. */
  @valueIn('amount', 'Float') amount!: () => unknown;
  /** Free text kept with the entry, e.g. "sub" or "500 bits". */
  @valueIn('label', 'String') label!: () => unknown;
  /** How many recent entries to keep (default 10). */
  @valueIn('keep', 'Float') keep!: () => unknown;
  /** How many top entries to output (default 5). */
  @valueIn('topCount', 'Float') topCount!: () => unknown;

  /** After every change, and once when the graph starts. */
  @eventOut('changed', 'Trigger') changed!: Emitter<void>;

  @valueOut('recent', 'Any') recent = (): TallyRecent[] => this.read().recent;
  @valueOut('top', 'Any') top = (): TallyEntry[] =>
    tallyTop(this.read(), countOf(this.topCount(), 5));
  @valueOut('last', 'Any') last = (): TallyRecent | null =>
    this.read().recent[0] ?? null;

  private boot: ReturnType<typeof setTimeout> | null = null;
  private unwatch: (() => void) | null = null;
  /** Set around this node's own writes, so the watcher skips them. */
  private writing = false;

  private ref(): VariableRef | null {
    return variableRef(this.config._projectId, this.scope(), this.name());
  }

  private read(): TallyState {
    const ref = this.ref();
    return ref ? stateOf(readVariable(ref)) : EMPTY;
  }

  private commit(next: TallyState): void {
    const ref = this.ref();
    if (!ref) return;
    this.writing = true;
    try {
      writeVariable(ref, next, this.persistent() === true);
    } finally {
      this.writing = false;
    }
    this.changed.emit(undefined);
  }

  protected override onBind(): void {
    this.boot = setTimeout(() => {
      this.boot = null;
      this.changed.emit(undefined);
    }, 0);
    // Reset (or edited) by someone else — e.g. the editor's Reset button.
    this.unwatch = onVariableChange((ref) => {
      if (!this.writing && sameRef(ref, this.ref()))
        this.changed.emit(undefined);
    });
  }

  protected override onUnbind(): void {
    if (this.boot !== null) clearTimeout(this.boot);
    this.unwatch?.();
    this.boot = null;
    this.unwatch = null;
  }

  @eventIn('add', 'Trigger')
  onAdd(): void {
    const raw = this.user();
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name === '') return;
    const a = this.amount();
    const amount =
      a === undefined || a === null || a === '' ? 1 : Number(a);
    if (!Number.isFinite(amount)) return;
    const l = this.label();
    this.commit(
      tallyAdd(
        this.read(),
        name,
        amount,
        typeof l === 'string' ? l : l == null ? '' : String(l),
        countOf(this.keep(), 10)
      )
    );
  }

  @eventIn('reset', 'Trigger')
  onReset(): void {
    this.commit(EMPTY);
  }
}
