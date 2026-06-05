import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useEditorStore } from '../../store/editorStore';
import { registerMedia } from './mediaRegistry';
import { ChromaVideoCanvas } from './ChromaVideoCanvas';
import { readChroma } from './videoFx';
import type {
  ComposeLayerRecord,
  AssetFile,
  RuntimeOverrideMap,
} from '../../store/editorStore';
import DOMPurify from 'dompurify';
import { TEXT_SANITIZE_OPTS } from '../../lib/textSanitize';
import { CameraCanvas } from './CameraCanvas';
import {
  compileTemplate,
  FeedContent,
  FeedErrorBoundary,
} from '../../lib/feedTemplate';

interface ComposeLayerStackProps {
  layers: ComposeLayerRecord[];
  assets: AssetFile[];
  /** Editor vs viewer. Both render the same passive DOM (editor input goes
   *  through ComposeEventCapture); the only behavioural difference is media
   *  audibility — video layers are audible in the viewer, but muted in the
   *  editor unless audio preview is enabled. Defaults to 'editor'. */
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
  const blendMode =
    typeof cfg.blendMode === 'string' && cfg.blendMode !== 'normal'
      ? (cfg.blendMode as CSSProperties['mixBlendMode'])
      : undefined;
  const style: CSSProperties = {
    position: 'absolute',
    width: cssLen(width, cfg, 'widthUnit'),
    height: cssLen(height, cfg, 'heightUnit'),
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    transformOrigin: 'center center',
    visibility: layer.visible ? 'visible' : 'hidden',
    opacity,
    mixBlendMode: blendMode,
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
  mode,
}: {
  layer: ComposeLayerRecord;
  assets: AssetFile[];
  includeChain: string[];
  mode: 'editor' | 'viewer';
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
        mode={mode}
      />
    </div>
  );
}

/** A compose-layer <video>, driven by config (autoplay/loop/onEnd/muted/volume)
 *  and registered in the media registry so the command bus / clip event lane can
 *  control it. Audio plays in the viewer; in the editor only when preview is on. */
function VideoLayer({
  layer,
  url,
  objectFit,
  mode,
}: {
  layer: ComposeLayerRecord;
  url: string;
  objectFit: CSSProperties['objectFit'];
  mode: 'editor' | 'viewer';
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const audioPreview = useEditorStore((s) => s.editorAudioPreviewEnabled);
  const cfg = layer.config as Record<string, unknown>;
  const autoplay = cfg.autoplay !== false;
  const loop = cfg.loop !== false;
  const onEnd = (cfg.onEnd as string) ?? 'freeze';
  const muted = cfg.muted !== false;
  const volume = typeof cfg.volume === 'number' ? cfg.volume : 1;
  const [hidden, setHidden] = useState(false);

  // Reset hidden + apply autoplay when the source changes.
  useEffect(() => {
    setHidden(false);
    const el = ref.current;
    if (el && autoplay) void el.play().catch(() => {});
  }, [url, autoplay]);

  // Audibility + volume.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const audible = (mode === 'viewer' || audioPreview) && !muted;
    el.muted = !audible;
    el.volume = Math.max(0, Math.min(1, volume));
  }, [mode, audioPreview, muted, volume, url]);

  // Media handle for command bus / clip events.
  useEffect(() => {
    return registerMedia(layer.id, {
      play: () => void ref.current?.play().catch(() => {}),
      pause: () => ref.current?.pause(),
      stop: () => {
        const el = ref.current;
        if (!el) return;
        el.pause();
        el.currentTime = 0;
        if (onEnd === 'hide') setHidden(true);
      },
      restart: () => {
        const el = ref.current;
        if (!el) return;
        setHidden(false);
        el.currentTime = 0;
        void el.play().catch(() => {});
      },
      seek: (t: number) => {
        if (ref.current) ref.current.currentTime = Math.max(0, t);
      },
      setVolume: (v: number) => {
        if (ref.current) ref.current.volume = Math.max(0, Math.min(1, v));
      },
      mute: () => {
        if (ref.current) ref.current.muted = true;
      },
      unmute: () => {
        if (ref.current) ref.current.muted = false;
      },
    });
  }, [layer.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const chroma = readChroma(cfg.chromaKey as Record<string, unknown>);

  return (
    <>
      <video
        ref={ref}
        src={url}
        autoPlay={autoplay}
        loop={loop}
        muted
        playsInline
        crossOrigin="anonymous"
        onEnded={() => {
          if (!loop && onEnd === 'hide') setHidden(true);
        }}
        style={{
          width: '100%',
          height: '100%',
          objectFit,
          // While keying, the <video> is the off-screen source for the canvas.
          display: chroma.enabled ? 'none' : 'block',
          visibility: hidden ? 'hidden' : 'visible',
          pointerEvents: 'none',
        }}
      />
      {chroma.enabled && !hidden && (
        <ChromaVideoCanvas
          videoRef={ref}
          chroma={chroma}
          objectFit={objectFit}
        />
      )}
    </>
  );
}

/** An audio-only compose layer: a non-visual `<audio>` element registered in the
 *  media registry so the command bus / clip event lane can play it. Renders
 *  nothing visible (the layer can be `visible:false` and still play, since the
 *  stack uses `visibility:hidden`, which doesn't stop playback). Audible in the
 *  viewer; in the editor only when audio preview is on, and never if `muted`. */
function AudioLayer({
  layer,
  url,
  mode,
}: {
  layer: ComposeLayerRecord;
  url: string | null;
  mode: 'editor' | 'viewer';
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const audioPreview = useEditorStore((s) => s.editorAudioPreviewEnabled);
  const cfg = layer.config as Record<string, unknown>;
  const autoplay = cfg.autoplay === true; // default off — usually command-driven
  const loop = cfg.loop === true;
  const muted = cfg.muted === true;
  const volume = typeof cfg.volume === 'number' ? cfg.volume : 1;

  // Apply autoplay when the source changes.
  useEffect(() => {
    const el = ref.current;
    if (el && autoplay && url) void el.play().catch(() => {});
  }, [url, autoplay]);

  // Audibility + volume.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const audible = (mode === 'viewer' || audioPreview) && !muted;
    el.muted = !audible;
    el.volume = Math.max(0, Math.min(1, volume));
  }, [mode, audioPreview, muted, volume, url]);

  // Media handle for the command bus / clip event lane.
  useEffect(() => {
    return registerMedia(layer.id, {
      play: () => void ref.current?.play().catch(() => {}),
      pause: () => ref.current?.pause(),
      stop: () => {
        const el = ref.current;
        if (!el) return;
        el.pause();
        el.currentTime = 0;
      },
      restart: () => {
        const el = ref.current;
        if (!el) return;
        el.currentTime = 0;
        void el.play().catch(() => {});
      },
      seek: (t: number) => {
        if (ref.current) ref.current.currentTime = Math.max(0, t);
      },
      setVolume: (v: number) => {
        if (ref.current) ref.current.volume = Math.max(0, Math.min(1, v));
      },
      mute: () => {
        if (ref.current) ref.current.muted = true;
      },
      unmute: () => {
        if (ref.current) ref.current.muted = false;
      },
    });
  }, [layer.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!url) return <Placeholder text="no audio" />;
  return (
    <audio
      ref={ref}
      src={url}
      autoPlay={autoplay}
      loop={loop}
      crossOrigin="anonymous"
      style={{ display: 'none' }}
    />
  );
}

function LayerContent({
  layer,
  assets,
  includeChain,
  mode,
}: {
  layer: ComposeLayerRecord;
  assets: AssetFile[];
  includeChain: string[];
  mode: 'editor' | 'viewer';
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
        mode={mode}
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
      <VideoLayer layer={layer} url={url} objectFit={objectFit} mode={mode} />
    );
  }
  if (layer.kind === 'audio') {
    const url = resolveAssetUrl(layer, assets);
    return <AudioLayer layer={layer} url={url} mode={mode} />;
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

/**
 * Generic, data-shape-independent feed/template layer. Renders the data-channel
 * fields visible to this layer — the GLOBAL scope merged with this layer's own
 * id scope (a `set_data` node optionally targets a layer/node id) — through a
 * user-authored JSX-ish (htm) template. Every field is exposed to the template
 * by its bare name (a field labeled `chat` → `${chat.map(...)}`). Because the
 * template produces real React elements with stable keys, reconciliation handles
 * per-item enter animation. Static styles live in `config.css`, injected scoped
 * to this layer via `@scope`. See dev-notes/modules/data-channels.md.
 */
function FeedLayer({ layer }: { layer: ComposeLayerRecord }) {
  const cfg = layer.config as { template?: string; css?: string };
  const globalFields = useEditorStore((s) => s.dataChannels['']);
  const ownFields = useEditorStore((s) => s.dataChannels[layer.id]);
  const channels = useMemo(
    () => ({ ...(globalFields ?? {}), ...(ownFields ?? {}) }),
    [globalFields, ownFields]
  );
  const template = typeof cfg.template === 'string' ? cfg.template : '';
  const compiled = useMemo(() => compileTemplate(template), [template]);
  const rawScopeId = useId();
  const scopeId = `feed-${rawScopeId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

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
        <FeedContent render={compiled.render} channels={channels} />
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

/** Siblings stack by DOM order (later = on top), so we render ASCENDING by
 *  sceneOrder: lowest first (back), highest last (front). This matches the
 *  tree, where the top row is the front-most layer. */
function orderSiblings(layers: ComposeLayerRecord[]): ComposeLayerRecord[] {
  return [...layers].sort(
    (a, b) => a.sceneOrder - b.sceneOrder || a.cameraOrder - b.cameraOrder
  );
}

function LayerView({
  layer,
  assets,
  includeChain,
  childrenByParent,
  mode,
}: {
  layer: ComposeLayerRecord;
  assets: AssetFile[];
  includeChain: string[];
  childrenByParent: Map<string | null, ComposeLayerRecord[]>;
  mode: 'editor' | 'viewer';
}) {
  // Per-layer subscription to its track-clip override: this keeps re-renders
  // localized to layers being animated; idle layers don't re-render each rAF.
  const clipOverride = useEditorStore((s) => s.composeLayerOverrides[layer.id]);
  const runtimeOverride = useEditorStore(
    (s) => s.runtimeLayerOverrides[layer.id]
  );
  // Child layers are nested INSIDE this layer's box, so their CSS left/top/
  // width/height (and % units) resolve against this layer's content box and
  // their rotation composes with ours — i.e. children are positioned, rotated
  // and sized relative to their parent rather than the viewport.
  const kids = orderSiblings(childrenByParent.get(layer.id) ?? []);
  // Layer wrappers are passive: pointer events go to the top-level capture
  // overlay (ComposeEventCapture), which hit-tests layers analytically (see
  // composeHitTest) via data-compose-layer-id. This single-owner model removes
  // the need to route between layer wrappers, canvas, and selection chrome.
  return (
    <div
      data-compose-layer-id={layer.id}
      style={{
        ...layerStyle(layer, clipOverride, runtimeOverride),
        pointerEvents: 'none',
      }}
    >
      <LayerContent
        layer={layer}
        assets={assets}
        includeChain={includeChain}
        mode={mode}
      />
      {kids.map((k) => (
        <LayerView
          key={k.id}
          layer={k}
          assets={assets}
          includeChain={includeChain}
          childrenByParent={childrenByParent}
          mode={mode}
        />
      ))}
    </div>
  );
}

export function ComposeLayerStack({
  layers,
  assets,
  includeChain = [],
  mode = 'editor',
}: ComposeLayerStackProps) {
  // Build the parent→children map for hierarchical rendering. A layer roots the
  // stack when it has no parent OR its parent isn't part of this layer set
  // (e.g. the parent is the compose_scene row, or a dangling/cross-scene
  // parent) — so it can never be orphaned out of the render entirely. This
  // mirrors ComposeTree's nesting logic. `group` layers stay in the map as
  // transparent container boxes; only the compose_scene root is excluded.
  const present = new Set(layers.map((l) => l.id));
  const childrenByParent = new Map<string | null, ComposeLayerRecord[]>();
  for (const l of layers) {
    if (l.kind === 'compose_scene') continue;
    const key = l.parentId && present.has(l.parentId) ? l.parentId : null;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key)!.push(l);
  }
  const roots = orderSiblings(childrenByParent.get(null) ?? []);

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
      {roots.map((l) => (
        <LayerView
          key={l.id}
          layer={l}
          assets={assets}
          includeChain={includeChain}
          childrenByParent={childrenByParent}
          mode={mode}
        />
      ))}
    </div>
  );
}
