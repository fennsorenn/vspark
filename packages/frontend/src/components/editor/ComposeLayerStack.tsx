import type { CSSProperties } from 'react';
import { useEditorStore } from '../../store/editorStore';
import type {
  ComposeLayerRecord,
  AssetFile,
  RuntimeOverrideMap,
} from '../../store/editorStore';
import { CameraCanvas } from './CameraCanvas';

interface ComposeLayerStackProps {
  layers: ComposeLayerRecord[];
  assets: AssetFile[];
  /** Render mode is currently ignored — both editor and viewer render the same
   *  passive DOM; the editor's input goes through ComposeEventCapture. Kept
   *  in the signature so ViewerPage's call site doesn't need to change. */
  mode?: 'editor' | 'viewer';
  /** Chain of compose-scene ids currently being rendered (outermost first).
   *  Used by scene_include layers to refuse rendering a scene that's already an
   *  ancestor, preventing infinite recursion. */
  includeChain?: string[];
}

function resolveAssetUrl(
  layer: ComposeLayerRecord,
  assets: AssetFile[]
): string | null {
  if (!layer.assetId) return null;
  const a = assets.find((x) => x.id === layer.assetId);
  return a?.url ?? null;
}

/** Resolve a numeric layer field to a CSS length string, honoring a per-field
 *  unit flag in config ('%' → percentage of the compose container, else px). */
function cssLen(
  value: number,
  config: Record<string, unknown>,
  unitKey: string
): string {
  return config[unitKey] === '%' ? `${value}%` : `${value}px`;
}

/** Read a numeric runtime override for a paramPath, falling back to undefined
 *  when absent or non-numeric. */
function runtimeNum(
  rt: RuntimeOverrideMap | undefined,
  path: string
): number | undefined {
  const v = rt?.[path];
  return typeof v === 'number' ? v : undefined;
}

function layerStyle(
  layer: ComposeLayerRecord,
  clipOverride?: {
    x?: number;
    y?: number;
    rotation?: number;
    width?: number;
    height?: number;
    opacity?: number;
  },
  runtimeOverride?: RuntimeOverrideMap
): CSSProperties {
  // Resolution order per paramPath: track-clip override > runtime override > base.
  // Track-clip wins so an in-progress clip isn't interrupted by a stale runtime
  // value. See dev-notes/modules/runtime-overrides.md.
  const x = clipOverride?.x ?? runtimeNum(runtimeOverride, 'x') ?? layer.x;
  const y = clipOverride?.y ?? runtimeNum(runtimeOverride, 'y') ?? layer.y;
  const rotation =
    clipOverride?.rotation ??
    runtimeNum(runtimeOverride, 'rotation') ??
    layer.rotation;
  const width =
    clipOverride?.width ?? runtimeNum(runtimeOverride, 'width') ?? layer.width;
  const height =
    clipOverride?.height ??
    runtimeNum(runtimeOverride, 'height') ??
    layer.height;
  const opacity =
    clipOverride?.opacity ??
    runtimeNum(runtimeOverride, 'opacity') ??
    (typeof layer.config.opacity === 'number' ? layer.config.opacity : 1);

  const cfg = layer.config;
  const style: CSSProperties = {
    position: 'absolute',
    width: cssLen(width, cfg, 'widthUnit'),
    height: cssLen(height, cfg, 'heightUnit'),
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    transformOrigin: 'center center',
    visibility: layer.visible ? 'visible' : 'hidden',
    opacity,
    overflow: 'hidden',
  };
  const xLen = cssLen(x, cfg, 'xUnit');
  const yLen = cssLen(y, cfg, 'yUnit');
  if (layer.anchorH === 'left') style.left = xLen;
  if (layer.anchorH === 'right') style.right = xLen;
  if (layer.anchorV === 'top') style.top = yLen;
  if (layer.anchorV === 'bottom') style.bottom = yLen;
  return style;
}

function CameraViewLayer({ layer }: { layer: ComposeLayerRecord }) {
  const nodes = useEditorStore((s) => s.nodes);
  const cam = layer.cameraNodeId
    ? nodes.find((n) => n.id === layer.cameraNodeId)
    : null;
  if (!cam) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: '#111',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666',
          fontSize: 12,
          pointerEvents: 'none',
          border: '1px dashed #333',
        }}
      >
        📷 No camera
      </div>
    );
  }
  return (
    <div style={{ width: '100%', height: '100%', pointerEvents: 'none' }}>
      <CameraCanvas
        cameraNode={cam}
        sceneId={cam.rootSceneNodeId}
        composeLayerId={layer.id}
        active={layer.visible}
      />
    </div>
  );
}

/** Mount another compose scene's full layer stack inside this layer's frame.
 *  Refuses to render if the target scene is already an ancestor in the include
 *  chain (cycle), showing a placeholder instead. */
function SceneIncludeLayer({
  layer,
  assets,
  includeChain,
}: {
  layer: ComposeLayerRecord;
  assets: AssetFile[];
  includeChain: string[];
}) {
  const targetId =
    typeof layer.config.includeSceneId === 'string'
      ? layer.config.includeSceneId
      : null;
  const targetLayers = useEditorStore((s) =>
    targetId
      ? s.composeLayers.filter((l) => l.rootComposeSceneId === targetId)
      : null
  );
  if (!targetId) return <Placeholder text="no scene" />;
  if (includeChain.includes(targetId)) {
    return <Placeholder text="⟳ recursive include" />;
  }
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <ComposeLayerStack
        layers={targetLayers ?? []}
        assets={assets}
        includeChain={[...includeChain, targetId]}
      />
    </div>
  );
}

function LayerContent({
  layer,
  assets,
  includeChain,
}: {
  layer: ComposeLayerRecord;
  assets: AssetFile[];
  includeChain: string[];
}) {
  if (layer.kind === 'camera_view') {
    return <CameraViewLayer layer={layer} />;
  }
  if (layer.kind === 'scene_include') {
    return (
      <SceneIncludeLayer
        layer={layer}
        assets={assets}
        includeChain={includeChain}
      />
    );
  }
  if (layer.kind === 'group' || layer.kind === 'compose_scene') {
    return null;
  }
  const objectFit =
    (layer.config.objectFit as CSSProperties['objectFit']) ?? 'cover';
  if (layer.kind === 'image') {
    const url = resolveAssetUrl(layer, assets);
    if (!url) return <Placeholder text="no image" />;
    return (
      <img
        src={url}
        alt=""
        draggable={false}
        style={{
          width: '100%',
          height: '100%',
          objectFit,
          display: 'block',
          pointerEvents: 'none',
        }}
      />
    );
  }
  if (layer.kind === 'video') {
    const url = resolveAssetUrl(layer, assets);
    if (!url) return <Placeholder text="no video" />;
    return (
      <video
        src={url}
        autoPlay
        muted
        loop
        playsInline
        style={{
          width: '100%',
          height: '100%',
          objectFit,
          display: 'block',
          pointerEvents: 'none',
        }}
      />
    );
  }
  const url = (layer.config.url as string | undefined) ?? '';
  if (!url) return <Placeholder text="no URL" />;
  // Iframes always swallow events when active. We keep them pointer-events:none
  // in editor mode so selection works; the streamed output (viewer mode) makes
  // them interactive only there.
  return (
    <iframe
      src={url}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        display: 'block',
        pointerEvents: 'none',
      }}
      title={layer.name}
    />
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#222',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#555',
        fontSize: 11,
        pointerEvents: 'none',
      }}
    >
      {text}
    </div>
  );
}

function LayerView({
  layer,
  assets,
  includeChain,
}: {
  layer: ComposeLayerRecord;
  assets: AssetFile[];
  includeChain: string[];
}) {
  // Per-layer subscription to its track-clip override: this keeps re-renders
  // localized to layers being animated; idle layers don't re-render each rAF.
  const clipOverride = useEditorStore((s) => s.composeLayerOverrides[layer.id]);
  const runtimeOverride = useEditorStore(
    (s) => s.runtimeLayerOverrides[layer.id]
  );
  // Layer wrappers are passive: pointer events go to the top-level capture
  // overlay (ComposeEventCapture), which uses document.elementsFromPoint to
  // find which layer is under the cursor via data-compose-layer-id. This
  // single-owner model removes the need to route between layer wrappers,
  // canvas, and selection chrome.
  return (
    <div
      data-compose-layer-id={layer.id}
      style={{
        ...layerStyle(layer, clipOverride, runtimeOverride),
        pointerEvents: 'none',
      }}
    >
      <LayerContent layer={layer} assets={assets} includeChain={includeChain} />
    </div>
  );
}

export function ComposeLayerStack({
  layers,
  assets,
  includeChain = [],
}: ComposeLayerStackProps) {
  // Single z-ordered pass. Convention: higher sceneOrder = more in front (top
  // of the layer tree). Absolutely-positioned siblings with no zIndex stack by
  // DOM order (later = on top), so we sort ASCENDING here: lowest sceneOrder
  // first in the DOM (back), highest last (front). This makes the rendered
  // stacking match the tree, where the top row is the front-most layer.
  const ordered = [...layers]
    .filter((l) => l.kind !== 'compose_scene' && l.kind !== 'group')
    .sort(
      (a, b) => a.sceneOrder - b.sceneOrder || a.cameraOrder - b.cameraOrder
    );

  // The container stays pointer-transparent so empty space falls through to the
  // parent viewport (click-to-deselect). Individual layer wrappers re-enable
  // pointer events on their own bounds. Selection chrome lives on a separate
  // ComposeSelectionOverlay above this stack.
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    >
      {ordered.map((l) => (
        <LayerView
          key={l.id}
          layer={l}
          assets={assets}
          includeChain={includeChain}
        />
      ))}
    </div>
  );
}
