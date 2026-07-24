import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from 'react';
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
import { getSnapGuides, subscribeSnapGuides } from './composeSnap';

interface ComposeSelectionOverlayProps {
  viewportRef: RefObject<HTMLElement>;
  layer: ComposeLayerRecord;
  /** Stage scale (letterbox fit). Chrome renders inside the scaled stage, so
   *  frames are computed in canonical px and chrome sizes are divided by this
   *  to stay a constant on-screen size. */
  scale: number;
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
  scale,
}: ComposeSelectionOverlayProps) {
  const updateLayer = useEditorStore((s) => s.updateComposeLayerLocal);
  // Track this layer's active clip override so the chrome follows the same
  // x/y/rotation the rendered layer uses (ComposeLayerStack applies it too).
  const override = useEditorStore((s) => s.composeLayerOverrides[layer.id]);
  // All layers, so the frame can be composed through this layer's ancestors
  // (nested layers are positioned relative to their parent).
  const composeLayers = useEditorStore((s) => s.composeLayers);
  const snap = useSyncExternalStore(subscribeSnapGuides, getSnapGuides);
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
    // Re-measure when the stage scale changes (the stage's layout box is
    // constant, so a ResizeObserver alone wouldn't catch a transform change).
  }, [viewportRef, scale]);

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
  // This overlay renders INSIDE the scaled compose stage, so it works in the
  // stage's canonical pixel space; the stage's CSS transform scales the chrome
  // to screen. viewportRect is the on-screen (scaled) stage rect, so canonical
  // dims are its size / stage scale. Chrome element sizes are divided by the
  // scale so they stay a constant on-screen size regardless of zoom.
  const s = scale || 1;
  const canonViewport = {
    width: viewportRect.width / s,
    height: viewportRect.height / s,
  };
  const byId = new Map(composeLayers.map((l) => [l.id, l] as const));
  const f = layerFrame(canonViewport, effectiveLayer, byId);
  // The frame of this layer's parent (or the viewport) — the basis for '%'
  // resize math and screen→local delta projection.
  const pf = layerParentFrame(canonViewport, effectiveLayer, byId);
  const parentFrame = {
    width: pf.hx * 2,
    height: pf.hy * 2,
    angle: pf.angle,
    scale: s,
  };
  // On-screen sizes for the chrome, expressed in canonical px (÷ scale) so the
  // stage transform renders them at a constant screen size.
  const handleSize = HANDLE_SIZE / s;
  const rotateOffset = ROTATE_OFFSET / s;
  const strokeW = 1 / s;
  const apply = (patch: Partial<ComposeLayerRecord>) =>
    updateLayer(layer.id, patch);

  // Snap guide lines. `snap` positions are in the parent box's local px; project
  // them through the parent frame (handles a rotated / nested parent) so the
  // line spans the parent box in viewport space.
  const pw = pf.hx * 2;
  const ph = pf.hy * 2;
  const projParent = (lx: number, ly: number) => ({
    x: pf.cx + pf.ux.x * (lx - pf.hx) + pf.uy.x * (ly - pf.hy),
    y: pf.cy + pf.ux.y * (lx - pf.hx) + pf.uy.y * (ly - pf.hy),
  });
  const guideSegments = [
    ...snap.vx.map((gx) => [projParent(gx, 0), projParent(gx, ph)] as const),
    ...snap.hy.map((gy) => [projParent(0, gy), projParent(pw, gy)] as const),
  ];

  // Outline path (4 corners) for a polygon outline so we get rotated borders.
  const corners = [
    pointAt(f, -1, -1),
    pointAt(f, 1, -1),
    pointAt(f, 1, 1),
    pointAt(f, -1, 1),
  ];

  // Container ancestors of the selected layer — draw their bounds (dashed) so
  // the user can see which boxes the selection is nested inside. The
  // compose_scene root is the whole canvas, so it's excluded.
  const ancestorOutlines: { x: number; y: number }[][] = [];
  {
    const guard = new Set<string>([effectiveLayer.id]);
    let cur = effectiveLayer.parentId
      ? byId.get(effectiveLayer.parentId)
      : undefined;
    while (cur && !guard.has(cur.id) && cur.kind !== 'compose_scene') {
      guard.add(cur.id);
      const af = layerFrame(viewportRect, cur, byId);
      ancestorOutlines.push([
        pointAt(af, -1, -1),
        pointAt(af, 1, -1),
        pointAt(af, 1, 1),
        pointAt(af, -1, 1),
      ]);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }

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
    left: pt.x - handleSize / 2,
    top: pt.y - handleSize / 2,
    width: handleSize,
    height: handleSize,
    background: '#4a9eff',
    border: `${strokeW}px solid #fff`,
    borderRadius: 2 / s,
    cursor,
    pointerEvents: 'auto',
    boxSizing: 'border-box',
    ...extra,
  });

  // Rotation handle sits rotateOffset above the top edge midpoint, in layer-local space.
  const rotPos = {
    x: f.cx - f.uy.x * (f.hy + rotateOffset),
    y: f.cy - f.uy.y * (f.hy + rotateOffset),
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
        {/* Container ancestor bounds (dashed, dimmer) — drawn under the
            selected layer's outline so the selection stays visually primary. */}
        {ancestorOutlines.map((pts, i) => (
          <polygon
            key={i}
            points={pts.map((c) => `${c.x},${c.y}`).join(' ')}
            fill="none"
            stroke="#4a9eff"
            strokeOpacity={0.4}
            strokeWidth={strokeW}
            strokeDasharray={`${5 / s} ${4 / s}`}
          />
        ))}
        {/* Snap guide lines (parent edges / centre) — drawn while dragging. */}
        {guideSegments.map(([a, b], i) => (
          <line
            key={`snap-${i}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="#ff3d8b"
            strokeWidth={strokeW}
            strokeDasharray={`${4 / s} ${3 / s}`}
          />
        ))}
        <polygon
          points={corners.map((c) => `${c.x},${c.y}`).join(' ')}
          fill="none"
          stroke="#4a9eff"
          strokeWidth={strokeW}
        />
        <line
          x1={topMid.x}
          y1={topMid.y}
          x2={rotPos.x}
          y2={rotPos.y}
          stroke="#4a9eff"
          strokeWidth={strokeW}
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
            // f.cx/f.cy are canonical; map to on-screen client coords (the
            // space startRotate compares the pointer against).
            { x: viewportRect.left + f.cx * s, y: viewportRect.top + f.cy * s },
            apply
          );
        }}
      />
    </div>
  );
}
