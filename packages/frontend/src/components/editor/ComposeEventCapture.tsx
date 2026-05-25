import { useEffect, useRef, type RefObject } from 'react'
import { useEditorStore, type ComposeLayerRecord } from '../../store/editorStore'
import { startDrag } from './composeLayerInteractions'
import { cyclePickAt } from './composePickCycle'
import { composeSceneDragStarter, composeSceneWheel } from './ComposeSceneInteractions'
import { composeViewportRect, layersAtClientPoint } from './composeHitTest'

const DRAG_THRESHOLD_PX = 3

interface ComposeEventCaptureProps {
  /** The viewport container. The capture div fills its bounds. */
  viewportRef: RefObject<HTMLDivElement>
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
 *      drag via composeSceneDragStarter. If nothing's selected, the cycle picks
 *      the topmost slot and that becomes the drag target.
 *  - On wheel: forwards to composeSceneWheel (3D dolly along cursor ray).
 *
 *  Lives above the canvas and layer DOM (which are all pointer-events:none) but
 *  below the selection chrome (which has its own precise handles for resize/
 *  rotate). The chrome's drag body is no longer needed for moves — drags from
 *  the capture overlay handle that. */
export function ComposeEventCapture({ viewportRef }: ComposeEventCaptureProps) {
  const captureRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = captureRef.current
    if (!el) return

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const start = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }
      let dragging = false

      const onMove = (ev: PointerEvent) => {
        if (dragging) return
        const dx = ev.clientX - start.x
        const dy = ev.clientY - start.y
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
        dragging = true
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        startDragOnCurrentTarget(start.x, start.y, start.pointerId)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (dragging) return
        cyclePickAt(start.x, start.y)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

    const onWheel = (ev: WheelEvent) => {
      const store = useEditorStore.getState()
      if (!store.selectedNodeId) return
      ev.preventDefault()
      composeSceneWheel.current?.(ev.deltaY, ev.clientX, ev.clientY)
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('wheel', onWheel)
    }
  }, [viewportRef])

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
  )
}

/** Drag routing on the *current* selection at the moment the drag is detected.
 *  If a 2D layer is selected and the cursor is over it, drag the layer.
 *  Otherwise drag the selected 3D node. If neither is selected, cycle to pick
 *  the topmost slot under the cursor and use that as the new selection + drag
 *  target — same model as the click path. */
function startDragOnCurrentTarget(x: number, y: number, pointerId: number) {
  const store = useEditorStore.getState()

  // Compose layer drag — uses the existing startDrag (move-only) flow.
  if (store.selectedComposeLayerId) {
    const layer = store.composeLayers.find((l) => l.id === store.selectedComposeLayerId)
    if (layer && layerUnderCursor(x, y) === layer.id) {
      const apply = (patch: Partial<ComposeLayerRecord>) => store.updateComposeLayerLocal(layer.id, patch)
      startDrag({ clientX: x, clientY: y, pointerId }, layer, apply)
      return
    }
  }

  // 3D node drag.
  if (store.selectedNodeId) {
    const started = composeSceneDragStarter.current?.(store.selectedNodeId, x, y, pointerId) ?? false
    if (started) return
  }

  // No useful selection: cycle (which selects the topmost slot under the
  // cursor), then drag that newly-selected target. We call cycle synchronously,
  // then re-evaluate via getState.
  cyclePickAt(x, y)
  const s2 = useEditorStore.getState()
  if (s2.selectedComposeLayerId) {
    const layer = s2.composeLayers.find((l) => l.id === s2.selectedComposeLayerId)
    if (layer) {
      const apply = (patch: Partial<ComposeLayerRecord>) => s2.updateComposeLayerLocal(layer.id, patch)
      startDrag({ clientX: x, clientY: y, pointerId }, layer, apply)
    }
  } else if (s2.selectedNodeId) {
    composeSceneDragStarter.current?.(s2.selectedNodeId, x, y, pointerId)
  }
}

/** Return the id of the topmost compose layer at the given client coords. */
function layerUnderCursor(x: number, y: number): string | null {
  const rect = composeViewportRect.current?.()
  if (!rect) return null
  const store = useEditorStore.getState()
  const visible = store.composeLayers.filter(
    (l) => l.sceneId === store.activeSceneId && (l.cameraNodeId == null || l.cameraNodeId === store.composeCameraId),
  )
  const ids = layersAtClientPoint(rect, visible, x, y)
  return ids[0] ?? null
}
