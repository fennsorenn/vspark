import type { CSSProperties } from 'react'
import { useEditorStore, type ComposeLayerRecord, type AssetFile } from '../../store/editorStore'
import { cyclePickAt } from './composePickCycle'
import { composeSceneDragStarter } from './ComposeSceneInteractions'

const SCENE_RENDER_SLOT = 0

interface ComposeLayerStackProps {
  layers: ComposeLayerRecord[]
  assets: AssetFile[]
  selectedId?: string | null
  /** Called when a layer is clicked. Provide to enable selection; omit for read-only viewer use. */
  onSelect?: (id: string | null) => void
  /** Render mode: 'editor' makes layers selection targets;
   *  'viewer' makes everything pointer-events:none for the streamed output. */
  mode: 'editor' | 'viewer'
}

function resolveAssetUrl(layer: ComposeLayerRecord, assets: AssetFile[]): string | null {
  if (!layer.assetId) return null
  const a = assets.find((x) => x.id === layer.assetId)
  return a?.url ?? null
}

function layerStyle(layer: ComposeLayerRecord): CSSProperties {
  const opacity = typeof layer.config.opacity === 'number' ? layer.config.opacity : 1
  const style: CSSProperties = {
    position: 'absolute',
    width: layer.width,
    height: layer.height,
    transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
    transformOrigin: 'center center',
    visibility: layer.visible ? 'visible' : 'hidden',
    opacity,
    overflow: 'hidden',
  }
  if (layer.anchorH === 'left')   style.left   = layer.x
  if (layer.anchorH === 'right')  style.right  = layer.x
  if (layer.anchorV === 'top')    style.top    = layer.y
  if (layer.anchorV === 'bottom') style.bottom = layer.y
  return style
}

function LayerContent({ layer, assets }: { layer: ComposeLayerRecord; assets: AssetFile[] }) {
  const objectFit = (layer.config.objectFit as CSSProperties['objectFit']) ?? 'cover'
  if (layer.kind === 'image') {
    const url = resolveAssetUrl(layer, assets)
    if (!url) return <Placeholder text="no image" />
    return <img src={url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit, display: 'block', pointerEvents: 'none' }} />
  }
  if (layer.kind === 'video') {
    const url = resolveAssetUrl(layer, assets)
    if (!url) return <Placeholder text="no video" />
    return <video src={url} autoPlay muted loop playsInline style={{ width: '100%', height: '100%', objectFit, display: 'block', pointerEvents: 'none' }} />
  }
  const url = (layer.config.url as string | undefined) ?? ''
  if (!url) return <Placeholder text="no URL" />
  // Iframes always swallow events when active. We keep them pointer-events:none
  // in editor mode so selection works; the streamed output (viewer mode) makes
  // them interactive only there.
  return <iframe src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" style={{ width: '100%', height: '100%', border: 'none', display: 'block', pointerEvents: 'none' }} title={layer.name} />
}

function Placeholder({ text }: { text: string }) {
  return <div style={{ width: '100%', height: '100%', background: '#222', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 11, pointerEvents: 'none' }}>{text}</div>
}

function LayerView({
  layer, assets, interactive, onSelect,
}: {
  layer: ComposeLayerRecord
  assets: AssetFile[]
  interactive: boolean
  onSelect?: (id: string | null) => void
}) {
  return (
    <div
      data-compose-layer-id={layer.id}
      style={{
        ...layerStyle(layer),
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: interactive ? 'pointer' : 'default',
      }}
      onPointerDown={(e) => {
        if (!interactive) return
        if (e.button !== 0) return
        e.stopPropagation()
        // Always run a click-vs-drag watcher and cycle on click. The cycle's
        // "nothing currently selected" path picks the topmost layer under the
        // cursor — same effect as a plain select — so this also handles the
        // first-click-on-an-unselected-layer case. Drags fall through; the
        // selection chrome (which floats above) owns the actual drag gesture.
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
          // Drag routing: if a 3D node is currently selected (and no layer is),
          // the drag should move that 3D node — even though the click landed on
          // this layer wrapper, the user picked the 3D via cycling and now wants
          // to drag it. Otherwise the drag belongs to this layer: select it if
          // needed and let the chrome's drag handler take over on subsequent moves.
          const store = useEditorStore.getState()
          if (!store.selectedComposeLayerId && store.selectedNodeId) {
            const started = composeSceneDragStarter.current?.(store.selectedNodeId, start.x, start.y, ev.pointerId) ?? false
            if (started) return
          }
          if (store.selectedComposeLayerId !== layer.id) onSelect?.(layer.id)
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
    >
      <LayerContent layer={layer} assets={assets} />
    </div>
  )
}

export function ComposeLayerStack({ layers, assets, selectedId: _selectedId, onSelect, mode }: ComposeLayerStackProps) {
  const behind = layers
    .filter((l) => l.sceneOrder > SCENE_RENDER_SLOT)
    .sort((a, b) => b.sceneOrder - a.sceneOrder || a.cameraOrder - b.cameraOrder)
  const front = layers
    .filter((l) => l.sceneOrder <= SCENE_RENDER_SLOT)
    .sort((a, b) => b.sceneOrder - a.sceneOrder || a.cameraOrder - b.cameraOrder)

  const interactive = mode === 'editor'

  const renderLayer = (l: ComposeLayerRecord) => (
    <LayerView
      key={l.id}
      layer={l}
      assets={assets}
      interactive={interactive}
      onSelect={onSelect}
    />
  )

  // Both containers stay pointer-transparent so empty space falls through to the
  // parent viewport (which handles click-to-deselect). Individual layer wrappers
  // re-enable pointer events on their own bounds. Selection chrome (handles,
  // outline, drag body) lives on a separate ComposeSelectionOverlay above both
  // layer groups and the 3D canvas, so it never gets occluded.
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
        {behind.map(renderLayer)}
      </div>
      <div style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}>
        {front.map(renderLayer)}
      </div>
    </>
  )
}
