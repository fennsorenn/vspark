/**
 * Graph variables shared by backend and editor: how a variable document is
 * named, and the state shapes (with their pure transitions) that the
 * `deadline` and `tally` nodes keep in one. The nodes write through the
 * backend store; the editor writes the same documents directly (Start / Pause
 * buttons, a goal set by hand), and the nodes react to the change. Both sides
 * use the transitions below, so a button does exactly what the node would.
 */

export interface VariableRef {
  projectId: string;
  /** '' = the shared namespace; a Logic graph id = private to that graph. */
  scope: string;
  name: string;
}

const enc = (s: string) => encodeURIComponent(s);

/** Document id in the persistent `variable` collection. Scope and name are
 *  encoded so the separators are unambiguous; the prefixes keep the two
 *  collections' ids apart (the mesh containment index keys ids across every
 *  rtype). */
export const persistentVariableId = (r: VariableRef): string =>
  `var:${r.projectId}:${enc(r.scope)}:${enc(r.name)}`;
/** Document id in the short-lived `runtime_variable` collection. */
export const runtimeVariableId = (r: VariableRef): string =>
  `rvar:${r.projectId}:${enc(r.scope)}:${enc(r.name)}`;

/** Normalize the parts of a ref; null when unusable (no project or no name). */
export function variableRef(
  projectId: unknown,
  scope: unknown,
  name: unknown
): VariableRef | null {
  if (typeof projectId !== 'string' || projectId === '') return null;
  const n = typeof name === 'string' ? name.trim() : '';
  if (n === '') return null;
  const s = typeof scope === 'string' ? scope.trim() : '';
  return { projectId, scope: s, name: n };
}

// ── Deadline (timer state) ───────────────────────────────────────────────────

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

export const DEADLINE_IDLE: DeadlineState = {
  endsAt: null,
  remaining: 0,
  total: 0,
  running: false,
  finished: false,
};

const nowS = () => Date.now() / 1000;
const fin = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** A stored value read as a timer state (anything else → idle). */
export function deadlineStateOf(raw: unknown): DeadlineState {
  if (!raw || typeof raw !== 'object') return DEADLINE_IDLE;
  const r = raw as Partial<DeadlineState>;
  const running = r.running === true && typeof r.endsAt === 'number';
  return {
    endsAt: running ? fin(r.endsAt) : null,
    remaining: Math.max(0, fin(r.remaining)),
    total: Math.max(0, fin(r.total)),
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

/** Pure transitions. A negative `add` takes time off (never below zero left;
 *  total shrinks by what was actually taken). */
export const deadlineOps = {
  start(seconds: number, now = nowS()): DeadlineState {
    const d = Math.max(0, seconds);
    return {
      endsAt: now + d,
      remaining: d,
      total: d,
      running: true,
      finished: false,
    };
  },
  pause(s: DeadlineState, now = nowS()): DeadlineState {
    if (!s.running) return s;
    return {
      ...s,
      endsAt: null,
      remaining: remainingOf(s, now),
      running: false,
    };
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
    return {
      ...s,
      endsAt: null,
      remaining: 0,
      running: false,
      finished: true,
    };
  },
  reset(): DeadlineState {
    return DEADLINE_IDLE;
  },
};

// ── Tally (per-viewer totals + recent entries) ───────────────────────────────

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

export const TALLY_EMPTY: TallyState = { totals: {}, recent: [] };

/** A stored value read as a tally (anything else → empty). */
export function tallyStateOf(raw: unknown): TallyState {
  if (!raw || typeof raw !== 'object') return TALLY_EMPTY;
  const r = raw as Partial<TallyState>;
  return {
    totals:
      r.totals && typeof r.totals === 'object' && !Array.isArray(r.totals)
        ? r.totals
        : {},
    recent: Array.isArray(r.recent) ? r.recent : [],
  };
}

/** Add one entry, keeping at most `keep` recent ones. */
export function tallyAdd(
  s: TallyState,
  name: string,
  amount: number,
  label: string,
  keep: number,
  at = nowS()
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
