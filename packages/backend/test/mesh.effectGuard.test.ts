import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { getMeshCollection } from '../src/mesh/index.js';
import { guardClientNodeChild } from '../src/mesh/docGuards.js';

/**
 * Guarding client-authored camera effects.
 *
 * Tabs author effects on the mesh now, so the owner check the REST route used
 * to perform has to run on the write itself. `persists` is NOT enough for this:
 * it gates SQLite only, so a doc that fails it still fans out to every replica
 * and shows up in other tabs as an effect on a node that does not exist.
 * Rejecting in `validate` NACKs the write and rolls the author's optimistic
 * copy back.
 */
describe('camera_effect client guard', () => {
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

  const effect = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    nodeId,
    kind: 'bloom',
    enabled: true,
    config: {},
    ...over,
  });

  it('accepts an effect on a node this server has', async () => {
    const col = getMeshCollection('camera_effect')!;
    const out = await col.set('e1', '', effect()).ack;
    expect(out.status).not.toBe('rejected');
    expect(col.get('e1')).toBeDefined();
  });

  it('persists an accepted effect', async () => {
    const col = getMeshCollection('camera_effect')!;
    await col.set('e1', '', effect()).ack;
    const list = await request(app).get(`/api/scene-nodes/${nodeId}/effects`);
    expect(list.body.data.map((e: { id: string }) => e.id)).toContain('e1');
  });

  // The guard only runs for CLIENT-authored writes — a participant id carrying
  // the client separator. A write issued here is the server's own, so the
  // integration cases above deliberately do not exercise it; the rule is
  // covered directly instead.
  it('rejects an effect whose node this server does not have', () => {
    expect(() =>
      guardClientNodeChild(effect({ nodeId: 'ghost' }), 'camera_effect')
    ).toThrow(/not found/);
  });

  it('rejects an effect with no owner at all', () => {
    const { nodeId: _drop, ...orphan } = effect();
    expect(() => guardClientNodeChild(orphan, 'camera_effect')).toThrow(
      /nodeId is required/
    );
  });

  it('passes a real node through unchanged', () => {
    const d = effect();
    expect(guardClientNodeChild(d, 'camera_effect')).toEqual(d);
  });

  it('still serves the REST create path', async () => {
    const res = await request(app)
      .post(`/api/scene-nodes/${nodeId}/effects`)
      .send({ kind: 'bloom' });
    expect(res.status).toBe(201);
    expect(
      getMeshCollection('camera_effect')!.get(res.body.data.id)
    ).toBeDefined();
  });
});
