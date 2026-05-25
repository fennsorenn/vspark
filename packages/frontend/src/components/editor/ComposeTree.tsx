import { useEditorStore } from '../../store/editorStore'

export function ComposeTree() {
  const nodes = useEditorStore((s) => s.nodes)
  const activeSceneId = useEditorStore((s) => s.activeSceneId)
  const cameras = nodes.filter((n) => n.kind === 'camera' && n.sceneId === activeSceneId)

  if (cameras.length === 0) {
    return (
      <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center', lineHeight: 1.5 }}>
        Add a camera node to start composing.<br />
        The Compose view shows what each<br />camera will broadcast.
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0', color: '#888', fontSize: 12 }}>
      <div style={{ padding: '8px 12px' }}>Compose layer tree — coming in the next step.</div>
    </div>
  )
}
