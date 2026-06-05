import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import {
  useEditorStore,
  type ComposeLayerRecord,
} from '../../store/editorStore';
import {
  startResize,
  startRotate,
  type ResizeEdge,
} from './composeLayerInteractions';
import { layerFrame, layerParentFrame } from './composeHitTest';

interface ComposeSelectionOverlayProps {
  viewportRef: RefObject<HTMLElement>;
  layer: ComposeLayerRecord;
}

const HANDLE_SIZE = 10;
const ROTATE_OFFSET = 28;

function pointAt(f: ReturnType<typeof layerFrame>, sx: number, sy: number) {
  // sx, sy ∈ {-1, 0, 1} pick a corner/edge offset in layer-local axes
  return {
    x: f.cx + f.ux.x * sx * f.hx + f.uy.x * sy * f.hy,
    y: f.cy + f.ux.y * sx * f.hx + f.uy.y * sy * f.hy,
  };
}

const EDGE_OFFSETS: Record<ResizeEdge, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  w: [-1, 0],
  e: [1, 0],
  sw: [-1, 1],
  s: [0, 1],
  se: [1, 1],
};

function cursorFor(edge: ResizeEdge): string {
  switch (edge) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'nw':
    case 'se':
      return 'nwse-resize';
  }
}

export function ComposeSelectionOverlay({
  viewportRef,
  layer,
}: ComposeSelectionOverlayProps) {
  const updateLayer = useEditorStore((s) => s.updateComposeLayerLocal);
  // Track this layer's active clip override so the chrome follows the same
  // x/y/rotation the rendered layer uses (ComposeLayerStack applies it too).
  const override = useEditorStore((s) => s.composeLayerOverrides[layer.id]);
  // All layers, so the frame can be composed through this layer's ancestors
  // (nested layers are positioned relative to their parent).
  const composeLayers = useEditorStore((s) => s.composeLayers);
  const [viewportRect, setViewportRect] = useState<DOMRect | null>(null);

  // Track the viewport rect (it can change with window resize / panel resize).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewportRect(el.getBoundingClientRect());
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('scroll', measure, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', measure, true);
    };
  }, [viewportRef]);

  if (!viewportRect) return null;

  // The clip override (if any) drives x/y/rotation of the rendered layer; merge
  // it so the selection frame sits exactly on the visible layer.
  const effectiveLayer: ComposeLayerRecord = override
    ? {
        ...layer,
        x: override.x ?? layer.x,
        y: override.y ?? layer.y,
        rotation: override.rotation ?? layer.rotation,
      }
    : layer;
  const byId = new Map(composeLayers.map((l) => [l.id, l] as const));
  const f = layerFrame(viewportRect, effectiveLayer, byId);
  // The frame of this layer's parent (or the viewport) — the basis for '%'
  // resize math and screen→local delta projection.
  const pf = layerParentFrame(viewportRect, effectiveLayer, byId);
  const parentFrame = {
    width: pf.hx * 2,
    height: pf.hy * 2,
    angle: pf.angle,
  };
  const apply = (patch: Partial<ComposeLayerRecord>) =>
    updateLayer(layer.id, patch);

  // Outline path (4 corners) for a polygon outline so we get rotated borders.
  const corners = [
    pointAt(f, -1, -1),
    pointAt(f, 1, -1),
    pointAt(f, 1, 1),
    pointAt(f, -1, 1),
  ];

  // Containing div fills the viewport and is pointer-events: none so it never
  // intercepts clicks meant for layers. Individual chrome elements opt in.
  const baseStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 100,
    pointerEvents: 'none',
    overflow: 'visible',
  };

  const handleStyleAt = (
    pt: { x: number; y: number },
    cursor: string,
    extra: CSSProperties = {}
  ): CSSProperties => ({
    position: 'absolute',
    left: pt.x - HANDLE_SIZE / 2,
    top: pt.y - HANDLE_SIZE / 2,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: '#4a9eff',
    border: '1px solid #fff',
    borderRadius: 2,
    cursor,
    pointerEvents: 'auto',
    boxSizing: 'border-box',
    ...extra,
  });

  // Rotation handle sits ROTATE_OFFSET above the top edge midpoint, in layer-local space.
  const rotPos = {
    x: f.cx - f.uy.x * (f.hy + ROTATE_OFFSET),
    y: f.cy - f.uy.y * (f.hy + ROTATE_OFFSET),
  };
  const topMid = pointAt(f, 0, -1);

  return (
    <div style={baseStyle}>
      {/* SVG outline so rotation comes for free. */}
      <svg
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          overflow: 'visible',
        }}
      >
        <polygon
          points={corners.map((c) => `${c.x},${c.y}`).join(' ')}
          fill="none"
          stroke="#4a9eff"
          strokeWidth={1}
        />
        <line
          x1={topMid.x}
          y1={topMid.y}
          x2={rotPos.x}
          y2={rotPos.y}
          stroke="#4a9eff"
          strokeWidth={1}
        />
      </svg>

      {/* Drag-move is handled by the capture overlay underneath this chrome.
          We no longer mount a drag body here — clicks and drags on the layer's
          body flow through the capture overlay's unified routing. */}

      {/* Resize handles */}
      {(Object.keys(EDGE_OFFSETS) as ResizeEdge[]).map((edge) => {
        const [sx, sy] = EDGE_OFFSETS[edge];
        const pt = pointAt(f, sx, sy);
        return (
          <div
            key={edge}
            style={handleStyleAt(pt, cursorFor(edge))}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              // startResize uses screen-space deltas and writes into
              // width/height/x/y. The parent frame supplies the '%' basis and
              // the parent's rotation so nested layers resize relative to it.
              startResize(
                { clientX: e.clientX, clientY: e.clientY },
                layer,
                edge,
                apply,
                parentFrame
              );
            }}
          />
        );
      })}

      {/* Rotation handle (white circle) */}
      <div
        style={handleStyleAt(rotPos, 'grab', {
          background: '#fff',
          borderColor: '#4a9eff',
          borderRadius: '50%',
        })}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startRotate(
            { clientX: e.clientX, clientY: e.clientY },
            layer,
            { x: viewportRect.left + f.cx, y: viewportRect.top + f.cy },
            apply
          );
        }}
      />
    </div>
  );
}
