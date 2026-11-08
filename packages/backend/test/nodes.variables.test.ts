import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkEvent } from '@vspark/shared/signal';
import { makeTestApp } from './helpers/testApp.js';
import { buildGraph } from './helpers/nodeHarness.js';
import { getDb } from '../src/db/index.js';
import {
  getMeshCollection,
  initBackendMesh,
  resetBackendMesh,
} from '../src/mesh/index.js';
import { runtimeVariableCollection } from '../src/mesh/variables.js';
import {
  deleteVariablesInScope,
  persistentVariableId,
  readVariable,
  runtimeVariableId,
  type VariableRef,
} from '../src/variables/store.js';
import { logicManager } from '../src/logic/manager.js';

/**
 * Graph variables: the `variable` / `set_variable` / `increment_variable`
 * nodes over the store in variables/store.ts — persistent ones in the
 * committed `variable` collection (persisted to the `variables` table),
 * short-lived ones in `runtime_variable` (the runtime channel).
 */
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

async function newProject(app: Parameters<typeof request>[0], name = 'P') {
  return (await request(app).post('/api/projects').send({ name })).body.data
    .id as string;
}

/** A setter (set_variable or increment_variable) plus a reader of the same
 *  variable, both configured from `cfg` + `_projectId`. */
function varGraph(
  setterKind: 'set_variable' | 'increment_variable',
  projectId: string,
  cfg: Record<string, unknown>
) {
  const { graph } = buildGraph(
    [
      { id: 'set', kind: setterKind },
      { id: 'get', kind: 'variable' },
      { id: 'trg', kind: 'component_trigger' },
      { id: 'sink', kind: 'log' },
    ],
    [
      {
        fromNodeId: 'get',
        fromPort: 'value',
        toNodeId: 'sink',
        toPort: 'inputs',
      },
      {
        fromNodeId: 'set',
        fromPort: 'value',
        toNodeId: 'sink',
        toPort: 'inputs',
      },
      {
        fromNodeId: 'trg',
        fromPort: 'trigger',
        toNodeId: 'sink',
        toPort: 'trigger',
      },
    ],
    {
      set: { _projectId: projectId, ...cfg },
      get: {
        _projectId: projectId,
        name: cfg.name,
        scope: cfg.scope,
      },
    }
  );
  return {
    fire: () => graph.deliverExternal('set', 'fire', mkEvent(undefined)),
    /** [variable.value, setter.value] — what a downstream node would pull. */
    read: () => {
      graph.fire('trg', 'trigger', mkEvent(undefined));
      return graph.peekInput('sink', 'inputs') as unknown[];
    },
  };
}

const dbRow = (id: string) =>
  getDb().prepare('SELECT * FROM variables WHERE id = ?').get(id) as
    | { value: string; scope: string; name: string }
    | undefined;

describe('graph variables', () => {
  let app: Parameters<typeof request>[0];
  let projectId: string;

  beforeEach(async () => {
    ({ app } = await makeTestApp({ mesh: true }));
    projectId = await newProject(app);
  });

  it('set_variable stores a value that variable reads back', () => {
    const g = varGraph('set_variable', projectId, {
      name: 'greeting',
      value: 'hi',
    });
    expect(g.read()).toEqual([]); // unset reads as nothing
    g.fire();
    expect(g.read()).toEqual(['hi', 'hi']);
  });

  it('increment_variable counts by 1 by default and by `by` when given', () => {
    const g = varGraph('increment_variable', projectId, { name: 'count' });
    g.fire();
    g.fire();
    expect(g.read()).toEqual([2, 2]);
    const h = varGraph('increment_variable', projectId, {
      name: 'count',
      by: 2.5,
    });
    h.fire();
    expect(h.read()).toEqual([4.5, 4.5]);
  });

  it('increment treats a non-numeric value as 0', () => {
    varGraph('set_variable', projectId, { name: 'x', value: 'text' }).fire();
    const g = varGraph('increment_variable', projectId, { name: 'x', by: 3 });
    g.fire();
    expect(g.read()).toEqual([3, 3]);
  });

  it('keeps scopes and projects apart', async () => {
    const other = await newProject(app, 'Other');
    varGraph('set_variable', projectId, { name: 'n', value: 'shared' }).fire();
    varGraph('set_variable', projectId, {
      name: 'n',
      scope: 'g1',
      value: 'g1',
    }).fire();
    varGraph('set_variable', other, { name: 'n', value: 'other' }).fire();

    const at = (pid: string, scope: string): VariableRef => ({
      projectId: pid,
      scope,
      name: 'n',
    });
    expect(readVariable(at(projectId, ''))).toBe('shared');
    expect(readVariable(at(projectId, 'g1'))).toBe('g1');
    expect(readVariable(at(other, ''))).toBe('other');
    expect(readVariable(at(other, 'g1'))).toBeUndefined();
  });

  it('is inert without a project (outside a Logic graph)', () => {
    const g = varGraph('set_variable', '', { name: 'n', value: 1 });
    g.fire();
    expect(g.read()).toEqual([]);
    expect(runtimeVariableCollection()!.all()).toEqual([]);
  });

  it('keeps a short-lived variable on the runtime channel only', () => {
    varGraph('set_variable', projectId, { name: 'tmp', value: 1 }).fire();
    const ref = { projectId, scope: '', name: 'tmp' };
    expect(
      runtimeVariableCollection()!.get(runtimeVariableId(ref))?.value
    ).toBe(1);
    expect(
      getMeshCollection('variable')!.get(persistentVariableId(ref))
    ).toBeUndefined();
    expect(dbRow(persistentVariableId(ref))).toBeUndefined();
  });

  it('persists a persistent variable to the variables table', () => {
    varGraph('increment_variable', projectId, {
      name: 'deaths',
      persistent: true,
    }).fire();
    const ref = { projectId, scope: '', name: 'deaths' };
    const row = dbRow(persistentVariableId(ref));
    expect(row && JSON.parse(row.value)).toBe(1);
    expect(
      runtimeVariableCollection()!.get(runtimeVariableId(ref))
    ).toBeUndefined();
  });

  it('brings persistent variables back after a restart and drops short-lived ones', () => {
    varGraph('set_variable', projectId, {
      name: 'kept',
      value: { n: 7 },
      persistent: true,
    }).fire();
    varGraph('set_variable', projectId, { name: 'lost', value: 7 }).fire();

    // Restart: a fresh mesh peer hydrated from the same database.
    resetBackendMesh();
    initBackendMesh();

    expect(readVariable({ projectId, scope: '', name: 'kept' })).toEqual({
      n: 7,
    });
    expect(
      readVariable({ projectId, scope: '', name: 'lost' })
    ).toBeUndefined();
    // …and counting continues from the restored value.
    const g = varGraph('increment_variable', projectId, {
      name: 'kept',
      persistent: true,
    });
    g.fire();
    expect(g.read()).toEqual([1, 1]); // a record isn't numeric → counts from 0
  });

  it('moves a variable between the collections when `persistent` changes', () => {
    const ref = { projectId, scope: '', name: 'm' };
    varGraph('set_variable', projectId, {
      name: 'm',
      value: 1,
      persistent: true,
    }).fire();
    expect(dbRow(persistentVariableId(ref))).toBeDefined();

    varGraph('set_variable', projectId, { name: 'm', value: 2 }).fire();
    expect(dbRow(persistentVariableId(ref))).toBeUndefined();
    expect(
      getMeshCollection('variable')!.get(persistentVariableId(ref))
    ).toBeUndefined();
    expect(readVariable(ref)).toBe(2);

    varGraph('increment_variable', projectId, {
      name: 'm',
      persistent: true,
    }).fire();
    expect(
      runtimeVariableCollection()!.get(runtimeVariableId(ref))
    ).toBeUndefined();
    expect(JSON.parse(dbRow(persistentVariableId(ref))!.value)).toBe(3);
  });

  it('deleteVariablesInScope removes both kinds in that scope only', () => {
    varGraph('set_variable', projectId, {
      name: 'a',
      scope: 'g',
      value: 1,
      persistent: true,
    }).fire();
    varGraph('set_variable', projectId, {
      name: 'b',
      scope: 'g',
      value: 1,
    }).fire();
    varGraph('set_variable', projectId, {
      name: 'a',
      value: 1,
      persistent: true,
    }).fire();

    expect(deleteVariablesInScope('g')).toBe(2);
    expect(readVariable({ projectId, scope: 'g', name: 'a' })).toBeUndefined();
    expect(readVariable({ projectId, scope: 'g', name: 'b' })).toBeUndefined();
    expect(
      dbRow(persistentVariableId({ projectId, scope: 'g', name: 'a' }))
    ).toBeUndefined();
    expect(readVariable({ projectId, scope: '', name: 'a' })).toBe(1);
    // The shared namespace is never bulk-deleted.
    expect(deleteVariablesInScope('')).toBe(0);
  });
});

describe('graph-local variables (logic_id)', () => {
  it('scopes to the running graph and are deleted with it', async () => {
    const { app } = await makeTestApp({ mesh: true });
    const projectId = await newProject(app);
    const graphId = 'logic-1';
    await getMeshCollection('logic')!.set(graphId, '', {
      id: graphId,
      ownerKind: 'project',
      ownerId: projectId,
      name: 'Counter',
      enabled: true,
      descriptor: {
        nodes: {
          id: {
            id: 'id',
            kind: 'logic_id',
            position: { x: 0, y: 0 },
            defaultConfig: {},
          },
          inc: {
            id: 'inc',
            kind: 'increment_variable',
            position: { x: 0, y: 0 },
            defaultConfig: { name: 'hits', persistent: true },
          },
        },
        edges: {
          e1: {
            fromNodeId: 'id',
            fromPort: 'id',
            toNodeId: 'inc',
            toPort: 'scope',
          },
        },
      },
    }).ack;

    logicManager.fire(graphId, 'inc', 'fire', mkEvent(undefined));
    logicManager.fire(graphId, 'inc', 'fire', mkEvent(undefined));
    const ref = { projectId, scope: graphId, name: 'hits' };
    expect(readVariable(ref)).toBe(2);
    expect(dbRow(persistentVariableId(ref))).toBeDefined();
    // The shared namespace is untouched.
    expect(
      readVariable({ projectId, scope: '', name: 'hits' })
    ).toBeUndefined();

    await getMeshCollection('logic')!.remove(graphId).ack;
    expect(readVariable(ref)).toBeUndefined();
    expect(dbRow(persistentVariableId(ref))).toBeUndefined();
  });
});
