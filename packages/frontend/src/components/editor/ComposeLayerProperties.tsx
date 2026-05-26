import { type CSSProperties } from 'react'
import { useEditorStore, type ComposeLayerRecord } from '../../store/editorStore'
import { api } from '../../api/client'
import type { ComposeAnchorH, ComposeAnchorV } from '../../api/client'
import { useTrackClipRecorder } from '../../hooks/useTrackClipRecorder'
import { NumInput, VecInput, SliderInput } from './numericInputs'

// The old `numInput` / `NumberField` / `KfBtn` helpers were removed when the
// numeric controls were unified — see ./numericInputs.tsx.

const textInput: CSSProperties = {
  width: '100%',
  background: '#2a2a2a',
  border: '1px solid #3a3a3a',
  color: '#e0e0e0',
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
}

const sectionHeader: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
  marginTop: 16,
}

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 6,
}

const label: CSSProperties = {
  fontSize: 12,
  color: '#bbb',
  width: 56,
  flexShrink: 0,
}

const select: CSSProperties = {
  background: '#2a2a2a',
  border: '1px solid #3a3a3a',
  color: '#e0e0e0',
  borderRadius: 4,
  padding: '3px 6px',
  fontSize: 12,
  outline: 'none',
}

export function ComposeLayerProperties({ layer }: { layer: ComposeLayerRecord }) {
  const assets = useEditorStore((s) => s.assets)
  const updateLayerLocal = useEditorStore((s) => s.updateComposeLayerLocal)
  const nodes = useEditorStore((s) => s.nodes)
  const { canRecord, recordKeyframe, recordKeyframes } = useTrackClipRecorder()

  const cameraNode = layer.cameraNodeId ? nodes.find((n) => n.id === layer.cameraNodeId) : null
  const scopeLabel = layer.cameraNodeId
    ? `Camera · ${cameraNode?.name ?? 'unknown'}`
    : 'Scene-wide (all cameras)'

  const commit = (patch: Partial<ComposeLayerRecord>) => {
    updateLayerLocal(layer.id, patch)
    api.updateComposeLayer(layer.id, patch).catch(() => {})
  }

  const compatibleAssets = assets.filter((a) => {
    if (layer.kind === 'image') return a.kind === 'image'
    if (layer.kind === 'video') return a.mimeType.startsWith('video/')
    return false
  })

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 18 }}>{layer.kind === 'image' ? '🖼' : layer.kind === 'video' ? '🎞' : '🌐'}</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{layer.name}</div>
          <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>{scopeLabel}</div>
        </div>
      </div>

      <div style={sectionHeader}>Name</div>
      <input
        type="text"
        value={layer.name}
        onChange={(e) => updateLayerLocal(layer.id, { name: e.target.value })}
        onBlur={(e) => api.updateComposeLayer(layer.id, { name: e.target.value }).catch(() => {})}
        style={textInput}
      />

      <div style={sectionHeader}>Position</div>
      <VecInput
        values={[layer.x, layer.y]}
        labels={['X', 'Y']}
        step={1}
        onChange={(_next, axis) => {
          // Suppress any active clip override so the typed value isn't masked.
          const paramPath = axis === 0 ? 'x' : 'y'
          useEditorStore.getState().suppressOverride('compose_layer', layer.id, paramPath)
        }}
        onCommit={(next, axis) => commit(axis === 0 ? { x: next[0] } : { y: next[1] })}
        canRecord={canRecord}
        onSetAxisKeyframe={(axis, value) => {
          const paramPath = axis === 0 ? 'x' : 'y'
          return recordKeyframe({ targetKind: 'compose_layer', targetId: layer.id, paramPath, value })
        }}
        onSetGroupKeyframe={() => recordKeyframes([
          { targetKind: 'compose_layer', targetId: layer.id, paramPath: 'x', value: layer.x },
          { targetKind: 'compose_layer', targetId: layer.id, paramPath: 'y', value: layer.y },
        ])}
      />
      <div style={row}>
        <span style={label}>Anchor</span>
        <select
          value={layer.anchorH}
          onChange={(e) => commit({ anchorH: e.target.value as ComposeAnchorH })}
          style={select}
        >
          <option value="left">Left</option>
          <option value="right">Right</option>
        </select>
        <select
          value={layer.anchorV}
          onChange={(e) => commit({ anchorV: e.target.value as ComposeAnchorV })}
          style={select}
        >
          <option value="top">Top</option>
          <option value="bottom">Bottom</option>
        </select>
      </div>

      <div style={sectionHeader}>Size</div>
      <VecInput
        values={[layer.width, layer.height]}
        labels={['W', 'H']}
        step={1}
        min={[8, 8]}
        onCommit={(next, axis) => commit(axis === 0 ? { width: next[0] } : { height: next[1] })}
      />

      <div style={sectionHeader}>Rotation</div>
      <NumInput
        value={layer.rotation}
        step={1}
        prefix="∠"
        suffix="°"
        onChange={() => useEditorStore.getState().suppressOverride('compose_layer', layer.id, 'rotation')}
        onCommit={(v) => commit({ rotation: v })}
        canRecord={canRecord}
        onSetKeyframe={(value) => recordKeyframe({ targetKind: 'compose_layer', targetId: layer.id, paramPath: 'rotation', value })}
        style={{ width: 110 }}
      />

      <div style={sectionHeader}>Visibility</div>
      <div style={row}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#bbb' }}>
          <input
            type="checkbox"
            checked={layer.visible}
            onChange={(e) => commit({ visible: e.target.checked })}
          />
          Visible
        </label>
      </div>
      <div style={row}>
        <span style={label}>Opacity</span>
        <SliderInput
          value={typeof layer.config.opacity === 'number' ? layer.config.opacity : 1}
          min={0} max={1} step={0.01}
          precision={2}
          onChange={(o) => commit({ config: { ...layer.config, opacity: o } })}
          style={{ flex: 1 }}
        />
      </div>

      {(layer.kind === 'image' || layer.kind === 'video') && (
        <>
          <div style={sectionHeader}>{layer.kind === 'image' ? 'Image asset' : 'Video asset'}</div>
          <select
            value={layer.assetId ?? ''}
            onChange={(e) => commit({ assetId: e.target.value || null })}
            style={{ ...select, width: '100%' }}
          >
            <option value="">— none —</option>
            {compatibleAssets.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <div style={{ ...row, marginTop: 6 }}>
            <span style={label}>Fit</span>
            <select
              value={(layer.config.objectFit as string | undefined) ?? 'cover'}
              onChange={(e) => commit({ config: { ...layer.config, objectFit: e.target.value } })}
              style={select}
            >
              <option value="cover">cover</option>
              <option value="contain">contain</option>
              <option value="fill">fill</option>
            </select>
          </div>
        </>
      )}

      {layer.kind === 'browser' && (
        <>
          <div style={sectionHeader}>URL</div>
          <input
            type="text"
            value={(layer.config.url as string | undefined) ?? ''}
            onChange={(e) => updateLayerLocal(layer.id, { config: { ...layer.config, url: e.target.value } })}
            onBlur={(e) => api.updateComposeLayer(layer.id, { config: { ...layer.config, url: e.target.value } }).catch(() => {})}
            placeholder="https://…"
            style={textInput}
          />
        </>
      )}

      <div style={sectionHeader}>Stack order</div>
      <div style={row}>
        <NumInput
          value={layer.sceneOrder}
          prefix="Scene"
          step={1}
          precision={0}
          onCommit={(v) => commit({ sceneOrder: Math.round(v) })}
          style={{ flex: 1 }}
        />
        <NumInput
          value={layer.cameraOrder}
          prefix="Cam"
          step={1}
          precision={0}
          onCommit={(v) => commit({ cameraOrder: Math.round(v) })}
          style={{ flex: 1 }}
        />
      </div>
      <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4, marginTop: -2 }}>
        scene_order &lt; 0 = in front of 3D · 0 = at 3D · &gt; 0 = behind 3D
      </div>
    </>
  )
}
