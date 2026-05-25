import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import { useEditorStore, type ComposeLayerRecord } from '../../store/editorStore'
import { startDrag, startResize, startRotate, type ResizeEdge } from './composeLayerInteractions'
import { cyclePickAt } from './composePickCycle'

interface ComposeSelectionOverlayProps {
  viewportRef: RefObject<HTMLElement>
  layer: ComposeLayerRecord
}

const HANDLE_SIZE = 10
const ROTATE_OFFSET = 28

/** Compute the layer's centre, axes, and half-extents in viewport-local pixel space.
 *  We project the layer's CSS-anchored rect onto the viewport rect so handles can
 *  follow rotation and arbitrary anchor corners without resorting to getBoundingClientRect. */
function layerFrame(viewport: DOMRect, layer: ComposeLayerRecord) {
  const left   = layer.anchorH === 'left'   ? layer.x : viewport.width  - layer.x - layer.width
  const top    = layer.anchorV === 'top'    ? layer.y : viewport.height - layer.y - layer.height
  const cx = left + layer.width / 2
  const cy = top + layer.height / 2
  const rad = (layer.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // Local axes in viewport space
  const ux = { x: cos,  y: sin }   // layer +x in viewport
  const uy = { x: -sin, y: cos }   // layer +y in viewport
  const hx = layer.width / 2
  const hy = layer.height / 2
  return { cx, cy, ux, uy, hx, hy }
}

function pointAt(f: ReturnType<typeof layerFrame>, sx: number, sy: number) {
  // sx, sy ∈ {-1, 0, 1} pick a corner/edge offset in layer-local axes
  return {
    x: f.cx + f.ux.x * sx * f.hx + f.uy.x * sy * f.hy,
    y: f.cy + f.ux.y * sx * f.hx + f.uy.y * sy * f.hy,
  }
}

const EDGE_OFFSETS: Record<ResizeEdge, [number, number]> = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1],
  w:  [-1,  0],            e:  [1,  0],
  sw: [-1,  1], s: [0,  1], se: [1,  1],
}

function cursorFor(edge: ResizeEdge): string {
  switch (edge) {
    case 'n': case 's': return 'ns-resize'
    case 'e': case 'w': return 'ew-resize'
    case 'ne': case 'sw': return 'nesw-resize'
    case 'nw': case 'se': return 'nwse-resize'
  }
}

export function ComposeSelectionOverlay({ viewportRef, layer }: ComposeSelectionOverlayProps) {
  const updateLayer = useEditorStore((s) => s.updateComposeLayerLocal)
  const [viewportRect, setViewportRect] = useState<DOMRect | null>(null)

  // Track the viewport rect (it can change with window resize / panel resize).
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => setViewportRect(el.getBoundingClientRect())
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('scroll', measure, true)
    return () => { ro.disconnect(); window.removeEventListener('scroll', measure, true) }
  }, [viewportRef])

  if (!viewportRect) return null

  const f = layerFrame(viewportRect, layer)
  const apply = (patch: Partial<ComposeLayerRecord>) => updateLayer(layer.id, patch)


  // Outline path (4 corners) for a polygon outline so we get rotated borders.
  const corners = [pointAt(f, -1, -1), pointAt(f, 1, -1), pointAt(f, 1, 1), pointAt(f, -1, 1)]

  // Containing div fills the viewport and is pointer-events: none so it never
  // intercepts clicks meant for layers. Individual chrome elements opt in.
  const baseStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 100,
    pointerEvents: 'none',
    overflow: 'visible',
  }

  // The draggable body covers the layer rect (axis-aligned). Easier than a rotated polygon
  // hit area for the common case; for high rotation, users can still grab edges/handles.
  // Position it as a rotated rect using transform so the body precisely overlays the layer.
  const bodyStyle: CSSProperties = {
    position: 'absolute',
    left: f.cx - f.hx,
    top: f.cy - f.hy,
    width: f.hx * 2,
    height: f.hy * 2,
    transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
    transformOrigin: 'center center',
    pointerEvents: 'auto',
    cursor: 'move',
    background: 'transparent',
  }

  const handleStyleAt = (pt: { x: number; y: number }, cursor: string, extra: CSSProperties = {}): CSSProperties => ({
    position: 'absolute',
    left: pt.x - HANDLE_SIZE / 2,
    top: pt.y - HANDLE_SIZE / 2,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: '#4a9eff',
    border: '1px solid #fff',
    borderRadius: 2,
    cursor,
    pointerEvents: 'auto',
    boxSizing: 'border-box',
    ...extra,
  })

  // Rotation handle sits ROTATE_OFFSET above the top edge midpoint, in layer-local space.
  const rotPos = {
    x: f.cx - f.uy.x * (f.hy + ROTATE_OFFSET),
    y: f.cy - f.uy.y * (f.hy + ROTATE_OFFSET),
  }
  const topMid = pointAt(f, 0, -1)

  return (
    <div style={baseStyle}>
      {/* SVG outline so rotation comes for free. */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
        <polygon
          points={corners.map((c) => `${c.x},${c.y}`).join(' ')}
          fill="none"
          stroke="#4a9eff"
          strokeWidth={1}
        />
        <line x1={topMid.x} y1={topMid.y} x2={rotPos.x} y2={rotPos.y} stroke="#4a9eff" strokeWidth={1} />
      </svg>

      {/* Drag body — distinguishes click vs drag by movement threshold. A click
          cycles selection through any layers stacked under the cursor (so the
          chrome doesn't trap the user on the front layer when several overlap). */}
      <div
        style={bodyStyle}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          const start = { x: e.clientX, y: e.clientY }
          let dragging = false
          const DRAG_THRESHOLD_PX = 3
          const onMove = (ev: PointerEvent) => {
            if (dragging) return
            const dx = ev.clientX - start.x
            const dy = ev.clientY - start.y
            if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
            dragging = true
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            // Start the real drag from the original press coords so the layer
            // doesn't jump by the threshold delta.
            startDrag({ clientX: start.x, clientY: start.y }, layer, apply)
          }
          const onUp = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            if (dragging) return
            cyclePickAt(start.x, start.y)
          }
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
        }}
      />

      {/* Resize handles */}
      {(Object.keys(EDGE_OFFSETS) as ResizeEdge[]).map((edge) => {
        const [sx, sy] = EDGE_OFFSETS[edge]
        const pt = pointAt(f, sx, sy)
        return (
          <div
            key={edge}
            style={handleStyleAt(pt, cursorFor(edge))}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault()
              e.stopPropagation()
              // startResize uses screen-space deltas and writes into width/height/x/y.
              // Pass a synthetic element representing the (non-rotated) layer rect so the
              // rotate-aware math in composeLayerInteractions can later upgrade if needed.
              startResize({ clientX: e.clientX, clientY: e.clientY }, layer, edge, apply)
            }}
          />
        )
      })}

      {/* Rotation handle (white circle) */}
      <div
        style={handleStyleAt(rotPos, 'grab', { background: '#fff', borderColor: '#4a9eff', borderRadius: '50%' })}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.stopPropagation()
          startRotate(
            { clientX: e.clientX, clientY: e.clientY },
            layer,
            { x: viewportRect.left + f.cx, y: viewportRect.top + f.cy },
            apply,
          )
        }}
      />
    </div>
  )
}
