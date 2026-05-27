import { useEditorStore } from '../../store/editorStore';
import { composeScenePicker } from './ComposeSceneInteractions';
import { composeViewportRect, layersAtClientPoint } from './composeHitTest';

/** Cycle the active selection through every pickable under the cursor in
 *  front-to-back z-order, wrapping when the end is reached. Treats the 3D
 *  scene as one more "slot" sitting at sceneOrder 0 (between layers with
 *  negative sceneOrder above it and positive sceneOrder behind).
 *
 *  Layers are hit-tested analytically (via composeHitTest) rather than via
 *  `document.elementsFromPoint`, because layer wrappers are pointer-events:none
 *  and would not appear in the DOM hit-test result. The 3D scene is tested via
 *  the in-canvas picker installed by ComposeSceneInteractions.
 *
 *  Shared by the layer chrome and the capture overlay so click-cycling feels
 *  identical from either start. */
export function cyclePickAt(x: number, y: number): void {
  const rect = composeViewportRect.current?.();
  if (!rect) return;
  const store = useEditorStore.getState();

  // Active-camera layers only — same filter ComposeView uses for rendering.
  const visible = store.composeLayers.filter(
    (l) =>
      l.rootComposeSceneId === store.activeComposeSceneId &&
      (l.cameraNodeId == null || l.cameraNodeId === store.composeCameraId)
  );
  const frontLayers = visible.filter((l) => l.sceneOrder <= 0);
  const backLayers = visible.filter((l) => l.sceneOrder > 0);

  // Front-to-back slot list: front layers (top-of-list first), 3D slot, back layers.
  const slots: Array<{ kind: 'layer'; id: string } | { kind: '3d' }> = [];
  for (const id of layersAtClientPoint(rect, frontLayers, x, y))
    slots.push({ kind: 'layer', id });
  slots.push({ kind: '3d' });
  for (const id of layersAtClientPoint(rect, backLayers, x, y))
    slots.push({ kind: 'layer', id });

  const debug = (window as unknown as { __composeCycleDebug?: boolean })
    .__composeCycleDebug;
  if (debug) {
    // eslint-disable-next-line no-console
    console.group('[compose cycle]');
    console.log(
      'slots',
      slots
        .map((s) => (s.kind === 'layer' ? `L:${s.id.slice(0, 6)}` : '3D'))
        .join(' → ')
    );
    console.log('picker result:', composeScenePicker.current?.(x, y));
    console.log(
      'selectedLayer',
      store.selectedComposeLayerId?.slice(0, 6),
      'selectedNode',
      store.selectedNodeId?.slice(0, 6)
    );
  }

  // Find the current selection's index in the cycle.
  let currentIdx = -1;
  if (store.selectedComposeLayerId) {
    currentIdx = slots.findIndex(
      (s) => s.kind === 'layer' && s.id === store.selectedComposeLayerId
    );
  }
  if (currentIdx < 0 && store.selectedNodeId) {
    const idx3d = slots.findIndex((s) => s.kind === '3d');
    if (
      idx3d >= 0 &&
      composeScenePicker.current?.(x, y) === store.selectedNodeId
    )
      currentIdx = idx3d;
  }

  const n = slots.length;
  const start = currentIdx < 0 ? -1 : currentIdx;
  for (let step = 1; step <= n; step++) {
    const next = slots[(start + step + n) % n];
    if (next.kind === 'layer') {
      if (store.selectedComposeLayerId === next.id && step < n) {
        if (debug) console.log('skip own layer');
        continue;
      }
      if (debug) {
        console.log('→ layer', next.id.slice(0, 6));
        console.groupEnd();
      }
      store.selectComposeLayer(next.id);
      store.selectNode(null);
      return;
    }
    const hitNodeId = composeScenePicker.current?.(x, y) ?? null;
    if (!hitNodeId) {
      if (debug) console.log('skip 3d (no hit)');
      continue;
    }
    const startedOn3d = slots[start]?.kind === '3d';
    if (startedOn3d && store.selectedNodeId === hitNodeId && step < n) {
      if (debug) console.log('skip own 3d');
      continue;
    }
    if (debug) {
      console.log('→ 3d', hitNodeId.slice(0, 6));
      console.groupEnd();
    }
    store.selectComposeLayer(null);
    store.selectNode(hitNodeId);
    return;
  }
  if (debug) console.groupEnd();
}
