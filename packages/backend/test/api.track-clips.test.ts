import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';

/**
 * Track-clip CRUD — mesh-backed writes. A clip's containment owner is a
 * scene-node, so we seed a real node before each test.
 */
describe('track-clips API (mesh-backed)', () => {
  let app: Express;
  let NODE: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    const projectId = (
      await request(app).post('/api/projects').send({ name: 'P' })
    ).body.data.id as string;
    await request(app)
      .post(`/api/projects/${projectId}/scenes`)
      .send({ name: 'S', populate: false });
    const sceneId = (
      await request(app).get(`/api/projects/${projectId}/scenes`)
    ).body.data.scenes[0].id as string;
    NODE = (
      await request(app)
        .post(`/api/scenes/${sceneId}/nodes`)
        .send({ name: 'Root', kind: 'group' })
    ).body.data.id as string;
  });

  const listClips = async () =>
    (await request(app).get(`/api/scene-nodes/${NODE}/track-clips`)).body
      .data as { id: string; name: string }[];

  // ── CLIP CRUD ────────────────────────────────────────────────────────────

  it('lists clips for a node (empty initially)', async () => {
    const clips = await listClips();
    expect(clips).toEqual([]);
  });

  it('creates a clip, reads it back, updates, and deletes it', async () => {
    // CREATE
    const create = await request(app)
      .post(`/api/scene-nodes/${NODE}/track-clips`)
      .send({ name: 'Clip A', duration: 4, loop: false, mode: 'override', autoplay: false });
    expect(create.status).toBe(201);
    expect(create.body.ok).toBe(true);
    const id = create.body.data.id as string;
    expect(typeof id).toBe('string');
    expect(create.body.data.name).toBe('Clip A');
    expect(create.body.data.ownerNodeId).toBe(NODE);
    expect(create.body.data.duration).toBe(4);
    expect(create.body.data.loop).toBe(false);
    // Keyed by id, so an empty clip carries empty MAPS, not empty arrays —
    // an array would put every lane on one mesh path (@vspark/shared/idMap).
    expect(create.body.data.lanes).toEqual({});
    expect(create.body.data.events).toEqual({});

    // READ-BACK via list
    const clips = await listClips();
    expect(clips).toHaveLength(1);
    expect(clips[0].id).toBe(id);
    expect(clips[0].name).toBe('Clip A');

    // UPDATE (PUT /api/track-clips/:id)
    const upd = await request(app)
      .put(`/api/track-clips/${id}`)
      .send({ name: 'Clip A Renamed', duration: 8, loop: true });
    expect(upd.status).toBe(200);
    expect(upd.body.data.name).toBe('Clip A Renamed');
    expect(upd.body.data.duration).toBe(8);
    expect(upd.body.data.loop).toBe(true);

    // DELETE
    const del = await request(app).delete(`/api/track-clips/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.data.id).toBe(id);

    // Confirm removal
    expect(await listClips()).toEqual([]);
  });

  it('returns 400 when name is missing on create', async () => {
    const res = await request(app)
      .post(`/api/scene-nodes/${NODE}/track-clips`)
      .send({ duration: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when updating a non-existent clip', async () => {
    const res = await request(app)
      .put('/api/track-clips/missing-id')
      .send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── LANE CRUD ────────────────────────────────────────────────────────────

  it('creates and updates a lane on a clip', async () => {
    const clipId = (
      await request(app)
        .post(`/api/scene-nodes/${NODE}/track-clips`)
        .send({ name: 'C' })
    ).body.data.id as string;

    // POST lane
    const laneRes = await request(app)
      .post(`/api/track-clips/${clipId}/lanes`)
      .send({
        targetKind: 'scene_node',
        targetId: NODE,
        paramPath: 'transform.position.x',
        defaultValue: 0,
      });
    expect(laneRes.status).toBe(201);
    const laneId = laneRes.body.data.id as string;
    expect(laneRes.body.data.clipId).toBe(clipId);
    expect(laneRes.body.data.paramPath).toBe('transform.position.x');

    // PUT lane
    const laneUpd = await request(app)
      .put(`/api/track-clip-lanes/${laneId}`)
      .send({ defaultValue: 1.5 });
    expect(laneUpd.status).toBe(200);
    expect(laneUpd.body.data.defaultValue).toBe(1.5);

    // DELETE lane
    const laneDel = await request(app).delete(`/api/track-clip-lanes/${laneId}`);
    expect(laneDel.status).toBe(200);
    expect(laneDel.body.data.id).toBe(laneId);
  });

  it('addresses one lane per mesh path, and tombstones it on delete', async () => {
    // The whole point of keying children by id: a lane edit writes
    // `lanes.<id>`, so two people editing different lanes of one clip merge
    // instead of overwriting. Deleting writes a null there — `set` can write a
    // path but not remove one — and readers skip it.
    const { getMeshCollection } = await import('../src/mesh/index.js');
    const clipId = (
      await request(app)
        .post(`/api/scene-nodes/${NODE}/track-clips`)
        .send({ name: 'Keyed' })
    ).body.data.id as string;
    const laneId = (
      await request(app)
        .post(`/api/track-clips/${clipId}/lanes`)
        .send({ targetKind: 'scene_node', targetId: NODE, paramPath: 'pos.x' })
    ).body.data.id as string;

    type Doc = {
      lanes: Record<string, unknown>;
      events: Record<string, unknown>;
    };
    const doc = () =>
      getMeshCollection('track_clip')!.get(clipId) as unknown as Doc;
    expect(doc().lanes[laneId]).toMatchObject({ paramPath: 'pos.x' });

    await request(app).delete(`/api/track-clip-lanes/${laneId}`);
    expect(doc().lanes[laneId]).toBeNull();
    // The tombstone stays in the replica but never reaches SQLite, so the
    // reload is clean.
    const reloaded = (await listClips()) as unknown as Doc[];
    expect(reloaded[0].lanes).toEqual({});
  });

  it('keys keyframes by id under their lane', async () => {
    const { getMeshCollection } = await import('../src/mesh/index.js');
    const clipId = (
      await request(app)
        .post(`/api/scene-nodes/${NODE}/track-clips`)
        .send({ name: 'KfKeyed' })
    ).body.data.id as string;
    const laneId = (
      await request(app)
        .post(`/api/track-clips/${clipId}/lanes`)
        .send({ targetKind: 'scene_node', targetId: NODE, paramPath: 'pos.y' })
    ).body.data.id as string;
    await request(app)
      .put(`/api/track-clip-lanes/${laneId}/keyframes`)
      .send({
        keyframes: [
          { id: 'k1', t: 0, value: 0 },
          { id: 'k2', t: 1, value: 1 },
        ],
      });

    const doc = getMeshCollection('track_clip')!.get(clipId) as unknown as {
      lanes: Record<string, { keyframes: Record<string, { value: number }> }>;
    };
    expect(Object.keys(doc.lanes[laneId].keyframes).sort()).toEqual([
      'k1',
      'k2',
    ]);
    // A single keyframe is now its own path — this is the write a dragging tab
    // makes, and it must not disturb its neighbour.
    await getMeshCollection('track_clip')!.set(
      clipId,
      `lanes.${laneId}.keyframes.k1.value`,
      9
    ).ack;
    const after = getMeshCollection('track_clip')!.get(clipId) as unknown as {
      lanes: Record<string, { keyframes: Record<string, { value: number }> }>;
    };
    expect(after.lanes[laneId].keyframes.k1.value).toBe(9);
    expect(after.lanes[laneId].keyframes.k2.value).toBe(1);
  });

  it('returns 400 when lane is missing required fields', async () => {
    const clipId = (
      await request(app)
        .post(`/api/scene-nodes/${NODE}/track-clips`)
        .send({ name: 'C2' })
    ).body.data.id as string;

    const res = await request(app)
      .post(`/api/track-clips/${clipId}/lanes`)
      .send({ targetKind: 'scene_node' }); // missing targetId and paramPath
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when adding a lane to a non-existent clip', async () => {
    const res = await request(app)
      .post('/api/track-clips/no-such-clip/lanes')
      .send({ targetKind: 'scene_node', targetId: NODE, paramPath: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when updating a non-existent lane', async () => {
    const res = await request(app)
      .put('/api/track-clip-lanes/no-such-lane')
      .send({ defaultValue: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── KEYFRAMES ────────────────────────────────────────────────────────────

  it('replaces keyframes on a lane', async () => {
    const clipId = (
      await request(app)
        .post(`/api/scene-nodes/${NODE}/track-clips`)
        .send({ name: 'KfClip' })
    ).body.data.id as string;

    const laneId = (
      await request(app)
        .post(`/api/track-clips/${clipId}/lanes`)
        .send({ targetKind: 'scene_node', targetId: NODE, paramPath: 'pos.y' })
    ).body.data.id as string;

    const kfRes = await request(app)
      .put(`/api/track-clip-lanes/${laneId}/keyframes`)
      .send({
        keyframes: [
          { t: 0, value: 0, easing: 'linear' },
          { t: 1, value: 1, easing: 'ease-in' },
        ],
      });
    expect(kfRes.status).toBe(200);
    expect(kfRes.body.data.laneId).toBe(laneId);
    expect(kfRes.body.data.keyframes).toHaveLength(2);
    expect(kfRes.body.data.keyframes[0].t).toBe(0);
    expect(kfRes.body.data.keyframes[1].t).toBe(1);
    expect(kfRes.body.data.keyframes[1].easing).toBe('ease-in');
  });

  it('returns 404 when replacing keyframes on a non-existent lane', async () => {
    const res = await request(app)
      .put('/api/track-clip-lanes/no-such-lane/keyframes')
      .send({ keyframes: [] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── EVENTS ───────────────────────────────────────────────────────────────

  it('replaces events on a clip', async () => {
    const clipId = (
      await request(app)
        .post(`/api/scene-nodes/${NODE}/track-clips`)
        .send({ name: 'EvClip' })
    ).body.data.id as string;

    const evRes = await request(app)
      .put(`/api/track-clips/${clipId}/events`)
      .send({
        events: [
          { t: 0.5, action: 'play', targetId: NODE, targetKind: 'scene_node' },
        ],
      });
    expect(evRes.status).toBe(200);
    expect(evRes.body.data.clipId).toBe(clipId);
    expect(evRes.body.data.events).toHaveLength(1);
    expect(evRes.body.data.events[0].t).toBe(0.5);
    expect(evRes.body.data.events[0].action).toBe('play');
  });

  it('returns 404 when replacing events on a non-existent clip', async () => {
    const res = await request(app)
      .put('/api/track-clips/no-such-clip/events')
      .send({ events: [] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // ── PLAYBACK CONTROL (503 without playback manager) ──────────────────────

  it('serves transport whenever the mesh store is up', async () => {
    // This used to assert 503 across the board: the routes drove a separate
    // in-memory playback manager, and an app with a working mesh store but no
    // injected manager refused every transport call. They now write the
    // clip_playback collection, so the manager is not a thing that can be
    // missing — one fewer piece of wiring between an HTTP caller and a result.
    const clipId = (
      await request(app)
        .post(`/api/scene-nodes/${NODE}/track-clips`)
        .send({ name: 'PbClip' })
    ).body.data.id as string;

    for (const verb of ['trigger', 'pause', 'resume', 'stop']) {
      const res = await request(app).post(`/api/track-clips/${clipId}/${verb}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(clipId);
    }
    const seek = await request(app)
      .post(`/api/track-clips/${clipId}/seek`)
      .send({ t: 0 });
    expect(seek.status).toBe(200);
  });

  it('404s transport on an unknown clip', async () => {
    const res = await request(app).post('/api/track-clips/nope/trigger');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
