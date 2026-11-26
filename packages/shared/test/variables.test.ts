import { describe, it, expect } from 'vitest';
import {
  DEADLINE_IDLE,
  TALLY_EMPTY,
  deadlineOps,
  deadlineStateOf,
  parseDateTime,
  persistentVariableId,
  remainingOf,
  runtimeVariableId,
  tallyAdd,
  tallyStateOf,
  tallyTop,
  variableRef,
} from '../src/variables';

describe('variable naming', () => {
  it('normalizes a ref and refuses one without project or name', () => {
    expect(variableRef('p', ' s ', ' n ')).toEqual({
      projectId: 'p',
      scope: 's',
      name: 'n',
    });
    expect(variableRef('p', undefined, 'n')?.scope).toBe('');
    expect(variableRef('', '', 'n')).toBeNull();
    expect(variableRef('p', '', '  ')).toBeNull();
    expect(variableRef(1, '', 'n')).toBeNull();
  });

  it('encodes scope and name into the two id schemes', () => {
    const r = { projectId: 'p', scope: 'a:b', name: 'x y' };
    expect(persistentVariableId(r)).toBe('var:p:a%3Ab:x%20y');
    expect(runtimeVariableId(r)).toBe('rvar:p:a%3Ab:x%20y');
  });
});

describe('deadline state', () => {
  it('reads anything that is not a state as idle, and cleans a stored one', () => {
    expect(deadlineStateOf(null)).toBe(DEADLINE_IDLE);
    expect(deadlineStateOf('x')).toBe(DEADLINE_IDLE);
    expect(
      deadlineStateOf({ running: true, endsAt: 'soon', remaining: -4, total: NaN })
    ).toEqual({ ...DEADLINE_IDLE });
    expect(
      deadlineStateOf({ running: true, endsAt: 50, remaining: 3, total: 9, finished: false })
    ).toEqual({ endsAt: 50, remaining: 3, total: 9, running: true, finished: false });
  });

  it('pause on a stopped timer and resume on a running one change nothing', () => {
    const run = deadlineOps.start(10, 0);
    expect(deadlineOps.resume(run, 5)).toBe(run);
    const idle = DEADLINE_IDLE;
    expect(deadlineOps.pause(idle, 5)).toBe(idle);
    expect(deadlineOps.resume(idle, 5)).toBe(idle);
    expect(deadlineOps.add(run, NaN)).toBe(run);
    expect(deadlineOps.add(run, 0)).toBe(run);
    expect(deadlineOps.reset()).toBe(DEADLINE_IDLE);
    expect(remainingOf(deadlineOps.start(-5, 0), 0)).toBe(0);
  });
});

describe('tally state', () => {
  it('reads anything that is not a tally as empty', () => {
    expect(tallyStateOf(undefined)).toBe(TALLY_EMPTY);
    expect(tallyStateOf({ totals: [], recent: 'x' })).toEqual(TALLY_EMPTY);
    const s = tallyAdd(TALLY_EMPTY, 'Ann', 2, 'tip', 5, 1);
    expect(tallyStateOf(s)).toEqual(s);
  });

  it('breaks ties by number of entries, then name', () => {
    let s = tallyAdd(TALLY_EMPTY, 'b', 2, '', 5, 1);
    s = tallyAdd(s, 'a', 2, '', 5, 2);
    s = tallyAdd(s, 'c', 1, '', 5, 3);
    s = tallyAdd(s, 'c', 1, '', 5, 4);
    expect(tallyTop(s, 3).map((e) => e.name)).toEqual(['c', 'a', 'b']);
  });
});


describe('date / time text', () => {
  const now = new Date(2026, 10, 9, 18, 0, 0).getTime();
  it('a time of day is its next occurrence; a full date that moment', () => {
    expect(parseDateTime('20:00', now)).toBe(new Date(2026, 10, 9, 20).getTime() / 1000);
    expect(parseDateTime('17:30:15', now)).toBe(
      new Date(2026, 10, 10, 17, 30, 15).getTime() / 1000
    );
    expect(parseDateTime('18:00', now)).toBe(new Date(2026, 10, 10, 18).getTime() / 1000);
    expect(parseDateTime('12:61', now)).toBeNull();
    expect(parseDateTime('2026-11-09T20:00:00Z')).toBe(Date.UTC(2026, 10, 9, 20) / 1000);
    expect(parseDateTime('nope')).toBeNull();
    expect(parseDateTime('  ')).toBeNull();
    expect(parseDateTime(42)).toBeNull();
  });
});

describe('deadline transitions', () => {
  it('start, add, pause, resume, finish', () => {
    let s = deadlineOps.start(600, 1000);
    expect(s).toEqual({ endsAt: 1600, remaining: 600, total: 600, running: true, finished: false });
    s = deadlineOps.add(s, 120, 1100);
    expect(s).toMatchObject({ endsAt: 1720, total: 720 });
    s = deadlineOps.pause(s, 1200);
    expect(s).toMatchObject({ endsAt: null, remaining: 520, running: false });
    expect(remainingOf(s, 9999)).toBe(520);
    s = deadlineOps.add(s, -1000, 1300);
    expect(s).toMatchObject({ remaining: 0, total: 200 });
    expect(deadlineOps.resume(s, 1400)).toBe(s); // nothing left to resume
    const f = deadlineOps.finish(deadlineOps.start(5, 0));
    expect(f).toMatchObject({ finished: true, running: false, remaining: 0 });
    expect(deadlineOps.add(f, 10)).toBe(f);
  });
});
