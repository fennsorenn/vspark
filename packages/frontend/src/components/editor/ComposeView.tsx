import { useLayoutEffect, useMemo, useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { ComposeLayerStack } from './ComposeLayerStack';
import { ComposeSelectionOverlay } from './ComposeSelectionOverlay';
import { ComposeEventCapture } from './ComposeEventCapture';
import { composeViewportRect } from './composeHitTest';

export function ComposeView() {
  const activeComposeSceneId = useEditorStore((s) => s.activeComposeSceneId);
  const composeScenes = useEditorStore((s) => s.composeScenes);
  const composeLayers = useEditorStore((s) => s.composeLayers);
  const assets = useEditorStore((s) => s.assets);
  const selectedComposeLayerId = useEditorStore(
    (s) => s.selectedComposeLayerId
  );

  const viewportRef = useRef<HTMLDivElement>(null);

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
        No compose scene selected.
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
          {stackLayers.length} layer{stackLayers.length === 1 ? '' : 's'}
        </span>
      </div>
      <div
        ref={viewportRef}
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
      </div>
    </div>
  );
}
