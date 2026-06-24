/**
 * hooks.sceneFadeIn.test.ts — useSceneFadeIn fade-in gating
 *
 * The hook keeps a 3D scene view hidden (opacity 0) while assets load + the
 * first frames settle, then fades it in (opacity 1). Loading state comes from
 * drei's useProgress, which we mock here so we can drive `active` directly.
 */

import {
  vi,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from 'vitest';
import { renderHook, act } from './helpers/render';

// Controllable stand-in for drei's loading-manager-backed useProgress.
let progressActive = false;
vi.mock('@react-three/drei', () => ({
  useProgress: () => ({ active: progressActive }),
}));

import { useSceneFadeIn } from '../src/hooks/useSceneFadeIn';

describe('useSceneFadeIn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    progressActive = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts hidden (opacity 0) before anything is ready', () => {
    const { result } = renderHook(() => useSceneFadeIn());
    expect(result.current.opacity).toBe(0);
  });

  it('fades in a settle window after loading finishes', () => {
    progressActive = true;
    const { result, rerender } = renderHook(() => useSceneFadeIn(250));
    expect(result.current.opacity).toBe(0);

    // Loading completes.
    act(() => {
      progressActive = false;
      rerender();
    });
    // Still hidden until the settle window elapses.
    expect(result.current.opacity).toBe(0);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.opacity).toBe(1);
  });

  it('does not reveal while loading is still in flight', () => {
    progressActive = true;
    const { result } = renderHook(() => useSceneFadeIn(250));
    // Even past the no-load fallback window, an active load keeps it hidden.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.opacity).toBe(0);
  });

  it('reveals via fallback when nothing ever registers as loading', () => {
    const { result } = renderHook(() => useSceneFadeIn());
    expect(result.current.opacity).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.opacity).toBe(1);
  });

  it('carries a CSS opacity transition', () => {
    const { result } = renderHook(() => useSceneFadeIn());
    expect(String(result.current.transition)).toContain('opacity');
  });
});
