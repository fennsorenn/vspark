/**
 * `logic` authored on the mesh.
 *
 * Graphs were the last document type with no sync at all: the panels re-polled
 * REST every three seconds and the canvas PUT the whole descriptor on a
 * debounce, so a rename took up to 3s to appear elsewhere and two people
 * editing one graph overwrote each other with no way to notice. Every edit was
 * also server-authored, so none of it could be undone.
 *
 * Same convention as behaviorEffectWrites: the store is NOT asserted on the
 * mesh path — the feeder mirrors the replica into the store, and there is no
 * feeder here. Only the REST fallback applies locally, and that IS asserted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Write {
  id: string;
  path?: string;
  value?: unknown;
  op: 'set' | 'update' | 'remove';
}

const writes: Write[] = [];
let canWrite = true;
const docs = new Map<string, object>();

const logicCollection = {
  canWrite: () => canWrite,
  get: (id: string) => docs.get(id),
  set: (id: string, path: string, value: unknown) => {
    writes.push({ id, path, value, op: 'set' });
    if (path === '') docs.set(id, value as object);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  update: (id: string, partial: object) => {
    writes.push({ id, value: partial, op: 'update' });
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  remove: (id: string) => {
    writes.push({ id, op: 'remove' });
    docs.delete(id);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
};

vi.mock('../src/mesh/peer', () => ({
  getMeshHandles: () => ({
    peer: {},
    serverPeerId: 'server',
    collections: { logic: logicCollection },
  }),
  meshBatch: <T>(fn: () => T): T => fn(),
}));

vi.mock('../src/api/client', () => ({
  api: {
    createProjectLogic: vi.fn((_p: string, name: string) =>
      Promise.resolve({ id: 'server-minted', name })
    ),
    createNodeLogic: vi.fn((_n: string, name: string) =>
      Promise.resolve({ id: 'server-minted', name })
    ),
    createLayerLogic: vi.fn((_l: string, name: string) =>
      Promise.resolve({ id: 'server-minted', name })
    ),
    updateLogic: vi.fn(() => Promise.resolve({})),
    deleteLogic: vi.fn(() => Promise.resolve({})),
  },
}));

const empty = { nodes: [], edges: [] };

/** A graph in both the store (where the write helpers look the doc up) and the
 *  replica (where they check the peer holds it). */
async function seed(id: string) {
  const { useEditorStore } = await import('../src/store/editorStore');
  useEditorStore.setState({
    logic: {
      [id]: {
        id,
        ownerKind: 'project',
        ownerId: 'p1',
        name: id,
        enabled: true,
        descriptor: empty as never,
      },
    },
  });
  docs.set(id, {});
}

describe('logic writes', () => {
  beforeEach(async () => {
    writes.length = 0;
    canWrite = true;
    docs.clear();
    const { useEditorStore } = await import('../src/store/editorStore');
    useEditorStore.setState({ logic: {} });
  });

  it('creating authors on the mesh, with the owner on the doc', async () => {
    const { commitLogicCreate } = await import('../src/mesh/logicWrites');

    await commitLogicCreate({ kind: 'scene_node', id: 'n1' }, 'Graph');

    expect(writes).toHaveLength(1);
    expect(writes[0].value).toMatchObject({
      ownerKind: 'scene_node',
      ownerId: 'n1',
      name: 'Graph',
      enabled: true,
    });
  });

  it('mints its own id, so the create is authored by this tab', async () => {
    const { commitLogicCreate } = await import('../src/mesh/logicWrites');

    const made = await commitLogicCreate({ kind: 'project', id: 'p1' }, 'G');

    // A server-minted id would mean a server-authored create — and no undo.
    expect(writes[0].id).toBe(made.id);
    expect(made.id).not.toBe('server-minted');
  });

  it('carries a pasted descriptor in the same write as the create', async () => {
    // On REST this needed a create plus a follow-up PUT, i.e. two actions to
    // undo for one paste.
    const { commitLogicCreate } = await import('../src/mesh/logicWrites');
    const descriptor = { nodes: [{ id: 'a' }], edges: [] };

    await commitLogicCreate(
      { kind: 'compose_layer', id: 'l1' },
      'Pasted',
      descriptor as never
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].value).toMatchObject({ descriptor });
  });

  it('a descriptor commit is one write on the descriptor path', async () => {
    // The canvas debounces its edits into this: a settled edit is one undo
    // step, not one per dragged node.
    const { commitLogicPath } = await import('../src/mesh/logicWrites');
    await seed('g1');

    commitLogicPath('g1', 'descriptor', empty);

    expect(writes).toEqual([
      { id: 'g1', path: 'descriptor', value: empty, op: 'set' },
    ]);
  });

  it('toggling enabled is one committed write', async () => {
    const { commitLogicPath } = await import('../src/mesh/logicWrites');
    await seed('g1');

    commitLogicPath('g1', 'enabled', false);

    expect(writes).toHaveLength(1);
    expect(writes[0].value).toBe(false);
  });

  it('deleting authors a remove on the mesh', async () => {
    const { commitLogicDelete } = await import('../src/mesh/logicWrites');
    await seed('g1');

    await commitLogicDelete('g1');

    expect(writes.some((w) => w.op === 'remove')).toBe(true);
  });

  it('falls back to REST when the peer cannot author', async () => {
    // The write still lands — it just is not undoable, which is the honest
    // consequence of the server authoring it.
    const { useEditorStore } = await import('../src/store/editorStore');
    const { api } = await import('../src/api/client');
    useEditorStore.setState({
      logic: {
        g1: {
          id: 'g1',
          ownerKind: 'project',
          ownerId: 'p1',
          name: 'G',
          enabled: true,
          descriptor: empty as never,
        },
      },
    });
    canWrite = false;

    const { commitLogicPath } = await import('../src/mesh/logicWrites');
    commitLogicPath('g1', 'enabled', false);

    expect(writes).toHaveLength(0);
    expect(api.updateLogic).toHaveBeenCalled();
    expect(useEditorStore.getState().logic.g1.enabled).toBe(false);
  });

  it('logicFor lists one owner in creation order', async () => {
    const { useEditorStore } = await import('../src/store/editorStore');
    const mk = (id: string, ownerId: string, createdAt: string) => ({
      id,
      ownerKind: 'scene_node',
      ownerId,
      name: id,
      enabled: true,
      descriptor: empty as never,
      createdAt,
    });
    useEditorStore.setState({
      logic: {
        b: mk('b', 'n1', '2024-01-02'),
        a: mk('a', 'n1', '2024-01-01'),
        other: mk('other', 'n2', '2024-01-01'),
      },
    });

    const { logicFor } = await import('../src/mesh/logicWrites');
    expect(logicFor({ kind: 'scene_node', id: 'n1' }).map((g) => g.id)).toEqual(
      ['a', 'b']
    );
  });
});
