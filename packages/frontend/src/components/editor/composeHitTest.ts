import type { ComposeLayerRecord } from '../../store/editorStore';

/** Module-level handle installed by ComposeView so the cycle/capture helpers
 *  can resolve the viewport's current bounding rect without prop-drilling. */
export const composeViewportRect: { current: (() => DOMRect | null) | null } = {
  current: null,
};

/** Resolve a layer field to pixels, honoring a per-field '%' unit flag in
 *  config (percentage of the given basis — the parent box dimension). */
function toPx(
  value: number,
  config: Record<string, unknown>,
  unitKey: string,
  basis: number
): number {
  return config[unitKey] === '%' ? (value / 100) * basis : value;
}

/** A layer's resolved geometry within its parent's coordinate frame. */
export interface LayerFrame {
  /** Centre in viewport-local px. */
  cx: number;
  cy: number;
  /** Layer +x / +y axes (unit vectors) expressed in viewport space, carrying
   *  the accumulated rotation of this layer and all its ancestors. */
  ux: { x: number; y: number };
  uy: { x: number; y: number };
  /** Half-extents in px. */
  hx: number;
  hy: number;
  /** Accumulated rotation (radians) of this layer plus all ancestors. */
  angle: number;
}

/** The viewport itself, treated as the parent frame of root layers: top-left
 *  origin, no rotation, spanning the whole viewport. */
function viewportFrame(width: number, height: number): LayerFrame {
  return {
    cx: width / 2,
    cy: height / 2,
    ux: { x: 1, y: 0 },
    uy: { x: 0, y: 1 },
    hx: width / 2,
    hy: height / 2,
    angle: 0,
  };
}

/** Compose a layer's frame *within* a given parent frame. The layer's x/y/
 *  width/height (and % units) are interpreted relative to the parent box, its
 *  rotation is added on top of the parent's accumulated rotation, and the whole
 *  thing is projected into viewport space through the parent's axes. This is
 *  what makes nested layers position/rotate/size relative to their parent. */
function childFrame(parent: LayerFrame, layer: ComposeLayerRecord): LayerFrame {
  const cfg = layer.config;
  const pw = parent.hx * 2;
  const ph = parent.hy * 2;
  const x = toPx(layer.x, cfg, 'xUnit', pw);
  const y = toPx(layer.y, cfg, 'yUnit', ph);
  const w = toPx(layer.width, cfg, 'widthUnit', pw);
  const h = toPx(layer.height, cfg, 'heightUnit', ph);

  // Anchored offset → top-left within the parent box (origin at parent's
  // top-left corner, in the parent's un-rotated local coordinates).
  const left = layer.anchorH === 'left' ? x : pw - x - w;
  const top = layer.anchorV === 'top' ? y : ph - y - h;

  // Offset of this layer's centre from the parent's centre, in parent-local px.
  const ox = left + w / 2 - pw / 2;
  const oy = top + h / 2 - ph / 2;

  // Project that offset into viewport space through the parent's axes.
  const cx = parent.cx + parent.ux.x * ox + parent.uy.x * oy;
  const cy = parent.cy + parent.ux.y * ox + parent.uy.y * oy;

  const angle = parent.angle + (layer.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    cx,
    cy,
    ux: { x: cos, y: sin },
    uy: { x: -sin, y: cos },
    hx: w / 2,
    hy: h / 2,
    angle,
  };
}

/** Walk a layer's parent chain (root-most first), guarding against cycles and
 *  parents that aren't part of the provided lookup. */
function ancestorChain(
  layer: ComposeLayerRecord,
  byId: Map<string, ComposeLayerRecord>
): ComposeLayerRecord[] {
  const chain: ComposeLayerRecord[] = [];
  const seen = new Set<string>([layer.id]);
  let cur = layer.parentId ? byId.get(layer.parentId) : undefined;
  while (cur && !seen.has(cur.id)) {
    chain.push(cur);
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain.reverse();
}

/** The frame of the coordinate system a layer's x/y/width/height live in — its
 *  parent layer's composed frame, or the viewport for a root layer. Used by the
 *  gesture math to convert screen-space deltas into the layer's stored units. */
export function layerParentFrame(
  viewport: { width: number; height: number },
  layer: ComposeLayerRecord,
  byId?: Map<string, ComposeLayerRecord>
): LayerFrame {
  let frame = viewportFrame(viewport.width, viewport.height);
  if (byId) {
    for (const anc of ancestorChain(layer, byId))
      frame = childFrame(frame, anc);
  }
  return frame;
}

/** Project a layer's anchored rect into viewport-local coords, composing the
 *  full ancestor chain so nested layers report a frame relative to their
 *  parent. Returns the centre, half-extents, the layer's local axes
 *  (rotation-aware), and the accumulated rotation in viewport space. Shared by
 *  ComposeSelectionOverlay (which draws handles) and the compose hit-test
 *  (which decides which layer is under the cursor). */
export function layerFrame(
  viewport: { width: number; height: number },
  layer: ComposeLayerRecord,
  byId?: Map<string, ComposeLayerRecord>
): LayerFrame {
  return childFrame(layerParentFrame(viewport, layer, byId), layer);
}

/** Test whether a viewport-local point lies inside a layer's rotated rect.
 *  Hidden layers are never pickable. Note: 2D-locked layers ARE still reported
 *  here so that 3D picking inside a locked camera_view keeps working; the 2D
 *  lock is enforced at the layer-selection / drag sites instead. */
export function pointInLayer(
  viewport: { width: number; height: number },
  layer: ComposeLayerRecord,
  px: number,
  py: number,
  byId?: Map<string, ComposeLayerRecord>
): boolean {
  if (!layer.visible) return false;
  const f = layerFrame(viewport, layer, byId);
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
 *  to viewport-local. Nested layers are resolved relative to their parents. */
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
  const byId = new Map(layers.map((l) => [l.id, l] as const));
  // Sort ascending sceneOrder → smaller (more in front) first. Within the same
  // slot, larger cameraOrder paints last → also goes first in the result.
  const ordered = [...layers].sort(
    (a, b) => a.sceneOrder - b.sceneOrder || b.cameraOrder - a.cameraOrder
  );
  const out: string[] = [];
  const viewport = { width: viewportRect.width, height: viewportRect.height };
  for (const l of ordered) {
    if (pointInLayer(viewport, l, px, py, byId)) out.push(l.id);
  }
  return out;
}
