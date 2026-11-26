import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkEvent } from '@vspark/shared/signal';
import { makeTestApp } from './helpers/testApp.js';
import { buildGraph } from './helpers/nodeHarness.js';
import { readVariable } from '../src/variables/store.js';
import { COOLDOWN_SCOPE } from '../src/signal/nodes/cooldown.js';

/**
 * Timing nodes: `cooldown` (wall-clock compare, optional shared group via a
 * project variable) and the two combo counters (`combo_threshold`,
 * `combo_timeout`, setTimeout-driven). Fake timers drive both the clock and
 * the timers.
 */
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  logSpy.mockRestore();
});

/** A node with two event outputs, each counted by a log sink. */
function twoWay(
  kind: string,
  outs: [string, string],
  cfg: Record<string, unknown>
) {
  const { graph } = buildGraph(
    [
      { id: 'n', kind },
      { id: 'a', kind: 'log' },
      { id: 'b', kind: 'log' },
    ],
    [
      { fromNodeId: 'n', fromPort: outs[0], toNodeId: 'a', toPort: 'trigger' },
      { fromNodeId: 'n', fromPort: outs[1], toNodeId: 'b', toPort: 'trigger' },
    ],
    { n: cfg }
  );
  const hits: string[] = [];
  const wrap = (id: string, label: string) => {
    let last: unknown;
    return () => {
      const v = graph.peekInput(id, 'trigger');
      if (v !== last) {
        last = v;
        hits.push(label);
      }
    };
  };
  const checkA = wrap('a', outs[0]);
  const checkB = wrap('b', outs[1]);
  return {
    graph,
    send: (payload: unknown = undefined) => {
      graph.deliverExternal('n', 'in', mkEvent(payload));
      checkA();
      checkB();
      return hits.at(-1);
    },
    hits,
  };
}

describe('cooldown', () => {
  it('passes the first event and blocks repeats within the cooldown', () => {
    const c = twoWay('cooldown', ['out', 'blocked'], { seconds: 10 });
    expect(c.send()).toBe('out');
    vi.advanceTimersByTime(5_000);
    expect(c.send()).toBe('blocked');
    vi.advanceTimersByTime(4_999);
    expect(c.send()).toBe('blocked');
    vi.advanceTimersByTime(1); // 10s after the last PASS — blocked ones don't count
    expect(c.send()).toBe('out');
  });

  it('passes payloads through unchanged', () => {
    const c = twoWay('cooldown', ['out', 'blocked'], { seconds: 1 });
    c.send('x');
    expect(
      (c.graph.peekInput('a', 'trigger') as { payload: unknown }).payload
    ).toBe('x');
    c.send('y');
    expect(
      (c.graph.peekInput('b', 'trigger') as { payload: unknown }).payload
    ).toBe('y');
  });

  it('lets everything through without a positive cooldown', () => {
    const c = twoWay('cooldown', ['out', 'blocked'], {});
    c.send(1);
    c.send(2);
    expect(c.hits).toEqual(['out', 'out']);
  });

  it('keeps private cooldowns per node', () => {
    const a = twoWay('cooldown', ['out', 'blocked'], { seconds: 10 });
    const b = twoWay('cooldown', ['out', 'blocked'], { seconds: 10 });
    expect(a.send()).toBe('out');
    expect(b.send()).toBe('out');
  });

  describe('shared group', () => {
    let projectId: string;
    beforeEach(async () => {
      vi.useRealTimers(); // supertest needs real timers
      const { app } = await makeTestApp({ mesh: true });
      projectId = (await request(app).post('/api/projects').send({ name: 'P' }))
        .body.data.id as string;
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    it('shares one cooldown between nodes (and graphs) of the same group', () => {
      const cfg = { seconds: 30, group: 'commands', _projectId: projectId };
      const a = twoWay('cooldown', ['out', 'blocked'], cfg);
      const b = twoWay('cooldown', ['out', 'blocked'], cfg);
      const other = twoWay('cooldown', ['out', 'blocked'], {
        ...cfg,
        group: 'other',
      });
      expect(a.send()).toBe('out');
      expect(b.send()).toBe('blocked');
      expect(other.send()).toBe('out');
      expect(
        readVariable({ projectId, scope: COOLDOWN_SCOPE, name: 'commands' })
      ).toBe(Date.now());
      vi.advanceTimersByTime(30_000);
      expect(b.send()).toBe('out');
      expect(a.send()).toBe('blocked');
    });

    it('does not share across projects', async () => {
      const a = twoWay('cooldown', ['out', 'blocked'], {
        seconds: 30,
        group: 'g',
        _projectId: projectId,
      });
      const b = twoWay('cooldown', ['out', 'blocked'], {
        seconds: 30,
        group: 'g',
        _projectId: 'another-project',
      });
      expect(a.send()).toBe('out');
      expect(b.send()).toBe('out');
    });
  });
});

/** A combo node whose single event output is counted, plus its `count`. */
function combo(
  kind: 'combo_threshold' | 'combo_timeout',
  cfg: Record<string, unknown>
) {
  const out = kind === 'combo_threshold' ? 'reached' : 'ended';
  const fired: number[] = []; // `count` as pulled when the output fired
  const { graph } = buildGraph(
    [
      { id: 'c', kind },
      { id: 'sink', kind: 'log' },
      { id: 'trg', kind: 'component_trigger' },
      { id: 'probe', kind: 'log' },
    ],
    [
      { fromNodeId: 'c', fromPort: out, toNodeId: 'sink', toPort: 'trigger' },
      {
        fromNodeId: 'c',
        fromPort: 'count',
        toNodeId: 'sink',
        toPort: 'inputs',
      },
      {
        fromNodeId: 'c',
        fromPort: 'count',
        toNodeId: 'probe',
        toPort: 'inputs',
      },
      {
        fromNodeId: 'trg',
        fromPort: 'trigger',
        toNodeId: 'probe',
        toPort: 'trigger',
      },
    ],
    { c: cfg }
  );
  let seen: unknown;
  const poll = () => {
    const ev = graph.peekInput('sink', 'trigger');
    if (ev !== undefined && ev !== seen) {
      seen = ev;
      fired.push((graph.peekInput('sink', 'inputs') as number[])[0]);
    }
  };
  return {
    graph,
    hit: (key?: string) => {
      if (key !== undefined) cfg.key = key;
      graph.deliverExternal('c', 'in', mkEvent(undefined));
      poll();
    },
    wait: (ms: number) => {
      vi.advanceTimersByTime(ms);
      poll();
    },
    count: () => {
      graph.fire('trg', 'trigger', mkEvent(undefined));
      return (graph.peekInput('probe', 'inputs') as number[])[0];
    },
    fired,
  };
}

describe('combo_threshold', () => {
  it('fires once when the count reaches the threshold within the window', () => {
    const c = combo('combo_threshold', { threshold: 3, window: 5 });
    c.hit();
    c.wait(4_000);
    c.hit();
    c.wait(4_000); // each hit restarts the window
    c.hit();
    expect(c.fired).toEqual([3]);
    c.hit();
    c.hit();
    expect(c.fired).toEqual([3]); // once per combo
    expect(c.count()).toBe(5);
  });

  it('resets the count when the window runs out', () => {
    const c = combo('combo_threshold', { threshold: 3, window: 5 });
    c.hit();
    c.hit();
    c.wait(5_000);
    expect(c.count()).toBe(0);
    c.hit();
    c.hit();
    expect(c.fired).toEqual([]);
    c.hit();
    expect(c.fired).toEqual([3]);
    // …and can fire again after the next window ends.
    c.wait(5_000);
    c.hit();
    c.hit();
    c.hit();
    expect(c.fired).toEqual([3, 3]);
  });

  it('counts a repeated key once and does not let it extend the window', () => {
    const c = combo('combo_threshold', { threshold: 3, window: 5 });
    c.hit('alice');
    c.wait(3_000);
    c.hit('alice'); // ignored — no count, no restart
    c.hit('bob');
    expect(c.count()).toBe(2);
    c.wait(4_999);
    c.hit('alice'); // still ignored
    c.wait(1); // 5s after bob → combo over
    expect(c.count()).toBe(0);
    c.hit('alice'); // a new combo: alice counts again
    expect(c.count()).toBe(1);
  });

  it('is inert without a positive window', () => {
    const c = combo('combo_threshold', { threshold: 1 });
    c.hit();
    expect(c.fired).toEqual([]);
    expect(c.count()).toBe(0);
  });

  it('clears its timer on graph teardown', () => {
    const c = combo('combo_threshold', { threshold: 5, window: 5 });
    c.hit();
    expect(vi.getTimerCount()).toBe(1);
    c.graph.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('combo_timeout', () => {
  it('fires ended with the final count when the timeout runs out', () => {
    const c = combo('combo_timeout', { timeout: 5 });
    c.hit();
    c.wait(4_000);
    c.hit();
    c.wait(4_000);
    c.hit();
    expect(c.fired).toEqual([]);
    expect(c.count()).toBe(3);
    c.wait(5_000);
    expect(c.fired).toEqual([3]);
    // The final count is held until the next combo starts.
    expect(c.count()).toBe(3);
    c.hit();
    expect(c.count()).toBe(1);
  });

  it('fires on every expiry, also for a single event', () => {
    const c = combo('combo_timeout', { timeout: 1 });
    c.hit();
    c.wait(1_000);
    c.hit();
    c.hit();
    c.wait(1_000);
    expect(c.fired).toEqual([1, 2]);
  });

  it('counts unique keys only, and repeats do not extend it', () => {
    const c = combo('combo_timeout', { timeout: 5 });
    c.hit('alice');
    c.wait(3_000);
    c.hit('alice');
    c.wait(2_000); // 5s after alice's counted hit
    expect(c.fired).toEqual([1]);
    c.hit('alice'); // new combo
    c.hit('bob');
    c.hit('');
    c.hit(''); // an empty key counts every event
    c.wait(5_000);
    expect(c.fired).toEqual([1, 4]);
  });

  it('never fires after graph teardown', () => {
    const c = combo('combo_timeout', { timeout: 5 });
    c.hit();
    c.graph.dispose();
    c.wait(10_000);
    expect(c.fired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
