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
const state = { armed: true, docs: new Map<string, object>() };

const collection = {
  canWrite: () => state.armed,
  get: (id: string) => state.docs.get(id),
  set: (id: string, path: string, value: unknown) => {
    sets.push([id, path, value]);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
  update: (id: string, partial: object) => {
    updates.push([id, partial]);
    return { ack: Promise.resolve({ status: 'acked' }) };
  },
};

vi.mock('../src/mesh/peer', () => ({
  getMeshHandles: () => ({
    peer: {},
    serverPeerId: 'server',
    collections: { scene_node: collection },
  }),
}));

const updateNode = vi.fn(() => Promise.resolve({}));
vi.mock('../src/api/client', () => {
  const fn = (...a: unknown[]) => updateNode(...(a as []));
  // `updateNode` is exported both standalone and on the `api` object.
  return {
    updateNode: fn,
    api: { updateNode: fn },
    fireSignalEvent: vi.fn(),
    updateScene: vi.fn(),
  };
});

import {
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
