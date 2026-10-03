import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { getMeshCollection } from '../src/mesh/index.js';
import * as refresh from '../src/behaviors/refresh.js';

/**
 * Attaching or detaching a behavior instantiates or tears down its signal graph.
 * That side effect used to live in the REST routes, which was fine while REST
 * was the only way a behavior could change — and silently wrong the moment one
 * could be authored on the mesh.
 *
 * A tab write, an undo, and a collab peer's edit all reach the collection
 * without passing through a route. These assert the side effect follows the
 * STATE rather than the entry point: the route path still works, and the
 * mesh-authored path — which no route test could reach — works too.
 */
describe('behavior lifecycle follows the committed write', () => {
  let app: Express;
  let nodeId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    const projectId = (
      await request(app).post('/api/projects').send({ name: 'P' })
    ).body.data.id as string;
    const sceneId = (
      await request(app)
        .post(`/api/projects/${projectId}/scenes`)
        .send({ name: 'S', populate: false })
    ).body.data.id as string;
    nodeId = (
      await request(app)
        .post(`/api/scenes/${sceneId}/nodes`)
        .send({ name: 'N', kind: 'group' })
    ).body.data.id as string;
  });

  const spyRefresh = () => vi.spyOn(refresh, 'refreshAllBehaviorManagers');

  it('fires for a behavior authored directly on the mesh', async () => {
    // The case the routes could never cover: no HTTP involved at all.
    const spy = spyRefresh();
    const col = getMeshCollection('behavior')!;
    await col.set('b1', '', {
      id: 'b1',
      nodeId,
      kind: 'breathing',
      enabled: true,
      config: {},
      sortOrder: 0,
    }).ack;
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fires when a mesh-authored behavior is removed', async () => {
    const col = getMeshCollection('behavior')!;
    await col.set('b1', '', {
      id: 'b1',
      nodeId,
      kind: 'breathing',
      enabled: true,
      config: {},
      sortOrder: 0,
    }).ack;

    const spy = spyRefresh();
    await col.remove('b1').ack;
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('still fires through the REST routes', async () => {
    const spy = spyRefresh();
    const created = await request(app)
      .post(`/api/scene-nodes/${nodeId}/behaviors`)
      .send({ kind: 'breathing' });
    expect(created.status).toBe(201);
    expect(spy).toHaveBeenCalled();

    spy.mockClear();
    await request(app).delete(`/api/behaviors/${created.body.data.id}`);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not fire for other rtypes', async () => {
    // The tap runs for every collection; only behaviors carry this side effect.
    const spy = spyRefresh();
    await getMeshCollection('camera_effect')!.set('e1', '', {
      id: 'e1',
      nodeId,
      kind: 'bloom',
      enabled: true,
      config: {},
    }).ack;
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refreshes AFTER the row lands, so the manager sees the new state', async () => {
    // Ordering matters in both directions: refresh before the write and the
    // manager reads stale rows; the graph then runs for a behavior that is not
    // there, or fails to run for one that is.
    const col = getMeshCollection('behavior')!;
    let rowsAtRefresh: unknown[] = [];
    const spy = vi
      .spyOn(refresh, 'refreshAllBehaviorManagers')
      .mockImplementation(() => {
        rowsAtRefresh = col.all();
      });
    await col.set('b1', '', {
      id: 'b1',
      nodeId,
      kind: 'breathing',
      enabled: true,
      config: {},
      sortOrder: 0,
    }).ack;
    expect(rowsAtRefresh.map((r) => (r as { id: string }).id)).toContain('b1');
    spy.mockRestore();
  });
});
