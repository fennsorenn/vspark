import { useState, type CSSProperties } from 'react'
import { useEditorStore, type ComposeLayerRecord } from '../../store/editorStore'
import { api } from '../../api/client'
import type { ComposeLayerKind } from '../../api/client'

const KIND_ICONS: Record<ComposeLayerKind, string> = {
  image:   '🖼',
  video:   '🎞',
  browser: '🌐',
}

const SCENE_RENDER_SLOT = 0

type Section = 'scene' | 'camera'

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  background: '#181818',
  borderBottom: '1px solid #2a2a2a',
  borderTop: '1px solid #2a2a2a',
  color: '#aaa',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  cursor: 'pointer',
  userSelect: 'none',
}

function rowStyle(selected: boolean, pinned: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    margin: '1px 4px',
    fontSize: 12,
    color: pinned ? '#888' : (selected ? '#fff' : '#ddd'),
    background: selected ? '#1a3a6a' : 'transparent',
    borderRadius: 3,
    cursor: 'pointer',
    userSelect: 'none',
  }
}

const pinnedSceneRowStyle: CSSProperties = {
  ...rowStyle(false, true),
  background: '#161620',
  fontStyle: 'italic',
  cursor: 'default',
}

const smallBtn: CSSProperties = {
  background: 'transparent',
  border: '1px solid #3a3a3a',
  color: '#888',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 10,
  padding: '1px 5px',
  lineHeight: 1.2,
}

const addBtn: CSSProperties = {
  background: '#2563eb',
  border: 'none',
  color: '#fff',
  borderRadius: 3,
  padding: '2px 7px',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 500,
}

/** Build the ordered list a section should render. For a camera section, that's
 *  all scene-wide layers (pinned) plus that camera's own layers, sorted by
 *  (sceneOrder DESC, cameraOrder ASC). For the Scene section, only scene-wide layers. */
function buildStack(
  layers: ComposeLayerRecord[],
  sceneId: string,
  cameraNodeId: string | null,
): { layer: ComposeLayerRecord; pinned: boolean }[] {
  const sceneWide = layers.filter((l) => l.sceneId === sceneId && l.cameraNodeId == null)
  if (cameraNodeId == null) {
    return [...sceneWide]
      .sort((a, b) => b.sceneOrder - a.sceneOrder || a.cameraOrder - b.cameraOrder)
      .map((l) => ({ layer: l, pinned: false }))
  }
  const camOwn = layers.filter((l) => l.sceneId === sceneId && l.cameraNodeId === cameraNodeId)
  const merged = [
    ...sceneWide.map((l) => ({ layer: l, pinned: true })),
    ...camOwn.map((l) => ({ layer: l, pinned: false })),
  ]
  merged.sort((a, b) => b.layer.sceneOrder - a.layer.sceneOrder || a.layer.cameraOrder - b.layer.cameraOrder)
  return merged
}

async function createLayer(sceneId: string, cameraNodeId: string | null, kind: ComposeLayerKind) {
  const defaultName = kind[0].toUpperCase() + kind.slice(1) + ' Layer'
  const name = window.prompt(`Name for new ${kind} layer:`, defaultName)
  if (!name?.trim()) return
  const config: Record<string, unknown> = kind === 'browser' ? { url: 'https://example.com' } : {}
  await api.createComposeLayer(sceneId, { name: name.trim(), kind, cameraNodeId, config })
  // WS broadcast appends to store; no local insert needed.
}

interface AddMenuProps {
  onPick: (kind: ComposeLayerKind) => void
}

function AddMenu({ onPick }: AddMenuProps) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button style={addBtn} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}>+ ▾</button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 4,
          background: '#1e1e1e', border: '1px solid #3a3a3a', borderRadius: 4,
          minWidth: 140, zIndex: 50, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          {(['image', 'video', 'browser'] as ComposeLayerKind[]).map((k) => (
            <button
              key={k}
              onClick={(e) => { e.stopPropagation(); setOpen(false); onPick(k) }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', color: '#ddd', cursor: 'pointer', fontSize: 12 }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#2a2a2a')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
            >
              <span style={{ marginRight: 6 }}>{KIND_ICONS[k]}</span>{k}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface LayerSectionProps {
  title: string
  section: Section
  sceneId: string
  cameraNodeId: string | null
  layers: ComposeLayerRecord[]
}

function LayerSection({ title, section, sceneId, cameraNodeId, layers }: LayerSectionProps) {
  const [expanded, setExpanded] = useState(true)
  const selectedComposeLayerId = useEditorStore((s) => s.selectedComposeLayerId)
  const selectComposeLayer = useEditorStore((s) => s.selectComposeLayer)

  const stack = buildStack(layers, sceneId, cameraNodeId)

  // Insert the pinned 3D render row at the slot boundary (sceneOrder == 0 sits at the render slot).
  const rows: Array<
    | { kind: 'pinned-3d' }
    | { kind: 'layer'; layer: ComposeLayerRecord; pinned: boolean }
  > = []
  let renderInserted = false
  for (const item of stack) {
    if (!renderInserted && item.layer.sceneOrder <= SCENE_RENDER_SLOT) {
      rows.push({ kind: 'pinned-3d' })
      renderInserted = true
    }
    rows.push({ kind: 'layer', layer: item.layer, pinned: item.pinned })
  }
  if (!renderInserted) rows.push({ kind: 'pinned-3d' })

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this layer?')) return
    await api.deleteComposeLayer(id)
  }

  const handleMove = async (id: string, dir: -1 | 1) => {
    // dir = -1 moves the layer one slot forward (towards camera; smaller sceneOrder).
    // We only support moving the layer's own sceneOrder by ±1 here; finer interleave (cameraOrder)
    // will be a future enhancement when drag-and-drop lands.
    const layer = layers.find((l) => l.id === id)
    if (!layer) return
    const targetScene = layer.sceneOrder + dir
    await api.updateComposeLayer(id, { sceneOrder: targetScene })
  }

  return (
    <div>
      <div style={sectionHeaderStyle} onClick={() => setExpanded((v) => !v)}>
        <span style={{ width: 12 }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ flex: 1 }}>{title}</span>
        <span onClick={(e) => e.stopPropagation()}>
          <AddMenu onPick={(kind) => createLayer(sceneId, cameraNodeId, kind)} />
        </span>
      </div>
      {expanded && rows.map((row, idx) => {
        if (row.kind === 'pinned-3d') {
          return (
            <div key={`pinned-3d-${section}-${idx}`} style={pinnedSceneRowStyle}>
              <span style={{ width: 14 }}>🎬</span>
              <span style={{ flex: 1 }}>[3D Scene]</span>
            </div>
          )
        }
        const l = row.layer
        const selected = selectedComposeLayerId === l.id
        return (
          <div
            key={l.id}
            style={rowStyle(selected, row.pinned)}
            onClick={() => selectComposeLayer(selected ? null : l.id)}
            title={row.pinned ? 'Scene layer (pinned in camera stack)' : ''}
          >
            <span style={{ width: 14 }}>{KIND_ICONS[l.kind]}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {l.name}
            </span>
            {!row.pinned && (
              <>
                <button title="Forward" style={smallBtn} onClick={(e) => { e.stopPropagation(); handleMove(l.id, -1) }}>↑</button>
                <button title="Back"    style={smallBtn} onClick={(e) => { e.stopPropagation(); handleMove(l.id, +1) }}>↓</button>
                <button title="Delete"  style={smallBtn} onClick={(e) => { e.stopPropagation(); handleDelete(l.id) }}>×</button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function ComposeTree() {
  const nodes = useEditorStore((s) => s.nodes)
  const activeSceneId = useEditorStore((s) => s.activeSceneId)
  const composeLayers = useEditorStore((s) => s.composeLayers)
  const cameras = nodes.filter((n) => n.kind === 'camera' && n.sceneId === activeSceneId)

  if (!activeSceneId) {
    return <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>No scene selected.</div>
  }
  if (cameras.length === 0) {
    return (
      <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center', lineHeight: 1.5 }}>
        Add a camera node to start composing.<br />
        The Compose view shows what each<br />camera will broadcast.
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
      <LayerSection
        title="Scene"
        section="scene"
        sceneId={activeSceneId}
        cameraNodeId={null}
        layers={composeLayers}
      />
      {cameras.map((cam) => (
        <LayerSection
          key={cam.id}
          title={`Camera · ${cam.name}`}
          section="camera"
          sceneId={activeSceneId}
          cameraNodeId={cam.id}
          layers={composeLayers}
        />
      ))}
    </div>
  )
}
