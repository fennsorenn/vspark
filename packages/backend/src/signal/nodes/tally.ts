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
 * Per-viewer totals and the latest entries, kept in one project variable
 * (`name` / `scope` like the variable nodes; `persistent` keeps it across
 * restarts — leave it off and reset it on stream start for per-stream lists).
 *
 * On `add`, `amount` (default 1) is added under `user`, and the entry joins
 * the recent list. Outputs are read straight from the variable, so another
 * graph's tally of the same name shows the same lists.
 */

export interface TallyEntry {
  /** The name as last seen (display name). */
  name: string;
  total: number;
  count: number;
}

export interface TallyRecent {
  name: string;
  amount: number;
  label: string;
  /** Epoch seconds. */
  at: number;
}

export interface TallyState {
  /** Keyed by the lower-cased name. */
  totals: Record<string, TallyEntry>;
  /** Newest first. */
  recent: TallyRecent[];
}

const EMPTY: TallyState = { totals: {}, recent: [] };

function stateOf(raw: unknown): TallyState {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const r = raw as Partial<TallyState>;
  return {
    totals:
      r.totals && typeof r.totals === 'object' && !Array.isArray(r.totals)
        ? r.totals
        : {},
    recent: Array.isArray(r.recent) ? r.recent : [],
  };
}

function countOf(v: unknown, fallback: number): number {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n)
    ? fallback
    : Math.max(0, Math.floor(n));
}

/** Pure: add one entry, keeping at most `keep` recent ones. */
export function tallyAdd(
  s: TallyState,
  name: string,
  amount: number,
  label: string,
  keep: number,
  at = Date.now() / 1000
): TallyState {
  const key = name.toLowerCase();
  const prev = s.totals[key];
  return {
    totals: {
      ...s.totals,
      [key]: {
        name,
        total: (prev?.total ?? 0) + amount,
        count: (prev?.count ?? 0) + 1,
      },
    },
    recent: [{ name, amount, label, at }, ...s.recent].slice(0, keep),
  };
}

/** The `n` highest totals, highest first (ties: most entries, then name). */
export function tallyTop(s: TallyState, n: number): TallyEntry[] {
  return Object.values(s.totals)
    .sort(
      (a, b) =>
        b.total - a.total || b.count - a.count || a.name.localeCompare(b.name)
    )
    .slice(0, n);
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
    writeVariable(ref, next, this.persistent() === true);
    this.changed.emit(undefined);
  }

  protected override onBind(): void {
    this.boot = setTimeout(() => {
      this.boot = null;
      this.changed.emit(undefined);
    }, 0);
  }

  protected override onUnbind(): void {
    if (this.boot !== null) clearTimeout(this.boot);
    this.boot = null;
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
