import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import {
  captureProjectSnapshot,
  revertProjectToSnapshot,
} from '../src/assistant/checkpoint.js';
import { getMeshCollection } from '../src/mesh/index.js';

/**
 * Project snapshot/revert that backs the assistant's auto-checkpoint undo:
 * a snapshot taken before a mutating turn restores the project — re-setting
 * changed docs and removing ones created since.
 */
describe('assistant checkpoint (capture + revert)', () => {
  let app: Express;
  let projectId: string;
  let sceneId: string;

  const createNode = (name: string) =>
    request(app)
      .post(`/api/scenes/${sceneId}/nodes`)
      .send({ name, kind: 'group' });

  const nodesOf = (project: string) =>
    (
      (getMeshCollection('scene_node')?.all() ?? []) as Record<
        string,
        unknown
      >[]
    ).filter((n) => n.projectId === project);

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

  it('removes docs created after the snapshot', async () => {
    const a = (await createNode('A')).body.data.id as string;
    const snap = captureProjectSnapshot(projectId);

    const b = (await createNode('B')).body.data.id as string;
    expect(nodesOf(projectId).map((n) => n.id)).toEqual(
      expect.arrayContaining([a, b])
    );

    const res = await revertProjectToSnapshot(snap);
    expect(res.removed).toBeGreaterThanOrEqual(1);
    const ids = nodesOf(projectId).map((n) => n.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
  });

  it('restores a doc modified after the snapshot', async () => {
    const a = (await createNode('Original')).body.data.id as string;
    const snap = captureProjectSnapshot(projectId);

    await request(app).put(`/api/scene-nodes/${a}`).send({ name: 'Renamed' });
    expect(nodesOf(projectId).find((n) => n.id === a)?.name).toBe('Renamed');

    await revertProjectToSnapshot(snap);
    expect(nodesOf(projectId).find((n) => n.id === a)?.name).toBe('Original');
  });

  it('does not touch another project', async () => {
    const otherProj = (
      await request(app).post('/api/projects').send({ name: 'Other' })
    ).body.data.id as string;
    const otherScene = (
      await request(app)
        .post(`/api/projects/${otherProj}/scenes`)
        .send({ name: 'S' })
    ).body.data.id as string;
    const otherNode = (
      await request(app)
        .post(`/api/scenes/${otherScene}/nodes`)
        .send({ name: 'Keep', kind: 'group' })
    ).body.data.id as string;

    const snap = captureProjectSnapshot(projectId);
    await createNode('B'); // a change in OUR project
    await revertProjectToSnapshot(snap);

    // the other project's node is untouched
    expect(nodesOf(otherProj).map((n) => n.id)).toContain(otherNode);
  });
});
