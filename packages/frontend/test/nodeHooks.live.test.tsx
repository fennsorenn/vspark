/**
 * Scene-node lists stay still during a drag (mesh/nodes.ts). A transform
 * preview arrives one op per field every 33ms; recomputing the node list for
 * each re-rendered every reader — the whole editor — and made another tab's
 * drag show as a choppy, delayed slideshow. The lists skip those ops; the
 * moving node shows its live transform through `liveNodes`, per node.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MeshProvider } from '@vspark/mesh-react';
import { testPeer } from './helpers/mesh';
import { useSceneNode, useSceneNodes } from '../src/mesh/nodes';
import { useEditorStore } from '../src/store/editorStore';

const wrapper = ({ children }: { children: ReactNode }) => (
  <MeshProvider peer={testPeer()}>{children}</MeshProvider>
);
const col = () => testPeer().collection('scene_node');
const seed = () => {
  useEditorStore.setState({ projectId: 'p1', liveNodes: {} });
  col().create({ id: 's1', kind: 'scene', projectId: 'p1', name: 'S' });
  col().create({
    id: 'n1',
    kind: 'group',
    projectId: 'p1',
    rootSceneNodeId: 's1',
    parentId: null,
    name: 'N',
    components: { transform: { type: 'transform', x: 0 } },
  });
};

describe('scene node hooks during a drag', () => {
  it('a transform preview does not re-render the node list; a commit does', () => {
    seed();
    let renders = 0;
    renderHook(
      () => {
        renders++;
        return useSceneNodes();
      },
      { wrapper }
    );
    const before = renders;
    act(() => {
      for (let i = 1; i <= 9; i++)
        col().set('n1', 'components.transform.x', i, { channel: 'preview' });
    });
    expect(renders).toBe(before);
    act(() => {
      col().set('n1', 'name', 'Renamed');
    });
    expect(renders).toBeGreaterThan(before);
  });

  it('one node shows its live transform over the document', () => {
    seed();
    const { result } = renderHook(() => useSceneNode('n1'), { wrapper });
    expect((result.current?.components?.transform as { x: number }).x).toBe(0);
    act(() => useEditorStore.getState().setLiveNode('n1', { x: 4 }));
    expect((result.current?.components?.transform as { x: number }).x).toBe(4);
  });
});
