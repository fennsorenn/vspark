/**
 * Compose layers read straight from the replica (mesh/compose.ts). The tab's
 * subscription spans the server, so the hooks keep to the open project — the
 * symptom without it was another project's compose scenes listed in this
 * project's Compose tree.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MeshProvider } from '@vspark/mesh-react';
import { testPeer } from './helpers/mesh';
import { useComposeLayers, useComposeScenes } from '../src/mesh/compose';
import { useEditorStore } from '../src/store/editorStore';

const wrapper = ({ children }: { children: ReactNode }) => (
  <MeshProvider peer={testPeer()}>{children}</MeshProvider>
);
const layerDoc = (id: string, projectId: string, kind = 'image') => ({
  id,
  projectId,
  kind,
  name: id,
  rootComposeSceneId: kind === 'compose_scene' ? null : 'cs-1',
  parentId: null,
  orderKey: 'a0',
});
const col = () => testPeer().collection('compose_layer');

describe('compose hooks', () => {
  it('list the open project only, layers and scenes apart', () => {
    useEditorStore.setState({ projectId: 'p1' });
    col().create(layerDoc('cs-1', 'p1', 'compose_scene'));
    col().create(layerDoc('l1', 'p1'));
    col().create(layerDoc('l2', 'other'));
    col().create(layerDoc('cs-2', 'other', 'compose_scene'));
    const layers = renderHook(() => useComposeLayers(), { wrapper });
    const scenes = renderHook(() => useComposeScenes(), { wrapper });
    expect(layers.result.current.map((l) => l.id)).toEqual(['l1']);
    expect(scenes.result.current.map((l) => l.id)).toEqual(['cs-1']);
  });

  it('show nothing while the project is still unknown', () => {
    useEditorStore.setState({ projectId: null });
    col().create(layerDoc('l1', 'p1'));
    const { result } = renderHook(() => useComposeLayers(), { wrapper });
    expect(result.current).toEqual([]);
  });

  it('follow edits live, and show a running gesture over the document', () => {
    useEditorStore.setState({ projectId: 'p1', liveLayers: {} });
    col().create({ ...layerDoc('l1', 'p1'), x: 0 });
    const { result } = renderHook(() => useComposeLayers(), { wrapper });
    act(() => {
      col().set('l1', 'name', 'renamed');
    });
    expect(result.current[0].name).toBe('renamed');
    act(() => useEditorStore.getState().setLiveLayer('l1', { x: 40 }));
    expect(result.current[0].x).toBe(40);
    act(() => useEditorStore.getState().setLiveLayer('l1', null));
    expect(result.current[0].x).toBe(0);
  });
});
