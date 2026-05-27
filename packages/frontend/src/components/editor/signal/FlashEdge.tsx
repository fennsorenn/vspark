import { useState, useRef, useCallback } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';

export interface FlashEdgeData extends Record<string, unknown> {
  color: string;
  flashing: boolean;
  lastValue: unknown;
  label?: string;
  isValue: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tooltip
// ──────────────────────────────────────────────────────────────────────────────

function ValueTooltip({
  value,
  x,
  y,
}: {
  value: unknown;
  x: number;
  y: number;
}) {
  const text =
    value === null || value === undefined
      ? '—'
      : JSON.stringify(value, null, 2);
  const lines = text.split('\n').slice(0, 12);
  if (lines.length < text.split('\n').length) lines.push('…');

  return (
    <div
      style={{
        position: 'absolute',
        transform: `translate(-50%, -100%) translate(${x}px, ${y - 8}px)`,
        background: '#13131f',
        border: '1px solid #3a3a5a',
        borderRadius: 5,
        padding: '5px 8px',
        fontSize: 10,
        color: '#ccc',
        fontFamily: 'monospace',
        whiteSpace: 'pre',
        maxWidth: 260,
        overflow: 'hidden',
        boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
        zIndex: 1000,
        pointerEvents: 'none',
      }}
    >
      {lines.join('\n')}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Edge
// ──────────────────────────────────────────────────────────────────────────────

export function FlashEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const d = data as FlashEdgeData;
  const [tooltip, setTooltip] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const onMouseEnter = useCallback(() => {
    timerRef.current = setTimeout(() => setTooltip(true), 900);
  }, []);

  const onMouseLeave = useCallback(() => {
    clearTimeout(timerRef.current);
    setTooltip(false);
  }, []);

  const strokeWidth = d.flashing ? 3.5 : d.isValue ? 1.5 : 2;
  const glow = d.flashing ? `drop-shadow(0 0 5px ${d.color})` : 'none';

  return (
    <>
      {/* Wide invisible hit area for hover */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        style={{ cursor: 'crosshair' }}
      />

      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: d.color,
          strokeWidth,
          strokeDasharray: d.isValue ? '4 3' : undefined,
          filter: glow,
          transition: 'filter 0.5s ease-out, stroke-width 0.3s ease-out',
          pointerEvents: 'none',
        }}
      />

      {d.label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              fontSize: 9,
              color: '#555',
              pointerEvents: 'none',
            }}
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}

      {tooltip && d.lastValue !== undefined && (
        <EdgeLabelRenderer>
          <ValueTooltip value={d.lastValue} x={labelX} y={labelY} />
        </EdgeLabelRenderer>
      )}
    </>
  );
}
