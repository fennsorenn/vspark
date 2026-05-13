import { useState, useRef, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useEditorStore } from '../../store/editorStore'
import { api } from '../../api/client'
import type { NodeRecord, NodeComponent } from '../../store/editorStore'
import { newComponentId } from '../../store/editorStore'
import { COMPONENT_TYPES } from './componentTypes'

const KIND_ICONS: Record<string, string> = {
  avatar: '🧍',
  model: '📦',
  light: '💡',
  camera: '📷',
  prop: '🔹',
  group: '📁',
}

const DEFAULT_COMPONENTS = {
  transform: { type: 'transform', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
}

const NODE_TYPES = [
  { label: 'Group', kind: 'group' },
  { label: 'Avatar', kind: 'avatar' },
  { label: 'Model', kind: 'model' },
  { label: 'Prop', kind: 'prop' },
  { label: 'Point Light', kind: 'light', lightType: 'point' },
  { label: 'Directional Light', kind: 'light', lightType: 'directional' },
  { label: 'Camera', kind: 'camera' },
]

// ---------- Context menu ----------
interface CtxMenu {
  nodeId: string
  x: number
  y: number
}

function ContextMenu({
  menu,
  nodes,
  onClose,
  onAddChild,
  onReparent,
  onUnparent,
  onDelete,
}: {
  menu: CtxMenu
  nodes: NodeRecord[]
  onClose: () => void
  onAddChild: (parentId: string, type: typeof NODE_TYPES[number]) => void
  onReparent: (nodeId: string, newParentId: string) => void
  onUnparent: (nodeId: string) => void
  onDelete: (nodeId: string) => void
}) {
  const node = nodes.find((n) => n.id === menu.nodeId)!
  const [showAddChild, setShowAddChild] = useState(false)
  const [showMoveInto, setShowMoveInto] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    top: menu.y,
    left: menu.x,
    background: '#1e1e1e',
    border: '1px solid #3a3a3a',
    borderRadius: 6,
    zIndex: 9999,
    minWidth: 180,
    boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
    fontFamily: 'system-ui, sans-serif',
    overflow: 'hidden',
  }

  const itemStyle: React.CSSProperties = {
    padding: '7px 14px',
    fontSize: 13,
    color: '#e0e0e0',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    userSelect: 'none',
  }

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: '#2a2a2a',
    margin: '3px 0',
  }

  return (
    <div ref={ref} style={menuStyle}>
      {/* Add Child submenu */}
      <div
        style={itemStyle}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'; setShowAddChild(true); setShowMoveInto(false) }}
        onMouseLeave={(e) => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
      >
        <span>Add Child</span>
        <span style={{ color: '#666' }}>▶</span>
        {showAddChild && (
          <div style={{
            position: 'absolute',
            left: '100%',
            top: 0,
            background: '#1e1e1e',
            border: '1px solid #3a3a3a',
            borderRadius: 6,
            minWidth: 160,
            boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
            overflow: 'hidden',
          }}>
            {NODE_TYPES.map((t) => (
              <div
                key={t.label}
                style={itemStyle}
                onMouseEnter={(e) => (e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'}
                onMouseLeave={(e) => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                onClick={() => { onAddChild(menu.nodeId, t); onClose() }}
              >
                {KIND_ICONS[t.kind] ?? '🔹'} {t.label}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Move Into submenu */}
      <div
        style={itemStyle}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'; setShowMoveInto(true); setShowAddChild(false) }}
        onMouseLeave={(e) => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
      >
        <span>Move Into</span>
        <span style={{ color: '#666' }}>▶</span>
        {showMoveInto && (
          <div style={{
            position: 'absolute',
            left: '100%',
            top: 32,
            background: '#1e1e1e',
            border: '1px solid #3a3a3a',
            borderRadius: 6,
            minWidth: 180,
            maxHeight: 240,
            overflowY: 'auto',
            boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
          }}>
            {nodes
              .filter((n) => n.id !== menu.nodeId && n.id !== node.parentId)
              .map((n) => (
                <div
                  key={n.id}
                  style={itemStyle}
                  onMouseEnter={(e) => (e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'}
                  onMouseLeave={(e) => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                  onClick={() => { onReparent(menu.nodeId, n.id); onClose() }}
                >
                  {KIND_ICONS[n.kind] ?? '🔹'} {n.name}
                </div>
              ))}
          </div>
        )}
      </div>

      {node.parentId && (
        <div
          style={itemStyle}
          onMouseEnter={(e) => (e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'}
          onMouseLeave={(e) => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
          onClick={() => { onUnparent(menu.nodeId); onClose() }}
        >
          Unparent
        </div>
      )}

      <div style={dividerStyle} />

      <div
        style={{ ...itemStyle, color: '#e05555' }}
        onMouseEnter={(e) => (e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'}
        onMouseLeave={(e) => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
        onClick={() => { onDelete(menu.nodeId); onClose() }}
      >
        Delete
      </div>
    </div>
  )
}

// ---------- Inline components section ----------
function NodeComponentsSection({ nodeId }: { nodeId: string }) {
  const nodeComponentsFor    = useEditorStore((s) => s.nodeComponentsFor)
  const addNodeComponent     = useEditorStore((s) => s.addNodeComponent)
  const updateNodeComponent  = useEditorStore((s) => s.updateNodeComponent)
  const removeNodeComponent  = useEditorStore((s) => s.removeNodeComponent)
  const selectedComponentId  = useEditorStore((s) => s.selectedComponentId)
  const selectComponent      = useEditorStore((s) => s.selectComponent)
  const vmcStatus            = useEditorStore((s) => s.vmcStatus)
  const vmcTracking          = useEditorStore((s) => s.vmcTracking)
  const components = nodeComponentsFor(nodeId)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showAddMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowAddMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAddMenu])

  const handleAdd = async (ct: typeof COMPONENT_TYPES[number]) => {
    setShowAddMenu(false)
    const comp: NodeComponent = {
      id: newComponentId(),
      nodeId,
      kind: ct.kind,
      enabled: true,
      config: { ...ct.defaultConfig },
    }
    addNodeComponent(comp)
    try {
      await api.createNodeComponent(nodeId, comp)
    } catch { /* non-fatal — state already updated locally */ }
  }

  const handleToggleEnabled = async (comp: NodeComponent) => {
    const next = !comp.enabled
    updateNodeComponent(comp.id, { enabled: next })
    try {
      await api.updateNodeComponent(comp.id, { enabled: next })
    } catch { /* non-fatal */ }
  }

  const handleRemove = async (comp: NodeComponent) => {
    removeNodeComponent(comp.id)
    try {
      await api.deleteNodeComponent(comp.id)
    } catch { /* non-fatal */ }
  }

  return (
    <div style={{
      marginLeft: 28,
      marginRight: 4,
      marginBottom: 4,
      background: '#111',
      borderRadius: 4,
      border: '1px solid #222',
      overflow: 'hidden',
    }}>
      {components.length === 0 && (
        <div style={{ padding: '4px 10px', fontSize: 11, color: '#444', fontStyle: 'italic' }}>
          No components
        </div>
      )}
      {components.map((comp) => {
        const ct = COMPONENT_TYPES.find((c) => c.kind === comp.kind)
        const isSelected = selectedComponentId === comp.id
        const hasStatus = comp.kind === 'vmc_receiver'
        const isConnected = hasStatus && vmcStatus[comp.id] === true
        const isTracking  = hasStatus && vmcTracking[comp.id] === true
        return (
          <div
            key={comp.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              borderBottom: '1px solid #1a1a1a',
              fontSize: 12,
              cursor: 'pointer',
              background: isSelected ? '#1a3a5a' : 'transparent',
            }}
            onClick={() => selectComponent(isSelected ? null : comp.id)}
          >
            <span style={{ fontSize: 14 }}>{ct?.icon ?? '⚙️'}</span>
            <span style={{ flex: 1, color: comp.enabled ? (isSelected ? '#fff' : '#ccc') : '#555' }}>
              {ct?.label ?? comp.kind}
            </span>
            {hasStatus && (
              <>
                <span
                  title={isConnected ? 'Client connected' : 'No client'}
                  style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: isConnected ? '#4ade80' : '#444',
                    boxShadow: isConnected ? '0 0 4px #4ade80' : 'none',
                  }}
                />
                <span
                  title={isConnected ? (isTracking ? 'Tracking active' : 'Tracking lost') : 'Not connected'}
                  style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: !isConnected ? '#444' : isTracking ? '#facc15' : '#555',
                    boxShadow: isTracking ? '0 0 4px #facc15' : 'none',
                  }}
                />
              </>
            )}
            <button
              title={comp.enabled ? 'Disable' : 'Enable'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: comp.enabled ? '#4a9' : '#555',
                fontSize: 13,
                padding: '0 2px',
                lineHeight: 1,
              }}
              onClick={(e) => { e.stopPropagation(); handleToggleEnabled(comp) }}
            >
              {comp.enabled ? '●' : '○'}
            </button>
            <button
              title="Remove component"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: '#555',
                fontSize: 14,
                padding: '0 2px',
                lineHeight: 1,
              }}
              onClick={(e) => { e.stopPropagation(); handleRemove(comp) }}
            >
              ×
            </button>
          </div>
        )
      })}

      {/* Add component button */}
      <div style={{ position: 'relative', padding: '3px 6px' }}>
        <button
          style={{
            background: 'none',
            border: '1px dashed #2a2a2a',
            borderRadius: 4,
            color: '#555',
            cursor: 'pointer',
            fontSize: 11,
            padding: '2px 8px',
            width: '100%',
            textAlign: 'left',
          }}
          onClick={() => setShowAddMenu((v) => !v)}
        >
          + Add Component
        </button>
        {showAddMenu && (
          <div ref={menuRef} style={{
            position: 'absolute',
            left: 6,
            bottom: '100%',
            marginBottom: 2,
            background: '#1e1e1e',
            border: '1px solid #3a3a3a',
            borderRadius: 6,
            minWidth: 200,
            zIndex: 1000,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            overflow: 'hidden',
          }}>
            {COMPONENT_TYPES.filter((ct) =>
              ct.applicableTo.length === 0 || ct.applicableTo.includes('any')
            ).map((ct) => (
              <div
                key={ct.kind}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 12px',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: '#e0e0e0',
                }}
                onMouseEnter={(e) => (e.currentTarget as HTMLDivElement).style.background = '#2a2a2a'}
                onMouseLeave={(e) => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                onClick={() => handleAdd(ct)}
              >
                <span style={{ fontSize: 16 }}>{ct.icon}</span>
                <div>
                  <div style={{ fontWeight: 500 }}>{ct.label}</div>
                  <div style={{ fontSize: 10, color: '#666', marginTop: 1 }}>{ct.description}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const formatBoneName = (name: string) =>
  name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

// ---------- Graph list panel ----------
import type { GraphDescriptor } from '@vspark/shared/signal'

function GraphListPanel() {
  const { activeGraphId, setActiveGraph } = useEditorStore()
  const [graphs, setGraphs] = useState<GraphDescriptor[]>([])

  useEffect(() => {
    api.getSignalGraphs().then(setGraphs).catch(() => {})
    const iv = setInterval(() => api.getSignalGraphs().then(setGraphs).catch(() => {}), 3000)
    return () => clearInterval(iv)
  }, [])

  const rowStyle = (active: boolean): React.CSSProperties => ({
    padding: '7px 12px',
    fontSize: 12,
    color: active ? '#fff' : '#bbb',
    background: active ? '#1e3a5f' : 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    userSelect: 'none',
    borderLeft: active ? '2px solid #4a90d9' : '2px solid transparent',
  })

  if (graphs.length === 0) {
    return (
      <div style={{ color: '#555', fontSize: 12, padding: 16, textAlign: 'center' }}>
        No active signal graphs.<br />Add a VMC Receiver component to a node.
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
      {graphs.map((g) => (
        <div
          key={g.id}
          style={rowStyle(g.id === activeGraphId)}
          onClick={() => setActiveGraph(g.id === activeGraphId ? null : g.id)}
        >
          <span style={{ opacity: 0.6 }}>⬡</span>
          <div>
            <div style={{ fontWeight: 500 }}>{g.label}</div>
            <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
              {g.nodes.length} nodes · {g.readonly ? 'read-only' : 'editable'}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------- Main SceneGraph ----------
export function SceneGraph() {
  const { projectId } = useParams<{ projectId: string }>()
  const {
    activeSceneId, nodes, selectedNodeId,
    selectNode, addNode, deleteNode: storeDeleteNode, updateNode: storeUpdateNode,
    nodeComponents, vrmBonesByNode, setHoveredBone,
    boneListExpanded, setBoneListExpanded,
  } = useEditorStore()

  const [dockTab, setDockTab] = useState<'scene' | 'graphs'>('scene')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set())
  const [expandedComponents, setExpandedComponents] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)

  const toggleBones = (id: string) =>
    setBoneListExpanded(id, !(boneListExpanded[id] ?? false))

  const sceneNodes = nodes.filter((n) => n.sceneId === activeSceneId)

  const toggleCollapse = (id: string) =>
    setCollapsedNodes((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const toggleComponents = (id: string) =>
    setExpandedComponents((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const handleAdd = async (type: typeof NODE_TYPES[number], parentId: string | null = null) => {
    setDropdownOpen(false)
    if (!activeSceneId) return
    const name = window.prompt(`Name for ${type.label}:`, type.label)
    if (!name?.trim()) return

    const components: Record<string, unknown> = { ...DEFAULT_COMPONENTS }
    if (type.kind === 'light') {
      components.light = { type: 'light', lightType: type.lightType ?? 'point', color: '#ffffff', intensity: 1 }
    } else if (type.kind === 'camera') {
      components.camera = { type: 'camera', fov: 50, near: 0.1, far: 1000 }
    }

    try {
      const node = await api.createNode(activeSceneId, {
        parentId,
        name: name.trim(),
        kind: type.kind,
        filePath: null,
        components,
      })
      addNode(node)
      // Auto-expand parent so the new child is visible
      if (parentId) setCollapsedNodes((s) => { const n = new Set(s); n.delete(parentId); return n })
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to create node')
    }
  }

  const handleDelete = async (nodeId: string) => {
    const node = sceneNodes.find((n) => n.id === nodeId)
    if (!node || !window.confirm(`Delete "${node.name}"?`)) return
    try {
      await api.deleteNode(nodeId)
      storeDeleteNode(nodeId)
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to delete node')
    }
  }

  const handleReparent = async (nodeId: string, newParentId: string | null) => {
    try {
      await api.updateNode(nodeId, { parentId: newParentId })
      storeUpdateNode(nodeId, { parentId: newParentId })
      if (newParentId) setCollapsedNodes((s) => { const n = new Set(s); n.delete(newParentId); return n })
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to move node')
    }
  }

  const renderNode = (node: NodeRecord, depth = 0) => {
    const isSelected = selectedNodeId === node.id
    const children = sceneNodes.filter((n) => n.parentId === node.id)
    const hasChildren = children.length > 0
    const isCollapsed = collapsedNodes.has(node.id)
    const showComponents = expandedComponents.has(node.id)
    const showBones = boneListExpanded[node.id] ?? false
    const compCount = nodeComponents.filter((c) => c.nodeId === node.id).length
    const icon = KIND_ICONS[node.kind] ?? '🔹'
    const bones = node.kind === 'avatar' ? (vrmBonesByNode[node.id] ?? null) : null

    return (
      <div key={node.id}>
        {/* Node row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: `4px 8px 4px ${8 + depth * 16}px`,
            cursor: 'pointer',
            background: isSelected ? '#1a3a6a' : 'transparent',
            borderRadius: 4,
            margin: '1px 4px',
            fontSize: 13,
            color: '#e0e0e0',
            userSelect: 'none',
            gap: 2,
          }}
          onClick={() => selectNode(isSelected ? null : node.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            setCtxMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
          }}
        >
          {/* Collapse chevron (or spacer) */}
          <span
            style={{
              width: 16,
              flexShrink: 0,
              color: '#555',
              fontSize: 10,
              textAlign: 'center',
              visibility: hasChildren ? 'visible' : 'hidden',
            }}
            onClick={(e) => { e.stopPropagation(); toggleCollapse(node.id) }}
          >
            {isCollapsed ? '▶' : '▼'}
          </span>

          <span style={{ fontSize: 14, flexShrink: 0 }}>{icon}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 4 }}>
            {node.name}
          </span>

          {/* Bones toggle — avatar only, shown once VRM is loaded */}
          {bones && (
            <button
              title={showBones ? 'Hide bones' : 'Show bones'}
              style={{
                background: 'none',
                border: 'none',
                color: showBones ? '#8af' : '#444',
                cursor: 'pointer',
                fontSize: 11,
                padding: '0 3px',
                flexShrink: 0,
                lineHeight: 1,
              }}
              onClick={(e) => { e.stopPropagation(); toggleBones(node.id) }}
            >
              🦴
            </button>
          )}

          {/* Components toggle */}
          <button
            title={showComponents ? 'Hide components' : 'Show components'}
            style={{
              background: 'none',
              border: 'none',
              color: showComponents ? '#4a8' : (compCount > 0 ? '#666' : '#333'),
              cursor: 'pointer',
              fontSize: 11,
              padding: '0 3px',
              flexShrink: 0,
              lineHeight: 1,
            }}
            onClick={(e) => { e.stopPropagation(); toggleComponents(node.id) }}
          >
            ⚙{compCount > 0 ? <sup style={{ fontSize: 8 }}>{compCount}</sup> : null}
          </button>

          {/* Open viewer link — camera nodes only */}
          {node.kind === 'camera' && projectId && (
            <a
              href={`/viewer/${projectId}/${node.id}`}
              target="_blank"
              rel="noreferrer"
              title="Open viewer"
              style={{
                color: '#555',
                fontSize: 12,
                padding: '0 2px',
                flexShrink: 0,
                lineHeight: 1,
                textDecoration: 'none',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              ↗
            </a>
          )}

          {/* Delete button */}
          <button
            style={{
              background: 'none',
              border: 'none',
              color: '#555',
              cursor: 'pointer',
              padding: '0 2px',
              fontSize: 14,
              lineHeight: 1,
              flexShrink: 0,
            }}
            onClick={(e) => { e.stopPropagation(); handleDelete(node.id) }}
            title="Delete node"
          >
            ×
          </button>
        </div>

        {/* Inline components section */}
        {showComponents && (
          <div style={{ paddingLeft: 8 + depth * 16 }}>
            <NodeComponentsSection nodeId={node.id} />
          </div>
        )}

        {/* Bone list */}
        {showBones && bones && (
          <div style={{
            marginLeft: 28 + depth * 16,
            marginRight: 4,
            marginBottom: 4,
            background: '#111',
            borderRadius: 4,
            border: '1px solid #222',
            overflow: 'hidden',
            maxHeight: 260,
            overflowY: 'auto',
          }}>
            {bones.map((boneName) => (
              <div
                key={boneName}
                style={{
                  padding: '3px 10px',
                  fontSize: 11,
                  color: '#aaa',
                  cursor: 'default',
                  borderBottom: '1px solid #1a1a1a',
                  userSelect: 'none',
                }}
                onMouseEnter={(e) => {
                  setHoveredBone(boneName)
                  ;(e.currentTarget as HTMLDivElement).style.background = '#1a2a3a'
                  ;(e.currentTarget as HTMLDivElement).style.color = '#7bf'
                }}
                onMouseLeave={(e) => {
                  setHoveredBone(null)
                  ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
                  ;(e.currentTarget as HTMLDivElement).style.color = '#aaa'
                }}
              >
                {formatBoneName(boneName)}
              </div>
            ))}
          </div>
        )}

        {/* Children */}
        {!isCollapsed && children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  const rootNodes = sceneNodes.filter((n) => !n.parentId)

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '7px 0',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    color: active ? '#e0e0e0' : '#555',
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid #4a90d9' : '2px solid transparent',
    cursor: 'pointer',
  })

  return (
    <div style={{
      width: 240,
      flexShrink: 0,
      background: '#141414',
      borderRight: '1px solid #2a2a2a',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'system-ui, sans-serif',
      overflow: 'hidden',
    }}>
      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #2a2a2a', flexShrink: 0 }}>
        <button style={tabStyle(dockTab === 'scene')}  onClick={() => setDockTab('scene')}>Scene</button>
        <button style={tabStyle(dockTab === 'graphs')} onClick={() => setDockTab('graphs')}>Graphs</button>
      </div>

      {dockTab === 'graphs' && <GraphListPanel />}

      {dockTab === 'scene' && <>
      {/* Scene header */}
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid #2a2a2a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Scene
        </span>
        <div style={{ position: 'relative' }}>
          <button
            style={{
              background: '#2563eb',
              border: 'none',
              color: '#fff',
              borderRadius: 5,
              padding: '3px 10px',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
            }}
            onClick={() => setDropdownOpen((v) => !v)}
          >
            Add ▾
          </button>
          {dropdownOpen && (
            <div style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: 4,
              background: '#1e1e1e',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              overflow: 'hidden',
              zIndex: 100,
              minWidth: 160,
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            }}>
              {NODE_TYPES.map((type) => (
                <button
                  key={type.label}
                  style={{
                    display: 'block',
                    width: '100%',
                    background: 'none',
                    border: 'none',
                    color: '#e0e0e0',
                    padding: '8px 14px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#2a2a2a')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                  onClick={() => handleAdd(type, null)}
                >
                  {KIND_ICONS[type.kind] ?? '🔹'} {type.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Node list */}
      <div
        style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}
        onClick={() => dropdownOpen && setDropdownOpen(false)}
      >
        {!activeSceneId ? (
          <div style={{ color: '#555', fontSize: 12, padding: '12px', textAlign: 'center' }}>
            No scene selected
          </div>
        ) : rootNodes.length === 0 ? (
          <div style={{ color: '#555', fontSize: 12, padding: '12px', textAlign: 'center' }}>
            No nodes yet. Click Add.
          </div>
        ) : (
          rootNodes.map((n) => renderNode(n, 0))
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          menu={ctxMenu}
          nodes={sceneNodes}
          onClose={() => setCtxMenu(null)}
          onAddChild={(parentId, type) => handleAdd(type, parentId)}
          onReparent={handleReparent}
          onUnparent={(id) => handleReparent(id, null)}
          onDelete={handleDelete}
        />
      )}
      </>}
    </div>
  )
}
