/**
 * Scene-node writes and the node field binding, on the tab's peer — the store
 * the app reads (helpers/mesh.ts gives each test one). What these pin: an edit
 * addresses exactly its own path, an action is one undo step, a preview is an
 * overlay that never becomes model state, and a bound field commits once.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MeshProvider } from '@vspark/mesh-react';
import { testPeer, seedEditor } from './helpers/mesh';
import {
  commitNodeCreate,
  commitNodeDelete,
  commitNodeDeleteKeepChildren,
  commitNodePatch,
  commitNodePath,
  previewNodePath,
  previewNodeTransform,
} from '../src/mesh/writes';
import { useMeshField } from '../src/hooks/useMeshField';
import { useSceneNode } from '../src/mesh/nodes';
import { useEditorStore, type StageObject } from '../src/store/editorStore';

vi.mock('../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/client')>()),
  api: {
    updateNode: vi.fn(() => Promise.resolve({})),
    deleteNode: vi.fn(() => Promise.resolve({})),
  },
}));

type Node = StageObject & Record<string, unknown>;
const nodes = () => testPeer().collection<Node>('scene_node');
const node = (id: string, extra: Partial<StageObject> = {}): StageObject => ({
  id,
  rootSceneNodeId: 's1',
  projectId: 'p1',
  parentId: null,
  name: id,
  kind: 'group',
  components: {
    transform: { type: 'transform', x: 0, y: 0, z: 0, opacity: 1 },
  },
  ...extra,
});
const seed = (...ns: StageObject[]) =>
  seedEditor({ projectId: 'p1', nodes: ns });
const wrapper = ({ children }: { children: ReactNode }) => (
  <MeshProvider peer={testPeer()}>{children}</MeshProvider>
);

describe('commitNodePath / commitNodePatch', () => {
  it('writes the exact dotted path, leaving siblings alone; one undo step', () => {
    seed(node('n1'));
    commitNodePath('n1', 'components.transform.x', 5);
    const t = nodes().get('n1')!.components.transform as Record<string, number>;
    expect(t).toMatchObject({ x: 5, y: 0, opacity: 1 });
    testPeer().undo();
    expect(
      (nodes().get('n1')!.components.transform as Record<string, number>).x
    ).toBe(0);
  });

  it('sends a multi-field edit as one op, so one undo step reverts it', () => {
    seed(node('n1'), node('p'));
    commitNodePatch('n1', { name: 'Renamed', parentId: 'p' });
    expect(nodes().get('n1')).toMatchObject({ name: 'Renamed', parentId: 'p' });
    testPeer().undo();
    expect(nodes().get('n1')).toMatchObject({ name: 'n1', parentId: null });
  });

  it('routes a node projected from a placed object to REST (Phase 6)', async () => {
    const { api } = await import('../src/api/client');
    useEditorStore.setState({
      projectedNodes: [{ ...node('r1'), remote: true }],
    });
    commitNodePath('r1', 'name', 'X');
    expect(api.updateNode).toHaveBeenCalledWith('r1', { name: 'X' });
  });
});

describe('creating and deleting', () => {
  it('a created node is in the store at once; one undo removes it', async () => {
    useEditorStore.setState({ projectId: 'p1' });
    const made = await commitNodeCreate('s1', { name: 'New', kind: 'group' });
    expect(nodes().get(made.id)?.name).toBe('New');
    testPeer().undo();
    expect(nodes().get(made.id)).toBeUndefined();
  });

  it('deleting removes the whole subtree as one undo action', async () => {
    seed(
      node('a'),
      node('b', { parentId: 'a' }),
      node('c', { parentId: 'b' }),
      node('x')
    );
    expect(await commitNodeDelete('a')).toBe(true);
    expect(['a', 'b', 'c'].map((id) => nodes().get(id))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(nodes().get('x')).toBeDefined();
    testPeer().undo();
    expect(nodes().get('c')?.parentId).toBe('b');
  });

  it('delete-keep-children detaches the children and removes the node in one action', async () => {
    seed(node('a'), node('b', { parentId: 'a' }));
    expect(await commitNodeDeleteKeepChildren('a', null)).toBe(true);
    expect(nodes().get('a')).toBeUndefined();
    expect(nodes().get('b')?.parentId).toBeNull();
    testPeer().undo();
    expect(nodes().get('b')?.parentId).toBe('a');
    expect(nodes().get('a')).toBeDefined();
  });
});

describe('previews', () => {
  it('a field preview is an overlay: shown, not committed, not undoable', () => {
    seed(node('n1'));
    previewNodePath('n1', 'name', 'Half-typed');
    expect(nodes().get('n1')?.name).toBe('Half-typed');
    expect(nodes().replica.raw('n1')?.name).toBe('n1');
    expect(testPeer().canUndo()).toBe(false);
  });

  it('a transform preview writes one overlay per scalar, keeping the rest', () => {
    seed(node('n1'));
    previewNodeTransform('n1', { x: 3, y: 4 });
    const t = nodes().get('n1')!.components.transform as Record<string, number>;
    expect(t).toMatchObject({ x: 3, y: 4, z: 0, opacity: 1 });
  });

  it('writes nothing for a node the replica does not hold', () => {
    previewNodeTransform('ghost', { x: 1 });
    expect(nodes().get('ghost')).toBeUndefined();
  });
});

function NameField({ id }: { id: string }) {
  const f = useMeshField<string>(id, 'name', '');
  return <input aria-label="name" {...f.bind()} />;
}

describe('useMeshField', () => {
  it('shows the document value and follows later changes', () => {
    seed(node('n1'));
    render(<NameField id="n1" />, { wrapper });
    expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe(
      'n1'
    );
    act(() => {
      nodes().set('n1', 'name', 'Changed elsewhere');
    });
    expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe(
      'Changed elsewhere'
    );
  });

  it('commits once on blur, not per keystroke — one undo step', () => {
    seed(node('n1'));
    render(<NameField id="n1" />, { wrapper });
    const input = screen.getByLabelText('name');
    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.change(input, { target: { value: 'AB' } });
    expect(nodes().replica.raw('n1')?.name).toBe('n1');
    fireEvent.blur(input);
    expect(nodes().get('n1')?.name).toBe('AB');
    testPeer().undo();
    expect(nodes().get('n1')?.name).toBe('n1');
  });

  it('keeps the draft when another write lands mid-edit', () => {
    seed(node('n1'));
    render(<NameField id="n1" />, { wrapper });
    const input = screen.getByLabelText('name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Mine' } });
    act(() => {
      nodes().set('n1', 'name', 'Theirs');
    });
    expect(input.value).toBe('Mine');
  });

  it('skips the commit when the value is unchanged', () => {
    seed(node('n1'));
    render(<NameField id="n1" />, { wrapper });
    const input = screen.getByLabelText('name');
    fireEvent.change(input, { target: { value: 'n1' } });
    fireEvent.blur(input);
    expect(testPeer().canUndo()).toBe(false);
  });
});

describe('useSceneNode', () => {
  it('reads one node of the open project and re-renders when it changes', () => {
    seed(node('n1'));
    let seen: string | undefined;
    function Probe() {
      seen = useSceneNode('n1')?.name;
      return null;
    }
    render(<Probe />, { wrapper });
    expect(seen).toBe('n1');
    act(() => {
      nodes().set('n1', 'name', 'Renamed');
    });
    expect(seen).toBe('Renamed');
  });
});
