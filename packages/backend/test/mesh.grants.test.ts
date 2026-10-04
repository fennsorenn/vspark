/**
 * The backend mesh's whitelist (principle 9): this server's tabs hold exactly
 * the rights each collection declares — no blanket grant — and tombstones keep
 * the ancestry that subtree grants are checked against, across a restart.
 *
 * A loopback peer attached to the backend mesh stands in for a tab
 * (`${serverPeerId}#tab`) or a remote collab peer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  createLoopbackPair,
  createMeshPeer,
  type Collection,
  type MeshPeer,
} from '@vspark/mesh';
import { makeClientParticipantId } from '@vspark/shared/sync';
import { makeTestApp } from './helpers/testApp.js';
import {
  getMeshCollection,
  getMeshPeer,
  initBackendMesh,
  resetBackendMesh,
} from '../src/mesh/index.js';
import { getDb } from '../src/db/index.js';

type Dto = Record<string, unknown> & { id: string };

/** Attach a peer to the backend mesh over loopback. */
function attach(peerId: string): {
  peer: MeshPeer;
  flush: () => Promise<void>;
} {
  const server = getMeshPeer()!;
  const lb = createLoopbackPair(server.id, peerId);
  server.addTransport(lb.a);
  const peer = createMeshPeer({
    identity: { peerId },
    home: server.id,
    transports: [lb.b],
    ackTimeoutMs: 200,
  });
  return { peer, flush: lb.flush };
}

const everything = (rtype: string) => ({
  entityRtype: rtype,
  entityId: '*',
  includeDescendants: false,
  pathPrefix: '',
});

describe('tab rights are what each collection declares', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
  });

  afterEach(() => resetBackendMesh());

  it('a tab can subscribe to the collections it is granted', async () => {
    const server = getMeshPeer()!;
    const { peer } = attach(makeClientParticipantId(server.id, 'tab1'));
    for (const rtype of [
      'scene_node',
      'behavior',
      'compose_layer',
      'animation_clip',
      'runtime_override',
      'media_control',
    ]) {
      peer.collection(rtype, {
        authority: server.id,
        channels: channelsOf(rtype),
      });
      await expect(
        peer.subscribe(server.id, everything(rtype))
      ).resolves.toBeDefined();
    }
  });

  it('a tab cannot subscribe to server-to-server collections', async () => {
    const server = getMeshPeer()!;
    const { peer } = attach(makeClientParticipantId(server.id, 'tab1'));
    peer.collection('node_stream', { channels: ['preview'] });
    await expect(
      peer.subscribe(server.id, everything('node_stream'))
    ).rejects.toThrow(/denied/);
  });

  it('a remote peer gets nothing without a grant', async () => {
    const server = getMeshPeer()!;
    const { peer } = attach('someone-else');
    peer.collection('scene_node', { authority: server.id });
    await expect(
      peer.subscribe(server.id, everything('scene_node'))
    ).rejects.toThrow(/denied/);
  });

  it('a tab cannot write a collection it may only read', async () => {
    const server = getMeshPeer()!;
    const { peer } = attach(makeClientParticipantId(server.id, 'tab1'));
    const clips = peer.collection<Dto>('animation_clip', {
      authority: server.id,
    });
    await peer.subscribe(server.id, everything('animation_clip'));
    const res = await clips.create({ id: 'clip-x', name: 'forged' }).ack;
    expect(res.status).toBe('rejected');
    const row = getDb()
      .prepare('SELECT 1 FROM animation_clips WHERE id = ?')
      .get('clip-x');
    expect(row).toBeUndefined();
  });

  it('a tab can write the collections it authors', async () => {
    const proj = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data;
    const scene = (
      await request(app)
        .post(`/api/projects/${proj.id}/scenes`)
        .send({ name: 'S' })
    ).body.data;
    const server = getMeshPeer()!;
    const { peer, flush } = attach(makeClientParticipantId(server.id, 'tab1'));
    const nodes = peer.collection<Dto>('scene_node', { authority: server.id });
    await peer.subscribe(server.id, everything('scene_node'));
    await flush();
    const res = await nodes.set(scene.id, 'name', 'Renamed by tab').ack;
    expect(res.status).toBe('acked');
  });
});

describe('tombstones keep their ancestry across a restart', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
  });

  afterEach(() => resetBackendMesh());

  it('persists ancestors and still serves the tombstone to a subtree grant', async () => {
    expect(await deleteThenRestartAndSubscribe(app, false)).toBe('deleted');
  });

  it('a row without ancestry (written before migration 042) is withheld', async () => {
    expect(await deleteThenRestartAndSubscribe(app, true)).toBe('kept');
  });
});

async function deleteThenRestartAndSubscribe(
  app: Express,
  dropAncestry: boolean
): Promise<'deleted' | 'kept'> {
  {
    const proj = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data;
    const scene = (
      await request(app)
        .post(`/api/projects/${proj.id}/scenes`)
        .send({ name: 'S' })
    ).body.data;
    const node = (
      await request(app)
        .post(`/api/scenes/${scene.id}/nodes`)
        .send({ name: 'Doomed', kind: 'group' })
    ).body.data;
    expect(node?.id).toBeTruthy();
    await request(app).delete(`/api/scene-nodes/${node.id}`).expect(200);

    const row = getDb()
      .prepare(
        "SELECT ancestors FROM mesh_tombstones WHERE rtype = 'scene_node' AND id = ?"
      )
      .get(node.id) as { ancestors: string | null } | undefined;
    expect(row?.ancestors && JSON.parse(row.ancestors)).toContain(scene.id);
    if (dropAncestry)
      getDb()
        .prepare('UPDATE mesh_tombstones SET ancestors = NULL WHERE id = ?')
        .run(node.id);

    // Restart the mesh: tombstones re-hydrate from SQLite.
    resetBackendMesh();
    initBackendMesh();
    const server = getMeshPeer()!;
    server.grants.grant({
      grantee: 'collab-peer',
      entityRtype: '*',
      entityId: scene.id,
      includeDescendants: true,
      pathPrefix: '',
      rights: { read: true },
    });

    // The collab peer still holds the node from before the delete.
    const { peer } = attach('collab-peer');
    const nodes: Collection<Dto> = peer.collection<Dto>('scene_node', {
      parent: (d) =>
        typeof d.parentId === 'string'
          ? { rtype: 'scene_node', id: d.parentId as string }
          : typeof d.rootSceneNodeId === 'string' && d.rootSceneNodeId !== d.id
            ? { rtype: 'scene_node', id: d.rootSceneNodeId as string }
            : null,
    });
    nodes.put(
      {
        id: node.id,
        name: 'Doomed',
        rootSceneNodeId: scene.id,
        parentId: null,
      },
      { v: { t: 1, c: 0, n: server.id } }
    );
    await peer.subscribe(server.id, {
      entityRtype: 'scene_node',
      entityId: scene.id,
      includeDescendants: true,
      pathPrefix: '',
    });
    return nodes.get(node.id) === undefined ? 'deleted' : 'kept';
  }
}

function channelsOf(rtype: string): string[] | undefined {
  if (rtype === 'runtime_override' || rtype === 'data_field')
    return ['runtime'];
  if (rtype === 'media_control') return ['control'];
  return undefined;
}

describe('removing a node through the mesh', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
  });

  afterEach(() => resetBackendMesh());

  it('leaves no live document for its behaviors (no ghosts)', async () => {
    const proj = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data;
    const scene = (
      await request(app)
        .post(`/api/projects/${proj.id}/scenes`)
        .send({ name: 'S' })
    ).body.data;
    const node = (
      await request(app)
        .post(`/api/scenes/${scene.id}/nodes`)
        .send({ name: 'Avatar', kind: 'group' })
    ).body.data;
    const beh = (
      await request(app)
        .post(`/api/scene-nodes/${node.id}/behaviors`)
        .send({ kind: 'breathing' })
    ).body.data;
    expect(beh?.id).toBeTruthy();

    const server = getMeshPeer()!;
    const { peer, flush } = attach(makeClientParticipantId(server.id, 'tab1'));
    const nodes = peer.collection<Dto>('scene_node', { authority: server.id });
    const behaviors = peer.collection<Dto>('behavior', {
      authority: server.id,
      parent: (d) =>
        typeof d.nodeId === 'string'
          ? { rtype: 'scene_node', id: d.nodeId }
          : null,
    });
    await peer.subscribe(server.id, everything('scene_node'));
    await peer.subscribe(server.id, everything('behavior'));
    expect(behaviors.get(beh.id)).toBeDefined();

    // The tab deletes the node (what SceneGraph's delete does).
    expect((await nodes.remove(node.id).ack).status).toBe('acked');
    await flush();

    const rowGone = !getDb()
      .prepare('SELECT 1 FROM behaviors WHERE id = ?')
      .get(beh.id);
    expect(rowGone).toBe(true);
    // The DOCUMENT must be gone too — on the server and on the tab.
    expect(getMeshCollection('behavior')!.get(beh.id)).toBeUndefined();
    expect(behaviors.get(beh.id)).toBeUndefined();
  });
});
