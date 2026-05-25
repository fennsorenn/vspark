import { useEffect, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { PerspectiveCamera, Environment } from '@react-three/drei'
import * as THREE from 'three'
import { useEditorStore } from '../../store/editorStore'
import { SceneNodes, CameraEffects } from './Viewport'
import { ComposeLayerStack } from './ComposeLayerStack'
import { ComposeSelectionOverlay } from './ComposeSelectionOverlay'
import { ComposeSceneInteractions } from './ComposeSceneInteractions'
import { FittedOrthoCamera } from './FittedOrthoCamera'

function getT(components: Record<string, unknown> | undefined) {
  const t = components?.transform as Partial<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }> | undefined
  return {
    x: t?.x ?? 0, y: t?.y ?? 0, z: t?.z ?? 0,
    rx: t?.rx ?? 0, ry: t?.ry ?? 0, rz: t?.rz ?? 0,
  }
}

export function ComposeView() {
  const nodes = useEditorStore((s) => s.nodes)
  const activeSceneId = useEditorStore((s) => s.activeSceneId)
  const composeCameraId = useEditorStore((s) => s.composeCameraId)
  const setComposeCameraId = useEditorStore((s) => s.setComposeCameraId)
  const composeLayers = useEditorStore((s) => s.composeLayers)
  const assets = useEditorStore((s) => s.assets)
  const selectedComposeLayerId = useEditorStore((s) => s.selectedComposeLayerId)
  const selectComposeLayer = useEditorStore((s) => s.selectComposeLayer)

  const cameras = nodes.filter((n) => n.kind === 'camera' && n.sceneId === activeSceneId)

  // Default to the first camera; clear if the selected camera disappeared.
  useEffect(() => {
    if (cameras.length === 0) { if (composeCameraId) setComposeCameraId(null); return }
    if (!composeCameraId || !cameras.some((c) => c.id === composeCameraId)) {
      setComposeCameraId(cameras[0].id)
    }
  }, [cameras, composeCameraId, setComposeCameraId])

  const camNode = cameras.find((c) => c.id === composeCameraId) ?? null
  const viewportRef = useRef<HTMLDivElement>(null)
  const selectedLayer = composeLayers.find((l) => l.id === selectedComposeLayerId) ?? null
  const cc = camNode?.components?.camera as { projection?: 'perspective' | 'orthographic'; fov?: number; near?: number; far?: number; orthoSize?: number; backgroundImage?: string } | undefined
  const projection = cc?.projection ?? 'perspective'
  const orthoSize = cc?.orthoSize ?? 2
  const t = getT(camNode?.components as Record<string, unknown> | undefined)

  // Layers visible from this camera: scene-wide + this camera's own.
  const stackLayers = useMemo(() => composeLayers.filter(
    (l) => l.sceneId === activeSceneId && (l.cameraNodeId == null || l.cameraNodeId === composeCameraId),
  ), [composeLayers, activeSceneId, composeCameraId])

  if (!camNode) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 13, background: '#0a0a0a' }}>
        No camera available.
      </div>
    )
  }

  /** Forward a click to whatever layer is at (x, y) in screen-client coords,
   *  skipping the 3D canvas. Selects null if no layer is under the cursor. */
  const selectByClientPoint = (x: number, y: number) => {
    const els = document.elementsFromPoint(x, y)
    for (const el of els) {
      const id = (el as HTMLElement).getAttribute?.('data-compose-layer-id')
      if (id) { selectComposeLayer(id); return }
    }
    selectComposeLayer(null)
  }

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#0a0a0a' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #2a2a2a', display: 'flex', gap: 8, alignItems: 'center', background: '#141414', flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>Camera</span>
        <select
          value={composeCameraId ?? ''}
          onChange={(e) => { setComposeCameraId(e.target.value || null); selectComposeLayer(null) }}
          style={{ background: '#1e1e1e', color: '#e0e0e0', border: '1px solid #3a3a3a', borderRadius: 4, padding: '3px 6px', fontSize: 12 }}
        >
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#555' }}>{stackLayers.length} layer{stackLayers.length === 1 ? '' : 's'}</span>
      </div>
      <div
        ref={viewportRef}
        style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#000' }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) selectComposeLayer(null) }}
      >
        <ComposeLayerStack
          layers={stackLayers}
          assets={assets}
          selectedId={selectedComposeLayerId}
          onSelect={selectComposeLayer}
          mode="editor"
        />
        {/* 3D canvas sits at z-index 1, between behind-layers (0) and front-layers (2).
            The canvas itself receives pointer events so R3F can hit-test 3D objects;
            when the click lands on empty 3D space, onPointerMissed fires and we
            forward the click via elementsFromPoint so behind layers stay selectable
            through 3D-empty pixels. */}
        <div data-compose-3d="" style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
          <Canvas
            gl={{ alpha: true, antialias: true, toneMapping: THREE.NoToneMapping }}
            style={{ background: 'transparent' }}
            onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
            onPointerMissed={(e) => selectByClientPoint(e.clientX, e.clientY)}
          >
            {projection === 'perspective' ? (
              <PerspectiveCamera
                makeDefault
                fov={cc?.fov ?? 50}
                near={cc?.near ?? 0.1}
                far={cc?.far ?? 1000}
                position={[t.x, t.y, t.z]}
                rotation={[t.rx, t.ry, t.rz]}
              />
            ) : (
              <FittedOrthoCamera
                size={orthoSize}
                near={cc?.near ?? 0.1}
                far={cc?.far ?? 1000}
                position={[t.x, t.y, t.z]}
                rotation={[t.rx, t.ry, t.rz]}
              />
            )}
            <ComposeSceneInteractions wheelTargetRef={viewportRef}>
              <SceneNodes omitKinds={['camera']} viewerMode />
            </ComposeSceneInteractions>
            <Environment preset="city" />
            <CameraEffects forceNodeId={camNode.id} />
          </Canvas>
        </div>
        {/* Selection chrome lives above everything so handles never get occluded. */}
        {selectedLayer && (
          <ComposeSelectionOverlay viewportRef={viewportRef} layer={selectedLayer} />
        )}
      </div>
    </div>
  )
}
