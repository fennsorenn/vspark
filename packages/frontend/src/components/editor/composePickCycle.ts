import { useEditorStore } from '../../store/editorStore'
import { composeScenePicker } from './ComposeSceneInteractions'

/** Cycle the active selection through every pickable under the cursor in
 *  front-to-back z-order, wrapping when the end is reached. The cycle treats
 *  the 3D scene as one more "layer" so the user can rotate selection between
 *  any overlapping 2D layers and any 3D node sitting between them.
 *
 *  Slots are gathered via `document.elementsFromPoint`, which returns elements
 *  in topmost-first order. 2D layers carry `data-compose-layer-id`; the canvas
 *  wrapper carries `data-compose-3d`. The 3D slot is only counted as a hit if
 *  the scene picker actually finds a node at the cursor — otherwise it's
 *  silently skipped (a click on empty 3D space doesn't disturb the cycle).
 *
 *  Shared by the layer selection chrome (ComposeSelectionOverlay), the per-
 *  layer pointerdown handler (ComposeLayerStack), and the 3D mesh pointerdown
 *  handler (ComposeSceneInteractions). Keeping a single implementation means
 *  click-cycling feels identical regardless of which thing started selected. */
export function cyclePickAt(x: number, y: number): void {
  const els = document.elementsFromPoint(x, y)
  const slots: Array<{ kind: 'layer'; id: string } | { kind: '3d' }> = []
  let seen3d = false
  const seenLayer = new Set<string>()
  for (const el of els) {
    const id = (el as HTMLElement).getAttribute?.('data-compose-layer-id')
    if (id) {
      if (!seenLayer.has(id)) { slots.push({ kind: 'layer', id }); seenLayer.add(id) }
      continue
    }
    if (!seen3d && (el as HTMLElement).hasAttribute?.('data-compose-3d')) {
      slots.push({ kind: '3d' })
      seen3d = true
    }
  }
  if (slots.length === 0) return

  const debug = (window as unknown as { __composeCycleDebug?: boolean }).__composeCycleDebug
  if (debug) {
    // eslint-disable-next-line no-console
    console.group('[compose cycle]')
    console.log('slots', slots.map((s) => s.kind === 'layer' ? `L:${s.id.slice(0, 6)}` : '3D').join(' → '))
    console.log('picker available?', !!composeScenePicker.current, 'picker result:', composeScenePicker.current?.(x, y))
  }

  const store = useEditorStore.getState()
  let currentIdx = -1
  if (store.selectedComposeLayerId) {
    currentIdx = slots.findIndex((s) => s.kind === 'layer' && s.id === store.selectedComposeLayerId)
  }
  if (currentIdx < 0 && store.selectedNodeId) {
    const idx3d = slots.findIndex((s) => s.kind === '3d')
    if (idx3d >= 0 && composeScenePicker.current?.(x, y) === store.selectedNodeId) {
      currentIdx = idx3d
    }
  }

  if (debug) console.log('currentIdx', currentIdx, 'selectedLayer', store.selectedComposeLayerId?.slice(0, 6), 'selectedNode', store.selectedNodeId?.slice(0, 6))

  const n = slots.length
  const start = currentIdx < 0 ? -1 : currentIdx
  for (let step = 1; step <= n; step++) {
    const next = slots[(start + step + n) % n]
    if (next.kind === 'layer') {
      if (store.selectedComposeLayerId === next.id && step < n) { if (debug) console.log('skip own layer', next.id.slice(0,6)); continue }
      if (debug) { console.log('→ layer', next.id.slice(0, 6)); console.groupEnd() }
      store.selectComposeLayer(next.id)
      return
    }
    const hitNodeId = composeScenePicker.current?.(x, y) ?? null
    if (!hitNodeId) { if (debug) console.log('skip 3d (no hit)'); continue }
    // Skip "no-op" advance only when the cycle started AT the 3D slot and we
    // just came full circle back to it (would otherwise re-select the same node).
    const startedOn3d = slots[start]?.kind === '3d'
    if (startedOn3d && store.selectedNodeId === hitNodeId && step < n) { if (debug) console.log('skip own 3d'); continue }
    if (debug) { console.log('→ 3d node', hitNodeId.slice(0, 6)); console.groupEnd() }
    store.selectComposeLayer(null)
    store.selectNode(hitNodeId)
    return
  }
  if (debug) console.groupEnd()
}
