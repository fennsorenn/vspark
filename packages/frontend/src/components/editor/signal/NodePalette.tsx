import { useState, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { SIGNAL_TYPE_COLORS } from '@vspark/shared/signal';
import type { NodeKindMeta, NodePortMeta } from '@vspark/shared/signal';
import { useEditorStore } from '../../../store/editorStore';
import { BottomDockResizeHandle } from '../AssetManager';
import { PALETTE_DRAG_KIND } from './SignalGraphCanvas';
import { HelpButton } from '../../../help/HelpButton';
import { useEscapeKey } from '../../../hooks/useEscapeKey';

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
// Per-node documentation popover — full description + a complete inputs/outputs
// reference (type + value-vs-event meaning), generated from the node metadata.
// ──────────────────────────────────────────────────────────────────────────────

function PortDocRow({ port }: { port: NodePortMeta }) {
  const { t } = useTranslation('signalGraph');
  const color = portColor(port.typeTag);
  const transport =
    port.transport === 'event'
      ? t('nodeDoc.event')
      : port.transport === 'list'
        ? t('nodeDoc.list')
        : t('nodeDoc.value');
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '3px 0',
      }}
    >
      <span style={{ alignSelf: 'center' }}>
        <PortPin port={port} />
      </span>
      <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#e0e0e0' }}>
        {port.name}
      </span>
      <span
        style={{ fontSize: 11, fontFamily: 'monospace', color, opacity: 0.9 }}
      >
        {port.typeTag}
      </span>
      <span style={{ fontSize: 10, color: '#777', marginLeft: 'auto' }}>
        {transport}
      </span>
    </div>
  );
}

function NodeDocPopover({
  meta,
  onClose,
}: {
  meta: NodeKindMeta;
  onClose: () => void;
}) {
  const { t } = useTranslation('signalGraph');
  const { display, kind, inputPorts, outputPorts } = meta;
  useEscapeKey(onClose);
  return createPortal(
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          width: 'min(440px, calc(100vw - 32px))',
          maxHeight: 'calc(100vh - 80px)',
          overflowY: 'auto',
          background: '#16161f',
          border: '1px solid #2a2a4a',
          borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,.6)',
          color: '#e0e0e0',
        }}
      >
        <div
          style={{
            background: display?.color ?? '#2a2a3a',
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>
            {display?.label ?? kind}
          </span>
          <span
            style={{
              fontSize: 10,
              fontFamily: 'monospace',
              color: 'rgba(255,255,255,0.6)',
            }}
          >
            {kind}
          </span>
          <button
            onClick={onClose}
            title={t('nodeDoc.close')}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.8)',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: '#bbb' }}>
            {display?.description ?? t('nodeDoc.noDescription')}
          </div>

          <div style={sectionLabelStyle}>{t('nodeDoc.inputs')}</div>
          {inputPorts.length > 0 ? (
            inputPorts.map((p) => <PortDocRow key={p.name} port={p} />)
          ) : (
            <div style={emptyPortStyle}>{t('nodeDoc.noInputs')}</div>
          )}

          <div style={sectionLabelStyle}>{t('nodeDoc.outputs')}</div>
          {outputPorts.length > 0 ? (
            outputPorts.map((p) => <PortDocRow key={p.name} port={p} />)
          ) : (
            <div style={emptyPortStyle}>{t('nodeDoc.noOutputs')}</div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#666',
  marginTop: 14,
  marginBottom: 4,
};

const emptyPortStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#555',
  fontStyle: 'italic',
  padding: '2px 0',
};

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
  const { t } = useTranslation('signalGraph');
  const { display, kind, inputPorts, outputPorts } = meta;
  const headerColor = display?.color ?? '#2a2a3a';
  const maxPorts = Math.max(inputPorts.length, outputPorts.length);
  const [docOpen, setDocOpen] = useState(false);

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
          padding: '4px 4px 4px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            fontWeight: 600,
            color: '#fff',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {display?.label ?? kind}
        </span>
        <button
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setDocOpen(true);
          }}
          title={t('nodeDoc.openTitle')}
          style={{
            flexShrink: 0,
            width: 15,
            height: 15,
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(255,255,255,0.18)',
            color: '#fff',
            fontSize: 10,
            lineHeight: 1,
            cursor: 'pointer',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ?
        </button>
      </div>
      {docOpen && (
        <NodeDocPopover meta={meta} onClose={() => setDocOpen(false)} />
      )}
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
