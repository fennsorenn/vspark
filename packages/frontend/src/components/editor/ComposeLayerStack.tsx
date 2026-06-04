import {
  Component,
  createElement,
  useId,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useEditorStore } from '../../store/editorStore';
import type {
  ComposeLayerRecord,
  AssetFile,
  RuntimeOverrideMap,
} from '../../store/editorStore';
import DOMPurify from 'dompurify';
import htm from 'htm';
import { TEXT_SANITIZE_OPTS } from '../../lib/textSanitize';
import { CameraCanvas } from './CameraCanvas';

/** htm bound to React.createElement — JSX-ish templates with no build step. */
const html = htm.bind(createElement);

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
  if (layer.kind === 'text') {
    return <TextLayer layer={layer} />;
  }
  if (layer.kind === 'feed') {
    return <FeedLayer layer={layer} />;
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

/** Text compose layer. Content is taken from `layer.config.content`, overridden
 *  by the runtime override `text.content` when a graph node has written one.
 *  When `config.allowHtml`, the content is DOMPurified and rendered as HTML
 *  (curated allow-list: inline formatting + emote-friendly img tags); otherwise
 *  it's rendered as plain text. */
function TextLayer({ layer }: { layer: ComposeLayerRecord }) {
  const overrideContent = useEditorStore((s) => {
    const v = s.runtimeLayerOverrides[layer.id]?.['text.content'];
    return typeof v === 'string' ? v : undefined;
  });
  const cfg = layer.config as {
    content?: string;
    fontFamily?: string;
    fontSize?: number;
    color?: string;
    weight?: number | string;
    align?: 'left' | 'center' | 'right';
    allowHtml?: boolean;
  };
  const content = overrideContent ?? cfg.content ?? '';
  const style: CSSProperties = {
    width: '100%',
    height: '100%',
    fontFamily: cfg.fontFamily ?? 'inherit',
    fontSize: typeof cfg.fontSize === 'number' ? `${cfg.fontSize}px` : 16,
    color: cfg.color ?? '#ffffff',
    fontWeight: cfg.weight ?? 'normal',
    textAlign: cfg.align ?? 'left',
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent:
      cfg.align === 'center'
        ? 'center'
        : cfg.align === 'right'
          ? 'flex-end'
          : 'flex-start',
    wordBreak: 'break-word',
    overflow: 'hidden',
  };
  if (cfg.allowHtml) {
    const safe = DOMPurify.sanitize(content, TEXT_SANITIZE_OPTS);
    return <div style={style} dangerouslySetInnerHTML={{ __html: safe }} />;
  }
  return <div style={style}>{content}</div>;
}

/** Host-provided component for feed templates: renders a per-field HTML blob
 *  (e.g. the chat `html` field with emote <img>s) safely. Templates inject raw
 *  HTML only through this; everything else is authored as JSX-ish markup and
 *  produced as real React elements. */
function Emote({ html: raw }: { html?: string }) {
  return (
    <span
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(raw ?? '', TEXT_SANITIZE_OPTS),
      }}
    />
  );
}

type FeedRender = (html: unknown, data: unknown, Emote: unknown) => ReactNode;

interface CompiledTemplate {
  render: FeedRender | null;
  error: string | null;
}

// Compiled templates are cached by source string — `new Function` (the htm
// "compile") runs once per distinct template, then re-renders are cheap.
const _templateCache = new Map<string, CompiledTemplate>();

/**
 * Compile a feed template (JSX-ish htm body) into a render function. The body is
 * interpolated into an htm tagged-template literal and evaluated as JS via
 * `new Function` — htm has no build step. `data` (the channel payload) and the
 * `Emote` helper are in scope.
 *
 * NOTE: templates execute as code. This is acceptable under vspark's local /
 * single-user model — no worse than the `browser` compose layer, which already
 * runs arbitrary web content. Revisit before any multi-user / untrusted-import
 * story (see dev-notes/modules/data-channels.md).
 */
function compileTemplate(src: string): CompiledTemplate {
  const hit = _templateCache.get(src);
  if (hit) return hit;
  let result: CompiledTemplate;
  try {
    const fn = new Function(
      'html',
      'data',
      'Emote',
      `return html\`${src}\`;`
    ) as FeedRender;
    result = { render: fn, error: null };
  } catch (e) {
    result = {
      render: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  _templateCache.set(src, result);
  return result;
}

/** Renders the compiled template; isolated in its own component so a render-time
 *  throw is caught by the surrounding error boundary. */
function FeedContent({ render, data }: { render: FeedRender; data: unknown }) {
  return <>{render(html, data, Emote)}</>;
}

/** Catches errors thrown while rendering a user template so a bad template
 *  degrades to a placeholder instead of white-screening the viewport. Reset by
 *  remounting (the parent keys it on the template source). */
class FeedErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <Placeholder text="template error" />;
    return this.props.children;
  }
}

/**
 * Generic, data-shape-independent feed/template layer. Subscribes to a named
 * data channel (fed by the `set_data` signal node over WS) and renders the
 * channel payload through a user-authored JSX-ish (htm) template, exposed to the
 * template as `data` (an array → loop with `${data.map(...)}`; a record →
 * reference fields directly). Because the template produces real React elements
 * with stable keys, reconciliation handles per-item enter animation. Static
 * styles live in `config.css`, injected scoped to this layer via `@scope`.
 * See dev-notes/modules/data-channels.md.
 */
function FeedLayer({ layer }: { layer: ComposeLayerRecord }) {
  const cfg = layer.config as {
    channel?: string;
    template?: string;
    css?: string;
  };
  const channel = typeof cfg.channel === 'string' ? cfg.channel : '';
  const payload = useEditorStore((s) =>
    channel ? s.dataChannels[channel] : undefined
  );
  const template = typeof cfg.template === 'string' ? cfg.template : '';
  const compiled = useMemo(() => compileTemplate(template), [template]);
  const rawScopeId = useId();
  const scopeId = `feed-${rawScopeId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  if (!channel) return <Placeholder text="no channel" />;
  if (!template) return <Placeholder text="empty template" />;
  if (!compiled.render) return <Placeholder text="template syntax error" />;

  const css = typeof cfg.css === 'string' ? cfg.css : '';
  const scopedCss = css
    ? `@scope ([data-feed-scope="${scopeId}"]) {\n${css}\n}`
    : '';

  return (
    <div
      data-feed-scope={scopeId}
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      {scopedCss && <style>{scopedCss}</style>}
      <FeedErrorBoundary key={template}>
        <FeedContent render={compiled.render} data={payload ?? null} />
      </FeedErrorBoundary>
    </div>
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
