import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { getMeshCollection } from '../src/mesh/index.js';
import { getDb } from '../src/db/index.js';
import { logicManager } from '../src/logic/manager.js';

/**
 * `logic` as a synced document.
 *
 * It had no sync of any kind: the panels re-polled every 3 seconds and the graph
 * canvas PUT the whole descriptor on a debounce, so two people editing the same
 * graph simply overwrote each other with no way to notice.
 *
 * As with behaviors, the reachability checks matter more than the behaviour
 * ones — a collection that is written but unwired fails silently. And as with
 * behaviors, committing carries a side effect: the descriptor IS the program,
 * so a write has to reconcile the running instance.
 */
describe('logic collection', () => {
  let app: Express;
  let projectId: string;
  let nodeId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    projectId = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data.id as string;
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

  it('is bound and reachable after init', () => {
    expect(getMeshCollection('logic')).toBeDefined();
  });

  it('persists a committed write through its descriptor', async () => {
    await getMeshCollection('logic')!.set('g1', '', {
      id: 'g1',
      ownerKind: 'project',
      ownerId: projectId,
      name: 'Graph',
      enabled: true,
      descriptor: { nodes: [], edges: [] },
    }).ack;

    const row = getDb()
      .prepare('SELECT * FROM logic WHERE id = ?')
      .get('g1') as Record<string, unknown> | undefined;
    expect(row?.name).toBe('Graph');
    expect(row?.owner_kind).toBe('project');
  });

  it('parents a node-owned graph under its node', async () => {
    await getMeshCollection('logic')!.set('g1', '', {
      id: 'g1',
      ownerKind: 'scene_node',
      ownerId: nodeId,
      name: 'NodeGraph',
      enabled: true,
      descriptor: { nodes: [], edges: [] },
    }).ack;
    // So a scene-subtree grant reaches it, like behaviors and effects.
    expect(
      getMeshCollection('logic')!
        .subtree(nodeId)
        .map((d) => (d as { id: string }).id)
    ).toContain('g1');
  });

  it('leaves a project-owned graph parentless', async () => {
    // Deliberate: there is no `project` rtype in the mesh. Grants use
    // entityRtype '*', so routing never consults this — the cost is only that
    // project graphs cannot be subtree-scoped until such an rtype exists.
    await getMeshCollection('logic')!.set('g1', '', {
      id: 'g1',
      ownerKind: 'project',
      ownerId: projectId,
      name: 'ProjGraph',
      enabled: true,
      descriptor: { nodes: [], edges: [] },
    }).ack;
    expect(getMeshCollection('logic')!.get('g1')).toBeDefined();
    expect(
      getMeshCollection('logic')!
        .subtree(nodeId)
        .map((d) => (d as { id: string }).id)
    ).not.toContain('g1');
  });

  it('reconciles the running graph on a committed write', async () => {
    // The descriptor is the program: persisting it without restarting the
    // instance would leave the old program running.
    const spy = vi.spyOn(logicManager, 'reconcile');
    await getMeshCollection('logic')!.set('g1', '', {
      id: 'g1',
      ownerKind: 'project',
      ownerId: projectId,
      name: 'Graph',
      enabled: true,
      descriptor: { nodes: [], edges: [] },
    }).ack;
    expect(spy).toHaveBeenCalledWith('g1');
    spy.mockRestore();
  });

  it('reconciles on remove, which stops the instance', async () => {
    await getMeshCollection('logic')!.set('g1', '', {
      id: 'g1',
      ownerKind: 'project',
      ownerId: projectId,
      name: 'Graph',
      enabled: true,
      descriptor: { nodes: [], edges: [] },
    }).ack;

    const spy = vi.spyOn(logicManager, 'reconcile');
    await getMeshCollection('logic')!.remove('g1').ack;
    expect(spy).toHaveBeenCalledWith('g1');
    spy.mockRestore();
    expect(
      getDb().prepare('SELECT 1 FROM logic WHERE id = ?').get('g1')
    ).toBeUndefined();
  });

  it('accepts a client-supplied id on create, so a tab can author it', async () => {
    // Without this the server mints the id, which makes the create
    // server-authored and so undoable by nobody.
    const res = await request(app)
      .post(`/api/projects/${projectId}/logic`)
      .send({ id: 'client-chosen', name: 'Mine' });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('client-chosen');
  });

  it('still mints an id when the caller does not supply one', async () => {
    const res = await request(app)
      .post(`/api/scene-nodes/${nodeId}/logic`)
      .send({ name: 'Auto' });
    expect(res.status).toBe(201);
    expect(typeof res.body.data.id).toBe('string');
    expect(res.body.data.id.length).toBeGreaterThan(0);
  });
});
