import { useEffect, useRef, type RefObject } from 'react';
import {
  useEditorStore,
  type ComposeLayerRecord,
} from '../../store/editorStore';
import { startDrag } from './composeLayerInteractions';
import { cyclePickAt } from './composePickCycle';
import {
  composeSceneStartDrag,
  composeSceneApplyWheel,
} from './ComposeSceneInteractions';
import { composeViewportRect, layersAtClientPoint } from './composeHitTest';

const DRAG_THRESHOLD_PX = 3;

interface ComposeEventCaptureProps {
  /** The viewport container. The capture div fills its bounds. */
  viewportRef: RefObject<HTMLDivElement>;
}

/** A single full-viewport invisible div that captures every pointer and wheel
 *  event in the compose view and dispatches them deliberately:
 *
 *  - On pointerdown: distinguish click vs drag via threshold.
 *    - Click → cyclePickAt: walks every pickable under the cursor (front-to-back)
 *      via elementsFromPoint + the 3D-scene picker and cycles selection.
 *    - Drag → routes to the currently-selected target: a compose layer's drag/
 *      resize/rotate (handled by the selection chrome's gestures, started here
 *      by calling the same startDrag function), or a 3D node's viewport-plane
 *      drag via composeSceneStartDrag (dispatched across the per-camera_view
 *      interaction registry). If nothing's selected, the cycle picks the
 *      topmost slot and that becomes the drag target.
 *  - On wheel: forwards to composeSceneApplyWheel (3D dolly along cursor ray).
 *
 *  Lives above the canvas and layer DOM (which are all pointer-events:none) but
 *  below the selection chrome (which has its own precise handles for resize/
 *  rotate). The chrome's drag body is no longer needed for moves — drags from
 *  the capture overlay handle that. */
export function ComposeEventCapture({ viewportRef }: ComposeEventCaptureProps) {
  const captureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = captureRef.current;
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      let dragging = false;

      const onMove = (ev: PointerEvent) => {
        if (dragging) return;
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (
          Math.abs(dx) < DRAG_THRESHOLD_PX &&
          Math.abs(dy) < DRAG_THRESHOLD_PX
        )
          return;
        dragging = true;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        startDragOnCurrentTarget(start.x, start.y, start.pointerId);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (dragging) return;
        cyclePickAt(start.x, start.y);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    const onWheel = (ev: WheelEvent) => {
      const store = useEditorStore.getState();
      if (!store.selectedNodeId) return;
      // Don't dolly through a camera_view whose 3D interaction is locked.
      const topId = layerUnderCursor(ev.clientX, ev.clientY);
      const topLayer = topId
        ? store.composeLayers.find((l) => l.id === topId)
        : null;
      if (topLayer?.kind === 'camera_view' && topLayer.config.locked3d === true)
        return;
      ev.preventDefault();
      composeSceneApplyWheel(ev.deltaY, ev.clientX, ev.clientY);
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('wheel', onWheel);
    };
  }, [viewportRef]);

  return (
    <div
      ref={captureRef}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        background: 'transparent',
        cursor: 'default',
      }}
    />
  );
}

/** The current compose viewport pixel dimensions (for %↔px drag conversion). */
function viewportFrame(): { width: number; height: number } | undefined {
  const rect = composeViewportRect.current?.();
  return rect ? { width: rect.width, height: rect.height } : undefined;
}

/** Drag routing on the *current* selection at the moment the drag is detected.
 *
 *  Priority:
 *  1. If the cursor is over a camera_view layer AND a 3D node is selected,
 *     the drag manipulates that 3D node (in-border 3D editing).
 *  2. Else if a compose layer is selected, MOVE it — from anywhere in the
 *     viewport, including outside its own border or over empty space. This is
 *     what lets a camera_view layer be repositioned without its 3D interaction
 *     swallowing the drag: grab outside the 3D area and drag.
 *  3. Else if a 3D node is selected, drag it.
 *  4. Else cycle-pick the topmost slot under the cursor and drag that. */
function startDragOnCurrentTarget(x: number, y: number, pointerId: number) {
  const store = useEditorStore.getState();
  const topId = layerUnderCursor(x, y);
  const topLayer = topId
    ? store.composeLayers.find((l) => l.id === topId)
    : null;
  const overCameraView = topLayer?.kind === 'camera_view';
  const cameraView3dLocked =
    overCameraView && topLayer?.config.locked3d === true;

  // 1. 3D editing inside a camera_view (unless its 3D interaction is locked).
  if (overCameraView && !cameraView3dLocked && store.selectedNodeId) {
    if (composeSceneStartDrag(store.selectedNodeId, x, y, pointerId)) return;
  }

  // 2. Move the selected compose layer from anywhere.
  if (store.selectedComposeLayerId) {
    const layer = store.composeLayers.find(
      (l) => l.id === store.selectedComposeLayerId
    );
    if (layer) {
      const apply = (patch: Partial<ComposeLayerRecord>) =>
        store.updateComposeLayerLocal(layer.id, patch);
      startDrag(
        { clientX: x, clientY: y, pointerId },
        layer,
        apply,
        viewportFrame()
      );
      return;
    }
  }

  // 3. Drag the selected 3D node.
  if (store.selectedNodeId) {
    if (composeSceneStartDrag(store.selectedNodeId, x, y, pointerId)) return;
  }

  // 4. Nothing useful selected: cycle to pick the topmost slot, then drag it.
  cyclePickAt(x, y);
  const s2 = useEditorStore.getState();
  if (s2.selectedComposeLayerId) {
    const layer = s2.composeLayers.find(
      (l) => l.id === s2.selectedComposeLayerId
    );
    if (layer) {
      const apply = (patch: Partial<ComposeLayerRecord>) =>
        s2.updateComposeLayerLocal(layer.id, patch);
      startDrag(
        { clientX: x, clientY: y, pointerId },
        layer,
        apply,
        viewportFrame()
      );
    }
  } else if (s2.selectedNodeId) {
    composeSceneStartDrag(s2.selectedNodeId, x, y, pointerId);
  }
}

/** Return the id of the topmost compose layer at the given client coords. */
function layerUnderCursor(x: number, y: number): string | null {
  const rect = composeViewportRect.current?.();
  if (!rect) return null;
  const store = useEditorStore.getState();
  const visible = store.composeLayers.filter(
    (l) => l.rootComposeSceneId === store.activeComposeSceneId
  );
  const ids = layersAtClientPoint(rect, visible, x, y);
  return ids[0] ?? null;
}
