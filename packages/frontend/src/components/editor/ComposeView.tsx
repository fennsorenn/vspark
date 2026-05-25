import { useEffect, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { PerspectiveCamera, Environment } from '@react-three/drei'
import * as THREE from 'three'
import { useEditorStore } from '../../store/editorStore'
import { SceneNodes, CameraEffects } from './Viewport'
import { ComposeLayerStack } from './ComposeLayerStack'

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
  const cc = camNode?.components?.camera as { fov?: number; near?: number; far?: number; backgroundImage?: string } | undefined
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
        style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#000' }}
        onClick={(e) => { if (e.target === e.currentTarget) selectComposeLayer(null) }}
      >
        <ComposeLayerStack
          layers={stackLayers}
          assets={assets}
          selectedId={selectedComposeLayerId}
          onSelect={selectComposeLayer}
          mode="editor"
        />
        {/* 3D canvas sits at z-index 1, between behind-layers (0) and front-layers (2). */}
        <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }}>
          <Canvas
            gl={{ alpha: true, antialias: true, toneMapping: THREE.NoToneMapping }}
            style={{ background: 'transparent' }}
            onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
          >
            <PerspectiveCamera
              makeDefault
              fov={cc?.fov ?? 50}
              near={cc?.near ?? 0.1}
              far={cc?.far ?? 1000}
              position={[t.x, t.y, t.z]}
              rotation={[t.rx, t.ry, t.rz]}
            />
            <SceneNodes omitKinds={['camera']} viewerMode />
            <Environment preset="city" />
            <CameraEffects forceNodeId={camNode.id} />
          </Canvas>
        </div>
      </div>
    </div>
  )
}
