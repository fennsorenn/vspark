import type { CSSProperties, MouseEvent } from 'react'
import type { ComposeLayerRecord } from '../../store/editorStore'
import type { AssetFile } from '../../store/editorStore'

const SCENE_RENDER_SLOT = 0

interface ComposeLayerStackProps {
  layers: ComposeLayerRecord[]
  assets: AssetFile[]
  selectedId?: string | null
  /** Called when a layer is clicked. Provide to enable selection; omit for read-only viewer use. */
  onSelect?: (id: string | null) => void
  /** Render mode: 'editor' enables selection outlines and pointer events on iframes only when selected;
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
    if (!url) return <div style={{ width: '100%', height: '100%', background: '#222', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 11 }}>no image</div>
    return <img src={url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit, display: 'block' }} />
  }
  if (layer.kind === 'video') {
    const url = resolveAssetUrl(layer, assets)
    if (!url) return <div style={{ width: '100%', height: '100%', background: '#222', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 11 }}>no video</div>
    return <video src={url} autoPlay muted loop playsInline style={{ width: '100%', height: '100%', objectFit, display: 'block' }} />
  }
  // browser
  const url = (layer.config.url as string | undefined) ?? ''
  if (!url) return <div style={{ width: '100%', height: '100%', background: '#222', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 11 }}>no URL</div>
  return <iframe src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} title={layer.name} />
}

export function ComposeLayerStack({ layers, assets, selectedId, onSelect, mode }: ComposeLayerStackProps) {
  // Painter's algorithm: larger sceneOrder is further back (drawn first).
  // We split into "behind 3D" and "in front of 3D" so callers can sandwich the canvas.
  const behind = layers
    .filter((l) => l.sceneOrder > SCENE_RENDER_SLOT)
    .sort((a, b) => b.sceneOrder - a.sceneOrder || a.cameraOrder - b.cameraOrder)
  const front = layers
    .filter((l) => l.sceneOrder <= SCENE_RENDER_SLOT)
    .sort((a, b) => b.sceneOrder - a.sceneOrder || a.cameraOrder - b.cameraOrder)

  const handleClickBg = (e: MouseEvent) => {
    if (mode !== 'editor' || !onSelect) return
    if (e.target === e.currentTarget) onSelect(null)
  }

  const renderLayer = (l: ComposeLayerRecord) => {
    const selected = selectedId === l.id
    const interactive = mode === 'editor'
    // For browser layers in editor mode, only enable pointer events while selected
    // (so you can iframe-interact deliberately but still drag/select normally).
    const allowChildPointer = mode === 'editor' && (l.kind !== 'browser' || selected)
    return (
      <div
        key={l.id}
        style={{
          ...layerStyle(l),
          pointerEvents: interactive ? 'auto' : 'none',
          cursor: interactive ? 'pointer' : 'default',
          outline: selected ? '1px solid #4a9eff' : 'none',
          outlineOffset: 0,
        }}
        onClick={(e) => {
          if (!interactive || !onSelect) return
          e.stopPropagation()
          onSelect(selected ? null : l.id)
        }}
      >
        <div style={{ width: '100%', height: '100%', pointerEvents: allowChildPointer ? 'auto' : 'none' }}>
          <LayerContent layer={l} assets={assets} />
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Behind the 3D canvas. In editor mode we still want layers clickable, but
          empty space here would block the canvas — so the container ignores pointer events
          and each layer re-enables them individually. */}
      <div
        style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
      >
        {behind.map(renderLayer)}
      </div>
      {/* In front of the 3D canvas. We need pointer events to land here in editor mode,
          but only on actual layers — empty space falls through to deselect. */}
      <div
        style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: mode === 'editor' ? 'auto' : 'none' }}
        onClick={handleClickBg}
      >
        {front.map(renderLayer)}
      </div>
    </>
  )
}
