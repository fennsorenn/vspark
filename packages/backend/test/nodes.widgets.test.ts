import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkEvent } from '@vspark/shared/signal';
import { makeTestApp } from './helpers/testApp.js';
import { buildGraph, pullValue, loneNode } from './helpers/nodeHarness.js';
import { applyMath, lookupStep, stepsOf } from '../src/signal/nodes/math.js';
import { parseDateTime } from '../src/signal/nodes/date_time.js';
import {
  deadlineOps,
  remainingOf,
  type DeadlineState,
} from '../src/signal/nodes/deadline.js';
import { tallyAdd, tallyTop } from '../src/signal/nodes/tally.js';
import { readVariable } from '../src/variables/store.js';

/**
 * The general nodes behind the stream widgets (dev-notes/plans/stream-widgets.md):
 * math / clamp / step_lookup / date_time (pure), deadline (timer state in a
 * project variable, no ticking), tally (per-viewer totals + recent list), and
 * the overlive goal node.
 */

describe('math, clamp, step lookup', () => {
  it('math applies its op; unset counts as 0; divide by 0 is 0', () => {
    expect(applyMath('add', 2, 3)).toBe(5);
    expect(applyMath('subtract', 2, 3)).toBe(-1);
    expect(applyMath('multiply', 2, 3)).toBe(6);
    expect(applyMath('divide', 3, 0)).toBe(0);
    expect(applyMath('min', 2, 3)).toBe(2);
    expect(applyMath('max', 2, 3)).toBe(3);
    expect(applyMath('bogus', 2, 3)).toBe(5);
    expect(pullValue('math', 'value', { a: 6, b: '2', op: 'divide' })).toBe(3);
    expect(pullValue('math', 'value', { b: 4 })).toBe(4);
  });

  it('clamp keeps a value between the bounds; an empty bound is open', () => {
    expect(pullValue('clamp', 'value', { value: 12, min: 0, max: 10 })).toBe(10);
    expect(pullValue('clamp', 'value', { value: -3, min: 0 })).toBe(0);
    expect(pullValue('clamp', 'value', { value: 99, max: '' })).toBe(99);
  });

  it('step lookup picks the highest reached step, else "below"', () => {
    const steps = [
      { at: 86400, value: 0.25 },
      { at: 43200, value: 0.5 },
    ];
    expect(lookupStep(stepsOf(steps), 0, 1)).toBe(1);
    expect(lookupStep(stepsOf(steps), 43200, 1)).toBe(0.5);
    expect(lookupStep(stepsOf(steps), 90000, 1)).toBe(0.25);
    expect(stepsOf(JSON.stringify(steps))).toHaveLength(2);
    expect(stepsOf('not json')).toEqual([]);
    expect(stepsOf([{ at: 'x', value: 1 }, null])).toEqual([]);
    expect(pullValue('step_lookup', 'value', { x: 50000, steps })).toBe(0.5);
    expect(pullValue('step_lookup', 'value', { x: 5 })).toBe(1);
  });
});

describe('date_time', () => {
  // 2026-11-09 18:00 local
  const now = new Date(2026, 10, 9, 18, 0, 0).getTime();

  it('a time of day means its next occurrence', () => {
    expect(parseDateTime('20:00', now)).toBe(
      new Date(2026, 10, 9, 20, 0, 0).getTime() / 1000
    );
    expect(parseDateTime('17:30', now)).toBe(
      new Date(2026, 10, 10, 17, 30, 0).getTime() / 1000
    );
    expect(parseDateTime('25:00', now)).toBeNull();
  });

  it('a full date means that moment; junk is invalid', () => {
    expect(parseDateTime('2026-11-09T20:00:00Z')).toBe(
      Date.UTC(2026, 10, 9, 20) / 1000
    );
    expect(parseDateTime('soon')).toBeNull();
    expect(parseDateTime('')).toBeNull();
    expect(pullValue('date_time', 'valid', { text: 'soon' })).toBe(false);
    expect(pullValue('date_time', 'seconds', { text: 'soon' })).toBe(0);
    expect(
      pullValue('date_time', 'seconds', { text: '2026-11-09T20:00:00Z' })
    ).toBe(Date.UTC(2026, 10, 9, 20) / 1000);
    const away = pullValue('date_time', 'fromNow', {
      text: new Date(Date.now() + 60_000).toISOString(),
    }) as number;
    expect(away).toBeGreaterThan(58);
    expect(away).toBeLessThanOrEqual(60);
  });
});

describe('deadline transitions', () => {
  it('start / add / pause / resume keep end time, remaining and total', () => {
    let s: DeadlineState = deadlineOps.start(600, 1000);
    expect(s).toMatchObject({ endsAt: 1600, total: 600, running: true });
    s = deadlineOps.add(s, 120, 1100);
    expect(s.endsAt).toBe(1720);
    expect(s.total).toBe(720);
    s = deadlineOps.pause(s, 1200);
    expect(s).toMatchObject({ endsAt: null, remaining: 520, running: false });
    s = deadlineOps.add(s, 30, 5000); // while paused: no clock running
    expect(s.remaining).toBe(550);
    s = deadlineOps.resume(s, 6000);
    expect(s.endsAt).toBe(6550);
    expect(remainingOf(s, 6050)).toBe(500);
  });

  it('taking off more time than is left stops at zero', () => {
    const s = deadlineOps.add(deadlineOps.start(60, 0), -100, 0);
    expect(remainingOf(s, 0)).toBe(0);
    expect(s.total).toBe(0);
  });

  it('a finished timer ignores add and resume', () => {
    const done = deadlineOps.finish(deadlineOps.start(10, 0));
    expect(deadlineOps.add(done, 60)).toBe(done);
    expect(deadlineOps.resume(done)).toBe(done);
  });
});

describe('tally', () => {
  it('adds under a name (case-insensitive), keeps the latest, ranks the top', () => {
    let s = { totals: {}, recent: [] };
    s = tallyAdd(s, 'Ann', 5, 'tip', 2, 1);
    s = tallyAdd(s, 'bob', 3, 'tip', 2, 2);
    s = tallyAdd(s, 'ann', 1, 'sub', 2, 3);
    expect(s.recent.map((r) => r.name)).toEqual(['ann', 'bob']);
    expect(tallyTop(s, 5)).toEqual([
      { name: 'ann', total: 6, count: 2 },
      { name: 'bob', total: 3, count: 1 },
    ]);
    expect(tallyTop(s, 1)).toHaveLength(1);
  });
});

async function newProject(app: Parameters<typeof request>[0]) {
  return (await request(app).post('/api/projects').send({ name: 'P' })).body
    .data.id as string;
}

/** A node plus a log sink pulling the listed outputs; each listed event
 *  output counts into a project variable named `ev:<port>`. */
function probe(
  kind: string,
  config: Record<string, unknown>,
  outs: string[],
  events: string[] = []
) {
  const projectId = config._projectId;
  const { graph } = buildGraph(
    [
      { id: 'n', kind },
      { id: 'trg', kind: 'component_trigger' },
      { id: 'sink', kind: 'log' },
      ...events.map((e) => ({ id: `count-${e}`, kind: 'increment_variable' })),
    ],
    [
      ...events.map((e) => ({
        fromNodeId: 'n',
        fromPort: e,
        toNodeId: `count-${e}`,
        toPort: 'fire',
      })),
      ...outs.map((p) => ({
        fromNodeId: 'n',
        fromPort: p,
        toNodeId: 'sink',
        toPort: 'inputs',
      })),
      {
        fromNodeId: 'trg',
        fromPort: 'trigger',
        toNodeId: 'sink',
        toPort: 'trigger',
      },
    ],
    {
      n: config,
      ...Object.fromEntries(
        events.map((e) => [
          `count-${e}`,
          { _projectId: projectId, name: `ev:${e}` },
        ])
      ),
    }
  );
  return {
    graph,
    count: (e: string) =>
      (readVariable({
        projectId: projectId as string,
        scope: '',
        name: `ev:${e}`,
      }) as number | undefined) ?? 0,
    fire: (port: string) =>
      graph.deliverExternal('n', port, mkEvent(undefined)),
    read: () => {
      graph.fire('trg', 'trigger', mkEvent(undefined));
      return graph.peekInput('sink', 'inputs') as unknown[];
    },
  };
}

describe('deadline and tally in a project variable', () => {
  let app: Parameters<typeof request>[0];
  let projectId: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    ({ app } = await makeTestApp({ mesh: true }));
    projectId = await newProject(app);
  });
  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
  });

  it('deadline stores its state, fires changed, and finished at the end', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const d = probe(
      'deadline',
      { _projectId: projectId, name: 't', duration: 10, by: 5, persistent: true },
      ['endsAt', 'remaining', 'total', 'running'],
      ['changed', 'finished']
    );
    vi.advanceTimersByTime(0); // start-up: `changed` once
    expect(d.count('changed')).toBe(1);

    d.fire('start');
    expect(d.read()).toEqual([1010, 10, 10, true]);
    d.fire('add');
    expect(d.read()).toEqual([1015, 15, 15, true]);
    expect(d.count('changed')).toBe(3);
    expect(
      readVariable({ projectId, scope: '', name: 't' })
    ).toMatchObject({ endsAt: 1015, total: 15, running: true });

    vi.advanceTimersByTime(5000);
    d.fire('pause');
    expect(d.read()).toEqual([0, 10, 15, false]);
    d.fire('resume');
    vi.advanceTimersByTime(10_000);
    expect(d.read()).toEqual([0, 0, 15, false]);
    expect(
      (readVariable({ projectId, scope: '', name: 't' }) as DeadlineState)
        .finished
    ).toBe(true);
    expect(d.count('finished')).toBe(1);
    d.graph.dispose();
  });

  it('a timer that ran out while stopped is marked finished on start-up, silently', async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    const first = probe(
      'deadline',
      { _projectId: projectId, name: 'late', duration: 5, persistent: true },
      ['running']
    );
    first.fire('start');
    first.graph.dispose();
    vi.setSystemTime(2_000_000 + 60_000);
    const again = probe(
      'deadline',
      { _projectId: projectId, name: 'late', persistent: true },
      ['running', 'remaining'],
      ['finished']
    );
    vi.advanceTimersByTime(1);
    expect(again.count('finished')).toBe(0);
    expect(again.read()).toEqual([false, 0]);
    expect(
      (readVariable({ projectId, scope: '', name: 'late' }) as DeadlineState)
        .finished
    ).toBe(true);
  });

  it('tally adds per user, resets, and ignores a nameless entry', () => {
    const t = probe(
      'tally',
      { _projectId: projectId, name: 'top', user: 'Ann', amount: 5, label: 'tip' },
      ['top', 'last']
    );
    t.fire('add');
    t.fire('add');
    const [top, last] = t.read() as [
      { name: string; total: number }[],
      { name: string; amount: number },
    ];
    expect(top).toEqual([{ name: 'Ann', total: 10, count: 2 }]);
    expect(last).toMatchObject({ name: 'Ann', amount: 5, label: 'tip' });
    t.fire('reset');
    expect(t.read()).toEqual([[], null]);
    const nameless = probe(
      'tally',
      { _projectId: projectId, name: 'top', user: '  ' },
      ['recent']
    );
    nameless.fire('add');
    expect(nameless.read()).toEqual([[]]);
  });
});

describe('overlive goal / follow / gift bomb', () => {
  const goal = (data: Record<string, unknown>) => ({
    type: 'goal',
    data: {
      goalId: 'g1',
      kind: 'follow',
      description: 'Follows',
      current: 5,
      target: 20,
      phase: 'progress',
      achieved: false,
      ...data,
    },
  });

  it('shows the goal, its progress, and that it ended', () => {
    const n = loneNode('overlive_goal');
    n.deliver('event', goal({}));
    expect(n.graph.getNodeState('n')).toMatchObject({
      description: 'Follows',
      current: 5,
      target: 20,
      progress: 0.25,
      active: true,
    });
    n.deliver('event', goal({ phase: 'end', current: 20, achieved: true }));
    expect(n.graph.getNodeState('n')).toMatchObject({
      active: false,
      achieved: true,
      progress: 1,
    });
  });

  it('a kind filter skips other goals; another goal ending keeps the shown one', () => {
    const n = loneNode('overlive_goal', { kind: 'new_subscription' });
    n.deliver('event', goal({}));
    expect(n.graph.getNodeState('n')).toBeUndefined();
    const any = loneNode('overlive_goal');
    any.deliver('event', goal({}));
    any.deliver('event', goal({ goalId: 'g2', phase: 'end' }));
    expect(any.graph.getNodeState('n')).toMatchObject({
      goalId: 'g1',
      active: true,
    });
  });

  it('follow and gift bomb carry their whole record in data', () => {
    expect(
      pullValue('overlive_follow', 'data', {}, {
        username: 'ann',
        displayName: 'Ann',
      })
    ).toEqual({ username: 'ann', displayName: 'Ann' });
    expect(
      pullValue('overlive_gift_bomb', 'data', {}, {
        gifterUsername: 'bob',
        gifterDisplayName: 'Bob',
        count: 5,
        tier: 'tier1',
        totalGifts: 9,
        anonymous: false,
      })
    ).toMatchObject({ username: 'bob', displayName: 'Bob', count: 5 });
  });
});
