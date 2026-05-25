import type { ComposeLayerRecord } from '../../store/editorStore'
import { api } from '../../api/client'

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
  let last: Partial<ComposeLayerRecord> | null = null

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - start.x
    const dy = ev.clientY - start.y
    last = { x: start.lx + dx * sx, y: start.ly + dy * sy }
    apply(last)
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
  const { sx, sy } = anchorSigns(layer)
  // Which directions does this edge stretch in?
  const touchesWest  = edge.includes('w')
  const touchesEast  = edge.includes('e')
  const touchesNorth = edge.includes('n')
  const touchesSouth = edge.includes('s')
  let last: Partial<ComposeLayerRecord> | null = null

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - start.x
    const dy = ev.clientY - start.y
    const patch: Partial<ComposeLayerRecord> = {}
    // Horizontal
    if (touchesEast) {
      // Far edge from anchor when anchorH=left; near edge when anchorH=right.
      // anchorH=left:  east edge moves with cursor → width += dx
      // anchorH=right: east edge is the anchored side → width -= dx, x stays
      patch.width = Math.max(8, start.w + dx * sx)
    } else if (touchesWest) {
      // anchorH=left:  dragging west edge shrinks/grows width AND shifts x by dx
      // anchorH=right: west edge is the far edge → width += -dx (since sx=-1, dx*sx = -dx) — wait, careful:
      //   When anchorH=right, sx=-1. The visual "left edge" of the layer is the FAR side from the anchor.
      //   So dragging left edge to the left should grow width by -dx (no change to x).
      //   When anchorH=left, sx=+1. Dragging left edge to the left grows width by -dx and shifts x by dx.
      patch.width = Math.max(8, start.w - dx * sx)
      if (layer.anchorH === 'left')  patch.x = start.lx + dx
      // anchorH=right: x unchanged when resizing west edge.
    }
    // Vertical (mirror logic)
    if (touchesSouth) {
      patch.height = Math.max(8, start.h + dy * sy)
    } else if (touchesNorth) {
      patch.height = Math.max(8, start.h - dy * sy)
      if (layer.anchorV === 'top') patch.y = start.ly + dy
    }
    last = patch
    apply(patch)
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (last) api.updateComposeLayer(layer.id, last).catch(() => {})
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** Start a rotation gesture. Rotation is measured in degrees clockwise around the layer center. */
export function startRotate(
  e: PointerEvent | { clientX: number; clientY: number; currentTarget: Element },
  layer: ComposeLayerRecord,
  layerEl: HTMLElement,
  apply: (patch: Partial<ComposeLayerRecord>) => void,
) {
  const rect = layerEl.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI
  const startRotation = layer.rotation
  let last: Partial<ComposeLayerRecord> | null = null

  const move = (ev: PointerEvent) => {
    const a = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI
    let next = startRotation + (a - startAngle)
    // Normalize to (-180, 180]
    while (next > 180) next -= 360
    while (next <= -180) next += 360
    last = { rotation: Math.round(next * 10) / 10 }
    apply(last)
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (last) api.updateComposeLayer(layer.id, last).catch(() => {})
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
