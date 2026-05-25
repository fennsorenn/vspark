import { useState, type CSSProperties, type DragEvent } from 'react'
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

const dropIndicatorStyle: CSSProperties = {
  height: 2,
  background: '#4a9eff',
  margin: '0 8px',
  borderRadius: 1,
}

// ---- Sequence model ----------------------------------------------------------
// A "slot" represents one row in a section's display.
type Slot =
  | { kind: 'pinned-3d' }
  | { kind: 'layer'; layer: ComposeLayerRecord; pinned: boolean }

/** Build the ordered list a section should render. Inserts the pinned 3D row
 *  between layers with negative sceneOrder (front) and >0 sceneOrder (back). */
function buildSequence(
  layers: ComposeLayerRecord[],
  sceneId: string,
  cameraNodeId: string | null,
): Slot[] {
  const sceneWide = layers.filter((l) => l.sceneId === sceneId && l.cameraNodeId == null)
  const camOwn = cameraNodeId
    ? layers.filter((l) => l.sceneId === sceneId && l.cameraNodeId === cameraNodeId)
    : []

  const all: { layer: ComposeLayerRecord; pinned: boolean }[] = [
    ...sceneWide.map((l) => ({ layer: l, pinned: cameraNodeId != null })),
    ...camOwn.map((l) => ({ layer: l, pinned: false })),
  ]
  // Painter order: larger sceneOrder is drawn first (further back), so the
  // top of the visible list (front of the camera) is most-negative sceneOrder.
  // Within the same sceneOrder slot, larger cameraOrder paints last (on top),
  // so it also appears at the top of the list.
  all.sort((a, b) => a.layer.sceneOrder - b.layer.sceneOrder || b.layer.cameraOrder - a.layer.cameraOrder)

  const slots: Slot[] = []
  let inserted = false
  for (const item of all) {
    if (!inserted && item.layer.sceneOrder >= SCENE_RENDER_SLOT) {
      // Insert the 3D marker before anything at or behind sceneOrder 0.
      slots.push({ kind: 'pinned-3d' })
      inserted = true
    }
    slots.push({ kind: 'layer', layer: item.layer, pinned: item.pinned })
  }
  if (!inserted) slots.push({ kind: 'pinned-3d' })
  return slots
}

/** Re-derive (sceneOrder, cameraOrder) for every layer in a section from the
 *  desired visual sequence, then return the diff of records that need updating. */
function renumberFromSequence(
  sequence: Slot[],
  section: Section,
): { id: string; sceneOrder: number; cameraOrder: number }[] {
  // Locate the 3D marker.
  const marker = sequence.findIndex((s) => s.kind === 'pinned-3d')
  if (marker < 0) return []

  const updates: { id: string; sceneOrder: number; cameraOrder: number }[] = []

  if (section === 'scene') {
    // All non-pinned items are scene-wide layers. Renumber so front items get
    // increasingly negative sceneOrder and back items increasingly positive.
    const front: ComposeLayerRecord[] = []
    const back: ComposeLayerRecord[] = []
    for (let i = 0; i < sequence.length; i++) {
      const s = sequence[i]
      if (s.kind !== 'layer') continue
      if (i < marker) front.push(s.layer)
      else back.push(s.layer)
    }
    // front: closest to top → most negative. Walk from top to marker.
    for (let i = 0; i < front.length; i++) {
      const desired = -(front.length - i)
      updates.push({ id: front[i].id, sceneOrder: desired, cameraOrder: 0 })
    }
    for (let i = 0; i < back.length; i++) {
      const desired = i + 1
      updates.push({ id: back[i].id, sceneOrder: desired, cameraOrder: 0 })
    }
    return updates
  }

  // Camera section: pinned scene layers keep their sceneOrder. Camera-own layers
  // get the sceneOrder of the nearest scene layer *below* them in the sequence
  // (i.e. behind, painted earlier). If above all scene layers, use (minSceneOrder - 1).
  // The 3D marker counts as a scene "layer" at sceneOrder = 0.
  // cameraOrder distinguishes multiple camera-own layers sharing the same anchor.

  // Collect anchors: pinned layers (and the 3D marker) ordered by position in sequence.
  // For each camera-own layer index, find the nearest anchor whose position > index;
  // adopt its sceneOrder.
  type Anchor = { pos: number; sceneOrder: number }
  const anchors: Anchor[] = []
  sequence.forEach((s, i) => {
    if (s.kind === 'pinned-3d') anchors.push({ pos: i, sceneOrder: 0 })
    else if (s.pinned) anchors.push({ pos: i, sceneOrder: s.layer.sceneOrder })
  })

  // Lowest sceneOrder among anchors (for "above all anchors" case).
  const minAnchorSO = Math.min(...anchors.map((a) => a.sceneOrder))

  // Build a map from anchor sceneOrder → camera-own layers that anchor to it, in order.
  const buckets: Map<number, string[]> = new Map()
  sequence.forEach((s, i) => {
    if (s.kind !== 'layer' || s.pinned) return
    const below = anchors.find((a) => a.pos > i)
    const so = below ? below.sceneOrder : minAnchorSO - 1
    if (!buckets.has(so)) buckets.set(so, [])
    buckets.get(so)!.push(s.layer.id)
  })

  for (const [sceneOrder, ids] of buckets) {
    // ids are ordered top-of-list (front) → bottom (back). Painter sorts cameraOrder
    // ASC, so largest cameraOrder paints last (on top). Assign decreasing cameraOrder
    // so the top-of-list ends up visually on top.
    const n = ids.length
    ids.forEach((id, idx) => {
      updates.push({ id, sceneOrder, cameraOrder: n - idx })
    })
  }
  return updates
}

/** Diff against current records and return only the rows whose order changed. */
function pruneUnchanged(
  desired: { id: string; sceneOrder: number; cameraOrder: number }[],
  current: ComposeLayerRecord[],
): typeof desired {
  return desired.filter((d) => {
    const cur = current.find((c) => c.id === d.id)
    return !cur || cur.sceneOrder !== d.sceneOrder || cur.cameraOrder !== d.cameraOrder
  })
}

// ---- Add menu ---------------------------------------------------------------

async function createLayer(sceneId: string, cameraNodeId: string | null, kind: ComposeLayerKind) {
  const defaultName = kind[0].toUpperCase() + kind.slice(1) + ' Layer'
  const name = window.prompt(`Name for new ${kind} layer:`, defaultName)
  if (!name?.trim()) return
  const config: Record<string, unknown> = kind === 'browser' ? { url: 'https://example.com' } : {}
  await api.createComposeLayer(sceneId, { name: name.trim(), kind, cameraNodeId, config })
}

interface AddMenuProps { onPick: (kind: ComposeLayerKind) => void }
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

// ---- Section ----------------------------------------------------------------

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
  const setComposeLayers = useEditorStore((s) => s.setComposeLayers)
  const composeLayers = useEditorStore((s) => s.composeLayers)

  const [dragId, setDragId] = useState<string | null>(null)
  /** Index in the visible sequence where dropping would place the dragged item.
   *  e.g. 0 means "drop before the first slot", sequence.length means "after the last." */
  const [dropAt, setDropAt] = useState<number | null>(null)

  const sequence = buildSequence(layers, sceneId, cameraNodeId)

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this layer?')) return
    await api.deleteComposeLayer(id)
  }

  /** Compute the new sequence after moving `id` to a drop position, then
   *  renumber and persist. dropAt is the index in the current `sequence` where
   *  the moved layer should be inserted (before that slot). */
  const applyMove = async (id: string, targetDropAt: number) => {
    const fromIdx = sequence.findIndex((s) => s.kind === 'layer' && s.layer.id === id)
    if (fromIdx < 0) return
    const item = sequence[fromIdx]
    if (item.kind !== 'layer') return
    if (item.pinned) return

    // Build the next sequence: remove from fromIdx, insert at targetDropAt.
    // If we remove first, the target index shifts when target > fromIdx.
    let target = targetDropAt
    if (target > fromIdx) target -= 1
    if (target === fromIdx) return // no-op

    const next = sequence.slice()
    next.splice(fromIdx, 1)
    next.splice(target, 0, item)

    const desired = renumberFromSequence(next, section)
    const updates = pruneUnchanged(desired, composeLayers)
    if (updates.length === 0) return

    // Optimistic local update so the UI reorders before the WS broadcast.
    setComposeLayers(composeLayers.map((l) => {
      const u = updates.find((x) => x.id === l.id)
      return u ? { ...l, sceneOrder: u.sceneOrder, cameraOrder: u.cameraOrder } : l
    }))
    await api.reorderComposeLayers(updates).catch(() => {})
  }

  /** ↑/↓ buttons: move dragged layer by one position in the visible sequence,
   *  treating the 3D scene marker as just another slot — so a layer can cross it. */
  const handleMoveButton = async (id: string, dir: -1 | 1) => {
    const idx = sequence.findIndex((s) => s.kind === 'layer' && s.layer.id === id)
    if (idx < 0) return
    let target = idx + dir
    if (target < 0 || target >= sequence.length) return
    // Skip past pinned items: nudge one further so we actually cross the marker
    // (otherwise dropping "at" the pinned slot is a no-op after renumber).
    // We use splice-style indexing: dropAt = target when moving up, target+1 when moving down.
    const dropAt = dir < 0 ? target : target + 1
    await applyMove(id, dropAt)
  }

  // ---- DnD handlers --------------------------------------------------------
  const onDragStart = (e: DragEvent<HTMLDivElement>, id: string) => {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    // Some browsers require setData to enable dragging.
    e.dataTransfer.setData('text/plain', id)
  }
  const onDragEnd = () => { setDragId(null); setDropAt(null) }

  /** For each visible row, hovering over the top half = drop BEFORE it,
   *  bottom half = drop AFTER it. */
  const onDragOverRow = (e: DragEvent<HTMLDivElement>, slotIdx: number) => {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const after = (e.clientY - rect.top) > rect.height / 2
    const dropIdx = after ? slotIdx + 1 : slotIdx
    setDropAt(dropIdx)
  }
  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (dragId && dropAt != null) await applyMove(dragId, dropAt)
    setDragId(null)
    setDropAt(null)
  }

  return (
    <div onDrop={onDrop} onDragLeave={() => setDropAt(null)}>
      <div style={sectionHeaderStyle} onClick={() => setExpanded((v) => !v)}>
        <span style={{ width: 12 }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ flex: 1 }}>{title}</span>
        <span onClick={(e) => e.stopPropagation()}>
          <AddMenu onPick={(kind) => createLayer(sceneId, cameraNodeId, kind)} />
        </span>
      </div>
      {expanded && sequence.map((slot, idx) => {
        const showIndicatorBefore = dropAt === idx && dragId
        const node = (() => {
          if (slot.kind === 'pinned-3d') {
            return (
              <div
                style={pinnedSceneRowStyle}
                onDragOver={(e) => onDragOverRow(e, idx)}
              >
                <span style={{ width: 14 }}>🎬</span>
                <span style={{ flex: 1 }}>[3D Scene]</span>
              </div>
            )
          }
          const l = slot.layer
          const selected = selectedComposeLayerId === l.id
          const draggable = !slot.pinned
          return (
            <div
              key={l.id}
              draggable={draggable}
              onDragStart={draggable ? (e) => onDragStart(e, l.id) : undefined}
              onDragEnd={draggable ? onDragEnd : undefined}
              onDragOver={(e) => onDragOverRow(e, idx)}
              style={{ ...rowStyle(selected, slot.pinned), opacity: dragId === l.id ? 0.4 : 1 }}
              onClick={() => selectComposeLayer(selected ? null : l.id)}
              title={slot.pinned ? 'Scene layer (pinned in camera stack)' : 'Drag to reorder'}
            >
              <span style={{ width: 14, cursor: draggable ? 'grab' : 'default', color: '#555' }}>⋮⋮</span>
              <span style={{ width: 14 }}>{KIND_ICONS[l.kind]}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
              {!slot.pinned && (
                <>
                  <button title="Forward" style={smallBtn} onClick={(e) => { e.stopPropagation(); handleMoveButton(l.id, -1) }}>↑</button>
                  <button title="Back"    style={smallBtn} onClick={(e) => { e.stopPropagation(); handleMoveButton(l.id, +1) }}>↓</button>
                  <button title="Delete"  style={smallBtn} onClick={(e) => { e.stopPropagation(); handleDelete(l.id) }}>×</button>
                </>
              )}
            </div>
          )
        })()
        return (
          <div key={slot.kind === 'pinned-3d' ? `pinned-3d-${section}-${idx}` : slot.layer.id}>
            {showIndicatorBefore && <div style={dropIndicatorStyle} />}
            {node}
            {/* Bottom drop indicator: only on the last row when dropAt == sequence.length */}
            {idx === sequence.length - 1 && dropAt === sequence.length && dragId && (
              <div style={dropIndicatorStyle} />
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
