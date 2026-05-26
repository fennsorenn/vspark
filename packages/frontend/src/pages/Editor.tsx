import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api/client'
import { useEditorStore } from '../store/editorStore'
import { useWsSync } from '../hooks/useWsSync'
import { useTrackClipEvaluator } from '../hooks/useTrackClipEvaluator'
import { TopBar } from '../components/editor/TopBar'
import { SceneGraph } from '../components/editor/SceneGraph'
import { Viewport } from '../components/editor/Viewport'
import { PropertiesPanel } from '../components/editor/PropertiesPanel'
import { AssetManager } from '../components/editor/AssetManager'
import { SignalGraphCanvas } from '../components/editor/signal/SignalGraphCanvas'
import { NodePalette } from '../components/editor/signal/NodePalette'
import { ComposeView } from '../components/editor/ComposeView'
import type { NodeKindMeta } from '@vspark/shared/signal'

export function Editor() {
  useWsSync()
  useTrackClipEvaluator()
  const { projectId } = useParams<{ projectId: string }>()
  const { setProject, setScenes, setActiveScene, setNodes, setAssets, setNodeComponents, setComponentKinds, setCameraEffects, setComposeLayers, setTrackClips, activeGraphId, leftTab } = useEditorStore()
  const [kindMeta, setKindMeta] = useState<NodeKindMeta[]>([])

  useEffect(() => {
    api.getSignalNodeKinds().then(setKindMeta).catch(() => {})
    api.getComponentKinds().then(setComponentKinds).catch(() => {})
  }, [setComponentKinds])

  useEffect(() => {
    if (!projectId) return

    api.getProjects().then((projects) => {
      const project = projects.find((p) => p.id === projectId)
      if (project) setProject(project.id, project.name)
    })

    api.getScenes(projectId).then(async ({ scenes, nodes, nodeComponents, cameraEffects, composeLayers, trackClips }) => {
      setScenes(scenes)
      setNodeComponents(nodeComponents)
      setCameraEffects(cameraEffects)
      setComposeLayers(composeLayers)
      setTrackClips(trackClips)
      if (scenes.length > 0) {
        const firstId = scenes[0].id
        setActiveScene(firstId)
        const sceneNodes = nodes.filter((n) => n.sceneId === firstId)
        if (sceneNodes.length > 0) {
          setNodes(sceneNodes)
        } else {
          const fetched = await api.getNodes(firstId)
          setNodes(fetched)
        }
      }
    })

    api.getAssets(projectId).then(setAssets).catch(() => {})
  }, [projectId, setProject, setScenes, setActiveScene, setNodes, setAssets, setNodeComponents, setCameraEffects, setComposeLayers, setTrackClips])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f0f0f' }}>
      <TopBar />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <SceneGraph />
        {/* Viewport always mounts (keeps 3D scene alive) but is hidden when another mode is active */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, visibility: (activeGraphId || leftTab === 'compose') ? 'hidden' : 'visible' }}>
            <Viewport />
          </div>
          {activeGraphId && (
            <div style={{ position: 'absolute', inset: 0 }}>
              <SignalGraphCanvas graphId={activeGraphId} kindMeta={kindMeta} />
            </div>
          )}
          {!activeGraphId && leftTab === 'compose' && (
            <ComposeView />
          )}
        </div>
        <PropertiesPanel />
      </div>
      {activeGraphId
        ? <NodePalette kindMeta={kindMeta} graphReadonly={true} />
        : <AssetManager />
      }
    </div>
  )
}
