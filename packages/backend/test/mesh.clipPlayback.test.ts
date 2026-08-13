import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { getMeshCollection } from '../src/mesh/index.js';
import { getDb } from '../src/db/index.js';

/**
 * clip_playback — a track clip's transport state as a synced document.
 *
 * These assert the rtype is actually REACHABLE, not merely written. A module can
 * pass its own unit tests for months while being unwired from every registration
 * point (`packages/shared/src/fracIndex.ts` did exactly that), so the checks
 * here are deliberately about wiring: the collection exists after init, its
 * writes reach SQLite through the descriptor, and its containment parent is the
 * clip rather than the doc's own id.
 */
describe('clip_playback collection', () => {
  let app: Express;
  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
  });

  /** A project + scene + node + clip to hang playback off. */
  async function seedClip(): Promise<{ nodeId: string; clipId: string }> {
    const projectId = (
      await request(app).post('/api/projects').send({ name: 'P' })
    ).body.data.id as string;
    const sceneId = (
      await request(app)
        .post(`/api/projects/${projectId}/scenes`)
        .send({ name: 'S', populate: false })
    ).body.data.id as string;
    const nodeId = (
      await request(app)
        .post(`/api/scenes/${sceneId}/nodes`)
        .send({ name: 'N', kind: 'group' })
    ).body.data.id as string;
    const clipId = (
      await request(app)
        .post(`/api/scene-nodes/${nodeId}/track-clips`)
        .send({ name: 'C' })
    ).body.data.id as string;
    return { nodeId, clipId };
  }

  it('is bound and reachable after init', () => {
    expect(getMeshCollection('clip_playback')).toBeDefined();
  });

  it('persists a committed write through its descriptor', async () => {
    const { clipId } = await seedClip();
    const col = getMeshCollection('clip_playback')!;

    await col.set('pb1', '', {
      id: 'pb1',
      clipId,
      state: 'playing',
      startEpoch: 1_700_000_000_000,
      pausedAtT: null,
      speed: 1,
      loop: false,
    }).ack;

    const row = getDb()
      .prepare('SELECT * FROM clip_playback WHERE id = ?')
      .get('pb1') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.clip_id).toBe(clipId);
    expect(row?.state).toBe('playing');
    expect(row?.start_epoch).toBe(1_700_000_000_000);
  });

  it('round-trips through the replica with camelCase field names', async () => {
    const { clipId } = await seedClip();
    const col = getMeshCollection('clip_playback')!;
    await col.set('pb1', '', {
      id: 'pb1',
      clipId,
      state: 'paused',
      startEpoch: null,
      pausedAtT: 2.5,
      speed: 1.5,
      loop: true,
    }).ack;

    expect(col.get('pb1')).toMatchObject({
      id: 'pb1',
      clipId,
      state: 'paused',
      pausedAtT: 2.5,
      speed: 1.5,
      loop: true,
    });
  });

  it('parents to the CLIP, so a scene-subtree grant reaches it', async () => {
    const { nodeId, clipId } = await seedClip();
    const col = getMeshCollection('clip_playback')!;
    await col.set('pb1', '', {
      id: 'pb1',
      clipId,
      state: 'stopped',
      startEpoch: null,
      pausedAtT: null,
      speed: 1,
      loop: false,
    }).ack;

    // The clip collection's subtree view is keyed on the owning node; playback
    // hangs under the clip, which hangs under the node — so a grant on the node
    // covers it transitively without playback knowing about nodes at all.
    const clips = getMeshCollection('track_clip')!;
    expect(
      clips.subtree(nodeId).map((c) => (c as { id: string }).id)
    ).toContain(clipId);
    expect(col.subtree(nodeId).map((p) => (p as { id: string }).id)).toContain(
      'pb1'
    );
  });

  it('does not collide with its clip in the containment index', async () => {
    // The index keys by id ALONE across every rtype, which is why the playback
    // doc has its own id and carries clipId as a field. Reusing the clip's id
    // here would overwrite the clip's own index entry.
    const { nodeId, clipId } = await seedClip();
    const col = getMeshCollection('clip_playback')!;
    await col.set('pb1', '', {
      id: 'pb1',
      clipId,
      state: 'stopped',
      startEpoch: null,
      pausedAtT: null,
      speed: 1,
      loop: false,
    }).ack;

    // The clip is still reachable from its node after playback was indexed.
    const clips = getMeshCollection('track_clip')!;
    expect(
      clips.subtree(nodeId).map((c) => (c as { id: string }).id)
    ).toContain(clipId);
  });

  it('deleting the clip takes its playback row with it', async () => {
    const { clipId } = await seedClip();
    const col = getMeshCollection('clip_playback')!;
    await col.set('pb1', '', {
      id: 'pb1',
      clipId,
      state: 'playing',
      startEpoch: 1,
      pausedAtT: null,
      speed: 1,
      loop: false,
    }).ack;

    await request(app).delete(`/api/track-clips/${clipId}`);

    const row = getDb()
      .prepare('SELECT 1 FROM clip_playback WHERE id = ?')
      .get('pb1');
    expect(row).toBeUndefined();
  });

  it('refuses to persist playback for a clip that does not exist', async () => {
    // `persists` gates SQLite only — the doc still fans out to replicas.
    const col = getMeshCollection('clip_playback')!;
    await col.set('pb1', '', {
      id: 'pb1',
      clipId: 'no-such-clip',
      state: 'playing',
      startEpoch: 1,
      pausedAtT: null,
      speed: 1,
      loop: false,
    }).ack;

    expect(
      getDb().prepare('SELECT 1 FROM clip_playback WHERE id = ?').get('pb1')
    ).toBeUndefined();
    expect(col.get('pb1')).toBeDefined();
  });
});
