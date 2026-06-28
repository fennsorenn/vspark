import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import {
  captureProjectSnapshot,
  revertChangeSet,
} from '../src/assistant/checkpoint.js';
import { getMeshCollection } from '../src/mesh/index.js';

/**
 * The assistant's auto-checkpoint undo reverts only the agent's OWN change-set
 * (diff of before→after snapshots), and only when a doc hasn't been touched
 * since — so it never clobbers a concurrent/subsequent user edit.
 */
describe('assistant checkpoint (change-set revert)', () => {
  let app: Express;
  let projectId: string;
  let sceneId: string;

  const createNode = (name: string) =>
    request(app)
      .post(`/api/scenes/${sceneId}/nodes`)
      .send({ name, kind: 'group' });

  const nodesOf = (project: string) =>
    (
      (getMeshCollection('scene_node')?.all() ?? []) as Record<string, unknown>[]
    ).filter((n) => n.projectId === project);
  const nameOf = (id: string) =>
    nodesOf(projectId).find((n) => n.id === id)?.name;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    projectId = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data.id as string;
    sceneId = (
      await request(app)
        .post(`/api/projects/${projectId}/scenes`)
        .send({ name: 'Main' })
    ).body.data.id as string;
  });

  it('removes a doc the agent created', async () => {
    const a = (await createNode('A')).body.data.id as string;
    const before = captureProjectSnapshot(projectId);
    const b = (await createNode('B')).body.data.id as string;
    const after = captureProjectSnapshot(projectId);

    const res = await revertChangeSet(before, after);
    expect(res.reverted).toBe(1);
    const ids = nodesOf(projectId).map((n) => n.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
  });

  it('restores a doc the agent modified', async () => {
    const a = (await createNode('Original')).body.data.id as string;
    const before = captureProjectSnapshot(projectId);
    await request(app).put(`/api/scene-nodes/${a}`).send({ name: 'Renamed' });
    const after = captureProjectSnapshot(projectId);

    await revertChangeSet(before, after);
    expect(nameOf(a)).toBe('Original');
  });

  it('does NOT undo a concurrent edit to an unrelated doc', async () => {
    const a = (await createNode('A')).body.data.id as string;
    const u = (await createNode('UserNode')).body.data.id as string;
    const before = captureProjectSnapshot(projectId);

    // agent changes A
    await request(app).put(`/api/scene-nodes/${a}`).send({ name: 'AgentEdit' });
    const after = captureProjectSnapshot(projectId);

    // meanwhile a user renames an unrelated node + creates a new one
    await request(app).put(`/api/scene-nodes/${u}`).send({ name: 'UserEdit' });
    const userNew = (await createNode('UserCreated')).body.data.id as string;

    await revertChangeSet(before, after);

    expect(nameOf(a)).toBe('A'); // agent's change rolled back
    expect(nameOf(u)).toBe('UserEdit'); // user's edit preserved
    expect(nodesOf(projectId).map((n) => n.id)).toContain(userNew); // not deleted
  });

  it('skips reverting a doc the user changed after the agent', async () => {
    const a = (await createNode('Orig')).body.data.id as string;
    const before = captureProjectSnapshot(projectId);
    await request(app).put(`/api/scene-nodes/${a}`).send({ name: 'AgentEdit' });
    const after = captureProjectSnapshot(projectId);

    // user edits the SAME node after the agent's turn
    await request(app).put(`/api/scene-nodes/${a}`).send({ name: 'UserAfter' });

    const res = await revertChangeSet(before, after);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(nameOf(a)).toBe('UserAfter'); // user's later edit not clobbered
  });
});
