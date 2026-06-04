import type { ComposeLayerRecord } from '../../store/editorStore';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import { sendComposeLayerPreview } from '../../hooks/useWsSync';

const PREVIEW_INTERVAL_MS = 33; // ~30 Hz cap on outgoing layer previews

/** Suppress any active clip override on the given layer params so a manual
 *  gesture's value isn't masked by a paused/playing clip — same precedence the
 *  properties-panel edits use (manual edit overrules a paused clip). */
function suppressLayerParams(layerId: string, params: string[]): void {
  const store = useEditorStore.getState();
  for (const p of params) store.suppressOverride('compose_layer', layerId, p);
}

/** Throttled preview emitter scoped to a single gesture. */
function makePreviewEmitter(id: string) {
  let last = 0;
  return (patch: Partial<ComposeLayerRecord>) => {
    const now = performance.now();
    if (now - last < PREVIEW_INTERVAL_MS) return;
    last = now;
    sendComposeLayerPreview(id, patch as Record<string, unknown>);
  };
}

/** Sign multipliers so that "dragging towards the bottom-right of the screen"
 *  always increases width/height, regardless of which corner the layer is anchored to.
 *  For position: positive offset means "away from the anchored edge". */
function anchorSigns(layer: ComposeLayerRecord): { sx: number; sy: number } {
  return {
    sx: layer.anchorH === 'right' ? -1 : 1,
    sy: layer.anchorV === 'bottom' ? -1 : 1,
  };
}

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** The coordinate frame a layer's stored x/y/width/height live in — its parent
 *  layer's box (or the viewport, for a root layer). `width`/`height` are the
 *  parent box dimensions in px (the basis for '%' fields); `angle` is the
 *  parent's accumulated rotation in radians, used to map screen-space pointer
 *  deltas into the parent's (possibly rotated) local axes so nested layers
 *  drag/resize relative to their parent. */
export interface ComposeFrame {
  width: number;
  height: number;
  angle?: number;
}

/** Convert a screen-space px delta to the field's stored unit. */
function deltaInUnit(
  dPx: number,
  config: Record<string, unknown>,
  unitKey: string,
  basis: number
): number {
  return config[unitKey] === '%' && basis > 0 ? (dPx / basis) * 100 : dPx;
}

/** Start a drag-move gesture. Returns the live patch as the pointer moves;
 *  caller is expected to apply it locally (optimistic) and persist on done. */
export function startDrag(
  e:
    | PointerEvent
    | {
        clientX: number;
        clientY: number;
        pointerId?: number;
        preventDefault?: () => void;
      },
  layer: ComposeLayerRecord,
  apply: (patch: Partial<ComposeLayerRecord>) => void,
  frame?: ComposeFrame
) {
  if (layer.config.locked === true) return;
  suppressLayerParams(layer.id, ['x', 'y']);
  const start = { x: e.clientX, y: e.clientY, lx: layer.x, ly: layer.y };
  const { sx, sy } = anchorSigns(layer);
  const emit = makePreviewEmitter(layer.id);
  const fw = frame?.width ?? 0;
  const fh = frame?.height ?? 0;
  // Map screen-space deltas into the parent's local axes so a layer nested under
  // a rotated parent still tracks the cursor along the parent's orientation.
  const pa = frame?.angle ?? 0;
  const cosP = Math.cos(pa);
  const sinP = Math.sin(pa);
  let last: Partial<ComposeLayerRecord> | null = null;

  const move = (ev: PointerEvent) => {
    const dxs = ev.clientX - start.x;
    const dys = ev.clientY - start.y;
    const dx = cosP * dxs + sinP * dys;
    const dy = -sinP * dxs + cosP * dys;
    last = {
      x: start.lx + deltaInUnit(dx * sx, layer.config, 'xUnit', fw),
      y: start.ly + deltaInUnit(dy * sy, layer.config, 'yUnit', fh),
    };
    apply(last);
    emit(last);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (last) api.updateComposeLayer(layer.id, last).catch(() => {});
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Start a resize gesture from a specific edge/corner. */
export function startResize(
  e: PointerEvent | { clientX: number; clientY: number },
  layer: ComposeLayerRecord,
  edge: ResizeEdge,
  apply: (patch: Partial<ComposeLayerRecord>) => void,
  frame?: ComposeFrame
) {
  if (layer.config.locked === true) return;
  suppressLayerParams(layer.id, ['x', 'y']);
  const fw = frame?.width ?? 0;
  const fh = frame?.height ?? 0;
  const wUnit = (d: number) => deltaInUnit(d, layer.config, 'widthUnit', fw);
  const hUnit = (d: number) => deltaInUnit(d, layer.config, 'heightUnit', fh);
  const xUnit = (d: number) => deltaInUnit(d, layer.config, 'xUnit', fw);
  const yUnit = (d: number) => deltaInUnit(d, layer.config, 'yUnit', fh);
  const start = {
    x: e.clientX,
    y: e.clientY,
    lx: layer.x,
    ly: layer.y,
    w: layer.width,
    h: layer.height,
  };
  const emit = makePreviewEmitter(layer.id);
  // Which directions does this edge stretch in?
  const touchesWest = edge.includes('w');
  const touchesEast = edge.includes('e');
  const touchesNorth = edge.includes('n');
  const touchesSouth = edge.includes('s');
  let last: Partial<ComposeLayerRecord> | null = null;

  // Project screen-space deltas onto the layer's local axes so rotated layers
  // resize along their own edges. The layer's orientation in screen space is its
  // own rotation plus the parent's accumulated rotation. Anchor-aware position
  // adjustment ensures that dragging the far edge from the anchor leaves the
  // anchored edge pinned. (For rotated layers we don't fully compensate the
  // centre shift, so the layer grows from its centre rather than its opposite
  // edge — acceptable for v1.)
  const rad = (frame?.angle ?? 0) + (layer.rotation * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  // Only the axis-aligned case can pin the anchored edge while moving the near
  // edge; once the layer (or any ancestor) is rotated we grow from the centre.
  const axisAligned = Math.abs(rad) < 1e-6;

  const move = (ev: PointerEvent) => {
    const dxs = ev.clientX - start.x;
    const dys = ev.clientY - start.y;
    const dxl = cosR * dxs + sinR * dys;
    const dyl = -sinR * dxs + cosR * dys;
    const patch: Partial<ComposeLayerRecord> = {};

    // Horizontal
    if (touchesEast) {
      // East = visual right edge. anchorH=left → far edge, grows by dxl.
      // anchorH=right → anchored edge, ideally no-op (we just no-op here).
      if (layer.anchorH === 'left') {
        patch.width = Math.max(0, start.w + wUnit(dxl));
      }
    } else if (touchesWest) {
      // West = visual left edge. anchorH=left → near edge, width shrinks/grows AND x shifts.
      // anchorH=right → far edge, grows by -dxl.
      if (layer.anchorH === 'right') {
        patch.width = Math.max(0, start.w - wUnit(dxl));
      } else if (axisAligned) {
        patch.width = Math.max(0, start.w - wUnit(dxs));
        patch.x = start.lx + xUnit(dxs);
      }
    }

    // Vertical
    if (touchesSouth) {
      if (layer.anchorV === 'top') {
        patch.height = Math.max(0, start.h + hUnit(dyl));
      }
    } else if (touchesNorth) {
      if (layer.anchorV === 'bottom') {
        patch.height = Math.max(0, start.h - hUnit(dyl));
      } else if (axisAligned) {
        patch.height = Math.max(0, start.h - hUnit(dys));
        patch.y = start.ly + yUnit(dys);
      }
    }

    last = patch;
    apply(patch);
    emit(patch);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (last) api.updateComposeLayer(layer.id, last).catch(() => {});
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Start a rotation gesture. Rotation is measured in degrees clockwise around the layer center.
 *  `centre` is the layer centre in screen-client coords. */
export function startRotate(
  e: PointerEvent | { clientX: number; clientY: number },
  layer: ComposeLayerRecord,
  centre: { x: number; y: number },
  apply: (patch: Partial<ComposeLayerRecord>) => void
) {
  if (layer.config.locked === true) return;
  suppressLayerParams(layer.id, ['rotation']);
  const cx = centre.x;
  const cy = centre.y;
  const startAngle =
    (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  const startRotation = layer.rotation;
  const emit = makePreviewEmitter(layer.id);
  let last: Partial<ComposeLayerRecord> | null = null;

  const move = (ev: PointerEvent) => {
    const a = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI;
    let next = startRotation + (a - startAngle);
    // Normalize to (-180, 180]
    while (next > 180) next -= 360;
    while (next <= -180) next += 360;
    last = { rotation: Math.round(next * 10) / 10 };
    apply(last);
    emit(last);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (last) api.updateComposeLayer(layer.id, last).catch(() => {});
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
