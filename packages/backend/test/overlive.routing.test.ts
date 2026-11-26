import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { getDb } from '../src/db/index.js';
import { logicManager } from '../src/logic/manager.js';
import { initOverliveManager } from '../src/overlive/manager.js';
import { writeVariable } from '../src/variables/store.js';

/**
 * OverliveManager routing: a trigger node's `account` / `channel` are resolved
 * as the node would pull them — a wired port wins over the inline config
 * (here a `variable` holding the account id; an Action wires a `settings`
 * node), an empty account means the project's default account.
 */
const ol = initOverliveManager();
const route = (projectId: string, ev: Record<string, unknown>) =>
  (ol as unknown as { routeEvent: (p: string, e: unknown) => void }).routeEvent(
    projectId,
    ev
  );
const follow = (source: string, channel = 'chan') => ({
  type: 'follow',
  id: 'e',
  platform: 'twitch',
  sourceInstanceId: source,
  channel,
  timestamp: new Date(),
  raw: null,
  data: { username: 'u', displayName: 'U' },
});

describe('overlive routing', () => {
  let app: Express;
  let projectId: string;

  /** A project graph with one follow trigger configured by `cfg`, the
   *  `account` optionally wired from a variable holding `wired`. */
  async function graphWith(cfg: Record<string, unknown>, wired?: string) {
    const id = `g-${Math.random().toString(36).slice(2)}`;
    await request(app)
      .post(`/api/projects/${projectId}/logic`)
      .send({ id, name: 'G' });
    const nodes: Record<string, unknown> = {
      f: {
        id: 'f',
        kind: 'overlive_follow',
        position: { x: 0, y: 0 },
        defaultConfig: cfg,
      },
    };
    const edges: Record<string, unknown> = {};
    if (wired !== undefined) {
      writeVariable({ projectId, scope: '', name: id }, wired, false);
      nodes.acc = {
        id: 'acc',
        kind: 'variable',
        position: { x: 0, y: 0 },
        defaultConfig: { name: id },
      };
      edges.e1 = {
        id: 'e1',
        fromNodeId: 'acc',
        fromPort: 'value',
        toNodeId: 'f',
        toPort: 'account',
      };
    }
    const res = await request(app)
      .put(`/api/logic/${id}`)
      .send({ descriptor: { id, label: 'G', readonly: false, nodes, edges } });
    expect(res.status).toBe(200);
    return id;
  }
  const hit = (graphId: string) =>
    logicManager.getStates(graphId)?.nodes.f?.portValues['in:event'] !==
    undefined;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    projectId = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data.id as string;
    for (const [id, def] of [
      ['acc-1', 1],
      ['acc-2', 0],
    ] as const)
      getDb()
        .prepare(
          `INSERT INTO overlive_accounts (id, project_id, platform, label, is_default)
           VALUES (?, ?, 'twitch', ?, ?)`
        )
        .run(id, projectId, id, def);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logicManager.close();
    vi.restoreAllMocks();
  });

  it('a wired account port wins over the inline config', async () => {
    const g = await graphWith({ account: 'acc-1' }, 'acc-2');
    route(projectId, follow('acc-1'));
    expect(hit(g)).toBe(false);
    route(projectId, follow('acc-2'));
    expect(hit(g)).toBe(true);
  });

  it('inline config and the default-account fallback still apply', async () => {
    const inline = await graphWith({ account: 'acc-2' });
    const empty = await graphWith({});
    const wiredEmpty = await graphWith({}, '');
    route(projectId, follow('acc-1'));
    expect([hit(inline), hit(empty), hit(wiredEmpty)]).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('the channel filter is resolved the same way', async () => {
    const g = await graphWith({ account: 'acc-1', channel: 'Other' });
    route(projectId, follow('acc-1', 'chan'));
    expect(hit(g)).toBe(false);
    route(projectId, follow('acc-1', 'other'));
    expect(hit(g)).toBe(true);
  });
});
