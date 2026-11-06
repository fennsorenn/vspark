/**
 * Runtime state read from the replica (mesh/runtime.ts): graph-driven
 * overrides, published data fields and server status — what the store used to
 * hold copies of.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MeshProvider } from '@vspark/mesh-react';
import { testPeer } from './helpers/mesh';
import {
  useDataFields,
  useRuntimeOverrides,
  useSceneNodeVisibleOverrides,
  useServerStatus,
  withLiveStatus,
} from '../src/mesh/runtime';

const wrapper = ({ children }: { children: ReactNode }) => (
  <MeshProvider peer={testPeer()}>{children}</MeshProvider>
);
const runtime = { channel: 'runtime' } as const;

describe('runtime hooks', () => {
  it('overrides: by param path for one target, cleared by removal', () => {
    const col = testPeer().collection('runtime_override');
    const { result } = renderHook(
      () => useRuntimeOverrides('compose_layer', 'l1'),
      { wrapper }
    );
    expect(result.current).toBeUndefined();
    act(() => {
      col.set(
        'compose_layer:l1:text.content',
        '',
        {
          id: 'compose_layer:l1:text.content',
          targetKind: 'compose_layer',
          targetId: 'l1',
          paramPath: 'text.content',
          value: 'live',
        },
        runtime
      );
    });
    expect(result.current).toEqual({ 'text.content': 'live' });
    act(() => {
      col.remove('compose_layer:l1:text.content', runtime);
    });
    expect(result.current).toBeUndefined();
  });

  it('scene-node visible overrides: one map by node id, other paths ignored', () => {
    const col = testPeer().collection('runtime_override');
    const { result } = renderHook(() => useSceneNodeVisibleOverrides(), {
      wrapper,
    });
    expect(result.current).toEqual({});
    act(() => {
      col.set(
        'scene_node:n1:visible',
        '',
        {
          id: 'scene_node:n1:visible',
          targetKind: 'scene_node',
          targetId: 'n1',
          paramPath: 'visible',
          value: false,
        },
        runtime
      );
      col.set(
        'scene_node:n1:position.x',
        '',
        {
          id: 'scene_node:n1:position.x',
          targetKind: 'scene_node',
          targetId: 'n1',
          paramPath: 'position.x',
          value: 2,
        },
        runtime
      );
      col.set(
        'compose_layer:l1:visible',
        '',
        {
          id: 'compose_layer:l1:visible',
          targetKind: 'compose_layer',
          targetId: 'l1',
          paramPath: 'visible',
          value: false,
        },
        runtime
      );
    });
    expect(result.current).toEqual({ n1: false });
    act(() => {
      col.remove('scene_node:n1:visible', runtime);
    });
    expect(result.current).toEqual({});
  });

  it('data fields: one scope at a time, global apart', () => {
    const col = testPeer().collection('data_field');
    act(() => {
      col.set(
        ':viewers',
        '',
        { id: ':viewers', scope: '', field: 'viewers', value: 7 },
        runtime
      );
      col.set(
        'l1:title',
        '',
        { id: 'l1:title', scope: 'l1', field: 'title', value: 'Hi' },
        runtime
      );
    });
    const global = renderHook(() => useDataFields(''), { wrapper });
    const own = renderHook(() => useDataFields('l1'), { wrapper });
    expect(global.result.current).toEqual({ viewers: 7 });
    expect(own.result.current).toEqual({ title: 'Hi' });
  });

  it('server status: one document, laid over a REST record', () => {
    act(() => {
      testPeer()
        .collection('server_status')
        .set(
          'obs_connection:c1',
          '',
          {
            id: 'obs_connection:c1',
            kind: 'obs_connection',
            key: 'c1',
            status: 'error',
            message: 'refused',
          },
          runtime
        );
    });
    const { result } = renderHook(
      () => useServerStatus('obs_connection', 'c1'),
      { wrapper }
    );
    const conn = withLiveStatus(
      {
        id: 'c1',
        status: 'disconnected',
        statusMessage: null as string | null,
      },
      result.current
    );
    expect(conn).toMatchObject({ status: 'error', statusMessage: 'refused' });
  });
});
