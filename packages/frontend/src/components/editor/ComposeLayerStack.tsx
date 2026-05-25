import { useRef, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore, type ComposeLayerRecord, type AssetFile } from '../../store/editorStore'
import { startDrag, startResize, startRotate, type ResizeEdge } from './composeLayerInteractions'

const SCENE_RENDER_SLOT = 0

interface ComposeLayerStackProps {
  layers: ComposeLayerRecord[]
  assets: AssetFile[]
  selectedId?: string | null
  /** Called when a layer is clicked. Provide to enable selection; omit for read-only viewer use. */
  onSelect?: (id: string | null) => void
  /** Render mode: 'editor' enables selection outlines + drag/resize/rotate handles;
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
    return <img src={url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit, display: 'block' }} />
  }
  if (layer.kind === 'video') {
    const url = resolveAssetUrl(layer, assets)
    if (!url) return <Placeholder text="no video" />
    return <video src={url} autoPlay muted loop playsInline style={{ width: '100%', height: '100%', objectFit, display: 'block' }} />
  }
  const url = (layer.config.url as string | undefined) ?? ''
  if (!url) return <Placeholder text="no URL" />
  return <iframe src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} title={layer.name} />
}

function Placeholder({ text }: { text: string }) {
  return <div style={{ width: '100%', height: '100%', background: '#222', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 11 }}>{text}</div>
}

const HANDLE_SIZE = 8
const handleBase: CSSProperties = {
  position: 'absolute',
  width: HANDLE_SIZE,
  height: HANDLE_SIZE,
  background: '#4a9eff',
  border: '1px solid #fff',
  borderRadius: 2,
  pointerEvents: 'auto',
}

function handleStyle(edge: ResizeEdge): CSSProperties {
  const half = HANDLE_SIZE / 2
  const s: CSSProperties = { ...handleBase, cursor: cursorFor(edge) }
  if (edge.includes('n')) s.top = -half
  if (edge.includes('s')) s.bottom = -half
  if (edge.includes('w')) s.left = -half
  if (edge.includes('e')) s.right = -half
  if (edge === 'n' || edge === 's') { s.left = `calc(50% - ${half}px)` }
  if (edge === 'e' || edge === 'w') { s.top  = `calc(50% - ${half}px)` }
  return s
}

function cursorFor(edge: ResizeEdge): string {
  switch (edge) {
    case 'n': case 's': return 'ns-resize'
    case 'e': case 'w': return 'ew-resize'
    case 'ne': case 'sw': return 'nesw-resize'
    case 'nw': case 'se': return 'nwse-resize'
  }
}

const ALL_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function LayerView({
  layer, assets, selected, interactive, onSelect,
}: {
  layer: ComposeLayerRecord
  assets: AssetFile[]
  selected: boolean
  interactive: boolean
  onSelect?: (id: string | null) => void
}) {
  const updateLayer = useEditorStore((s) => s.updateComposeLayerLocal)
  const wrapRef = useRef<HTMLDivElement>(null)

  const apply = (patch: Partial<ComposeLayerRecord>) => updateLayer(layer.id, patch)

  // For browser layers in editor mode, only enable pointer events on the iframe while selected
  // (so dragging the layer body still works when unselected).
  const allowChildPointer = interactive && (layer.kind !== 'browser' || selected)

  const onPointerDownBody = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    if (!selected) { onSelect?.(layer.id); return }
    if (e.button !== 0) return
    // Drag-move
    e.preventDefault()
    e.stopPropagation()
    startDrag({ clientX: e.clientX, clientY: e.clientY }, layer, apply)
  }

  return (
    <div
      ref={wrapRef}
      style={{
        ...layerStyle(layer),
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: interactive ? (selected ? 'move' : 'pointer') : 'default',
        outline: selected ? '1px solid #4a9eff' : 'none',
      }}
      onPointerDown={onPointerDownBody}
      onClick={(e) => { if (interactive) e.stopPropagation() }}
    >
      <div style={{ width: '100%', height: '100%', pointerEvents: allowChildPointer ? 'auto' : 'none', overflow: 'hidden' }}>
        <LayerContent layer={layer} assets={assets} />
      </div>
      {selected && interactive && (
        <>
          {ALL_EDGES.map((edge) => (
            <div
              key={edge}
              style={handleStyle(edge)}
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                startResize({ clientX: e.clientX, clientY: e.clientY }, layer, edge, apply)
              }}
            />
          ))}
          {/* Rotation handle */}
          <div
            style={{
              position: 'absolute',
              top: -28,
              left: `calc(50% - ${HANDLE_SIZE / 2}px)`,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              background: '#fff',
              border: '1px solid #4a9eff',
              borderRadius: '50%',
              cursor: 'grab',
              pointerEvents: 'auto',
            }}
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (wrapRef.current) startRotate({ clientX: e.clientX, clientY: e.clientY, currentTarget: e.currentTarget as Element }, layer, wrapRef.current, apply)
            }}
          />
          {/* Tether line from rotation handle to layer top edge */}
          <div style={{
            position: 'absolute',
            top: -20,
            left: '50%',
            width: 1,
            height: 20,
            background: '#4a9eff',
            pointerEvents: 'none',
          }} />
        </>
      )}
    </div>
  )
}

export function ComposeLayerStack({ layers, assets, selectedId, onSelect, mode }: ComposeLayerStackProps) {
  const behind = layers
    .filter((l) => l.sceneOrder > SCENE_RENDER_SLOT)
    .sort((a, b) => b.sceneOrder - a.sceneOrder || a.cameraOrder - b.cameraOrder)
  const front = layers
    .filter((l) => l.sceneOrder <= SCENE_RENDER_SLOT)
    .sort((a, b) => b.sceneOrder - a.sceneOrder || a.cameraOrder - b.cameraOrder)

  const interactive = mode === 'editor'
  const handleClickBg = (e: MouseEvent) => {
    if (!interactive || !onSelect) return
    if (e.target === e.currentTarget) onSelect(null)
  }

  const renderLayer = (l: ComposeLayerRecord) => (
    <LayerView
      key={l.id}
      layer={l}
      assets={assets}
      selected={selectedId === l.id}
      interactive={interactive}
      onSelect={onSelect}
    />
  )

  return (
    <>
      {/* Behind the 3D canvas. Container is pointer-transparent so empty space falls through
          to the canvas (which is itself pointer-transparent in compose mode, letting clicks reach
          the front container below). Individual layers re-enable pointer events. */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
        {behind.map(renderLayer)}
      </div>
      {/* In front of the 3D canvas. Captures click-empty to deselect in editor mode. */}
      <div
        style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: interactive ? 'auto' : 'none' }}
        onClick={handleClickBg}
      >
        {front.map(renderLayer)}
      </div>
    </>
  )
}
