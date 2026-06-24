import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useProgress } from '@react-three/drei';

/**
 * Returns a style that keeps a 3D scene view hidden while its assets load and
 * its first frames settle, then fades it in once it's ready.
 *
 * Opening a scene otherwise shows the avatar(s) popping in one by one and
 * snapping around as the VRM loads and the first pose/animation frames apply.
 * We gate visibility on {@link useProgress} (backed by THREE's default loading
 * manager, which every GLTF/FBX loader here feeds): once loading has started
 * and finished, a short `settleMs` window lets the opening pose frames apply
 * off-screen before we fade in. If nothing ever registers as loading (empty
 * scene, or everything served from cache), a fallback timer reveals the view so
 * it can never stay hidden.
 *
 * Usable outside <Canvas> — `useProgress` reads a standalone store — so callers
 * spread the returned style onto the Canvas (or its wrapper).
 */
export function useSceneFadeIn(settleMs = 250): CSSProperties {
  const { active } = useProgress();
  const [ready, setReady] = useState(false);
  // Latches once the loading manager reports any in-flight work, so we can tell
  // "loading finished" apart from "nothing has started loading yet".
  const startedRef = useRef(false);

  useEffect(() => {
    if (active) startedRef.current = true;
  }, [active]);

  useEffect(() => {
    if (ready) return;
    if (startedRef.current) {
      // Loading started: reveal a beat after it finishes (active → false).
      if (!active) {
        const id = setTimeout(() => setReady(true), settleMs);
        return () => clearTimeout(id);
      }
      return; // still loading — hold
    }
    // Nothing has started loading; don't stay hidden forever.
    const fallback = setTimeout(() => setReady(true), 1500);
    return () => clearTimeout(fallback);
  }, [active, ready, settleMs]);

  return {
    opacity: ready ? 1 : 0,
    transition: 'opacity 400ms ease-in',
  };
}
