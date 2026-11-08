/**
 * Composites on the server: the built-ins are listed and placed through the
 * preset path (their part ids remapped like any other id), and a part can't
 * be moved to another container or deleted on its own — whoever writes —
 * until the composite is dissolved. See @vspark/shared/composites.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { getMeshCollection } from '../src/mesh/index.js';
import { logicManager } from '../src/logic/manager.js';
import {
  ALERT_COMPOSITE,
  compositeMarkerOf,
  PART_MOVE_REFUSED,
  writeSetting,
  type CompositeView,
} from '@vspark/shared/composites';

type Doc = Record<string, unknown>;

async function seed(app: Express) {
  const projectId = (
    await request(app).post('/api/projects').send({ name: 'P' })
  ).body.data.id as string;
  const composeSceneId = (
    await request(app)
      .post(`/api/projects/${projectId}/compose-scenes`)
      .send({ name: 'C', config: {}, width: 1920, height: 1080, visible: true })
  ).body.data.id as string;
  await request(app)
    .post(`/api/projects/${projectId}/scenes`)
    .send({ name: 'S', populate: false });
  const sceneId = (await request(app).get(`/api/projects/${projectId}/scenes`))
    .body.data.scenes[0].id as string;
  return { projectId, composeSceneId, sceneId };
}

async function place(
  app: Express,
  id: string,
  target: { projectId: string; sceneId: string; composeSceneId?: string }
): Promise<string> {
  const payload = (await request(app).get(`/api/presets/builtin/${id}`)).body
    .data.payload;
  const res = await request(app)
    .post('/api/presets/instantiate')
    .send({
      payload,
      projectId: target.projectId,
      rootSceneNodeId: target.sceneId,
      rootComposeSceneId: target.composeSceneId ?? null,
    });
  expect(res.status).toBe(200);
  return res.body.data.rootId as string;
}

const layers = () => getMeshCollection('compose_layer')!;
const nodes = () => getMeshCollection('scene_node')!;

describe('composites — listing and placing', () => {
  let app: Express;
  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
  });

  it('lists the built-in composites with their types, apart from the presets', async () => {
    const res = await request(app).get('/api/presets/composites');
    expect(res.status).toBe(200);
    expect(
      (res.body.data as Doc[]).map((c) => [c.composite, c.rootKind])
    ).toEqual([
      ['alert', 'compose_layer'],
      ['chat_overlay', 'compose_layer'],
      ['chat_overlay_3d', 'scene_node'],
      ['scrolling_chat', 'scene_node'],
    ]);
    const presets = (await request(app).get('/api/presets/builtin')).body
      .data as Doc[];
    expect(presets.some((p) => String(p.id).includes('composite'))).toBe(false);
    // The old alert presets are still there (decided: kept until replaced).
    expect(presets.some((p) => p.id === 'builtin:alert-donation')).toBe(true);
  });

  it('places an alert with every part id pointing at the placed entities', async () => {
    const target = await seed(app);
    const rootId = await place(app, 'builtin:composite-alert', target);
    const marker = compositeMarkerOf('compose_layer', layers().get(rootId))!;
    expect(marker.type).toBe('alert');
    const { parts } = marker;
    for (const role of ['badgeImage', 'badgeVideo', 'caption', 'sound'])
      expect(layers().get(parts[role])?.parentId, role).toBe(rootId);
    expect(getMeshCollection('track_clip')!.get(parts.fade)).toBeDefined();
    const graph = getMeshCollection('logic')!.get(parts.queue) as Doc;
    expect(graph.ownerId).toBe(rootId);
    // Stored in document form (keyed by node id), so per-node paths address
    // the node — the preset itself carries lists.
    const nodes = (graph.descriptor as Doc).nodes as Record<string, Doc>;
    expect(Array.isArray(nodes)).toBe(false);
    expect(nodes.ev.kind).toBe('overlive_redemption');
    // The graph is valid and running: the engine accepted the trigger wiring.
    expect(logicManager.getRunningDescriptors().map((g) => g.id)).toContain(
      parts.queue
    );
  });

  it('every trigger leaves a graph the engine accepts', async () => {
    const target = await seed(app);
    const rootId = await place(app, 'builtin:composite-alert', target);
    const view = (): CompositeView => ({
      rtype: 'compose_layer',
      rootId,
      marker: compositeMarkerOf('compose_layer', layers().get(rootId))!,
      get: (rtype, id) => getMeshCollection(rtype)!.get(id),
    });
    const trigger = ALERT_COMPOSITE.settings.find((s) => s.key === 'trigger')!;
    const queueId = view().marker.parts.queue;
    for (const next of ['named', 'sub', 'raid', 'tip', 'donation']) {
      const writes = writeSetting(view(), ALERT_COMPOSITE, trigger, next);
      expect(writes.length, next).toBeGreaterThan(0);
      const acks = writes.map(
        (w) => getMeshCollection(w.rtype)!.set(w.id, w.path, w.value).ack
      );
      for (const o of await Promise.all(acks))
        expect(o.status, next).toBe('acked');
      const running = logicManager
        .getRunningDescriptors()
        .find((g) => g.id === queueId);
      expect(running, next).toBeDefined();
      expect(
        running!.descriptor.nodes.find((n) => n.id === 'ev')?.kind,
        next
      ).toBe(
        next === 'named'
          ? 'on_trigger'
          : next === 'sub'
            ? 'overlive_subscription'
            : next === 'raid'
              ? 'overlive_raid'
              : 'overlive_redemption'
      );
    }
  });

  it('places the 3D composites with the marker on the node properties', async () => {
    const target = await seed(app);
    for (const [id, type] of [
      ['builtin:composite-chat-overlay-3d', 'chat_overlay_3d'],
      ['builtin:composite-scrolling-chat', 'scrolling_chat'],
    ]) {
      const rootId = await place(app, id, target);
      const marker = compositeMarkerOf('scene_node', nodes().get(rootId));
      expect(marker?.type).toBe(type);
      for (const partId of Object.values(marker!.parts))
        expect(partId.startsWith('__preset:')).toBe(false);
    }
  });
});

describe('composites — part protection', () => {
  let app: Express;
  let target: Awaited<ReturnType<typeof seed>>;
  let rootId: string;
  let parts: Record<string, string>;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    target = await seed(app);
    rootId = await place(app, 'builtin:composite-alert', target);
    parts = compositeMarkerOf('compose_layer', layers().get(rootId))!.parts;
  });

  it('refuses moving a part out of the composite, over REST and the store', async () => {
    const res = await request(app)
      .put(`/api/compose-layers/${parts.caption}`)
      .send({ parentId: null });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(PART_MOVE_REFUSED);
    expect(layers().get(parts.caption)?.parentId).toBe(rootId);

    const outcome = await layers().set(parts.caption, 'parentId', null).ack;
    expect(outcome.status).toBe('rejected');
  });

  it('refuses moving a part one level deeper inside the composite', async () => {
    const group = (
      await request(app)
        .post(`/api/compose-scenes/${target.composeSceneId}/layers`)
        .send({ name: 'G', kind: 'group', parentId: rootId })
    ).body.data.id as string;
    const res = await request(app)
      .put(`/api/compose-layers/${parts.caption}`)
      .send({ parentId: group });
    expect(res.status).toBe(409);
    // Other objects may come and go freely.
    const out = await request(app)
      .put(`/api/compose-layers/${group}`)
      .send({ parentId: null });
    expect(out.status).toBe(200);
  });

  it('allows reordering parts and editing them in place', async () => {
    const res = await request(app)
      .put(`/api/compose-layers/${parts.caption}`)
      .send({ orderKey: 'a0', x: 12, config: { fontSize: 22 } });
    expect(res.status).toBe(200);
    expect(layers().get(parts.caption)?.x).toBe(12);
  });

  it('refuses deleting a part, but deletes the whole composite with its parts', async () => {
    const res = await request(app).delete(`/api/compose-layers/${parts.sound}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COMPOSITE_PART');
    expect(layers().get(parts.sound)).toBeDefined();

    // Deleting the whole thing removes its parts with it.
    const peer = (await import('../src/mesh/index.js')).getMeshPeer()!;
    await Promise.all(peer.removeTree(rootId).map((h) => h.ack));
    expect(layers().get(rootId)).toBeUndefined();
    expect(layers().get(parts.sound)).toBeUndefined();
  });

  it('dissolving lifts the protection', async () => {
    const dissolve = await request(app)
      .put(`/api/compose-layers/${rootId}`)
      .send({ config: { composite: null } });
    expect(dissolve.status).toBe(200);
    expect(compositeMarkerOf('compose_layer', layers().get(rootId))).toBeNull();
    expect(
      (
        await request(app)
          .put(`/api/compose-layers/${parts.caption}`)
          .send({ parentId: null })
      ).status
    ).toBe(200);
    expect(
      (await request(app).delete(`/api/compose-layers/${parts.sound}`)).status
    ).toBe(200);
  });

  it('protects scene-node parts the same way', async () => {
    const root = await place(app, 'builtin:composite-scrolling-chat', target);
    const { message } = compositeMarkerOf(
      'scene_node',
      nodes().get(root)
    )!.parts;
    const move = await request(app)
      .put(`/api/scene-nodes/${message}`)
      .send({ parentId: null });
    expect(move.status).toBe(409);
    const del = await request(app).delete(`/api/scene-nodes/${message}`);
    expect(del.status).toBe(409);
    expect(nodes().get(message)?.parentId).toBe(root);

    await request(app)
      .put(`/api/scene-nodes/${root}`)
      .send({ properties: { composite: null } });
    expect(
      (await request(app).delete(`/api/scene-nodes/${message}`)).status
    ).toBe(200);
  });
});
