import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { runtimeOverrideManager } from '../src/runtime_overrides/manager.js';
import { overrideCollection } from '../src/mesh/runtime.js';
import {
  guardClientSceneNode,
  assertSceneInstanceValid,
  SceneNodeInvalid,
} from '../src/mesh/docGuards.js';

/**
 * Server-authoritative scene_node checks.
 *
 * Clients author node creates straight onto the mesh (so the create lands on
 * the authoring tab's undo stack), which bypasses `POST /scenes/:id/nodes`.
 * Both paths therefore run the same guard: the route maps a throw to 400, the
 * mesh `validate` hook turns it into a nack that rolls the client's optimistic
 * write back. These cover the guard itself and the route that shares it.
 */
describe('scene-node guards', () => {
  let app: Express;
  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
  });

  /** A project with `count` empty scenes; returns [projectId, ...sceneIds]. */
  const seed = async (count = 1) => {
    const projectId = (
      await request(app).post('/api/projects').send({ name: 'P' })
    ).body.data.id as string;
    for (let i = 0; i < count; i++)
      await request(app)
        .post(`/api/projects/${projectId}/scenes`)
        .send({ name: `S${i}`, populate: false });
    const scenes = (await request(app).get(`/api/projects/${projectId}/scenes`))
      .body.data.scenes as { id: string }[];
    return { projectId, sceneIds: scenes.map((s) => s.id) };
  };

  const createInstance = (sceneId: string, properties: unknown) =>
    request(app)
      .post(`/api/scenes/${sceneId}/nodes`)
      .send({ name: 'Inst', kind: 'scene_instance', properties });

  describe('REST route', () => {
    it('rejects a scene_instance with no sourceSceneId', async () => {
      const { sceneIds } = await seed();
      const res = await createInstance(sceneIds[0], {});
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/sourceSceneId/);
    });

    it('rejects a scene instancing itself', async () => {
      const { sceneIds } = await seed();
      const res = await createInstance(sceneIds[0], {
        sourceSceneId: sceneIds[0],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/cannot instance itself/);
    });

    it('rejects a source scene from another project', async () => {
      const a = await seed();
      const b = await seed();
      const res = await createInstance(a.sceneIds[0], {
        sourceSceneId: b.sceneIds[0],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/same project/);
    });

    it('accepts a valid instance of a sibling scene', async () => {
      const { sceneIds } = await seed(2);
      const res = await createInstance(sceneIds[0], {
        sourceSceneId: sceneIds[1],
      });
      expect(res.status).toBe(201);
    });

    it('rejects an instance that would close a cycle', async () => {
      const { sceneIds } = await seed(2);
      // S0 already instances S1; now try to place S0 inside S1.
      expect(
        (await createInstance(sceneIds[0], { sourceSceneId: sceneIds[1] }))
          .status
      ).toBe(201);

      const res = await createInstance(sceneIds[1], {
        sourceSceneId: sceneIds[0],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/circular/);
    });
  });

  describe('guardClientSceneNode', () => {
    it('re-derives projectId from the scene rather than trusting the writer', async () => {
      const { projectId, sceneIds } = await seed();
      const guarded = guardClientSceneNode({
        id: 'new-node',
        rootSceneNodeId: sceneIds[0],
        kind: 'group',
        name: 'N',
        projectId: 'someone-elses-project',
      });
      expect(guarded.projectId).toBe(projectId);
    });

    it('passes a well-formed node through unchanged', async () => {
      const { projectId, sceneIds } = await seed();
      const doc = {
        id: 'new-node',
        rootSceneNodeId: sceneIds[0],
        kind: 'group',
        name: 'N',
        projectId,
      };
      expect(guardClientSceneNode(doc)).toBe(doc);
    });

    it('refuses a client-authored scene_instance that closes a cycle', async () => {
      const { projectId, sceneIds } = await seed(2);
      expect(
        (await createInstance(sceneIds[0], { sourceSceneId: sceneIds[1] }))
          .status
      ).toBe(201);

      expect(() =>
        guardClientSceneNode({
          id: 'new-inst',
          rootSceneNodeId: sceneIds[1],
          kind: 'scene_instance',
          name: 'Inst',
          projectId,
          properties: { sourceSceneId: sceneIds[0] },
        })
      ).toThrow(SceneNodeInvalid);
    });

    it('leaves a doc whose scene we do not hold alone (collab projection)', () => {
      const doc = {
        id: 'foreign',
        rootSceneNodeId: 'a-scene-on-another-server',
        kind: 'group',
        name: 'N',
        projectId: 'their-project',
      };
      expect(guardClientSceneNode(doc)).toBe(doc);
    });

    it('leaves a scene row itself alone (its own root, never client-created)', () => {
      const doc = { id: 'scene-1', rootSceneNodeId: 'scene-1', kind: 'scene' };
      expect(guardClientSceneNode(doc)).toBe(doc);
    });
  });

  describe('runtime overrides on delete', () => {
    /** Every override currently held. The bus keeps no map of its own any
     *  more — the retained `runtime_override` collection is the state. */
    const snapshot = () => overrideCollection()?.all() ?? [];

    it("clears a deleted node's overrides from the persistence tap", async () => {
      const { sceneIds } = await seed();
      const nodeId = (
        await request(app)
          .post(`/api/scenes/${sceneIds[0]}/nodes`)
          .send({ name: 'N', kind: 'group' })
      ).body.data.id as string;

      runtimeOverrideManager.registerTarget(nodeId, sceneIds[0]);
      runtimeOverrideManager.set('scene_node', nodeId, 'position.x', 3);
      expect(snapshot().some((e) => e.targetId === nodeId)).toBe(true);

      // The route no longer clears these itself — the mesh tap does, so a
      // remove authored by a tab or collab peer is cleaned up the same way.
      await request(app).delete(`/api/scene-nodes/${nodeId}`);

      expect(snapshot().some((e) => e.targetId === nodeId)).toBe(false);
    });
  });

  describe('assertSceneInstanceValid', () => {
    it('throws SceneNodeInvalid with the route-visible message', async () => {
      const { projectId, sceneIds } = await seed();
      expect(() =>
        assertSceneInstanceValid(sceneIds[0], projectId, {})
      ).toThrow(/sourceSceneId/);
    });
  });
});
