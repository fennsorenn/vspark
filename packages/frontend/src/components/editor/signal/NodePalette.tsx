import { useState, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { SIGNAL_TYPE_COLORS } from '@vspark/shared/signal';
import type { NodeKindMeta, NodePortMeta } from '@vspark/shared/signal';
import { useEditorStore } from '../../../store/editorStore';
import { BottomDockResizeHandle } from '../AssetManager';
import { PALETTE_DRAG_KIND } from './SignalGraphCanvas';
import { HelpButton } from '../../../help/HelpButton';

// ──────────────────────────────────────────────────────────────────────────────
// Port row — mirrors the on-canvas node so the palette previews a node's shape:
// inputs on the left (pin first), outputs on the right (pin last). The pin is a
// hollow diamond for value/data ports and a filled dot for event/trigger ports,
// matching the handles drawn on the real node.
// ──────────────────────────────────────────────────────────────────────────────

function portColor(typeTag: string): string {
  return (
    SIGNAL_TYPE_COLORS[typeTag as keyof typeof SIGNAL_TYPE_COLORS] ?? '#888'
  );
}

function PortPin({ port }: { port: NodePortMeta }) {
  const color = portColor(port.typeTag);
  const isValue = port.transport === 'value';
  return (
    <span
      style={{
        width: 7,
        height: 7,
        flexShrink: 0,
        background: isValue ? 'transparent' : color,
        border: isValue ? `1.5px solid ${color}` : 'none',
        borderRadius: isValue ? 1 : '50%',
        transform: isValue ? 'rotate(45deg)' : undefined,
      }}
    />
  );
}

function PortRow({
  port,
  side,
}: {
  port: NodePortMeta;
  side: 'input' | 'output';
}) {
  const color = portColor(port.typeTag);
  const isRight = side === 'output';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        justifyContent: isRight ? 'flex-end' : 'flex-start',
      }}
    >
      {!isRight && <PortPin port={port} />}
      <span
        title={`${port.name}: ${port.typeTag}`}
        style={{
          fontSize: 9,
          fontFamily: 'monospace',
          color: '#bbb',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}
      >
        {port.name}
        <span style={{ color, opacity: 0.8 }}> {port.typeTag}</span>
      </span>
      {isRight && <PortPin port={port} />}
    </div>
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
  const maxPorts = Math.max(inputPorts.length, outputPorts.length);

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
        alignSelf: 'flex-start',
        width: 192,
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
          padding: '6px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
        }}
      >
        {display?.description && (
          <div
            style={{
              fontSize: 10,
              color: '#777',
              lineHeight: 1.35,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {display.description}
          </div>
        )}
        {maxPorts > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              columnGap: 8,
              rowGap: 3,
            }}
          >
            {Array.from({ length: maxPorts }).map((_, i) => (
              <Fragment key={i}>
                <div style={{ minWidth: 0 }}>
                  {inputPorts[i] && (
                    <PortRow port={inputPorts[i]} side="input" />
                  )}
                </div>
                <div style={{ minWidth: 0 }}>
                  {outputPorts[i] && (
                    <PortRow port={outputPorts[i]} side="output" />
                  )}
                </div>
              </Fragment>
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

// Canonical category order so the tab strip reads consistently regardless of
// node registration order. Any tag not listed here is appended after these.
const TAG_ORDER = [
  'input',
  'mocap',
  'math',
  'output',
  'scene',
  'clips',
  'overlive',
  'utility',
];

export function NodePalette({ kindMeta, graphReadonly }: Props) {
  const { t } = useTranslation('signalGraph');
  const bottomDockHeight = useEditorStore((s) => s.bottomDockHeight);
  // Collect unique tags and order them canonically. "all" tab is always first.
  const present = new Set(kindMeta.flatMap((m) => m.display?.tags ?? []));
  const tags = [
    'all',
    ...TAG_ORDER.filter((tag) => present.has(tag)),
    ...[...present].filter((tag) => !TAG_ORDER.includes(tag)).sort(),
  ];
  const [activeTag, setActiveTag] = useState('all');
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const matchesQuery = (m: NodeKindMeta) =>
    (m.display?.label ?? m.kind).toLowerCase().includes(q) ||
    m.kind.toLowerCase().includes(q) ||
    (m.display?.description ?? '').toLowerCase().includes(q);

  // A search spans every category (ignoring the active tab) so nodes are always
  // findable by name; without a query we fall back to the selected category.
  const visible = q
    ? kindMeta.filter(matchesQuery)
    : activeTag === 'all'
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
          gap: 6,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: '#444',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            flexShrink: 0,
          }}
        >
          {t('palette.header')}
        </span>
        {/* Scrollable category strip — never clips, even with many categories. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            flex: 1,
            minWidth: 0,
            overflowX: 'auto',
            scrollbarWidth: 'thin',
          }}
        >
          {tags.map((tag) => (
            <button
              key={tag}
              style={tabStyle(activeTag === tag && !q)}
              onClick={() => {
                setActiveTag(tag);
                setQuery('');
              }}
            >
              {t(`palette.tags.${tag}`, { defaultValue: tag })}
            </button>
          ))}
        </div>
        {/* Search filters across every category. */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('palette.searchPlaceholder')}
          style={{
            flexShrink: 0,
            width: 150,
            background: '#1a1a2a',
            border: '1px solid #2a2a4a',
            borderRadius: 4,
            color: '#e0e0e0',
            fontSize: 11,
            padding: '3px 8px',
            outline: 'none',
          }}
        />
        {graphReadonly && (
          <span
            style={{
              fontSize: 10,
              color: '#444',
              flexShrink: 0,
            }}
          >
            {t('palette.readOnly')}
          </span>
        )}
        <HelpButton
          topic="logic"
          anchor="nodes"
          tip={t('help.nodes')}
          style={{ flexShrink: 0 }}
        />
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
            {q ? t('palette.noMatch', { query }) : t('palette.empty')}
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
