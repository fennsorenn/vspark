import type { ComposeLayerRecord } from '../../store/editorStore';

/** Module-level handle installed by ComposeView so the cycle/capture helpers
 *  can resolve the viewport's current bounding rect without prop-drilling. */
export const composeViewportRect: { current: (() => DOMRect | null) | null } = {
  current: null,
};

/** Project a layer's CSS-anchored rect into viewport-local coords. Returns the
 *  centre, half-extents, and the layer's local axes (rotation-aware) in
 *  viewport space. Shared by ComposeSelectionOverlay (which draws handles) and
 *  the compose hit-test (which decides which layer is under the cursor). */
export function layerFrame(
  viewport: { width: number; height: number },
  layer: ComposeLayerRecord
) {
  const left =
    layer.anchorH === 'left' ? layer.x : viewport.width - layer.x - layer.width;
  const top =
    layer.anchorV === 'top'
      ? layer.y
      : viewport.height - layer.y - layer.height;
  const cx = left + layer.width / 2;
  const cy = top + layer.height / 2;
  const rad = (layer.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // layer +x and +y axes expressed in viewport space
  const ux = { x: cos, y: sin };
  const uy = { x: -sin, y: cos };
  const hx = layer.width / 2;
  const hy = layer.height / 2;
  return { cx, cy, ux, uy, hx, hy };
}

/** Test whether a viewport-local point lies inside a layer's rotated rect. */
export function pointInLayer(
  viewport: { width: number; height: number },
  layer: ComposeLayerRecord,
  px: number,
  py: number
): boolean {
  if (!layer.visible) return false;
  const f = layerFrame(viewport, layer);
  const dx = px - f.cx;
  const dy = py - f.cy;
  // Project onto local axes (which are unit vectors), then test against half-extents.
  const lx = dx * f.ux.x + dy * f.ux.y;
  const ly = dx * f.uy.x + dy * f.uy.y;
  return Math.abs(lx) <= f.hx && Math.abs(ly) <= f.hy;
}

/** Front-to-back-painter-order list of layer ids whose visible rect contains
 *  the client-space point (cx, cy). Front = smaller sceneOrder (drawn last).
 *  Caller provides the viewport's bounding rect so we can convert client coords
 *  to viewport-local. */
export function layersAtClientPoint(
  viewportRect: DOMRect,
  layers: ComposeLayerRecord[],
  cx: number,
  cy: number
): string[] {
  const px = cx - viewportRect.left;
  const py = cy - viewportRect.top;
  if (px < 0 || py < 0 || px > viewportRect.width || py > viewportRect.height)
    return [];
  // Sort ascending sceneOrder → smaller (more in front) first. Within the same
  // slot, larger cameraOrder paints last → also goes first in the result.
  const ordered = [...layers].sort(
    (a, b) => a.sceneOrder - b.sceneOrder || b.cameraOrder - a.cameraOrder
  );
  const out: string[] = [];
  const viewport = { width: viewportRect.width, height: viewportRect.height };
  for (const l of ordered) {
    if (pointInLayer(viewport, l, px, py)) out.push(l.id);
  }
  return out;
}
