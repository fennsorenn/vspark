import type { ComposeLayerRecord } from '../../store/editorStore';

/** Module-level handle installed by ComposeView so the cycle/capture helpers
 *  can resolve the viewport's current bounding rect without prop-drilling. */
export const composeViewportRect: { current: (() => DOMRect | null) | null } = {
  current: null,
};

/** Resolve a layer field to pixels, honoring a per-field '%' unit flag in
 *  config (percentage of the given viewport dimension). */
function toPx(
  value: number,
  config: Record<string, unknown>,
  unitKey: string,
  basis: number
): number {
  return config[unitKey] === '%' ? (value / 100) * basis : value;
}

/** A layer's px geometry within the viewport, resolving %/px units. */
export function layerPxGeometry(
  viewport: { width: number; height: number },
  layer: ComposeLayerRecord
) {
  const cfg = layer.config;
  return {
    x: toPx(layer.x, cfg, 'xUnit', viewport.width),
    y: toPx(layer.y, cfg, 'yUnit', viewport.height),
    width: toPx(layer.width, cfg, 'widthUnit', viewport.width),
    height: toPx(layer.height, cfg, 'heightUnit', viewport.height),
  };
}

/** Project a layer's CSS-anchored rect into viewport-local coords. Returns the
 *  centre, half-extents, and the layer's local axes (rotation-aware) in
 *  viewport space. Shared by ComposeSelectionOverlay (which draws handles) and
 *  the compose hit-test (which decides which layer is under the cursor). */
export function layerFrame(
  viewport: { width: number; height: number },
  layer: ComposeLayerRecord
) {
  const g = layerPxGeometry(viewport, layer);
  const left =
    layer.anchorH === 'left' ? g.x : viewport.width - g.x - g.width;
  const top = layer.anchorV === 'top' ? g.y : viewport.height - g.y - g.height;
  const cx = left + g.width / 2;
  const cy = top + g.height / 2;
  const rad = (layer.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // layer +x and +y axes expressed in viewport space
  const ux = { x: cos, y: sin };
  const uy = { x: -sin, y: cos };
  const hx = g.width / 2;
  const hy = g.height / 2;
  return { cx, cy, ux, uy, hx, hy };
}

/** Test whether a viewport-local point lies inside a layer's rotated rect.
 *  Hidden layers are never pickable. Note: 2D-locked layers ARE still reported
 *  here so that 3D picking inside a locked camera_view keeps working; the 2D
 *  lock is enforced at the layer-selection / drag sites instead. */
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
