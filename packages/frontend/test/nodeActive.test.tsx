/**
 * A node is active only while it and every node above it are visible
 * (components/editor/nodeActive.tsx). Hidden nodes skip their per-frame work
 * on it — a hidden Live2D model used to redraw every frame regardless.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { NodeActive, useNodeActive } from '../src/components/editor/nodeActive';

const tree =
  (...visible: boolean[]) =>
  ({ children }: { children: ReactNode }) =>
    visible.reduceRight<ReactNode>(
      (inner, v) => <NodeActive visible={v}>{inner}</NodeActive>,
      children
    );

describe('NodeActive', () => {
  it('is active outside any node and under visible ones', () => {
    expect(renderHook(() => useNodeActive()).result.current).toBe(true);
    expect(
      renderHook(() => useNodeActive(), { wrapper: tree(true, true) }).result
        .current
    ).toBe(true);
  });

  it('a hidden node deactivates itself and everything below it', () => {
    expect(
      renderHook(() => useNodeActive(), { wrapper: tree(true, false) }).result
        .current
    ).toBe(false);
    expect(
      renderHook(() => useNodeActive(), { wrapper: tree(false, true, true) })
        .result.current
    ).toBe(false);
  });
});
