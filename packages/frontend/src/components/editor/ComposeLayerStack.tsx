import type { CSSProperties } from 'react'
import { useEditorStore } from '../../store/editorStore'
import type { ComposeLayerRecord, AssetFile } from '../../store/editorStore'

const SCENE_RENDER_SLOT = 0

interface ComposeLayerStackProps {
  layers: ComposeLayerRecord[]
  assets: AssetFile[]
  /** Render mode is currently ignored — both editor and viewer render the same
   *  passive DOM; the editor's input goes through ComposeEventCapture. Kept
   *  in the signature so ViewerPage's call site doesn't need to change. */
  mode?: 'editor' | 'viewer'
}

function resolveAssetUrl(layer: ComposeLayerRecord, assets: AssetFile[]): string | null {
  if (!layer.assetId) return null
  const a = assets.find((x) => x.id === layer.assetId)
  return a?.url ?? null
}

function layerStyle(layer: ComposeLayerRecord, override?: { x?: number; y?: number; rotation?: number }): CSSProperties {
  const opacity = typeof layer.config.opacity === 'number' ? layer.config.opacity : 1
  const x        = override?.x        ?? layer.x
  const y        = override?.y        ?? layer.y
  const rotation = override?.rotation ?? layer.rotation
  const style: CSSProperties = {
    position: 'absolute',
    width: layer.width,
    height: layer.height,
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    transformOrigin: 'center center',
    visibility: layer.visible ? 'visible' : 'hidden',
    opacity,
    overflow: 'hidden',
  }
  if (layer.anchorH === 'left')   style.left   = x
  if (layer.anchorH === 'right')  style.right  = x
  if (layer.anchorV === 'top')    style.top    = y
  if (layer.anchorV === 'bottom') style.bottom = y
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
  layer, assets,
}: {
  layer: ComposeLayerRecord
  assets: AssetFile[]
}) {
  // Per-layer subscription to its track-clip override: this keeps re-renders
  // localized to layers being animated; idle layers don't re-render each rAF.
  const override = useEditorStore((s) => s.composeLayerOverrides[layer.id])
  // Layer wrappers are passive: pointer events go to the top-level capture
  // overlay (ComposeEventCapture), which uses document.elementsFromPoint to
  // find which layer is under the cursor via data-compose-layer-id. This
  // single-owner model removes the need to route between layer wrappers,
  // canvas, and selection chrome.
  return (
    <div
      data-compose-layer-id={layer.id}
      style={{ ...layerStyle(layer, override), pointerEvents: 'none' }}
    >
      <LayerContent layer={layer} assets={assets} />
    </div>
  )
}

export function ComposeLayerStack({ layers, assets }: ComposeLayerStackProps) {
  const behind = layers
    .filter((l) => l.sceneOrder > SCENE_RENDER_SLOT)
    .sort((a, b) => b.sceneOrder - a.sceneOrder || a.cameraOrder - b.cameraOrder)
  const front = layers
    .filter((l) => l.sceneOrder <= SCENE_RENDER_SLOT)
    .sort((a, b) => b.sceneOrder - a.sceneOrder || a.cameraOrder - b.cameraOrder)

  const renderLayer = (l: ComposeLayerRecord) => (
    <LayerView key={l.id} layer={l} assets={assets} />
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
