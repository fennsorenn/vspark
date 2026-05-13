import { useState, useRef } from 'react'
import { useEditorStore } from '../../store/editorStore'
import { api } from '../../api/client'
import type { AssetFile } from '../../api/client'
import type { NodeComponent } from '../../store/editorStore'
import { newComponentId } from '../../store/editorStore'
import { COMPONENT_TYPES } from './componentTypes'


export function AssetManager() {
  const { assets, addAsset, deleteAsset, activeSceneId, addNode, projectId, selectedNodeId, nodes, updateNode: storeUpdateNode, addNodeComponent, nodeComponents } = useEditorStore()
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const canApplyAnim = selectedNode?.kind === 'avatar' || selectedNode?.kind === 'model'
  const [tab, setTab] = useState<'models' | 'animations' | 'components'>('models')
  const [uploading, setUploading] = useState(false)
  const modelInputRef = useRef<HTMLInputElement>(null)
  const animInputRef = useRef<HTMLInputElement>(null)

  const models = assets.filter((a) => a.kind === 'model')
  const animations = assets.filter((a) => a.kind === 'animation')

  const handleUpload = async (file: File) => {
    if (!projectId) {
      alert('No project loaded.')
      return
    }
    setUploading(true)
    try {
      const asset = await api.uploadAsset(projectId, file)
      addAsset(asset)
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleAddToScene = async (asset: AssetFile) => {
    if (!activeSceneId) {
      alert('No active scene. Select or create a scene first.')
      return
    }
    const ext = asset.name.split('.').pop()?.toLowerCase()
    const nodeKind = ext === 'vrm' ? 'avatar' : 'model'
    try {
      const node = await api.createNode(activeSceneId, {
        parentId: null,
        name: asset.name,
        kind: nodeKind,
        filePath: asset.url,
        components: {
          transform: { type: 'transform', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        },
      })
      addNode(node)
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to add to scene')
    }
  }

  const handleApplyAnimation = async (asset: AssetFile) => {
    if (!selectedNode) return
    const components = { ...selectedNode.components, animation: { idleUrl: asset.url } }
    try {
      await api.updateNode(selectedNode.id, { components })
      storeUpdateNode(selectedNode.id, { components })
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to apply animation')
    }
  }

  const handleDelete = async (asset: AssetFile) => {
    try {
      await api.deleteAsset(asset.id)
      deleteAsset(asset.id)
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  const handleAddComponent = async (kind: string) => {
    if (!selectedNode) return
    const ct = COMPONENT_TYPES.find((c) => c.kind === kind)
    if (!ct) return
    const comp: NodeComponent = {
      id: newComponentId(),
      nodeId: selectedNode.id,
      kind,
      enabled: true,
      config: { ...ct.defaultConfig },
    }
    addNodeComponent(comp)
    try {
      await api.createNodeComponent(selectedNode.id, comp)
    } catch { /* non-fatal */ }
  }

  const tabBtn = (t: 'models' | 'animations' | 'components'): React.CSSProperties => ({
    background: tab === t ? '#2a2a2a' : 'none',
    border: 'none',
    borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
    color: tab === t ? '#e0e0e0' : '#666',
    padding: '6px 14px',
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'system-ui, sans-serif',
  })

  const uploadBtn: React.CSSProperties = {
    background: uploading ? '#1a3a5a' : '#2563eb',
    border: 'none',
    color: '#fff',
    borderRadius: 5,
    padding: '4px 12px',
    cursor: uploading ? 'not-allowed' : 'pointer',
    fontSize: 12,
    fontWeight: 500,
    flexShrink: 0,
  }

  const currentList = tab === 'models' ? models : animations

  return (
    <div style={{
      height: 200,
      flexShrink: 0,
      background: '#141414',
      borderTop: '1px solid #2a2a2a',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        borderBottom: '1px solid #2a2a2a',
        padding: '0 12px',
        gap: 4,
        flexShrink: 0,
      }}>
        <button style={tabBtn('models')} onClick={() => setTab('models')}>Models</button>
        <button style={tabBtn('animations')} onClick={() => setTab('animations')}>Animations</button>
        <button style={tabBtn('components')} onClick={() => setTab('components')}>Components</button>
        <div style={{ flex: 1 }} />
        {tab === 'components' ? null : tab === 'models' ? (
          <>
            <button style={uploadBtn} disabled={uploading} onClick={() => modelInputRef.current?.click()}>
              {uploading ? 'Uploading…' : 'Upload Model'}
            </button>
            <input
              ref={modelInputRef}
              type="file"
              accept=".vrm,.glb,.gltf"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleUpload(file)
                e.target.value = ''
              }}
            />
          </>
        ) : (
          <>
            <button style={uploadBtn} disabled={uploading} onClick={() => animInputRef.current?.click()}>
              {uploading ? 'Uploading…' : 'Upload Animation'}
            </button>
            <input
              ref={animInputRef}
              type="file"
              accept=".fbx,.bvh"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleUpload(file)
                e.target.value = ''
              }}
            />
          </>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {/* Components tab */}
        {tab === 'components' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!selectedNode && (
              <div style={{ color: '#555', fontSize: 12, textAlign: 'center', paddingTop: 12 }}>
                Select a node in the scene to add components.
              </div>
            )}
            {selectedNode && COMPONENT_TYPES.map((ct) => {
              const alreadyAdded = nodeComponents.some(
                (c) => c.nodeId === selectedNode.id && c.kind === ct.kind
              )
              return (
                <div key={ct.kind} style={{
                  background: '#1e1e1e',
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                  padding: '10px 12px',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                }}>
                  <span style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}>{ct.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#e0e0e0', marginBottom: 3 }}>
                      {ct.label}
                    </div>
                    <div style={{ fontSize: 11, color: '#666', lineHeight: 1.4 }}>
                      {ct.description}
                    </div>
                  </div>
                  <button
                    style={{
                      background: alreadyAdded ? '#1a2a1a' : '#1a3a1a',
                      border: 'none',
                      color: alreadyAdded ? '#4a7' : '#5b9',
                      borderRadius: 4,
                      padding: '3px 10px',
                      cursor: alreadyAdded ? 'default' : 'pointer',
                      fontSize: 11,
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                    disabled={alreadyAdded}
                    onClick={() => handleAddComponent(ct.kind)}
                    title={alreadyAdded ? 'Already added' : `Add to ${selectedNode.name}`}
                  >
                    {alreadyAdded ? '✓ Added' : '+ Add'}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* Models / Animations tabs */}
        {tab !== 'components' && currentList.length === 0 ? (
          <div style={{ color: '#555', fontSize: 12, textAlign: 'center', paddingTop: 20 }}>
            No {tab} yet. Upload one above.
          </div>
        ) : tab !== 'components' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {currentList.map((asset) => (
              <div key={asset.id} style={{
                background: '#1e1e1e',
                border: '1px solid #2a2a2a',
                borderRadius: 6,
                padding: '8px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                minWidth: 140,
                maxWidth: 200,
              }}>
                <div style={{ fontSize: 13, color: '#e0e0e0', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {asset.name}
                </div>
                <div style={{
                  display: 'inline-block',
                  background: '#2a2a2a',
                  borderRadius: 3,
                  padding: '1px 6px',
                  fontSize: 10,
                  color: '#888',
                  alignSelf: 'flex-start',
                }}>
                  {asset.name.split('.').pop()?.toUpperCase()}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                  {asset.kind === 'model' && (
                    <button
                      style={{ background: '#1a3a5a', border: 'none', color: '#7ab', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
                      onClick={() => handleAddToScene(asset)}
                    >
                      Add to Scene
                    </button>
                  )}
                  {asset.kind === 'animation' && canApplyAnim && (
                    <button
                      style={{ background: '#1a3a2a', border: 'none', color: '#7c9', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
                      title={`Apply to "${selectedNode!.name}"`}
                      onClick={() => handleApplyAnimation(asset)}
                    >
                      Apply to {selectedNode!.name}
                    </button>
                  )}
                  {asset.kind === 'animation' && !canApplyAnim && (
                    <span style={{ fontSize: 10, color: '#555', alignSelf: 'center' }}>
                      Select an avatar first
                    </span>
                  )}
                  <button
                    style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
                    onClick={() => handleDelete(asset)}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

