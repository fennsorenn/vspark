import { useState } from 'react';
import { SIGNAL_TYPE_COLORS } from '@vspark/shared/signal';
import type { NodeKindMeta, NodePortMeta } from '@vspark/shared/signal';
import { useEditorStore } from '../../../store/editorStore';
import { BottomDockResizeHandle } from '../AssetManager';
import { PALETTE_DRAG_KIND } from './SignalGraphCanvas';

// ──────────────────────────────────────────────────────────────────────────────
// Port chip
// ──────────────────────────────────────────────────────────────────────────────

function PortChip({ port }: { port: NodePortMeta }) {
  const color =
    SIGNAL_TYPE_COLORS[port.typeTag as keyof typeof SIGNAL_TYPE_COLORS] ?? '#888';
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: 'monospace',
        color,
        background: `${color}22`,
        border: `1px solid ${color}55`,
        borderRadius: 3,
        padding: '1px 4px',
      }}
    >
      {port.name}: {port.typeTag}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Node card in palette
// ──────────────────────────────────────────────────────────────────────────────

function PaletteCard({
  meta,
  readonly,
}: {
  meta: NodeKindMeta;
  readonly: boolean;
}) {
  const { display, kind, inputPorts, outputPorts } = meta;
  const headerColor = display?.color ?? '#2a2a3a';

  const handleDragStart = (e: React.DragEvent) => {
    if (readonly) return;
    e.dataTransfer.setData(PALETTE_DRAG_KIND, kind);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      draggable={!readonly}
      onDragStart={handleDragStart}
      title={display?.description ?? kind}
      style={{
        background: '#1a1a2a',
        border: '1px solid #2a2a4a',
        borderRadius: 6,
        overflow: 'hidden',
        cursor: readonly ? 'default' : 'grab',
        userSelect: 'none',
        flexShrink: 0,
        width: 180,
      }}
    >
      <div
        style={{
          background: headerColor,
          padding: '4px 8px',
          fontSize: 11,
          fontWeight: 600,
          color: '#fff',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {display?.label ?? kind}
      </div>
      <div
        style={{
          padding: '5px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}
      >
        {display?.description && (
          <div style={{ fontSize: 10, color: '#666', marginBottom: 2 }}>
            {display.description}
          </div>
        )}
        {inputPorts.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {inputPorts.map((p) => (
              <PortChip key={p.name} port={p} />
            ))}
          </div>
        )}
        {outputPorts.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {outputPorts.map((p) => (
              <PortChip key={p.name} port={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Node palette — tabbed by tag
// ──────────────────────────────────────────────────────────────────────────────

interface Props {
  kindMeta: NodeKindMeta[];
  graphReadonly: boolean;
}

export function NodePalette({ kindMeta, graphReadonly }: Props) {
  const bottomDockHeight = useEditorStore((s) => s.bottomDockHeight);
  // Collect all unique tags, preserving insertion order. "all" tab is always first.
  const tags = [
    'all',
    ...Array.from(new Set(kindMeta.flatMap((m) => m.display?.tags ?? []))),
  ];
  const [activeTag, setActiveTag] = useState('all');

  const visible =
    activeTag === 'all'
      ? kindMeta
      : kindMeta.filter((m) => m.display?.tags.includes(activeTag));

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
    color: active ? '#e0e0e0' : '#555',
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid #4a90d9' : '2px solid transparent',
    cursor: 'pointer',
    flexShrink: 0,
  });

  return (
    <div
      style={{
        height: bottomDockHeight,
        background: '#111',
        borderTop: '1px solid #2a2a2a',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
        flexShrink: 0,
        position: 'relative',
      }}
    >
      <BottomDockResizeHandle />
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid #1e1e2e',
          padding: '0 8px',
          gap: 2,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: '#444',
            marginRight: 6,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          Nodes
        </span>
        {tags.map((tag) => (
          <button
            key={tag}
            style={tabStyle(activeTag === tag)}
            onClick={() => setActiveTag(tag)}
          >
            {tag}
          </button>
        ))}
        {graphReadonly && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              color: '#444',
              paddingRight: 8,
            }}
          >
            read-only graph
          </span>
        )}
      </div>

      {/* Cards */}
      <div
        style={{
          flex: 1,
          overflowX: 'auto',
          overflowY: 'hidden',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
        }}
      >
        {visible.length === 0 ? (
          <span style={{ color: '#444', fontSize: 12 }}>
            No nodes in this category.
          </span>
        ) : (
          visible.map((m) => (
            <PaletteCard key={m.kind} meta={m} readonly={graphReadonly} />
          ))
        )}
      </div>
    </div>
  );
}
