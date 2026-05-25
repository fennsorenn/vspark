import { useEffect, useState, type CSSProperties } from 'react'
import { useEditorStore, type ComposeLayerRecord } from '../../store/editorStore'
import { api } from '../../api/client'
import type { ComposeAnchorH, ComposeAnchorV } from '../../api/client'

const numInput: CSSProperties = {
  width: 64,
  background: '#2a2a2a',
  border: '1px solid #3a3a3a',
  color: '#e0e0e0',
  borderRadius: 4,
  padding: '3px 6px',
  fontSize: 12,
  outline: 'none',
  textAlign: 'right',
}

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

function NumberField({ value, onCommit, step = 1 }: { value: number; onCommit: (n: number) => void; step?: number }) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  return (
    <input
      type="number"
      value={text}
      step={step}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text)
        if (Number.isFinite(n) && n !== value) onCommit(n)
        else setText(String(value))
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      style={numInput}
    />
  )
}

export function ComposeLayerProperties({ layer }: { layer: ComposeLayerRecord }) {
  const assets = useEditorStore((s) => s.assets)
  const updateLayerLocal = useEditorStore((s) => s.updateComposeLayerLocal)
  const nodes = useEditorStore((s) => s.nodes)

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
      <div style={row}>
        <span style={label}>X</span>
        <NumberField value={layer.x} onCommit={(n) => commit({ x: n })} />
        <span style={label}>Y</span>
        <NumberField value={layer.y} onCommit={(n) => commit({ y: n })} />
      </div>
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
      <div style={row}>
        <span style={label}>W</span>
        <NumberField value={layer.width} onCommit={(n) => commit({ width: Math.max(8, n) })} />
        <span style={label}>H</span>
        <NumberField value={layer.height} onCommit={(n) => commit({ height: Math.max(8, n) })} />
      </div>

      <div style={sectionHeader}>Rotation</div>
      <div style={row}>
        <span style={label}>Deg</span>
        <NumberField value={layer.rotation} step={1} onCommit={(n) => commit({ rotation: n })} />
      </div>

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
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={typeof layer.config.opacity === 'number' ? layer.config.opacity : 1}
          onChange={(e) => {
            const o = Number(e.target.value)
            commit({ config: { ...layer.config, opacity: o } })
          }}
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
        <span style={label}>Scene</span>
        <NumberField value={layer.sceneOrder} onCommit={(n) => commit({ sceneOrder: n })} />
        <span style={label}>Camera</span>
        <NumberField value={layer.cameraOrder} onCommit={(n) => commit({ cameraOrder: n })} />
      </div>
      <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4, marginTop: -2 }}>
        scene_order &lt; 0 = in front of 3D · 0 = at 3D · &gt; 0 = behind 3D
      </div>
    </>
  )
}
