import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Canvas } from '@react-three/fiber'
import { PerspectiveCamera, Environment } from '@react-three/drei'
import { useEditorStore } from '../store/editorStore'
import { api } from '../api/client'
import { useWsSync } from '../hooks/useWsSync'
import { SceneNodes } from '../components/editor/Viewport'

function getT(components: Record<string, unknown> | undefined) {
  const t = components?.transform as Partial<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }> | undefined
  return {
    x: t?.x ?? 0, y: t?.y ?? 0, z: t?.z ?? 0,
    rx: t?.rx ?? 0, ry: t?.ry ?? 0, rz: t?.rz ?? 0,
  }
}

export function ViewerPage() {
  useWsSync()
  const { projectId, nodeId } = useParams<{ projectId: string; nodeId: string }>()
  const { setProject, setScenes, setActiveScene, setNodes, setNodeComponents, nodes } = useEditorStore()

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    return () => {
      document.documentElement.style.background = ''
      document.body.style.background = ''
    }
  }, [])

  useEffect(() => {
    if (!projectId) return

    api.getProjects().then((projects) => {
      const project = projects.find((p) => p.id === projectId)
      if (project) setProject(project.id, project.name)
    }).catch(() => {})

    api.getScenes(projectId).then(async ({ scenes, nodes: sceneNodes, nodeComponents }) => {
      setScenes(scenes)
      setNodeComponents(nodeComponents)
      if (scenes.length === 0) return
      const firstId = scenes[0].id
      setActiveScene(firstId)
      const filtered = sceneNodes.filter((n) => n.sceneId === firstId)
      setNodes(filtered.length > 0 ? filtered : await api.getNodes(firstId))
    }).catch(() => {})
  }, [projectId, setProject, setScenes, setActiveScene, setNodes, setNodeComponents])

  const camNode = nodes.find((n) => n.id === nodeId)
  const cc = camNode?.components?.camera as { fov?: number; near?: number; far?: number } | undefined
  const t = getT(camNode?.components as Record<string, unknown> | undefined)

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'transparent' }}>
      <Canvas
        gl={{ alpha: true, antialias: true }}
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
      </Canvas>
    </div>
  )
}
