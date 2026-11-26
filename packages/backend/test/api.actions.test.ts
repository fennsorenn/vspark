import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { makeTestApp } from './helpers/testApp.js';
import { getMeshCollection } from '../src/mesh/index.js';
import { getDb } from '../src/db/index.js';
import { logicManager } from '../src/logic/manager.js';
import { hotkeyManager } from '../src/hotkeys/manager.js';
import { actionLifecycle } from '../src/actions/lifecycle.js';
import {
  actionGraphId,
  graphFingerprint,
  templateFingerprint,
} from '@vspark/shared/actions';
import {
  toDescriptorDoc,
  toGraphDescriptor,
  type GraphDescriptorDoc,
} from '@vspark/shared/signal';

/**
 * Actions: the `action` collection, its owned Logic graph, and the lifecycle
 * that keeps the two in step (actions/lifecycle.ts). Every write goes through
 * the mesh like a tab's would, so the tap — not the route — is what is pinned.
 */
type Json = Record<string, any>;

const actionsCol = () => getMeshCollection('action')!;
const logicCol = () => getMeshCollection('logic')!;
const graphOf = (actionId: string) =>
  toGraphDescriptor(
    logicCol().get(actionGraphId(actionId))?.descriptor as GraphDescriptorDoc
  );
const kindsOf = (actionId: string) => graphOf(actionId).nodes.map((n) => n.kind);
const statusOf = async (app: Express, id: string) =>
  (await request(app).get(`/api/actions/${id}`)).body.data as Json;

describe('actions', () => {
  let app: Express;
  let projectId: string;

  const create = async (body: Json = {}) =>
    request(app)
      .post(`/api/projects/${projectId}/actions`)
      .send({ kind: 'hotkey', ...body });

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    projectId = (await request(app).post('/api/projects').send({ name: 'P' }))
      .body.data.id as string;
  });

  afterEach(() => logicManager.close());

  // ── wiring (a missed step here fails silently) ────────────────────────────

  it('is bound, persists, and parents the graph under the action', async () => {
    expect(getMeshCollection('action')).toBeDefined();
    const res = await create({ id: 'a1', name: 'My hotkey' });
    expect(res.status).toBe(201);
    expect(
      getDb().prepare('SELECT name, kind FROM actions WHERE id = ?').get('a1')
    ).toEqual({ name: 'My hotkey', kind: 'hotkey' });
    expect(
      getDb()
        .prepare('SELECT owner_kind, owner_id FROM logic WHERE id = ?')
        .get(actionGraphId('a1'))
    ).toEqual({ owner_kind: 'action', owner_id: 'a1' });
    expect(
      logicCol()
        .subtree('a1')
        .map((d) => (d as { id: string }).id)
    ).toContain(actionGraphId('a1'));
  });

  // ── create ───────────────────────────────────────────────────────────────

  it('create builds and stores the graph and its fingerprint', async () => {
    const res = await create({
      id: 'a1',
      settings: { responses: { '0': { type: 'play_clip', clipId: 'c1' } } },
    });
    const data = res.body.data as Json;
    expect(data).toMatchObject({
      kind: 'hotkey',
      name: 'Hotkey',
      enabled: true,
      graphId: actionGraphId('a1'),
      modified: false,
      templateUpdateAvailable: false,
      missingGraph: false,
    });
    expect(data.settings.mode).toBe('single');
    expect(data.templateFingerprint).toBe(
      templateFingerprint('hotkey', data.settings)
    );
    expect(kindsOf('a1')).toEqual(
      expect.arrayContaining(['system_hotkey', 'start_clip', 'settings'])
    );
    // The graph runs.
    expect(
      logicManager.getRunningDescriptors().map((r) => r.id)
    ).toContain(actionGraphId('a1'));
  });

  it('runs under the action’s project: boot start, node iteration, _projectId', async () => {
    await create({ id: 'a1' });
    const graphId = actionGraphId('a1');
    // Boot path: nothing running, startAllEnabled picks action graphs up.
    logicManager.close();
    expect(logicManager.getRunningDescriptors()).toHaveLength(0);
    logicManager.startAllEnabled();
    expect(logicManager.getRunningDescriptors().map((r) => r.id)).toContain(
      graphId
    );
    // Routing (overlive / hotkeys / OBS / triggers) finds the graph's nodes
    // under the right project.
    const hotkey = [...logicManager.iterateNodes()].find(
      (n) => n.graphId === graphId && n.node.kind === 'system_hotkey'
    );
    expect(hotkey?.projectId).toBe(projectId);
    // Project-scoped nodes get the action's project injected.
    expect(
      logicManager.getStates(graphId)?.nodes.hotkey?.config
    ).toMatchObject({ _projectId: projectId });
    // A disabled action's graph is not started at boot.
    await request(app).put('/api/actions/a1').send({ enabled: false });
    logicManager.close();
    logicManager.startAllEnabled();
    expect(logicManager.getRunningDescriptors().map((r) => r.id)).not.toContain(
      graphId
    );
  });

  it('rejects an unknown kind and a malformed body', async () => {
    expect((await create({ kind: 'nope' })).status).toBe(400);
    expect((await create({ kind: 7 })).status).toBe(400);
    expect((await request(app).get('/api/actions/missing')).status).toBe(404);
    expect(
      (await request(app).put('/api/actions/missing').send({ name: 'x' }))
        .status
    ).toBe(404);
    // Tabs cannot write an unknown kind either.
    const out = await actionsCol().set('bad', '', {
      id: 'bad',
      projectId,
      kind: 'nope',
      name: 'x',
      enabled: true,
      settings: {},
    }).ack;
    expect(out.status).toBe('rejected');
  });

  it('lists a project’s actions and the kinds', async () => {
    await create({ id: 'a1' });
    await create({ id: 'a2', name: 'Second' });
    const list = (await request(app).get(`/api/projects/${projectId}/actions`))
      .body.data as Json[];
    expect(list.map((a) => a.id)).toEqual(['a1', 'a2']);
    const kinds = (await request(app).get('/api/action-kinds')).body
      .data as Json[];
    expect(kinds[0]).toMatchObject({ kind: 'hotkey', label: 'Hotkey' });
    expect(kinds[0].fields).toContainEqual({ path: 'mode', class: 'shape' });
  });

  // ── value vs shape ───────────────────────────────────────────────────────

  it('a value-setting change leaves the graph untouched; the running graph sees it', async () => {
    await create({
      id: 'a1',
      settings: {
        shortcut: { key: 'F8' },
        responses: { '0': { type: 'play_clip', clipId: 'c1' } },
      },
    });
    const graphId = actionGraphId('a1');
    const before = JSON.stringify(logicCol().get(graphId)?.descriptor);
    expect(logicManager.pullInput(graphId, 'response_0', 'clipId')).toBe('c1');

    const res = await request(app)
      .put('/api/actions/a1')
      .send({
        settings: {
          shortcut: { key: 'F9', ctrl: true },
          responses: { '0': { clipId: 'c2' } },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.settings.responses['0']).toEqual({
      type: 'play_clip',
      clipId: 'c2',
    });
    expect(JSON.stringify(logicCol().get(graphId)?.descriptor)).toBe(before);
    expect(res.body.data.modified).toBe(false);
    // Live: the settings nodes resolve the new values without a rebuild.
    expect(logicManager.pullInput(graphId, 'response_0', 'clipId')).toBe('c2');
    expect(logicManager.pullInput(graphId, 'hotkey', 'key')).toBe('F9');
    expect(logicManager.pullInput(graphId, 'hotkey', 'ctrl')).toBe(true);
  });

  it('the hotkey fires on the shortcut read from settings', async () => {
    await create({ id: 'a1', settings: { shortcut: { key: 'F8', shift: true } } });
    const graphId = actionGraphId('a1');
    const press = (key: string, shift: boolean) =>
      hotkeyManager.dispatch({ key, ctrl: false, shift, alt: false, meta: false });
    const lastIn = () =>
      logicManager.getStates(graphId)?.nodes.hotkey?.portValues['in:event'];
    press('F8', false);
    expect(lastIn()).toBeUndefined();
    press('F8', true);
    expect(lastIn()).toBeDefined();
  });

  it('a shape-setting change rebuilds an unmodified graph', async () => {
    await create({ id: 'a1' });
    expect(kindsOf('a1')).not.toContain('cycle');
    const res = await request(app)
      .put('/api/actions/a1')
      .send({
        settings: {
          mode: 'toggle',
          responses: { '1': { type: 'spawn_clip' } },
        },
      });
    expect(kindsOf('a1')).toEqual(
      expect.arrayContaining(['cycle', 'start_clip', 'spawn_clip'])
    );
    expect(res.body.data).toMatchObject({
      modified: false,
      templateUpdateAvailable: false,
    });
  });

  it('a shape change done through the mesh rebuilds too (tab path)', async () => {
    await create({ id: 'a1' });
    await actionsCol().set('a1', 'settings.mode', 'cycle').ack;
    expect(graphOf('a1').nodes.find((n) => n.id === 'cycle')?.defaultConfig)
      .toEqual({ count: 3 });
    expect(actionsCol().get('a1')?.templateFingerprint).toBe(
      templateFingerprint('hotkey', actionsCol().get('a1')?.settings)
    );
  });

  // ── modified / reset ─────────────────────────────────────────────────────

  it('modified detection ignores node positions', async () => {
    await create({ id: 'a1' });
    const graphId = actionGraphId('a1');
    const hotkey = graphOf('a1').nodes.find((n) => n.id === 'hotkey')!;
    await logicCol().set(graphId, 'descriptor.nodes.hotkey', {
      ...hotkey,
      position: { x: 1234, y: 567 },
    }).ack;
    expect((await statusOf(app, 'a1')).modified).toBe(false);

    await logicCol().set(
      graphId,
      'descriptor.nodes.hotkey.defaultConfig.enabled',
      false
    ).ack;
    expect((await statusOf(app, 'a1')).modified).toBe(true);
  });

  it('keeps a modified graph on a shape change and offers the template update', async () => {
    await create({ id: 'a1' });
    const graphId = actionGraphId('a1');
    await logicCol().set(graphId, 'descriptor.nodes.extra', {
      id: 'extra',
      kind: 'log',
      position: { x: 0, y: 0 },
    }).ack;
    const edited = JSON.stringify(logicCol().get(graphId)?.descriptor);

    const data = (
      await request(app)
        .put('/api/actions/a1')
        .send({ settings: { mode: 'toggle' } })
    ).body.data as Json;
    expect(JSON.stringify(logicCol().get(graphId)?.descriptor)).toBe(edited);
    expect(data).toMatchObject({ modified: true, templateUpdateAvailable: true });

    // Reset regenerates from the current template and clears both badges.
    const reset = (await request(app).post('/api/actions/a1/reset')).body
      .data as Json;
    expect(reset).toMatchObject({ modified: false, templateUpdateAvailable: false });
    expect(kindsOf('a1')).toContain('cycle');
    expect(kindsOf('a1')).not.toContain('log');
  });

  it('reset recreates a missing graph', async () => {
    await create({ id: 'a1' });
    await logicCol().remove(actionGraphId('a1')).ack;
    expect((await statusOf(app, 'a1')).missingGraph).toBe(true);
    expect((await request(app).post('/api/actions/a1/reset')).status).toBe(200);
    expect((await statusOf(app, 'a1')).missingGraph).toBe(false);
    expect((await request(app).post('/api/actions/none/reset')).status).toBe(404);
  });

  // ── boot ─────────────────────────────────────────────────────────────────

  it('boot regenerates unmodified graphs whose template changed, only those', async () => {
    await create({ id: 'stale' });
    await create({ id: 'edited' });
    await create({ id: 'nograph' });

    // Simulate an older template: a graph that differs from today's output,
    // recorded as what it was generated from (so: unmodified, but outdated).
    const old = graphOf('stale');
    old.nodes = old.nodes.filter((n) => n.id !== 'cfg_shortcut_meta');
    old.edges = old.edges.filter((e) => e.fromNodeId !== 'cfg_shortcut_meta');
    await logicCol().set(actionGraphId('stale'), 'descriptor', toDescriptorDoc(old)).ack;
    await actionsCol().set('stale', 'templateFingerprint', graphFingerprint(old)).ack;

    // Same older template, but the user edited the graph since.
    const oldE = { ...old, id: actionGraphId('edited') };
    await logicCol().set(actionGraphId('edited'), 'descriptor', toDescriptorDoc(oldE)).ack;
    await actionsCol().set('edited', 'templateFingerprint', graphFingerprint(oldE)).ack;
    await logicCol().set(actionGraphId('edited'), 'descriptor.nodes.extra', {
      id: 'extra',
      kind: 'log',
      position: { x: 0, y: 0 },
    }).ack;
    const editedBefore = JSON.stringify(logicCol().get(actionGraphId('edited'))?.descriptor);

    await logicCol().remove(actionGraphId('nograph')).ack;

    expect((await statusOf(app, 'stale')).templateUpdateAvailable).toBe(true);
    actionLifecycle.bootSync();

    expect(await statusOf(app, 'stale')).toMatchObject({
      modified: false,
      templateUpdateAvailable: false,
    });
    expect(kindsOf('stale')).toHaveLength(graphOf('nograph').nodes.length);
    expect(JSON.stringify(logicCol().get(actionGraphId('edited'))?.descriptor)).toBe(
      editedBefore
    );
    expect(await statusOf(app, 'edited')).toMatchObject({
      modified: true,
      templateUpdateAvailable: true,
    });
    expect((await statusOf(app, 'nograph')).missingGraph).toBe(false);
  });

  // ── enable / delete ──────────────────────────────────────────────────────

  it('disabling stops the graph, enabling starts it again', async () => {
    await create({ id: 'a1' });
    const running = () =>
      logicManager.getRunningDescriptors().some((r) => r.id === actionGraphId('a1'));
    expect(running()).toBe(true);
    await request(app).put('/api/actions/a1').send({ enabled: false });
    expect(running()).toBe(false);
    await request(app).put('/api/actions/a1').send({ enabled: true });
    expect(running()).toBe(true);
  });

  it('delete cascades the graph', async () => {
    await create({ id: 'a1' });
    const graphId = actionGraphId('a1');
    expect((await request(app).delete('/api/actions/a1')).status).toBe(200);
    expect(actionsCol().get('a1')).toBeUndefined();
    expect(logicCol().get(graphId)).toBeUndefined();
    expect(getDb().prepare('SELECT 1 FROM logic WHERE id = ?').get(graphId))
      .toBeUndefined();
    expect(getDb().prepare('SELECT 1 FROM actions WHERE id = ?').get('a1'))
      .toBeUndefined();
    expect(
      logicManager.getRunningDescriptors().some((r) => r.id === graphId)
    ).toBe(false);
    expect((await request(app).delete('/api/actions/a1')).status).toBe(404);
  });

  // ── the settings node's scope ────────────────────────────────────────────

  it('allows the settings node in an action graph and rejects it in plain Logic', async () => {
    await create({ id: 'a1' });
    const node = { id: 's', kind: 'settings', position: { x: 0, y: 0 }, defaultConfig: { field: 'mode' } };
    const inAction = await logicCol().set(
      actionGraphId('a1'),
      'descriptor.nodes.s',
      node
    ).ack;
    expect(inAction.status).not.toBe('rejected');
    expect(logicManager.pullInput(actionGraphId('a1'), 's', 'field')).toBe('mode');

    await request(app)
      .post(`/api/projects/${projectId}/logic`)
      .send({ id: 'plain', name: 'Plain' });
    const plain = await logicCol().set('plain', 'descriptor.nodes.s', node).ack;
    expect(plain.status).toBe('rejected');
  });
});
