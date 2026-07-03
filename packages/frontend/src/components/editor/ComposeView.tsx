import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
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
  layersAtClientPoint,
  layerFrame,
} from './composeHitTest';
import { api } from '../../api/client';
import { uniqueName } from './createKinds';

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
  const selectedComposeLayerId = useEditorStore(
    (s) => s.selectedComposeLayerId
  );

  const viewportRef = useRef<HTMLDivElement>(null);
  // OS image-file drag-and-drop onto the viewport. `dropTarget` drives the
  // highlight: a layer id (drop replaces that image layer's asset) or 'new'
  // (drop creates a new image layer at the cursor).
  const [dropTarget, setDropTarget] = useState<string | 'new' | null>(null);
  const [isDropping, setIsDropping] = useState(false);

  // Install a module-level getter so other modules (cycle, capture overlay)
  // can resolve the viewport rect without prop-drilling.
  useLayoutEffect(() => {
    composeViewportRect.current = () =>
      viewportRef.current?.getBoundingClientRect() ?? null;
    return () => {
      composeViewportRect.current = null;
    };
  }, []);

  const selectedLayer =
    composeLayers.find((l) => l.id === selectedComposeLayerId) ?? null;

  const composeScene =
    composeScenes.find((s) => s.id === activeComposeSceneId) ?? null;

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
  const imageLayerAt = (clientX: number, clientY: number): string | null => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const ids = layersAtClientPoint(rect, stackLayers, clientX, clientY);
    for (const id of ids) {
      if (stackLayers.find((l) => l.id === id)?.kind === 'image') return id;
    }
    return null;
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
    const rect = viewportRef.current?.getBoundingClientRect();
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/')
    );
    if (files.length === 0 || !projectId || !activeComposeSceneId || !rect)
      return;
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
              x: Math.round(e.clientX - rect.left) + i * 24,
              y: Math.round(e.clientY - rect.top) + i * 24,
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
        <span style={{ fontSize: 11, color: '#555' }}>
          {t('view.layerCount', { count: stackLayers.length })}
        </span>
      </div>
      <div
        ref={viewportRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          background: '#000',
        }}
      >
        {/* 3D output is rendered by camera_view layers inside the stack. */}
        <ComposeLayerStack layers={stackLayers} assets={assets} />
        {/* The capture overlay owns all pointer/wheel events for the compose
            viewport. Sits above the layers but below the selection chrome. */}
        <ComposeEventCapture viewportRef={viewportRef} />
        {/* Selection chrome (outline + resize/rotate handles) lives on top. */}
        {selectedLayer && (
          <ComposeSelectionOverlay
            viewportRef={viewportRef}
            layer={selectedLayer}
          />
        )}
        {/* Drag-and-drop feedback: highlight the whole viewport when a drop
            would create a new image layer, or the targeted image layer when a
            drop would replace its asset. */}
        {dropTarget && (
          <DropHighlight
            viewportRef={viewportRef}
            target={dropTarget}
            layers={stackLayers}
          />
        )}
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
 *  viewport. `'new'` outlines the whole viewport (drop → create a new layer);
 *  a layer id outlines that image layer's rotated rect (drop → replace asset). */
function DropHighlight({
  viewportRef,
  target,
  layers,
}: {
  viewportRef: RefObject<HTMLDivElement>;
  target: string | 'new';
  layers: ComposeLayerRecord[];
}) {
  const base: CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: 110,
    pointerEvents: 'none',
  };
  const rect = viewportRef.current?.getBoundingClientRect();
  if (target === 'new' || !rect) {
    return (
      <div
        style={{
          ...base,
          boxSizing: 'border-box',
          border: '2px dashed #4a9eff',
          background: 'rgba(74,158,255,0.08)',
        }}
      />
    );
  }
  const layer = layers.find((l) => l.id === target);
  if (!layer) return null;
  const byId = new Map(layers.map((l) => [l.id, l] as const));
  const f = layerFrame({ width: rect.width, height: rect.height }, layer, byId);
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
        strokeWidth={2}
        strokeDasharray="6 4"
      />
    </svg>
  );
}
