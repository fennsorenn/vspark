import { useEffect } from 'react'
import { useEditorStore } from '../../store/editorStore'

export function ComposeView() {
  const nodes = useEditorStore((s) => s.nodes)
  const activeSceneId = useEditorStore((s) => s.activeSceneId)
  const composeCameraId = useEditorStore((s) => s.composeCameraId)
  const setComposeCameraId = useEditorStore((s) => s.setComposeCameraId)

  const cameras = nodes.filter((n) => n.kind === 'camera' && n.sceneId === activeSceneId)

  // Default to the first camera; clear if the selected camera disappeared.
  useEffect(() => {
    if (cameras.length === 0) { if (composeCameraId) setComposeCameraId(null); return }
    if (!composeCameraId || !cameras.some((c) => c.id === composeCameraId)) {
      setComposeCameraId(cameras[0].id)
    }
  }, [cameras, composeCameraId, setComposeCameraId])

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#0a0a0a' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #2a2a2a', display: 'flex', gap: 8, alignItems: 'center', background: '#141414' }}>
        <span style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>Camera</span>
        <select
          value={composeCameraId ?? ''}
          onChange={(e) => setComposeCameraId(e.target.value || null)}
          style={{ background: '#1e1e1e', color: '#e0e0e0', border: '1px solid #3a3a3a', borderRadius: 4, padding: '3px 6px', fontSize: 12 }}
        >
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontSize: 13 }}>
        Compose viewport — coming in the next step.
      </div>
    </div>
  )
}
