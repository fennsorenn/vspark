/**
 * Behaviors live in the tab's peer — the store the app reads — and so does a
 * receiver's tracking status, which therefore cannot outlive its behavior.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MeshProvider } from '@vspark/mesh-react';
import {
  commitBehaviorCreate,
  commitBehaviorDelete,
  commitBehaviorPatch,
} from '../src/mesh/behaviorWrites';
import { useNodeBehaviors, useTrackingStatuses } from '../src/mesh/hooks';
import { testPeer } from './helpers/mesh';
import type { Behavior } from '../src/store/editorStore';

const behaviors = () => testPeer().collection<Behavior>('behavior');
const wrapper = ({ children }: { children: ReactNode }) => (
  <MeshProvider peer={testPeer()}>{children}</MeshProvider>
);

describe('behavior writes', () => {
  it('a created behavior shows up on its node at once; one undo removes it', async () => {
    testPeer().collection('scene_node').create({ id: 'n1', name: 'Avatar' });
    const { result } = renderHook(() => useNodeBehaviors('n1'), { wrapper });
    const b = await commitBehaviorCreate('n1', { kind: 'breathing' });
    expect(behaviors().get(b.id)?.kind).toBe('breathing');
    expect(result.current.map((x) => x.id)).toEqual([b.id]);
    testPeer().undo();
    expect(behaviors().get(b.id)).toBeUndefined();
  });

  it('a config edit is one committed write, undone in one step', async () => {
    const b = await commitBehaviorCreate('n1', {
      kind: 'breathing',
      config: { rate: 1 },
    });
    commitBehaviorPatch(b.id, { config: { rate: 2 } });
    expect(behaviors().get(b.id)?.config).toEqual({ rate: 2 });
    testPeer().undo();
    expect(behaviors().get(b.id)?.config).toEqual({ rate: 1 });
  });

  it('deleting removes it; undo restores it', async () => {
    const b = await commitBehaviorCreate('n1', { kind: 'breathing' });
    expect(await commitBehaviorDelete(b.id)).toBe(true);
    expect(behaviors().get(b.id)).toBeUndefined();
    testPeer().undo();
    expect(behaviors().get(b.id)).toBeDefined();
  });
});

describe('tracking status', () => {
  it('follows the server_status document, and goes with it', () => {
    const status = testPeer().collection('server_status');
    const { result } = renderHook(() => useTrackingStatuses(), { wrapper });
    act(() => {
      status.set(
        'tracking:b1',
        '',
        {
          id: 'tracking:b1',
          kind: 'tracking',
          key: 'b1',
          connected: true,
          tracking: true,
        },
        { channel: 'runtime' }
      );
    });
    expect(result.current.b1).toMatchObject({
      connected: true,
      tracking: true,
    });
    // The server removes it with the behavior: no stale `tracking: true`.
    act(() => {
      status.remove('tracking:b1', { channel: 'runtime' });
    });
    expect(result.current.b1).toBeUndefined();
  });
});
