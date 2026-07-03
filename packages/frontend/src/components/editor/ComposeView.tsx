import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  useEditorStore,
  type ComposeLayerRecord,
} from '../../store/editorStore';
import { ComposeLayerStack } from './ComposeLayerStack';
import { ComposeSelectionOverlay } from './ComposeSelectionOverlay';
import { ComposeEventCapture } from './ComposeEventCapture';
import {
  composeViewportRect,
  composeStageScale,
  layersAtClientPoint,
  layerFrame,
} from './composeHitTest';
import { api } from '../../api/client';
import { uniqueName } from './createKinds';
import { NumInput } from './numericInputs';

/** Fallback canonical compose resolution when a scene has none set. */
export const DEFAULT_COMPOSE_WIDTH = 1920;
export const DEFAULT_COMPOSE_HEIGHT = 1080;

/** Resolve a compose scene's canonical resolution, falling back to the default. */
export function composeSceneResolution(scene: {
  width?: number;
  height?: number;
} | null | undefined): { width: number; height: number } {
  return {
    width: scene?.width && scene.width > 0 ? scene.width : DEFAULT_COMPOSE_WIDTH,
    height:
      scene?.height && scene.height > 0 ? scene.height : DEFAULT_COMPOSE_HEIGHT,
  };
}

/** A fixed-resolution compose stage, letterbox scale-to-fit into its container.
 *  Non-interactive — used by the viewer (and internally mirrored by the editor,
 *  which needs refs + overlays inside the stage). */
export function ComposeStage({
  canonW,
  canonH,
  background = 'transparent',
  children,
}: {
  canonW: number;
  canonH: number;
  background?: string;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      setScale(Math.min(r.width / canonW, r.height / canonH));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canonW, canonH]);
  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: canonW,
          height: canonH,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: 'center center',
          background,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function ComposeView() {
  const { t } = useTranslation('compose');
  const activeComposeSceneId = useEditorStore((s) => s.activeComposeSceneId);
  const composeScenes = useEditorStore((s) => s.composeScenes);
  const composeLayers = useEditorStore((s) => s.composeLayers);
  const assets = useEditorStore((s) => s.assets);
  const projectId = useEditorStore((s) => s.projectId);
  const addAsset = useEditorStore((s) => s.addAsset);
  const addComposeLayer = useEditorStore((s) => s.addComposeLayer);
  const updateComposeLayerLocal = useEditorStore(
    (s) => s.updateComposeLayerLocal
  );
  const selectComposeLayer = useEditorStore((s) => s.selectComposeLayer);
  const updateComposeSceneLocal = useEditorStore(
    (s) => s.updateComposeSceneLocal
  );
  const selectedComposeLayerId = useEditorStore(
    (s) => s.selectedComposeLayerId
  );

  // The outer container holds the letterboxed, fixed-resolution stage. Layer
  // coordinates live in the stage's canonical pixel space; the stage is CSS
  // scale-to-fit into whatever space the container has.
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  // OS image-file drag-and-drop onto the viewport. `dropTarget` drives the
  // highlight: a layer id (drop replaces that image layer's asset) or 'new'
  // (drop creates a new image layer at the cursor).
  const [dropTarget, setDropTarget] = useState<string | 'new' | null>(null);
  const [isDropping, setIsDropping] = useState(false);

  const selectedLayer =
    composeLayers.find((l) => l.id === selectedComposeLayerId) ?? null;

  const composeScene =
    composeScenes.find((s) => s.id === activeComposeSceneId) ?? null;

  // Canonical stage resolution (per compose scene; defaults to 1920×1080).
  const canonW =
    composeScene?.width && composeScene.width > 0
      ? composeScene.width
      : DEFAULT_COMPOSE_WIDTH;
  const canonH =
    composeScene?.height && composeScene.height > 0
      ? composeScene.height
      : DEFAULT_COMPOSE_HEIGHT;

  // Fit the canonical stage into the container (letterbox scale-to-fit). Track
  // the container size and recompute on resize.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const s = Math.min(r.width / canonW, r.height / canonH);
      scaleRef.current = s;
      setScale(s);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canonW, canonH]);

  // Install module-level getters so the capture/pick helpers can resolve the
  // stage rect and its scale without prop-drilling.
  useEffect(() => {
    composeViewportRect.current = () =>
      stageRef.current?.getBoundingClientRect() ?? null;
    composeStageScale.current = () => scaleRef.current;
    return () => {
      composeViewportRect.current = null;
      composeStageScale.current = null;
    };
  }, []);

  // All layers in the active compose scene. 3D output is itself a camera_view
  // layer, so there's no separate camera filter anymore.
  const stackLayers = useMemo(
    () =>
      composeLayers.filter((l) => l.rootComposeSceneId === activeComposeSceneId),
    [composeLayers, activeComposeSceneId]
  );

  // Only react to OS file drags (they carry "Files"); internal layer/asset
  // drags use custom MIME types and must pass through to their own handlers.
  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files');

  // Topmost image layer under the cursor, if any — the drop target for a replace.
  // layersAtClientPoint reads the module stage rect + scale, so it hit-tests in
  // canonical space.
  const imageLayerAt = (clientX: number, clientY: number): string | null => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const ids = layersAtClientPoint(rect, stackLayers, clientX, clientY);
    for (const id of ids) {
      if (stackLayers.find((l) => l.id === id)?.kind === 'image') return id;
    }
    return null;
  };

  // Convert client coords to canonical stage px (for placing a new layer).
  const toCanonical = (clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const s = scaleRef.current || 1;
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left) / s,
      y: (clientY - rect.top) / s,
    };
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget(imageLayerAt(e.clientX, e.clientY) ?? 'new');
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    // Only clear when leaving the viewport itself, not when crossing a child.
    if (e.currentTarget === e.target) setDropTarget(null);
  };

  const onDrop = async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const target = imageLayerAt(e.clientX, e.clientY);
    setDropTarget(null);
    const drop = toCanonical(e.clientX, e.clientY);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/')
    );
    if (files.length === 0 || !projectId || !activeComposeSceneId) return;
    setIsDropping(true);
    try {
      if (target) {
        // Replace the target image layer's asset with the first dropped file.
        const asset = await api.uploadAsset(projectId, files[0]);
        addAsset(asset);
        await api.updateComposeLayer(target, { assetId: asset.id });
        updateComposeLayerLocal(target, { assetId: asset.id });
        selectComposeLayer(target);
      } else {
        // Create a new image layer per dropped file, at (and cascading from)
        // the cursor, anchored top-left.
        let lastId: string | null = null;
        for (let i = 0; i < files.length; i++) {
          const asset = await api.uploadAsset(projectId, files[i]);
          addAsset(asset);
          const taken = new Set(
            useEditorStore
              .getState()
              .composeLayers.filter(
                (l) => l.rootComposeSceneId === activeComposeSceneId
              )
              .map((l) => l.name)
          );
          const created = await api.createComposeSceneLayer(
            activeComposeSceneId,
            {
              name: uniqueName('Image Layer', taken),
              kind: 'image',
              assetId: asset.id,
              anchorH: 'left',
              anchorV: 'top',
              x: Math.round(drop.x) + i * 24,
              y: Math.round(drop.y) + i * 24,
              config: {},
            }
          );
          addComposeLayer(created);
          lastId = created.id;
        }
        if (lastId) selectComposeLayer(lastId);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsDropping(false);
    }
  };

  if (!composeScene) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666',
          fontSize: 13,
          background: '#0a0a0a',
        }}
      >
        {t('view.noSceneSelected')}
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#0a0a0a',
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          borderBottom: '1px solid #2a2a2a',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          background: '#141414',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: '#888',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          {composeScene.name}
        </span>
        <div style={{ flex: 1 }} />
        {/* Fixed compose resolution (canonical px). The stage scales to fit. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: '#888',
          }}
          title={t('view.resolutionHint')}
        >
          <NumInput
            className="vs-compose-width"
            value={canonW}
            min={16}
            step={1}
            precision={0}
            onChange={(w) => {
              if (!composeScene || w < 16) return;
              const next = { ...composeScene, width: Math.round(w) };
              updateComposeSceneLocal(next);
              api
                .updateComposeLayer(composeScene.id, { width: Math.round(w) })
                .catch(() => {});
            }}
            style={{ width: 56 }}
          />
          <span style={{ color: '#555' }}>×</span>
          <NumInput
            className="vs-compose-height"
            value={canonH}
            min={16}
            step={1}
            precision={0}
            onChange={(h) => {
              if (!composeScene || h < 16) return;
              const next = { ...composeScene, height: Math.round(h) };
              updateComposeSceneLocal(next);
              api
                .updateComposeLayer(composeScene.id, { height: Math.round(h) })
                .catch(() => {});
            }}
            style={{ width: 56 }}
          />
        </div>
        <span style={{ fontSize: 11, color: '#555' }}>
          {t('view.layerCount', { count: stackLayers.length })}
        </span>
      </div>
      <div
        ref={containerRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          background: '#0a0a0a',
        }}
      >
        {/* Fixed-resolution stage (canonical px), letterbox-scaled to fit. Layer
            coordinates live in this canonical space so the same scene renders
            identically at any editor/viewer size. */}
        <div
          ref={stageRef}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: canonW,
            height: canonH,
            transform: `translate(-50%, -50%) scale(${scale})`,
            transformOrigin: 'center center',
            background: '#000',
            overflow: 'hidden',
          }}
        >
          {/* 3D output is rendered by camera_view layers inside the stack. */}
          <ComposeLayerStack layers={stackLayers} assets={assets} />
          {/* The capture overlay owns all pointer/wheel events for the compose
              viewport. Sits above the layers but below the selection chrome. */}
          <ComposeEventCapture viewportRef={stageRef} />
          {/* Selection chrome (outline + resize/rotate handles) lives on top. */}
          {selectedLayer && (
            <ComposeSelectionOverlay
              viewportRef={stageRef}
              layer={selectedLayer}
              scale={scale}
            />
          )}
          {/* Drag-and-drop feedback: dashed stage border when a drop would
              create a new image layer, or the targeted image layer's outline
              when a drop would replace its asset. */}
          {dropTarget && (
            <DropHighlight
              target={dropTarget}
              layers={stackLayers}
              canonW={canonW}
              canonH={canonH}
            />
          )}
        </div>
        {isDropping && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 120,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.4)',
              color: '#fff',
              fontSize: 13,
              pointerEvents: 'none',
            }}
          >
            {t('view.uploading')}
          </div>
        )}
      </div>
    </div>
  );
}

/** Visual feedback for an in-progress OS image-file drag over the compose
 *  viewport. Rendered inside the canonical stage. `'new'` outlines the whole
 *  stage (drop → create a new layer); a layer id outlines that image layer's
 *  rotated rect (drop → replace asset). */
function DropHighlight({
  target,
  layers,
  canonW,
  canonH,
}: {
  target: string | 'new';
  layers: ComposeLayerRecord[];
  canonW: number;
  canonH: number;
}) {
  const base: CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 110,
    pointerEvents: 'none',
  };
  if (target === 'new') {
    return (
      <div
        style={{
          ...base,
          boxSizing: 'border-box',
          border: '4px dashed #4a9eff',
          background: 'rgba(74,158,255,0.08)',
        }}
      />
    );
  }
  const layer = layers.find((l) => l.id === target);
  if (!layer) return null;
  const byId = new Map(layers.map((l) => [l.id, l] as const));
  const f = layerFrame({ width: canonW, height: canonH }, layer, byId);
  const corner = (sx: number, sy: number) => ({
    x: f.cx + f.ux.x * sx * f.hx + f.uy.x * sy * f.hy,
    y: f.cy + f.ux.y * sx * f.hx + f.uy.y * sy * f.hy,
  });
  const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  return (
    <svg
      style={{ ...base, width: '100%', height: '100%', overflow: 'visible' }}
    >
      <polygon
        points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="rgba(74,158,255,0.15)"
        stroke="#4a9eff"
        strokeWidth={4}
        strokeDasharray="8 6"
      />
    </svg>
  );
}
