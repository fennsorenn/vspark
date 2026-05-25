import type { ComposeLayerRecord } from '../../store/editorStore'
import { api } from '../../api/client'
import { sendComposeLayerPreview } from '../../hooks/useWsSync'

const PREVIEW_INTERVAL_MS = 33   // ~30 Hz cap on outgoing layer previews

/** Throttled preview emitter scoped to a single gesture. */
function makePreviewEmitter(id: string) {
  let last = 0
  return (patch: Partial<ComposeLayerRecord>) => {
    const now = performance.now()
    if (now - last < PREVIEW_INTERVAL_MS) return
    last = now
    sendComposeLayerPreview(id, patch as Record<string, unknown>)
  }
}

/** Sign multipliers so that "dragging towards the bottom-right of the screen"
 *  always increases width/height, regardless of which corner the layer is anchored to.
 *  For position: positive offset means "away from the anchored edge". */
function anchorSigns(layer: ComposeLayerRecord): { sx: number; sy: number } {
  return {
    sx: layer.anchorH === 'right'  ? -1 : 1,
    sy: layer.anchorV === 'bottom' ? -1 : 1,
  }
}

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Start a drag-move gesture. Returns the live patch as the pointer moves;
 *  caller is expected to apply it locally (optimistic) and persist on done. */
export function startDrag(
  e: PointerEvent | { clientX: number; clientY: number; pointerId?: number; preventDefault?: () => void },
  layer: ComposeLayerRecord,
  apply: (patch: Partial<ComposeLayerRecord>) => void,
) {
  const start = { x: e.clientX, y: e.clientY, lx: layer.x, ly: layer.y }
  const { sx, sy } = anchorSigns(layer)
  const emit = makePreviewEmitter(layer.id)
  let last: Partial<ComposeLayerRecord> | null = null

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - start.x
    const dy = ev.clientY - start.y
    last = { x: start.lx + dx * sx, y: start.ly + dy * sy }
    apply(last)
    emit(last)
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (last) api.updateComposeLayer(layer.id, last).catch(() => {})
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** Start a resize gesture from a specific edge/corner. */
export function startResize(
  e: PointerEvent | { clientX: number; clientY: number },
  layer: ComposeLayerRecord,
  edge: ResizeEdge,
  apply: (patch: Partial<ComposeLayerRecord>) => void,
) {
  const start = { x: e.clientX, y: e.clientY, lx: layer.x, ly: layer.y, w: layer.width, h: layer.height }
  const emit = makePreviewEmitter(layer.id)
  // Which directions does this edge stretch in?
  const touchesWest  = edge.includes('w')
  const touchesEast  = edge.includes('e')
  const touchesNorth = edge.includes('n')
  const touchesSouth = edge.includes('s')
  let last: Partial<ComposeLayerRecord> | null = null

  // Project screen-space deltas onto the layer's local axes so rotated layers
  // resize along their own edges. Anchor-aware position adjustment ensures that
  // dragging the far edge from the anchor leaves the anchored edge pinned.
  // (For rotated layers we don't fully compensate the centre shift, so the layer
  // grows from its centre rather than its opposite edge — acceptable for v1.)
  const rad = (layer.rotation * Math.PI) / 180
  const cosR = Math.cos(rad)
  const sinR = Math.sin(rad)

  const move = (ev: PointerEvent) => {
    const dxs = ev.clientX - start.x
    const dys = ev.clientY - start.y
    const dxl =  cosR * dxs + sinR * dys
    const dyl = -sinR * dxs + cosR * dys
    const patch: Partial<ComposeLayerRecord> = {}

    // Horizontal
    if (touchesEast) {
      // East = visual right edge. anchorH=left → far edge, grows by dxl.
      // anchorH=right → anchored edge, ideally no-op (we just no-op here).
      if (layer.anchorH === 'left') {
        patch.width = Math.max(8, start.w + dxl)
      }
    } else if (touchesWest) {
      // West = visual left edge. anchorH=left → near edge, width shrinks/grows AND x shifts.
      // anchorH=right → far edge, grows by -dxl.
      if (layer.anchorH === 'right') {
        patch.width = Math.max(8, start.w - dxl)
      } else if (layer.rotation === 0) {
        patch.width = Math.max(8, start.w - dxs)
        patch.x = start.lx + dxs
      }
    }

    // Vertical
    if (touchesSouth) {
      if (layer.anchorV === 'top') {
        patch.height = Math.max(8, start.h + dyl)
      }
    } else if (touchesNorth) {
      if (layer.anchorV === 'bottom') {
        patch.height = Math.max(8, start.h - dyl)
      } else if (layer.rotation === 0) {
        patch.height = Math.max(8, start.h - dys)
        patch.y = start.ly + dys
      }
    }

    last = patch
    apply(patch)
    emit(patch)
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (last) api.updateComposeLayer(layer.id, last).catch(() => {})
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** Start a rotation gesture. Rotation is measured in degrees clockwise around the layer center.
 *  `centre` is the layer centre in screen-client coords. */
export function startRotate(
  e: PointerEvent | { clientX: number; clientY: number },
  layer: ComposeLayerRecord,
  centre: { x: number; y: number },
  apply: (patch: Partial<ComposeLayerRecord>) => void,
) {
  const cx = centre.x
  const cy = centre.y
  const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI
  const startRotation = layer.rotation
  const emit = makePreviewEmitter(layer.id)
  let last: Partial<ComposeLayerRecord> | null = null

  const move = (ev: PointerEvent) => {
    const a = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI
    let next = startRotation + (a - startAngle)
    // Normalize to (-180, 180]
    while (next > 180) next -= 360
    while (next <= -180) next += 360
    last = { rotation: Math.round(next * 10) / 10 }
    apply(last)
    emit(last)
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (last) api.updateComposeLayer(layer.id, last).catch(() => {})
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
