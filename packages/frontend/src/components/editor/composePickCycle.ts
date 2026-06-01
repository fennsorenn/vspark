import { useEditorStore } from '../../store/editorStore';
import { composeScenePick } from './ComposeSceneInteractions';
import { composeViewportRect, layersAtClientPoint } from './composeHitTest';

/** Cycle the active selection through every pickable under the cursor in
 *  front-to-back z-order, wrapping when the end is reached.
 *
 *  In the explicit compose model every layer (including `camera_view`) is a
 *  slot. A camera_view slot is special: it can resolve either to selecting the
 *  layer itself, or — if a 3D node inside it is under the cursor — to selecting
 *  that 3D node. So a camera_view contributes up to two stops in the cycle: its
 *  3D-node hit (front) and the layer itself (behind it).
 *
 *  Layers are hit-tested analytically (composeHitTest) rather than via
 *  `document.elementsFromPoint`, because layer wrappers are pointer-events:none.
 *  3D nodes are tested via the per-camera_view pickers registered by
 *  ComposeSceneInteractions. */
export function cyclePickAt(x: number, y: number): void {
  const rect = composeViewportRect.current?.();
  if (!rect) return;
  const store = useEditorStore.getState();

  // All layers in the active compose scene (no camera filter — camera_view is a
  // layer now).
  const visible = store.composeLayers.filter(
    (l) => l.rootComposeSceneId === store.activeComposeSceneId
  );

  // Front-to-back layer ids under the cursor.
  const layerIds = layersAtClientPoint(rect, visible, x, y);
  const layerById = new Map(visible.map((l) => [l.id, l]));

  // The 3D node under the cursor, if any (resolved across all camera_views).
  const hitNodeId = composeScenePick(x, y);

  // Build the slot list. For a camera_view layer that has a 3D node under the
  // cursor, emit a '3d' slot (front) then the 'layer' slot. Otherwise just the
  // 'layer' slot.
  type Slot =
    | { kind: 'layer'; id: string }
    | { kind: '3d'; nodeId: string; layerId: string };
  const slots: Slot[] = [];
  for (const id of layerIds) {
    const layer = layerById.get(id);
    // Locked-3D camera_views don't expose their 3D nodes to picking.
    if (
      layer?.kind === 'camera_view' &&
      hitNodeId &&
      layer.config.locked3d !== true
    ) {
      slots.push({ kind: '3d', nodeId: hitNodeId, layerId: id });
    }
    // 2D-locked layers can't be selected as a layer (but their 3D, above, can).
    if (layer?.config.locked !== true) {
      slots.push({ kind: 'layer', id });
    }
  }

  if (slots.length === 0) {
    // Nothing under the cursor — clear selection.
    store.selectComposeLayer(null);
    store.selectNode(null);
    return;
  }

  // Find the current selection's index in the cycle.
  let currentIdx = -1;
  if (store.selectedNodeId) {
    currentIdx = slots.findIndex(
      (s) => s.kind === '3d' && s.nodeId === store.selectedNodeId
    );
  }
  if (currentIdx < 0 && store.selectedComposeLayerId) {
    currentIdx = slots.findIndex(
      (s) => s.kind === 'layer' && s.id === store.selectedComposeLayerId
    );
  }

  const n = slots.length;
  const start = currentIdx < 0 ? -1 : currentIdx;
  const next = slots[(start + 1 + n) % n];
  if (next.kind === 'layer') {
    store.selectComposeLayer(next.id);
    store.selectNode(null);
  } else {
    store.selectComposeLayer(null);
    store.selectNode(next.nodeId);
  }
}
