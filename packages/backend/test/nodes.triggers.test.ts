import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkEvent } from '@vspark/shared/signal';
import { makeTestApp } from './helpers/testApp.js';
import { getMeshCollection } from '../src/mesh/index.js';
import { logicManager } from '../src/logic/manager.js';
import { readVariable } from '../src/variables/store.js';
import { MAX_TRIGGER_DEPTH, triggerRouter } from '../src/triggers/router.js';

/**
 * Cross-graph triggers through running Logic graphs: `send_trigger` in one
 * graph reaches `on_trigger` nodes in every graph of the same project — and
 * no other project — and a trigger that re-sends itself is cut off.
 *
 * Receivers count deliveries in a variable, which doubles as an end-to-end
 * check that the receiving graph ran.
 */
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

type N = { id: string; kind: string; cfg?: Record<string, unknown> };
type E = [string, string, string, string];

let graphSeq = 0;
async function graph(
  projectId: string,
  nodes: N[],
  edges: E[]
): Promise<string> {
  const id = `g${++graphSeq}`;
  await getMeshCollection('logic')!.set(id, '', {
    id,
    ownerKind: 'project',
    ownerId: projectId,
    name: id,
    enabled: true,
    descriptor: {
      nodes: Object.fromEntries(
        nodes.map((n) => [
          n.id,
          {
            id: n.id,
            kind: n.kind,
            position: { x: 0, y: 0 },
            defaultConfig: n.cfg ?? {},
          },
        ])
      ),
      edges: Object.fromEntries(
        edges.map(([fromNodeId, fromPort, toNodeId, toPort], i) => [
          `e${i}`,
          { fromNodeId, fromPort, toNodeId, toPort },
        ])
      ),
    },
  }).ack;
  return id;
}

/** on_trigger(name) → increment_variable(counter) [+ extra nodes/edges]. */
const receiver = (
  name: string,
  counter: string,
  extra: { nodes?: N[]; edges?: E[] } = {}
) => ({
  nodes: [
    { id: 'on', kind: 'on_trigger', cfg: { name } },
    { id: 'inc', kind: 'increment_variable', cfg: { name: counter } },
    ...(extra.nodes ?? []),
  ],
  edges: [['on', 'event', 'inc', 'fire'] as E, ...(extra.edges ?? [])],
});

describe('send_trigger / on_trigger', () => {
  let p1: string;
  let p2: string;
  const count = (projectId: string, name: string) =>
    readVariable({ projectId, scope: '', name });

  beforeEach(async () => {
    const { app } = await makeTestApp({ mesh: true });
    p1 = (await request(app).post('/api/projects').send({ name: 'P1' })).body
      .data.id;
    p2 = (await request(app).post('/api/projects').send({ name: 'P2' })).body
      .data.id;
  });
  afterEach(() => logicManager.close());

  it('delivers to every graph of the sending project only, with the payload', async () => {
    const sender = await graph(
      p1,
      [
        {
          id: 'send',
          kind: 'send_trigger',
          cfg: { name: 'hello', payload: { user: 'bob' } },
        },
      ],
      []
    );
    const r1 = receiver('hello', 'got', {
      nodes: [{ id: 'save', kind: 'set_variable', cfg: { name: 'payload' } }],
      edges: [
        ['on', 'event', 'save', 'fire'],
        ['on', 'payload', 'save', 'value'],
      ],
    });
    await graph(p1, r1.nodes, r1.edges);
    const r2 = receiver('hello', 'got');
    await graph(p1, r2.nodes, r2.edges); // a second graph of the same project
    const r3 = receiver('other', 'got-other');
    await graph(p1, r3.nodes, r3.edges); // a different trigger name
    const r4 = receiver('hello', 'got');
    await graph(p2, r4.nodes, r4.edges); // another project

    logicManager.fire(sender, 'send', 'fire', mkEvent(undefined));

    expect(count(p1, 'got')).toBe(2);
    expect(count(p1, 'payload')).toEqual({ user: 'bob' });
    expect(count(p1, 'got-other')).toBeUndefined();
    expect(count(p2, 'got')).toBeUndefined();
  });

  it('matches names exactly, ignoring surrounding spaces; empty never fires', async () => {
    const r = receiver(' Go ', 'n');
    await graph(p1, r.nodes, r.edges);
    const e = receiver('', 'empty');
    await graph(p1, e.nodes, e.edges);
    triggerRouter.send(p1, 'go', null);
    expect(count(p1, 'n')).toBeUndefined();
    triggerRouter.send(p1, 'Go', null);
    expect(count(p1, 'n')).toBe(1);
    triggerRouter.send(p1, '', null);
    expect(count(p1, 'empty')).toBeUndefined();
  });

  it('stops a trigger that re-sends itself', async () => {
    const r = receiver('loop', 'n', {
      nodes: [{ id: 'again', kind: 'send_trigger', cfg: { name: 'loop' } }],
      edges: [['on', 'event', 'again', 'fire']],
    });
    await graph(p1, r.nodes, r.edges);

    expect(triggerRouter.send(p1, 'loop', null)).toEqual({
      status: 'sent',
      delivered: 1,
    });
    expect(count(p1, 'n')).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('trigger loop')
    );
    // Not nested any more → it goes through again.
    triggerRouter.send(p1, 'loop', null);
    expect(count(p1, 'n')).toBe(2);
  });

  it('stops an indirect loop (a → b → a)', async () => {
    const a = receiver('a', 'na', {
      nodes: [{ id: 'toB', kind: 'send_trigger', cfg: { name: 'b' } }],
      edges: [['on', 'event', 'toB', 'fire']],
    });
    const b = receiver('b', 'nb', {
      nodes: [{ id: 'toA', kind: 'send_trigger', cfg: { name: 'a' } }],
      edges: [['on', 'event', 'toA', 'fire']],
    });
    await graph(p1, a.nodes, a.edges);
    await graph(p1, b.nodes, b.edges);
    triggerRouter.send(p1, 'a', null);
    expect(count(p1, 'na')).toBe(1);
    expect(count(p1, 'nb')).toBe(1);
  });

  it(`cuts a non-repeating chain at ${MAX_TRIGGER_DEPTH} nested triggers`, async () => {
    const links = MAX_TRIGGER_DEPTH + 4;
    for (let i = 0; i < links; i++) {
      const r = receiver(`t${i}`, 'depth', {
        nodes: [
          { id: 'next', kind: 'send_trigger', cfg: { name: `t${i + 1}` } },
        ],
        edges: [['on', 'event', 'next', 'fire']],
      });
      await graph(p1, r.nodes, r.edges);
    }
    triggerRouter.send(p1, 't0', null);
    expect(count(p1, 'depth')).toBe(MAX_TRIGGER_DEPTH);
  });
});
