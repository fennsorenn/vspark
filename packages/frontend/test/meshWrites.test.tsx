/**
 * meshWrites.test.tsx
 *
 * The mesh write path and the control binding built on it:
 *  - commitNodePath writes one dotted path onto the tab peer, and falls back to
 *    REST when the peer can't author it (unarmed, doc absent, remote node);
 *  - previewNodePath stays local — no mesh traffic, so no undo step;
 *  - useMeshField tracks the store live, but a draft in progress wins over a
 *    concurrent remote write, and commits exactly once on blur.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent, act } from './helpers/render';
import { useEditorStore, type StageObject } from '../src/store/editorStore';

const sets: Array<[string, string, unknown]> = [];
const updates: Array<[string, object]> = [];
const removes: string[] = [];
/** Writes issued inside a peer.batch(), in order — one user-level action. */
let batched: string[] | null = null;
const batches: string[][] = [];
const state = { armed: true, docs: new Map<string, object>() };

const note = (what: string) => {
  if (batched) batched.push(what);
};

const collection = {
  canWrite: () => state.armed,
  get: (id: string) => state.docs.get(id),
  set: (id: string, path: string, value: unknown) => {
    sets.push([id, path, value]);
    note(`set:${id}:${path}`);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  update: (id: string, partial: object) => {
    updates.push([id, partial]);
    note(`update:${id}`);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  remove: (id: string) => {
    removes.push(id);
    note(`remove:${id}`);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
};

vi.mock('../src/mesh/peer', () => ({
  getMeshHandles: () => ({
    peer: {},
    serverPeerId: 'server',
    collections: { scene_node: collection },
  }),
  // Mirrors the real helper: run fn, recording which writes it grouped.
  meshBatch: <T,>(fn: () => T): T => {
    batched = [];
    try {
      return fn();
    } finally {
      batches.push(batched!);
      batched = null;
    }
  },
}));

const updateNode = vi.fn(() => Promise.resolve({}));
vi.mock('../src/api/client', () => {
  const fn = (...a: unknown[]) => updateNode(...(a as []));
  // `updateNode` is exported both standalone and on the `api` object.
  const createNode = (_sceneId: unknown, spec: Record<string, unknown>) =>
    Promise.resolve({ ...spec, id: 'rest-minted-id' });
  const deleteNode = () => Promise.resolve({});
  return {
    updateNode: fn,
    api: { updateNode: fn, createNode, deleteNode },
    createNode,
    deleteNode,
    fireSignalEvent: vi.fn(),
    updateScene: vi.fn(),
  };
});

import {
  commitNodeCreate,
  commitNodeDelete,
  commitNodeDeleteKeepChildren,
  commitNodePatch,
  commitNodePath,
  previewNodePath,
  canMeshWrite,
} from '../src/mesh/writes';
import { useMeshField } from '../src/hooks/useMeshField';

const NODE_ID = 'node-1';

const node = (over: Partial<StageObject> = {}): StageObject =>
  ({
    id: NODE_ID,
    name: 'Cube',
    kind: 'group',
    parentId: null,
    properties: {},
    components: {},
    ...over,
  }) as StageObject;

function seed(n: StageObject = node()) {
  useEditorStore.setState({ nodes: [n] });
  state.docs.set(n.id, n);
}

beforeEach(() => {
  sets.length = 0;
  updates.length = 0;
  removes.length = 0;
  batches.length = 0;
  batched = null;
  updateNode.mockClear();
  state.armed = true;
  state.docs = new Map();
  seed();
});

describe('commitNodePath', () => {
  it('writes the exact dotted path onto the peer, not the whole doc', () => {
    commitNodePath(
      NODE_ID,
      'properties.materialOverrides.body.baseColor',
      '#f00'
    );

    expect(sets).toEqual([
      [NODE_ID, 'properties.materialOverrides.body.baseColor', '#f00'],
    ]);
    // Mesh owns it — REST must not double-write.
    expect(updateNode).not.toHaveBeenCalled();
  });

  it('falls back to REST with a whole top-level field when the peer is unarmed', () => {
    state.armed = false;

    commitNodePath(NODE_ID, 'properties.animation.speed', 2);

    expect(sets).toEqual([]);
    expect(updateNode).toHaveBeenCalledWith(NODE_ID, {
      properties: { animation: { speed: 2 } },
    });
    // The fallback has no feeder echo, so it applies locally itself.
    expect(useEditorStore.getState().nodes[0].properties).toEqual({
      animation: { speed: 2 },
    });
  });

  it('falls back to REST when the replica does not hold the doc yet', () => {
    state.docs.delete(NODE_ID);

    commitNodePath(NODE_ID, 'name', 'Renamed');

    expect(sets).toEqual([]);
    expect(updateNode).toHaveBeenCalledWith(NODE_ID, { name: 'Renamed' });
  });

  it('routes remote nodes to REST so the Phase-6 relay reaches their owner', () => {
    seed(
      node({
        remote: true,
        remoteOwnerPeerId: 'peer-b',
      } as Partial<StageObject>)
    );

    commitNodePath(NODE_ID, 'name', 'Renamed');

    expect(sets).toEqual([]);
    expect(updateNode).toHaveBeenCalledWith(NODE_ID, { name: 'Renamed' });
  });

  it('ignores a write to an unknown node', () => {
    commitNodePath('nope', 'name', 'x');
    expect(sets).toEqual([]);
    expect(updateNode).not.toHaveBeenCalled();
  });

  it('reports whether the peer can author writes', () => {
    expect(canMeshWrite()).toBe(true);
    state.armed = false;
    expect(canMeshWrite()).toBe(false);
  });
});

describe('commitNodePatch', () => {
  it('sends a multi-field edit as one op, so it is one undo step', () => {
    commitNodePatch(NODE_ID, {
      filePath: 'a.vrm',
      components: { animation: undefined },
    } as Partial<StageObject>);

    expect(updates).toEqual([
      [NODE_ID, { filePath: 'a.vrm', components: { animation: undefined } }],
    ]);
    expect(sets).toEqual([]);
    expect(updateNode).not.toHaveBeenCalled();
  });

  it('falls back to REST with whole top-level fields, not the nested partial', () => {
    // REST replaces `components` wholesale, so sending the partial verbatim
    // would wipe the sibling component.
    state.armed = false;
    seed(
      node({
        components: { transform: { type: 'transform' }, godray: { power: 1 } },
      } as Partial<StageObject>)
    );

    commitNodePatch(NODE_ID, {
      components: { godray: { power: 5 } },
    } as Partial<StageObject>);

    expect(updateNode).toHaveBeenCalledWith(NODE_ID, {
      components: { transform: { type: 'transform' }, godray: { power: 5 } },
    });
  });

  it('reparents to the root, keeping an explicit null through the fallback', () => {
    // `parentId: null` is meaningful — REST uses field-presence semantics, so
    // the null has to survive as a present key or the node never detaches.
    state.armed = false;
    seed(node({ parentId: 'old-parent' } as Partial<StageObject>));

    commitNodePatch(NODE_ID, { parentId: null, boneAttachment: null });

    expect(updateNode).toHaveBeenCalledWith(NODE_ID, {
      parentId: null,
      boneAttachment: null,
    });
    expect(useEditorStore.getState().nodes[0].parentId).toBeNull();
  });

  it('reparents through the mesh as one op when the peer is armed', () => {
    commitNodePatch(NODE_ID, { parentId: 'new-parent' });

    expect(updates).toEqual([[NODE_ID, { parentId: 'new-parent' }]]);
    expect(updateNode).not.toHaveBeenCalled();
  });

  it('merges leaf-wise on the fallback, keeping untouched sibling keys', () => {
    state.armed = false;
    seed(
      node({
        components: { godray: { power: 1, color: '#fff' } },
      } as Partial<StageObject>)
    );

    commitNodePatch(NODE_ID, {
      components: { godray: { power: 5 } },
    } as Partial<StageObject>);

    expect(updateNode).toHaveBeenCalledWith(NODE_ID, {
      components: { godray: { power: 5, color: '#fff' } },
    });
  });
});

describe('commitNodeCreate', () => {
  it('mints the id locally so the create is authored by this tab', async () => {
    useEditorStore.setState({ projectId: 'proj-1' });

    const created = await commitNodeCreate('scene-1', {
      name: 'New Group',
      kind: 'group',
    });

    expect(sets).toHaveLength(1);
    const [id, path, doc] = sets[0];
    expect(path).toBe(''); // whole-doc upsert — what the backend validates
    expect(id).toBe(created.id);
    expect(doc).toMatchObject({
      id: created.id,
      rootSceneNodeId: 'scene-1',
      projectId: 'proj-1',
      name: 'New Group',
      kind: 'group',
      parentId: null,
      hidden: false,
    });
  });

  it('throws when the backend nacks the create, like the REST route did', async () => {
    const rejecting = {
      ...collection,
      set: () => ({
        ack: Promise.resolve({ status: 'rejected', reason: 'circular' }),
      }),
    };
    state.docs.set('unused', {});
    const spy = vi
      .spyOn(collection, 'set')
      .mockImplementation(rejecting.set as typeof collection.set);

    await expect(
      commitNodeCreate('scene-1', { name: 'X', kind: 'scene_instance' })
    ).rejects.toThrow('circular');
    spy.mockRestore();
  });
});

describe('commitNodeDelete', () => {
  const tree = () => {
    // root → mid → leaf, plus a sibling of mid.
    const nodes = [
      node({ id: 'root', name: 'root' }),
      node({ id: 'mid', name: 'mid', parentId: 'root' }),
      node({ id: 'leaf', name: 'leaf', parentId: 'mid' }),
      node({ id: 'sib', name: 'sib', parentId: 'root' }),
      node({ id: 'other', name: 'other', parentId: null }),
    ];
    useEditorStore.setState({ nodes });
    state.docs = new Map(nodes.map((n) => [n.id, n]));
  };

  it('removes the whole subtree as ONE undo action, children before parents', async () => {
    tree();

    await commitNodeDelete('root');

    // Every doc is removed explicitly (so each gets a tombstone and can be
    // restored), and no node is removed before one of its own descendants.
    expect(new Set(removes)).toEqual(new Set(['leaf', 'mid', 'sib', 'root']));
    const at = (id: string) => removes.indexOf(id);
    expect(at('leaf')).toBeLessThan(at('mid'));
    expect(at('mid')).toBeLessThan(at('root'));
    expect(at('sib')).toBeLessThan(at('root'));
    expect(removes).not.toContain('other');

    // All of it in a single batch = a single undo step.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(removes.map((id) => `remove:${id}`));
  });

  it('leaves nodes outside the subtree alone', async () => {
    tree();
    await commitNodeDelete('mid');
    expect(removes).toEqual(['leaf', 'mid']);
  });

  it('removes a childless node as a single write', async () => {
    tree();
    await commitNodeDelete('sib');
    expect(removes).toEqual(['sib']);
  });

  it('falls back to REST and prunes the store when the peer is unarmed', async () => {
    tree();
    state.armed = false;

    await commitNodeDelete('mid');

    expect(removes).toEqual([]);
    const ids = useEditorStore.getState().nodes.map((n) => n.id);
    expect(ids).not.toContain('mid');
    expect(ids).not.toContain('leaf');
    expect(ids).toContain('root');
  });

  it('routes a remote node to REST rather than the local peer', async () => {
    seed(node({ remote: true, remoteOwnerPeerId: 'peer-b' } as Partial<StageObject>));
    await commitNodeDelete(NODE_ID);
    expect(removes).toEqual([]);
  });
});

describe('commitNodeDeleteKeepChildren', () => {
  it('detaches the children and removes the node in one action', async () => {
    const nodes = [
      node({ id: 'gp', name: 'gp' }),
      node({ id: 'mid', name: 'mid', parentId: 'gp' }),
      node({ id: 'c1', name: 'c1', parentId: 'mid' }),
      node({ id: 'c2', name: 'c2', parentId: 'mid' }),
    ];
    useEditorStore.setState({ nodes });
    state.docs = new Map(nodes.map((n) => [n.id, n]));

    await commitNodeDeleteKeepChildren('mid', 'gp');

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      'set:c1:parentId',
      'set:c2:parentId',
      'remove:mid',
    ]);
    expect(sets.map(([id, , v]) => [id, v])).toEqual([
      ['c1', 'gp'],
      ['c2', 'gp'],
    ]);
  });
});

describe('previewNodePath', () => {
  it('applies locally without any mesh traffic (so it logs no undo step)', () => {
    previewNodePath(NODE_ID, 'name', 'Half-typed');

    expect(sets).toEqual([]);
    expect(updateNode).not.toHaveBeenCalled();
    expect(useEditorStore.getState().nodes[0].name).toBe('Half-typed');
  });
});

function Probe({ id = NODE_ID }: { id?: string }) {
  const field = useMeshField<string>(id, 'name', '');
  return <input data-testid="name" {...field.bind()} />;
}

const input = () => screen.getByTestId('name') as HTMLInputElement;

describe('useMeshField', () => {
  it('renders the stored value and tracks later store changes', () => {
    renderWithProviders(<Probe />);
    expect(input().value).toBe('Cube');

    // A rename arriving from another tab lands in the store via the feeder.
    act(() => {
      useEditorStore.getState().updateNode(NODE_ID, { name: 'FromOtherTab' });
    });
    expect(input().value).toBe('FromOtherTab');
  });

  it('does not commit while typing, then commits once on blur', () => {
    renderWithProviders(<Probe />);

    fireEvent.change(input(), { target: { value: 'Cu' } });
    fireEvent.change(input(), { target: { value: 'Cub' } });
    fireEvent.change(input(), { target: { value: 'Cubey' } });
    expect(sets).toEqual([]); // per-keystroke commits would ruin undo

    fireEvent.blur(input());
    expect(sets).toEqual([[NODE_ID, 'name', 'Cubey']]);
  });

  it('keeps the in-progress draft when a remote write lands mid-edit', () => {
    renderWithProviders(<Probe />);

    fireEvent.change(input(), { target: { value: 'MyEdit' } });
    act(() => {
      useEditorStore.getState().updateNode(NODE_ID, { name: 'TheirEdit' });
    });

    expect(input().value).toBe('MyEdit');

    fireEvent.blur(input());
    expect(sets).toEqual([[NODE_ID, 'name', 'MyEdit']]);
  });

  it('skips the commit when the value is unchanged', () => {
    renderWithProviders(<Probe />);

    fireEvent.change(input(), { target: { value: 'Cube' } });
    fireEvent.blur(input());

    expect(sets).toEqual([]);
  });

  it('drops a stale draft when the binding is repointed at another node', () => {
    const { rerender } = renderWithProviders(<Probe />);
    fireEvent.change(input(), { target: { value: 'Draft' } });

    act(() => {
      useEditorStore.setState({
        nodes: [node(), node({ id: 'node-2', name: 'Sphere' })],
      });
    });
    rerender(<Probe id="node-2" />);

    expect(input().value).toBe('Sphere');
  });
});
