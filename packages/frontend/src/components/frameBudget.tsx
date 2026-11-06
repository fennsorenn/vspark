/**
 * One render loop for every R3F canvas on the page, with a frame budget.
 *
 * Rendering never takes more than `share` of the main thread: after a frame
 * whose rendering took `c` ms, the next one waits until `c / share` ms after
 * that frame started, skipping display refreshes as needed. A scene that fits
 * the budget renders every refresh, unchanged; one that does not drops to a
 * lower frame rate, and the time it leaves goes to everything else on the main
 * thread — incoming mesh messages, input, timers. Without it an overloaded
 * scene delivered another tab's drag previews in bursts, with stalls up to
 * ~1.7s (2026-10-04).
 *
 * The loop is page-wide, not per canvas: the editor shows the viewport and
 * compose camera views at once, and only their combined cost says how busy the
 * main thread is. Each canvas runs `frameloop="never"` and registers here
 * through `<FrameBudget />` while it is active.
 */
import { createContext, useContext, useEffect } from 'react';
import { advance, useThree } from '@react-three/fiber';

/** Share of the main thread rendering may take on this page. The output page
 *  (OBS) allows more: it has no editor UI to keep responsive. */
export const FrameBudgetContext = createContext(0.75);

/** Refreshes this close to the budget still render, so timing jitter does not
 *  skip frames a scene fits into. */
const TOLERANCE_MS = 1;

interface Entry {
  render: (timestamp: number, runGlobalEffects: boolean) => void;
  share: number;
}

const entries = new Set<Entry>();
let raf: number | null = null;
let nextAt = 0;

function tick(timestamp: number): void {
  raf = entries.size ? requestAnimationFrame(tick) : null;
  if (!entries.size || timestamp + TOLERANCE_MS < nextAt) return;
  const start = performance.now();
  let share = 1;
  let first = true;
  for (const e of entries) {
    // Global effects (R3F addEffect/addAfterEffect) once per frame, not once
    // per canvas.
    e.render(timestamp, first);
    first = false;
    share = Math.min(share, e.share);
  }
  const cost = performance.now() - start;
  nextAt = start + cost / share;
}

/** Render `render` in the shared loop until the returned function is called. */
export function registerFrame(
  render: Entry['render'],
  share: number
): () => void {
  const entry: Entry = { render, share };
  entries.add(entry);
  raf ??= requestAnimationFrame(tick);
  return () => {
    entries.delete(entry);
    if (!entries.size && raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  };
}

/**
 * rAF timestamp (ms) → the time `advance()` expects (seconds). With
 * `frameloop="never"`, R3F sets `clock.elapsedTime` to the value passed and
 * hands every `useFrame` `delta = value − previous`, so passing milliseconds
 * made every per-frame delta 1000× too large (~16.7 instead of ~0.0167): the
 * pose's One Euro filter stopped smoothing and Motion Snappiness overshot every
 * frame.
 */
export function toR3fTime(timestampMs: number): number {
  return timestampMs / 1000;
}

/** Put inside a `<Canvas frameloop="never">`: renders it in the shared,
 *  budgeted loop while `active`. */
export function FrameBudget({ active = true }: { active?: boolean }) {
  const get = useThree((s) => s.get);
  const share = useContext(FrameBudgetContext);
  useEffect(() => {
    if (!active) return;
    return registerFrame(
      (timestamp, runGlobalEffects) =>
        advance(toR3fTime(timestamp), runGlobalEffects, get()),
      share
    );
  }, [active, get, share]);
  return null;
}
