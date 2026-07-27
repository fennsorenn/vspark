// Shared "active snap guides" signal. The drag gesture (composeLayerInteractions)
// publishes the guide lines it snapped to this frame; ComposeSelectionOverlay
// subscribes and draws them. Positions are in the dragged layer's PARENT-local
// pixel space (0..parentWidth for vertical lines, 0..parentHeight for
// horizontal), which is exactly the frame the overlay already computes.

export interface SnapGuides {
  /** Vertical guide lines at these parent-local x positions (px). */
  vx: number[];
  /** Horizontal guide lines at these parent-local y positions (px). */
  hy: number[];
}

const EMPTY: SnapGuides = { vx: [], hy: [] };
let current: SnapGuides = EMPTY;
const listeners = new Set<() => void>();

export function setSnapGuides(next: SnapGuides): void {
  // Collapse an empty update back to the shared EMPTY reference so a
  // useSyncExternalStore snapshot stays stable while idle.
  current = next.vx.length === 0 && next.hy.length === 0 ? EMPTY : next;
  for (const l of listeners) l();
}

export function clearSnapGuides(): void {
  if (current !== EMPTY) setSnapGuides(EMPTY);
}

export function getSnapGuides(): SnapGuides {
  return current;
}

export function subscribeSnapGuides(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
