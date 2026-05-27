import { Handle, Position, type NodeProps } from '@xyflow/react'
import { SIGNAL_TYPE_COLORS } from '@vspark/shared/signal'
import type { NodeDisplay, NodePortMeta } from '@vspark/shared/signal'
import { useEditorStore } from '../../../store/editorStore'
import { api } from '../../../api/client'

export interface SignalNodeData extends Record<string, unknown> {
  nodeId:              string
  graphId:             string
  kind:                string
  display:             NodeDisplay | undefined
  inputPorts:          NodePortMeta[]
  outputPorts:         NodePortMeta[]
  connectedInputPorts: string[]
  readonly:            boolean
  lastExecutedAt:      number | null
  portValues:          Record<string, unknown>
  config:              unknown
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function typeColor(type: string): string {
  return SIGNAL_TYPE_COLORS[type as keyof typeof SIGNAL_TYPE_COLORS] ?? '#888'
}

function RelativeTime({ ts }: { ts: number | null }) {
  if (!ts) return <span style={{ color: '#444', fontSize: 9 }}>never</span>
  const age = Date.now() - ts
  const text = age < 1000 ? `${age}ms ago` : age < 60000 ? `${(age / 1000).toFixed(1)}s ago` : 'idle'
  const fresh = age < 500
  return (
    <span style={{ fontSize: 9, color: fresh ? '#4ade80' : '#666' }}>
      {fresh && <span style={{ marginRight: 3 }}>●</span>}{text}
    </span>
  )
}

function ConfigRow({ label, value }: { label: string; value: unknown }) {
  const display = value === null || value === undefined ? '—'
    : typeof value === 'object' ? JSON.stringify(value).slice(0, 40)
    : String(value)
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'baseline', padding: '1px 10px' }}>
      <span style={{ fontSize: 9, color: '#555', fontFamily: 'monospace', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 9, color: '#888', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {display}
      </span>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Inline static input — shown on unconnected value input ports
// ──────────────────────────────────────────────────────────────────────────────

const STATIC_INPUT_TYPES = new Set(['String', 'Float', 'Bool', 'Account'])

const staticInputStyle: React.CSSProperties = {
  background: '#0e0e1a',
  border: '1px solid #333',
  color: '#ccc',
  borderRadius: 3,
  padding: '2px 5px',
  fontSize: 10,
  fontFamily: 'monospace',
  outline: 'none',
  minWidth: 0,
}

function StaticInput({ port, configValue, onChange }: {
  port:        NodePortMeta
  configValue: unknown
  onChange:    (value: unknown) => void
}) {
  if (port.type === 'Account') {
    return <AccountSelect configValue={configValue} onChange={onChange} />
  }
  if (port.type === 'Bool') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
        <input
          type="checkbox"
          defaultChecked={!!configValue}
          key={String(configValue)}
          onChange={(e) => onChange(e.target.checked)}
          style={{ cursor: 'pointer' }}
        />
        <span style={{ fontSize: 9, color: '#666' }}>{configValue ? 'true' : 'false'}</span>
      </label>
    )
  }
  return (
    <input
      type={port.type === 'Float' ? 'number' : 'text'}
      defaultValue={(configValue as string | number | undefined) ?? ''}
      key={JSON.stringify(configValue)}
      placeholder={port.type === 'Float' ? '0' : port.name}
      style={{ ...staticInputStyle, width: port.type === 'Float' ? 70 : 140 }}
      onBlur={(e) => {
        const raw = e.target.value
        onChange(port.type === 'Float' ? (parseFloat(raw) || 0) : raw)
      }}
      // Prevent ReactFlow from stealing keyboard events
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

/**
 * Account dropdown rendered for unconnected `Account` value ports. Pulls
 * the project's overlive accounts from the editor store (loaded once on
 * Editor mount and refreshed by the Accounts modal). Value persisted is
 * the account id string; an empty string clears the selection.
 */
function AccountSelect({ configValue, onChange }: {
  configValue: unknown
  onChange:    (value: unknown) => void
}) {
  const accounts = useEditorStore((s) => s.overliveAccounts)
  const current  = typeof configValue === 'string' ? configValue : ''
  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{ ...staticInputStyle, width: 180 }}
    >
      <option value="">— select account —</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.platform === 'twitch' ? '🟣' : '🟢'} {a.label}
        </option>
      ))}
    </select>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Port handle row
// ──────────────────────────────────────────────────────────────────────────────

function PortRow({ port, side, portValue, connected, configValue, onStaticChange }: {
  port:           NodePortMeta
  side:           'input' | 'output'
  portValue:      unknown
  connected:      boolean
  configValue:    unknown
  onStaticChange: (portName: string, value: unknown) => void
}) {
  const color    = typeColor(port.type)
  const id       = side === 'input' ? `in-${port.name}` : `out-${port.name}`
  const isValue  = port.portKind === 'value'
  const hasEvent = Boolean(portValue && typeof portValue === 'object' && '_event' in (portValue as object))
  const isRight  = side === 'output'
  const showStatic = side === 'input' && isValue && !connected && STATIC_INPUT_TYPES.has(port.type)

  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        display:  'flex',
        alignItems: 'center',
        justifyContent: isRight ? 'flex-end' : 'flex-start',
        padding: '2px 10px',
        gap: 4,
      }}>
        <Handle
          type={side === 'input' ? 'target' : 'source'}
          position={side === 'input' ? Position.Left : Position.Right}
          id={id}
          style={{
            background:      color,
            border:          isValue ? `2px solid ${color}` : 'none',
            backgroundColor: isValue ? 'transparent' : color,
            width:  9,
            height: 9,
            borderRadius: isValue ? 0 : 2,
            transform:    isValue ? 'rotate(45deg)' : undefined,
          }}
        />
        <span style={{ fontSize: 10, color: '#aaa', fontFamily: 'monospace', order: isRight ? -1 : 0 }}>
          {port.name}
        </span>
        <span style={{ fontSize: 8, color, opacity: 0.7, fontFamily: 'monospace' }}>
          {isValue ? '◆' : '▶'} {port.type}
        </span>
        {hasEvent && (
          <span style={{ fontSize: 8, color: '#4ade80', marginLeft: 2 }} aria-hidden>●</span>
        )}
      </div>
      {showStatic && (
        <div style={{ paddingLeft: 22, paddingRight: 10, paddingBottom: 4 }}>
          <StaticInput
            port={port}
            configValue={configValue}
            onChange={(v) => onStaticChange(port.name, v)}
          />
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Node card
// ──────────────────────────────────────────────────────────────────────────────

export function SignalNodeCard({ data, selected }: NodeProps & { data: SignalNodeData }) {
  const { nodeId, graphId, display, kind, inputPorts, outputPorts,
          connectedInputPorts, lastExecutedAt, portValues, config } = data
  const headerColor   = display?.color ?? '#2a2a3a'
  const label         = display?.label ?? kind
  const maxPorts      = Math.max(inputPorts.length, outputPorts.length)
  const connectedSet  = new Set(connectedInputPorts)
  const configRecord  = config && typeof config === 'object' ? config as Record<string, unknown> : {}

  const { nodeComponents, updateNodeComponent } = useEditorStore()

  const handleStaticChange = (portName: string, value: unknown) => {
    // Component-owned graphs use the "kind:componentId" id shape. Standalone
    // project graphs use a bare UUID — they don't have a node_components row
    // to update, so we delegate to the canvas via a custom event which mutates
    // the descriptor's defaultConfig and persists via PUT.
    if (!graphId.includes(':')) {
      window.dispatchEvent(new CustomEvent('vspark:project-graph-literal', {
        detail: { graphId, nodeId, portName, value },
      }))
      return
    }
    const componentId   = graphId.split(':').slice(1).join(':')
    const comp = nodeComponents.find((c) => c.id === componentId)
    if (!comp) return
    const prevConfig    = comp.config as Record<string, unknown>
    const prevNodeConf  = (prevConfig.nodeConfig ?? {}) as Record<string, unknown>
    const prevNodeEntry = (prevNodeConf[nodeId] ?? {}) as Record<string, unknown>
    const newConfig = {
      ...prevConfig,
      nodeConfig: { ...prevNodeConf, [nodeId]: { ...prevNodeEntry, [portName]: value } },
    }
    updateNodeComponent(componentId, { config: newConfig })
    api.updateNodeComponent(componentId, { config: newConfig }).catch(() => {})
  }

  // Config display: skip null/undefined and internal _ keys.
  const configEntries = Object.entries(configRecord)
    .filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined)

  return (
    <div style={{
      minWidth: 200,
      background: '#1a1a2a',
      border:  `1px solid ${selected ? '#4a90d9' : '#2a2a4a'}`,
      borderRadius: 6,
      boxShadow: selected ? '0 0 0 2px #4a90d944' : '0 2px 8px rgba(0,0,0,0.4)',
      fontFamily: 'system-ui, sans-serif',
    }}>
      {/* Header */}
      <div style={{
        background:   headerColor,
        borderRadius: '5px 5px 0 0',
        padding: '5px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#fff', flex: 1 }}>{label}</span>
        <RelativeTime ts={lastExecutedAt} />
        {display?.tags.map((tag) => (
          <span key={tag} style={{
            fontSize: 9, color: '#ffffff99', background: '#ffffff22',
            borderRadius: 3, padding: '1px 4px', textTransform: 'uppercase', letterSpacing: 0.3,
          }}>
            {tag}
          </span>
        ))}
      </div>

      {/* Ports */}
      {maxPorts > 0 && (
        <div style={{ padding: '4px 0' }}>
          {Array.from({ length: maxPorts }).map((_, i) => (
            <div key={i} style={{ display: 'flex' }}>
              <div style={{ flex: 1 }}>
                {inputPorts[i] && (
                  <PortRow
                    port={inputPorts[i]}
                    side="input"
                    portValue={portValues[`in:${inputPorts[i].name}`]}
                    connected={connectedSet.has(inputPorts[i].name)}
                    configValue={configRecord[inputPorts[i].name]}
                    onStaticChange={handleStaticChange}
                  />
                )}
              </div>
              <div style={{ flex: 1 }}>
                {outputPorts[i] && (
                  <PortRow
                    port={outputPorts[i]}
                    side="output"
                    portValue={portValues[`out:${outputPorts[i].name}`]}
                    connected={false}
                    configValue={undefined}
                    onStaticChange={handleStaticChange}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Config / parameter values */}
      {configEntries.length > 0 && (
        <div style={{ borderTop: '1px solid #2a2a4a', padding: '4px 0' }}>
          {configEntries.slice(0, 6).map(([k, v]) => (
            <ConfigRow key={k} label={k} value={v} />
          ))}
          {configEntries.length > 6 && (
            <div style={{ fontSize: 9, color: '#444', padding: '1px 10px' }}>
              +{configEntries.length - 6} more…
            </div>
          )}
        </div>
      )}

      {/* Kind chip */}
      <div style={{
        borderTop: '1px solid #1e1e3a',
        padding: '2px 10px',
        fontSize: 9, color: '#333', fontFamily: 'monospace', letterSpacing: 0.3,
      }}>
        {kind}
      </div>
    </div>
  )
}
