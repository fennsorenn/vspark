import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { getMeshCollection } from '../src/mesh/index.js';
import { getDb } from '../src/db/index.js';
import { logicManager } from '../src/logic/manager.js';
import { behaviorGraphLifecycle } from '../src/behaviors/graphLifecycle.js';
import {
  behaviorGraphId,
  behaviorTemplateFingerprint,
  behaviorTemplateGraph,
  registerBehaviorTemplate,
} from '../src/behaviors/templates.js';
import { setBreathingManager } from '../src/behaviors/refresh.js';
import { BreathingManager } from '../src/behaviors/breathing/manager.js';
import { graphFingerprint } from '@vspark/shared/actions';
import {
  toDescriptorDoc,
  toGraphDescriptor,
  type GraphDescriptor,
  type GraphDescriptorDoc,
} from '@vspark/shared/signal';

/**
 * Behaviors' stored, editable graphs (plan: actions.md Phase 4): the `logic`
 * document a behavior owns, its `templateFingerprint`, and the lifecycle that
 * keeps the two in step (behaviors/graphLifecycle.ts). Writes go through the
 * mesh like a tab's would, so the taps — not the routes — are what is pinned.
 */
type Json = Record<string, any>;

const behaviorsCol = () => getMeshCollection('behavior')!;
const logicCol = () => getMeshCollection('logic')!;
const gid = (id: string, kind = 'breathing') => behaviorGraphId(kind, id);
const graphOf = (id: string, kind = 'breathing') =>
  toGraphDescriptor(
    logicCol().get(gid(id, kind))?.descriptor as GraphDescriptorDoc
  );
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('behavior graphs', () => {
  let app: Express;
  let nodeId: string;

  const status = async (id: string) =>
    (await request(app).get(`/api/behaviors/${id}/graph`)).body.data as Json;

  const create = async (id: string, kind = 'breathing', config: Json = {}) => {
    const res = await request(app)
      .post(`/api/scene-nodes/${nodeId}/behaviors`)
      .send({ id, kind, config });
    expect(res.status).toBe(201);
  };

  /** A tab-style edit of one graph element. */
  const addNode = (id: string, nodeKey: string, kind = 'behavior_id') =>
    logicCol().set(gid(id), `descriptor.nodes.${nodeKey}`, {
      id: nodeKey,
      kind,
      position: { x: 0, y: 0 },
    }).ack;

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
        .send({ name: 'N', kind: 'avatar' })
    ).body.data.id as string;
  });

  afterEach(() => logicManager.close());

  // ── create ───────────────────────────────────────────────────────────────

  it('REST create stores the template graph, parented under the behavior', async () => {
    await create('b1');
    expect(
      getDb()
        .prepare('SELECT owner_kind, owner_id FROM logic WHERE id = ?')
        .get(gid('b1'))
    ).toEqual({ owner_kind: 'behavior', owner_id: 'b1' });
    expect(
      logicCol()
        .subtree('b1')
        .map((d) => (d as Json).id)
    ).toContain(gid('b1'));
    expect(await status('b1')).toMatchObject({
      graphId: gid('b1'),
      missingGraph: false,
      modified: false,
      templateUpdateAvailable: false,
      templateFingerprint: behaviorTemplateFingerprint('breathing', {}),
    });
    expect(graphFingerprint(graphOf('b1'))).toBe(
      behaviorTemplateFingerprint('breathing', {})
    );
  });

  it('a behavior authored on the mesh gets its graph on the next tick', async () => {
    await behaviorsCol().set('b2', '', {
      id: 'b2',
      nodeId,
      kind: 'breathing',
      enabled: true,
      config: {},
      sortOrder: 0,
    }).ack;
    await tick();
    expect(logicCol().get(gid('b2'))).toBeDefined();
    expect((await status('b2')).modified).toBe(false);
  });

  it('a graph restored in the same batch as its behavior wins (undo of a delete)', async () => {
    // Undo re-creates the behavior and then its (hand-edited) graph; the
    // deferred creation must not overwrite the restored graph.
    const edited = withExtraNode(behaviorTemplateGraph('breathing', 'b3', {})!);
    void behaviorsCol().set('b3', '', {
      id: 'b3',
      nodeId,
      kind: 'breathing',
      enabled: true,
      config: {},
      sortOrder: 0,
      templateFingerprint: behaviorTemplateFingerprint('breathing', {}),
    }).ack;
    await logicCol().set(gid('b3'), '', {
      id: gid('b3'),
      ownerKind: 'behavior',
      ownerId: 'b3',
      name: 'Breathing',
      enabled: true,
      descriptor: toDescriptorDoc(edited),
    }).ack;
    await tick();
    expect(graphOf('b3').nodes.map((n) => n.id)).toContain('extra');
    expect((await status('b3')).modified).toBe(true);
  });

  it('kinds without a graph get none', async () => {
    await create('api', 'api_controller');
    await tick();
    expect(
      logicCol()
        .all()
        .some((g) => g.ownerId === 'api')
    ).toBe(false);
    expect((await request(app).get('/api/behaviors/api/graph')).status).toBe(
      404
    );
  });

  it('the behavior-kinds meta says which kinds have a graph', async () => {
    const kinds = (await request(app).get('/api/behavior-kinds')).body
      .data as Json[];
    const by = Object.fromEntries(kinds.map((k) => [k.kind, k.hasGraph]));
    expect(by.breathing).toBe(true);
    expect(by.vmc_receiver_2d).toBe(true);
    expect(by.api_controller).toBe(false);
  });

  // ── edits, modified, reset ───────────────────────────────────────────────

  it('a canvas edit reads as modified; moving nodes does not', async () => {
    await create('b1');
    const someNode = graphOf('b1').nodes[0];
    await logicCol().set(gid('b1'), `descriptor.nodes.${someNode.id}`, {
      ...someNode,
      position: { x: someNode.position.x + 99, y: 7 },
    }).ack;
    expect((await status('b1')).modified).toBe(false);

    await addNode('b1', 'extra');
    expect(await status('b1')).toMatchObject({
      modified: true,
      templateUpdateAvailable: false,
    });
  });

  it('a value-setting change leaves the graph alone', async () => {
    await create('b1');
    await addNode('b1', 'extra');
    const before = JSON.stringify(logicCol().get(gid('b1'))?.descriptor);
    await request(app)
      .put('/api/behaviors/b1')
      .send({ config: { chestAmplitude: 0.5 } });
    expect(JSON.stringify(logicCol().get(gid('b1'))?.descriptor)).toBe(before);
    expect((await status('b1')).modified).toBe(true);
  });

  it('reset regenerates the template graph and clears modified', async () => {
    await create('b1');
    await addNode('b1', 'extra');
    const res = await request(app).post('/api/behaviors/b1/reset-graph');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      modified: false,
      missingGraph: false,
    });
    expect(graphOf('b1').nodes.map((n) => n.id)).not.toContain('extra');
  });

  it('reset recreates a missing graph', async () => {
    await create('b1');
    await logicCol().remove(gid('b1')).ack;
    expect((await status('b1')).missingGraph).toBe(true);
    await request(app).post('/api/behaviors/b1/reset-graph');
    expect(await status('b1')).toMatchObject({
      missingGraph: false,
      modified: false,
    });
  });

  it('serves the template for the editor (Reset writes it itself)', async () => {
    await create('b1');
    const t = (await request(app).get('/api/behaviors/b1/template')).body
      .data as Json;
    expect(t.graphId).toBe(gid('b1'));
    expect(t.fingerprint).toBe(behaviorTemplateFingerprint('breathing', {}));
    expect(t.shapeFields).toEqual([]);
    expect(graphFingerprint(t.descriptor as GraphDescriptorDoc)).toBe(
      t.fingerprint
    );
  });

  it('deleting the behavior deletes its graph', async () => {
    await create('b1');
    await request(app).delete('/api/behaviors/b1');
    expect(logicCol().get(gid('b1'))).toBeUndefined();
    expect(
      getDb().prepare('SELECT 1 FROM logic WHERE id = ?').get(gid('b1'))
    ).toBeUndefined();
  });

  // ── validation ───────────────────────────────────────────────────────────

  it('accepts the behavior-context nodes Logic refuses', async () => {
    await create('b1');
    const out = await logicCol().set(gid('b1'), 'descriptor.nodes.cfg_x', {
      id: 'cfg_x',
      kind: 'settings',
      position: { x: 0, y: 0 },
      defaultConfig: { field: 'x' },
    }).ack;
    expect(out.status).not.toBe('rejected');
    expect((await addNode('b1', 'bid', 'behavior_id')).status).not.toBe(
      'rejected'
    );
  });

  it('refuses what cannot run: unknown kinds and dangling edges', async () => {
    await create('b1');
    expect((await addNode('b1', 'bad', 'no_such_kind')).status).toBe(
      'rejected'
    );
    const dangling = await logicCol().set(gid('b1'), 'descriptor.edges.ghost', {
      fromNodeId: 'ghost',
      fromPort: 'x',
      toNodeId: 'clock',
      toPort: 'hz',
    }).ack;
    expect(dangling.status).toBe('rejected');
    // Logic graphs keep their own rule: no settings node outside Actions.
    const projectGraph = await logicCol().set('pg', '', {
      id: 'pg',
      ownerKind: 'project',
      ownerId: 'nope',
      name: 'G',
      enabled: true,
      descriptor: toDescriptorDoc({
        id: 'pg',
        label: 'G',
        readonly: false,
        nodes: [{ id: 's', kind: 'settings', position: { x: 0, y: 0 } }],
        edges: [],
      }),
    }).ack;
    expect(projectGraph.status).toBe('rejected');
  });

  it('every template passes the behavior-graph validation', async () => {
    for (const kind of [
      'vmc_receiver',
      'vmc_receiver_2d',
      'ifacialmocap_receiver',
      'breathing',
      'manual_calibration',
      'pose_stylizer',
      'blendshape_limiter',
      'lipsync_processor',
      'mediapipe_tracker',
    ]) {
      await create(`b_${kind}`, kind);
      // Written through the mesh, i.e. through the validation.
      expect(await status(`b_${kind}`)).toMatchObject({
        missingGraph: false,
        modified: false,
      });
    }
  });

  it('LogicManager never runs a behavior graph', async () => {
    await create('b1');
    await addNode('b1', 'extra');
    logicManager.startAllEnabled();
    expect(
      logicManager.getRunningDescriptors().some((r) => r.id === gid('b1'))
    ).toBe(false);
  });

  // ── the running graph follows the stored one ─────────────────────────────

  describe('with a running manager', () => {
    let manager: BreathingManager;
    beforeEach(() => {
      manager = new BreathingManager();
      setBreathingManager(manager);
    });
    afterEach(() => {
      manager.close();
      setBreathingManager(null as never);
    });

    it('a canvas write rebuilds the running graph; reset rebuilds it back', async () => {
      await create('b1');
      expect(manager.getStates('b1')).not.toBeNull();
      expect(
        manager.getGraphDescriptor('b1')!.nodes.map((n) => n.id)
      ).not.toContain('extra');

      await addNode('b1', 'extra');
      expect(
        manager.getGraphDescriptor('b1')!.nodes.map((n) => n.id)
      ).toContain('extra');

      await request(app).post('/api/behaviors/b1/reset-graph');
      expect(
        manager.getGraphDescriptor('b1')!.nodes.map((n) => n.id)
      ).not.toContain('extra');
    });
  });

  // ── boot ─────────────────────────────────────────────────────────────────

  it('boot regenerates unmodified stale graphs only, and creates missing ones', async () => {
    await create('stale');
    await create('edited');
    await create('nograph');

    // "stale": generated from an older template — its graph equals the
    // recorded fingerprint, which no longer equals the current template.
    const old = withExtraNode(behaviorTemplateGraph('breathing', 'stale', {})!);
    await logicCol().set(gid('stale'), 'descriptor', toDescriptorDoc(old)).ack;
    await behaviorsCol().set(
      'stale',
      'templateFingerprint',
      graphFingerprint(old)
    ).ack;
    // "edited": modified by hand, also generated from that older template.
    const oldEdited = withExtraNode(
      behaviorTemplateGraph('breathing', 'edited', {})!
    );
    await behaviorsCol().set(
      'edited',
      'templateFingerprint',
      graphFingerprint(oldEdited)
    ).ack;
    await addNode('edited', 'mine');
    const editedBefore = JSON.stringify(
      logicCol().get(gid('edited'))?.descriptor
    );
    await logicCol().remove(gid('nograph')).ack;

    expect((await status('stale')).templateUpdateAvailable).toBe(true);
    behaviorGraphLifecycle.bootSync();

    expect(await status('stale')).toMatchObject({
      modified: false,
      templateUpdateAvailable: false,
    });
    expect(graphOf('stale').nodes.map((n) => n.id)).not.toContain('extra');
    expect(JSON.stringify(logicCol().get(gid('edited'))?.descriptor)).toBe(
      editedBefore
    );
    expect(await status('edited')).toMatchObject({
      modified: true,
      templateUpdateAvailable: true,
    });
    expect(await status('nograph')).toMatchObject({
      missingGraph: false,
      modified: false,
    });
  });

  // ── shape settings (no shipped kind has one; a test kind does) ───────────

  describe('a kind with a shape setting', () => {
    let restore: () => void;
    beforeEach(() => {
      const base = behaviorTemplateGraph('breathing', '_', {})!;
      restore = registerBehaviorTemplate({
        kind: 'test_shape',
        graphIdPrefix: 'test_shape:',
        shapeFields: ['mode'],
        build: (shape) => ({
          label: 'Test',
          readonly: false,
          nodes:
            shape.mode === 'double'
              ? [
                  ...base.nodes,
                  {
                    id: 'second',
                    kind: 'behavior_id',
                    position: { x: 0, y: 0 },
                  },
                ]
              : base.nodes,
          edges: base.edges,
        }),
      });
    });
    afterEach(() => restore());

    const nodesOf = (id: string) =>
      graphOf(id, 'test_shape').nodes.map((n) => n.id);

    it('a shape change rebuilds an unmodified graph', async () => {
      await create('s1', 'test_shape', { mode: 'single' });
      expect(nodesOf('s1')).not.toContain('second');
      await request(app)
        .put('/api/behaviors/s1')
        .send({ config: { mode: 'double' } });
      expect(nodesOf('s1')).toContain('second');
      expect(await status('s1')).toMatchObject({
        modified: false,
        templateUpdateAvailable: false,
      });
    });

    it('a shape change keeps a modified graph and offers the update', async () => {
      await create('s1', 'test_shape', { mode: 'single' });
      await logicCol().set(gid('s1', 'test_shape'), 'descriptor.nodes.mine', {
        id: 'mine',
        kind: 'behavior_id',
        position: { x: 0, y: 0 },
      }).ack;
      await request(app)
        .put('/api/behaviors/s1')
        .send({ config: { mode: 'double' } });
      expect(nodesOf('s1')).toContain('mine');
      expect(nodesOf('s1')).not.toContain('second');
      expect(await status('s1')).toMatchObject({
        modified: true,
        templateUpdateAvailable: true,
      });
    });
  });
});

function withExtraNode(g: GraphDescriptor): GraphDescriptor {
  return {
    ...g,
    nodes: [
      ...g.nodes,
      { id: 'extra', kind: 'behavior_id', position: { x: 0, y: 0 } },
    ],
  };
}
