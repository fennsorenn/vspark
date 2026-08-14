import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  commitEffectCreate,
} from '../../mesh/effectWrites';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import {
  commitNodeCreate,
  commitNodePatch,
  commitNodePath,
} from '../../mesh/writes';
import { commitLayerCreate, commitLayerPath } from '../../mesh/layerWrites';
import type { AssetFile } from '../../api/client';
import type { BottomDockTab, Behavior } from '../../store/editorStore';
import { newBehaviorId, CAMERA_EFFECT_KINDS } from '../../store/editorStore';
import { BEHAVIOR_ICON, BEHAVIOR_FALLBACK } from '../icons';
import { TrackClipTimeline } from './TrackClipTimeline';
import { PresetLibrary } from './PresetLibrary';
import { CreatePalette } from './CreatePalette';
import { AssetThumb } from './AssetThumb';
import { DND_ASSET } from './dnd';
import { behaviorCompatibleWith } from './createKinds';
import { HelpButton } from '../../help/HelpButton';

/** Per-tab contextual help target — one consistent `?` follows the active tab. */
const tabHelp: Partial<
  Record<BottomDockTab, { topic: string; anchor?: string; tipKey: string }>
> = {
  create: { topic: 'scene', anchor: 'nodes', tipKey: 'help.create' },
  models: { topic: 'avatar', anchor: 'loading', tipKey: 'help.models' },
  animations: {
    topic: 'avatar',
    anchor: 'animation',
    tipKey: 'help.animations',
  },
  images: { topic: 'assets', anchor: 'kinds', tipKey: 'help.assets' },
  videos: { topic: 'assets', anchor: 'kinds', tipKey: 'help.assets' },
  audio: { topic: 'assets', anchor: 'kinds', tipKey: 'help.assets' },
  components: { topic: 'behaviors', anchor: 'vmc', tipKey: 'help.behaviors' },
  effects: { topic: 'camera-effects', anchor: 'what', tipKey: 'help.effects' },
  clips: { topic: 'track-clips', anchor: 'what', tipKey: 'help.clips' },
  presets: { topic: 'presets', anchor: 'what', tipKey: 'help.presets' },
};

export function AssetManager() {
  const { t } = useTranslation('assets');
  const {
    assets,
    addAsset,
    deleteAsset,
    activeSceneId,
    projectId,
    selectedNodeId,
    nodes,
    addBehavior,
    behaviors,
    behaviorKinds,
    cameraEffects,
  } = useEditorStore();
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const canApplyAnim =
    selectedNode?.kind === 'avatar' || selectedNode?.kind === 'model';
  const canApplyModel =
    selectedNode?.kind === 'avatar' || selectedNode?.kind === 'model';
  const canApplyTexture =
    selectedNode?.kind === 'billboard' || selectedNode?.kind === 'particle';
  const canApplyCameraBg = selectedNode?.kind === 'camera';
  const canApplyVideo = selectedNode?.kind === 'video';
  const canApplyAudio = selectedNode?.kind === 'audio';
  const tab = useEditorStore((s) => s.bottomTab);
  const setTab = useEditorStore((s) => s.setBottomTab);
  const leftTab = useEditorStore((s) => s.leftTab);
  const activeComposeSceneId = useEditorStore((s) => s.activeComposeSceneId);
  const selectComposeLayer = useEditorStore((s) => s.selectComposeLayer);
  const selectedComposeLayerId = useEditorStore(
    (s) => s.selectedComposeLayerId
  );
  const composeLayers = useEditorStore((s) => s.composeLayers);
  const updateComposeLayerLocal = useEditorStore(
    (s) => s.updateComposeLayerLocal
  );
  const selectedComposeLayer =
    composeLayers.find((l) => l.id === selectedComposeLayerId) ?? null;
  const canApplyImageLayer = selectedComposeLayer?.kind === 'image';
  const canApplyVideoLayer = selectedComposeLayer?.kind === 'video';
  const canApplyAudioLayer = selectedComposeLayer?.kind === 'audio';
  // The "Add" action follows the left-dock context: Compose tab → create a
  // compose layer; Scene/Graphs tab → create a 3D scene node.
  const composeMode = leftTab === 'compose';
  const bottomDockHeight = useEditorStore((s) => s.bottomDockHeight);
  const bottomTabFlash = useEditorStore((s) => s.bottomTabFlash);
  const [uploading, setUploading] = useState(false);
  const [assetQuery, setAssetQuery] = useState('');

  // Tabs worth highlighting for the current selection. Non-destructive — every
  // tab stays clickable; relevant ones just get an accent so the eye lands on
  // them (e.g. select an avatar → Animations + Components light up).
  const relevantTabs = new Set<BottomDockTab>();
  if (selectedNode) {
    relevantTabs.add('components');
    if (selectedNode.kind === 'avatar' || selectedNode.kind === 'model') {
      relevantTabs.add('models');
      relevantTabs.add('animations');
    }
    if (selectedNode.kind === 'camera') {
      relevantTabs.add('effects');
      relevantTabs.add('images');
    }
    if (selectedNode.kind === 'billboard' || selectedNode.kind === 'particle')
      relevantTabs.add('images');
    if (selectedNode.kind === 'video') relevantTabs.add('videos');
    if (selectedNode.kind === 'audio') relevantTabs.add('audio');
  }
  // A selected compose media layer highlights its asset tab too.
  if (selectedComposeLayer) {
    if (selectedComposeLayer.kind === 'image') relevantTabs.add('images');
    if (selectedComposeLayer.kind === 'video') relevantTabs.add('videos');
    if (selectedComposeLayer.kind === 'audio') relevantTabs.add('audio');
  }

  // Brief pulse of the active tab when something flashes it (scene "+" button,
  // Properties pickers). Toggling off→on restarts the CSS animation even when
  // the same tab is flashed twice in a row.
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!bottomTabFlash) return;
    setFlashing(false);
    const raf = requestAnimationFrame(() => setFlashing(true));
    const timer = setTimeout(() => setFlashing(false), 900);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [bottomTabFlash]);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const animInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const models = assets.filter((a) => a.kind === 'model');
  const animations = assets.filter((a) => a.kind === 'animation');
  const images = assets.filter((a) => a.kind === 'image');
  const videos = assets.filter((a) => a.kind === 'video');
  const audioAssets = assets.filter((a) => a.kind === 'audio');

  // OS file drag-and-drop onto the dock. Uploads every dropped file, then jumps
  // to the tab for the first file's kind so the upload is visible.
  const KIND_TO_TAB: Record<string, BottomDockTab> = {
    model: 'models',
    animation: 'animations',
    image: 'images',
    video: 'videos',
    audio: 'audio',
  };
  const dragDepth = useRef(0);
  const [fileDragOver, setFileDragOver] = useState(false);

  const handleUploadFiles = async (files: FileList | File[]) => {
    if (!projectId) {
      alert(t('alerts.noProject'));
      return;
    }
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    let firstKind: string | null = null;
    const failures: string[] = [];
    for (const file of list) {
      try {
        const asset = await api.uploadAsset(projectId, file);
        addAsset(asset);
        if (firstKind == null) firstKind = asset.kind;
      } catch {
        failures.push(file.name);
      }
    }
    setUploading(false);
    if (firstKind && KIND_TO_TAB[firstKind]) setTab(KIND_TO_TAB[firstKind]);
    if (failures.length > 0)
      alert(t('alerts.uploadFailedFiles', { files: failures.join(', ') }));
  };

  // Only react to OS file drags (dataTransfer carries "Files"); internal asset/
  // tile drags use custom MIME types and must pass straight through.
  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files');

  const handleAddToScene = async (asset: AssetFile) => {
    if (!activeSceneId) {
      alert(t('alerts.noScene'));
      return;
    }
    const ext = asset.name.split('.').pop()?.toLowerCase();
    const nodeKind = ext === 'vrm' ? 'avatar' : 'model';
    try {
      await commitNodeCreate(activeSceneId, {
        parentId: null,
        name: asset.name,
        kind: nodeKind,
        filePath: asset.url,
        components: {
          transform: {
            type: 'transform',
            x: 0,
            y: 0,
            z: 0,
            rx: 0,
            ry: 0,
            rz: 0,
            sx: 1,
            sy: 1,
            sz: 1,
          },
        },
      });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.addSceneFailed'));
    }
  };

  const handleAddAsBillboard = async (asset: AssetFile) => {
    if (!activeSceneId) {
      alert(t('alerts.noSceneShort'));
      return;
    }
    try {
      await commitNodeCreate(activeSceneId, {
        parentId: null,
        name: asset.name,
        kind: 'billboard',
        filePath: asset.url,
        components: {
          transform: {
            type: 'transform',
            x: 0,
            y: 0,
            z: 0,
            rx: 0,
            ry: 0,
            rz: 0,
            sx: 1,
            sy: 1,
            sz: 1,
          },
          billboard: {
            facing: 'world',
            backface: 'mirror',
            width: 1,
            height: 1,
            alpha: 1,
            textureUrl: asset.url,
          },
        },
      });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.addBillboardFailed'));
    }
  };

  const TRANSFORM_DEFAULT = {
    type: 'transform',
    x: 0,
    y: 0,
    z: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    sx: 1,
    sy: 1,
    sz: 1,
  };

  const handleAddAsVideo = async (asset: AssetFile) => {
    if (!activeSceneId) {
      alert(t('alerts.noSceneShort'));
      return;
    }
    try {
      await commitNodeCreate(activeSceneId, {
        parentId: null,
        name: asset.name,
        kind: 'video',
        filePath: asset.url,
        components: {
          transform: TRANSFORM_DEFAULT,
          video: {
            type: 'video',
            assetId: asset.id,
            sourceUrl: asset.url,
            facing: 'world',
            backface: 'none',
            width: 1.6,
            height: 0.9,
            alpha: 1,
            autoplay: true,
            loop: true,
            onEnd: 'freeze',
            muted: true,
            volume: 1,
          },
        },
      });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.addVideoFailed'));
    }
  };

  const handleAddAsAudio = async (asset: AssetFile) => {
    if (!activeSceneId) {
      alert(t('alerts.noSceneShort'));
      return;
    }
    try {
      await commitNodeCreate(activeSceneId, {
        parentId: null,
        name: asset.name,
        kind: 'audio',
        filePath: asset.url,
        components: {
          transform: TRANSFORM_DEFAULT,
          audio: {
            type: 'audio',
            audioType: 'simple',
            assetId: asset.id,
            sourceUrl: asset.url,
            autoplay: true,
            loop: false,
            onEnd: 'stop',
            volume: 1,
            fadeTime: 0,
            refDistance: 1,
            rolloffFactor: 1,
            maxDistance: 100,
            coneInnerAngle: 360,
            coneOuterAngle: 360,
            coneOuterGain: 0,
          },
        },
      });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.addAudioFailed'));
    }
  };

  // Add an image/video asset as a compose layer in the active compose scene.
  const handleAddAsLayer = async (
    asset: AssetFile,
    kind: 'image' | 'video'
  ) => {
    if (!activeComposeSceneId) {
      alert(t('alerts.noComposeScene'));
      return;
    }
    const config: Record<string, unknown> =
      kind === 'video'
        ? {
            objectFit: 'contain',
            autoplay: true,
            loop: true,
            onEnd: 'freeze',
            muted: true,
            volume: 1,
          }
        : { objectFit: 'contain' };
    try {
      const created = await commitLayerCreate(activeComposeSceneId, {
        name: asset.name,
        kind,
        assetId: asset.id,
        config,
      });
      selectComposeLayer(created.id);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.addLayerFailed'));
    }
  };

  const handleApplyMediaSource = async (
    asset: AssetFile,
    key: 'video' | 'audio'
  ) => {
    if (!selectedNode) return;
    const existing = (selectedNode.components?.[key] ?? {}) as Record<
      string,
      unknown
    >;
    const components = {
      ...selectedNode.components,
      [key]: { ...existing, assetId: asset.id, sourceUrl: asset.url },
    };
    try {
      commitNodePatch(selectedNode.id, { components, filePath: asset.url });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.applyMediaFailed'));
    }
  };

  // Compose media layers (image / video / audio) resolve their source from the
  // `assetId` column — set it on the selected layer from the drawer.
  const handleApplyMediaSourceToLayer = async (asset: AssetFile) => {
    const layer = selectedComposeLayer;
    if (!layer) return;
    try {
      commitLayerPath(layer.id, 'assetId', asset.id);
      updateComposeLayerLocal(layer.id, { assetId: asset.id });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.applyMediaFailed'));
    }
  };

  const handleApplyTexture = async (asset: AssetFile) => {
    if (!selectedNode) return;
    const key = selectedNode.kind === 'particle' ? 'particle' : 'billboard';
    const existing = (selectedNode.components?.[key] ?? {}) as Record<
      string,
      unknown
    >;
    const components = {
      ...selectedNode.components,
      [key]: { ...existing, textureUrl: asset.url },
    };
    try {
      commitNodePath(selectedNode.id, 'components', components);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.applyTextureFailed'));
    }
  };

  const handleApplyCameraBg = async (asset: AssetFile) => {
    if (!selectedNode) return;
    const existing = (selectedNode.components?.camera ?? {}) as Record<
      string,
      unknown
    >;
    const components = {
      ...selectedNode.components,
      camera: { ...existing, backgroundImage: asset.url },
    };
    try {
      commitNodePath(selectedNode.id, 'components', components);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.applyCameraBgFailed'));
    }
  };

  const handleApplyModel = async (asset: AssetFile) => {
    if (!selectedNode) return;
    try {
      commitNodePath(selectedNode.id, 'filePath', asset.url);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.applyModelFailed'));
    }
  };

  const handleApplyAnimation = async (asset: AssetFile) => {
    if (!selectedNode) return;
    // Write the legacy idle shape AND clear any migrated
    // properties.animation.idle. The resolver (and the properties panel) prefer
    // the migrated { clipId } over the legacy idleUrl, so leaving a stale clipId
    // behind would silently pin the avatar to the *previous* idle — the new url
    // would land in the ignored legacy slot. Clearing it lets the Viewport
    // re-derive a fresh clip id for this url, exactly like the panel's edit path.
    const prevProps = (selectedNode.properties as Record<string, unknown>) ?? {};
    const prevAnim =
      (prevProps.animation as Record<string, unknown> | undefined) ?? {};
    const prevSpeed =
      (prevAnim.idle as { speed?: number } | undefined)?.speed ??
      (selectedNode.components?.animation as { speed?: number } | undefined)
        ?.speed ??
      1;
    const components = {
      ...selectedNode.components,
      animation: { idleUrl: asset.url, speed: prevSpeed },
    };
    const properties = { ...prevProps, animation: { ...prevAnim, idle: undefined } };
    try {
      commitNodePatch(selectedNode.id, { components, properties });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.applyAnimFailed'));
    }
  };

  // Set the clip as the avatar's *base* animation — the loop live tracking
  // stacks onto (properties.animation.base), distinct from the idle. Mirrors the
  // Properties panel's base-animation edit path (url shape, replaces base
  // wholesale so no stale clipId lingers).
  const handleApplyAnimationAsBase = async (asset: AssetFile) => {
    if (!selectedNode) return;
    const prevProps = (selectedNode.properties as Record<string, unknown>) ?? {};
    const prevAnim =
      (prevProps.animation as Record<string, unknown> | undefined) ?? {};
    const prevSpeed =
      (prevAnim.base as { speed?: number } | undefined)?.speed ?? 1;
    const properties = {
      ...prevProps,
      animation: { ...prevAnim, base: { url: asset.url, speed: prevSpeed } },
    };
    try {
      commitNodePath(selectedNode.id, 'properties', properties);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.applyAnimFailed'));
    }
  };

  const handleDelete = async (asset: AssetFile) => {
    try {
      await api.deleteAsset(asset.id);
      deleteAsset(asset.id);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.deleteFailed'));
    }
  };

  const handleAddBehavior = async (kind: string) => {
    if (!selectedNode) return;
    const ct = behaviorKinds.find((c) => c.kind === kind);
    if (!ct) return;
    const comp: Behavior = {
      id: newBehaviorId(),
      nodeId: selectedNode.id,
      kind,
      enabled: true,
      config: { ...ct.defaultConfig },
    };
    addBehavior(comp);
    try {
      await api.createBehavior(selectedNode.id, comp);
    } catch {
      /* non-fatal */
    }
  };

  const handleAddEffect = async (kind: string) => {
    if (!selectedNode || selectedNode.kind !== 'camera') return;
    const ek = CAMERA_EFFECT_KINDS.find((k) => k.kind === kind);
    if (!ek) return;
    const effect = {
      id: newBehaviorId(),
      nodeId: selectedNode.id,
      kind,
      enabled: true,
      config: { ...ek.defaultConfig },
    };
    await commitEffectCreate(selectedNode.id, effect);
  };

  const tabBtn = (tabId: BottomDockTab): React.CSSProperties => {
    const active = tab === tabId;
    const relevant = relevantTabs.has(tabId);
    return {
      background: active ? '#2a2a2a' : 'none',
      border: 'none',
      borderBottom: active
        ? '2px solid #2563eb'
        : relevant
          ? '2px solid #3a5a8a'
          : '2px solid transparent',
      color: active ? '#e0e0e0' : relevant ? '#9bb4cc' : '#666',
      padding: '6px 14px',
      cursor: 'pointer',
      fontSize: 13,
      fontFamily: 'system-ui, sans-serif',
      borderRadius: 3,
      animation: active && flashing ? 'vsTabFlash 0.45s ease 2' : undefined,
    };
  };

  // Responsive tile grid for the card-based tabs (Components, Effects, assets).
  // Replaces the old one-card-per-row layout so a wide dock fills horizontally.
  const cardGrid: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: 8,
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    margin: '12px 0 6px',
  };

  // One component card. `dimmed` is used for components that don't normally
  // apply to the selected node's kind — still addable, just de-emphasised.
  const renderBehaviorCard = (
    ct: (typeof behaviorKinds)[number],
    dimmed: boolean
  ) => {
    const alreadyAdded = behaviors.some(
      (c) => c.nodeId === selectedNode!.id && c.kind === ct.kind
    );
    return (
      <div
        key={ct.kind}
        style={{
          background: '#1e1e1e',
          border: '1px solid #2a2a2a',
          borderRadius: 6,
          padding: '10px 12px',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          opacity: dimmed ? 0.55 : 1,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            lineHeight: 1,
            marginTop: 2,
            color: '#cfcfcf',
          }}
        >
          {(() => {
            const I = BEHAVIOR_ICON[ct.kind] ?? BEHAVIOR_FALLBACK;
            return <I size={20} />;
          })()}
        </span>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: '#e0e0e0',
              marginBottom: 3,
            }}
          >
            {t(`kinds:behavior.${ct.kind}.label`, { defaultValue: ct.label })}
          </div>
          <div style={{ fontSize: 11, color: '#666', lineHeight: 1.4 }}>
            {t(`kinds:behavior.${ct.kind}.description`, {
              defaultValue: ct.description,
            })}
          </div>
        </div>
        <button
          style={{
            background: alreadyAdded ? '#1a2a1a' : '#1a3a1a',
            border: 'none',
            color: alreadyAdded ? '#4a7' : '#5b9',
            borderRadius: 4,
            padding: '3px 10px',
            cursor: alreadyAdded ? 'default' : 'pointer',
            fontSize: 11,
            flexShrink: 0,
            marginTop: 2,
          }}
          disabled={alreadyAdded}
          onClick={() => handleAddBehavior(ct.kind)}
          title={
            alreadyAdded
              ? t('card.alreadyAdded')
              : t('card.addToNode', { name: selectedNode!.name })
          }
        >
          {alreadyAdded ? t('card.added') : t('card.add')}
        </button>
      </div>
    );
  };

  const uploadBtn: React.CSSProperties = {
    background: uploading ? '#1a3a5a' : '#2563eb',
    border: 'none',
    color: '#fff',
    borderRadius: 5,
    padding: '4px 12px',
    cursor: uploading ? 'not-allowed' : 'pointer',
    fontSize: 12,
    fontWeight: 500,
    flexShrink: 0,
  };

  return (
    <div
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setFileDragOver(true);
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setFileDragOver(false);
        }
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setFileDragOver(false);
        handleUploadFiles(e.dataTransfer.files);
      }}
      style={{
        height: bottomDockHeight,
        flexShrink: 0,
        background: '#141414',
        borderTop: '1px solid #2a2a2a',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
        position: 'relative',
      }}
    >
      <BottomDockResizeHandle />
      {fileDragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            background: 'rgba(37,99,235,0.12)',
            border: '2px dashed #2563eb',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div style={{ color: '#cfe0ff', fontSize: 15, fontWeight: 600 }}>
            {t('upload.dropFiles')}
          </div>
        </div>
      )}
      <style>{`@keyframes vsTabFlash { 0%,100% { box-shadow: none } 50% { box-shadow: 0 0 0 2px #2563eb inset, 0 0 10px rgba(37,99,235,0.6) } }`}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid #2a2a2a',
          padding: '0 12px',
          gap: 4,
          flexShrink: 0,
        }}
      >
        <button className="vs-tab-create" style={tabBtn('create')} onClick={() => setTab('create')}>
          {t('tabs.create')}
        </button>
        <button className="vs-tab-models" style={tabBtn('models')} onClick={() => setTab('models')}>
          {t('tabs.models')}
        </button>
        <button
          className="vs-tab-animations"
          style={tabBtn('animations')}
          onClick={() => setTab('animations')}
        >
          {t('tabs.animations')}
        </button>
        <button className="vs-tab-images" style={tabBtn('images')} onClick={() => setTab('images')}>
          {t('tabs.images')}
        </button>
        <button className="vs-tab-videos" style={tabBtn('videos')} onClick={() => setTab('videos')}>
          {t('tabs.videos')}
        </button>
        <button className="vs-tab-audio" style={tabBtn('audio')} onClick={() => setTab('audio')}>
          {t('tabs.audio')}
        </button>
        <button
          className="vs-tab-components"
          style={tabBtn('components')}
          onClick={() => setTab('components')}
        >
          {t('tabs.components')}
        </button>
        <button className="vs-tab-effects" style={tabBtn('effects')} onClick={() => setTab('effects')}>
          {t('tabs.effects')}
        </button>
        <button className="vs-tab-clips" style={tabBtn('clips')} onClick={() => setTab('clips')}>
          {t('tabs.clips')}
        </button>
        <button className="vs-tab-presets" style={tabBtn('presets')} onClick={() => setTab('presets')}>
          {t('tabs.presets')}
        </button>
        {/* One contextual help affordance for the active tab — consistent across
            all tabs, instead of an inconsistent scatter of per-tab buttons. */}
        {tabHelp[tab] && (
          <HelpButton
            topic={tabHelp[tab]!.topic}
            anchor={tabHelp[tab]!.anchor}
            tip={t(tabHelp[tab]!.tipKey)}
            size={12}
          />
        )}
        <div style={{ flex: 1 }} />
        {(tab === 'models' ||
          tab === 'animations' ||
          tab === 'images' ||
          tab === 'videos' ||
          tab === 'audio') && (
          <input
            className="vs-asset-search"
            value={assetQuery}
            onChange={(e) => setAssetQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            style={{
              background: '#1a1a1a',
              border: '1px solid #2a2a2a',
              borderRadius: 5,
              color: '#ccc',
              padding: '4px 8px',
              fontSize: 12,
              width: 130,
              marginRight: 4,
            }}
          />
        )}
        {tab === 'create' ||
        tab === 'components' ||
        tab === 'effects' ||
        tab === 'clips' ||
        tab === 'presets' ? null : tab === 'models' ? (
          <>
            <button
              className="vs-upload-model"
              style={uploadBtn}
              disabled={uploading}
              onClick={() => modelInputRef.current?.click()}
            >
              {uploading ? t('upload.uploading') : t('upload.model')}
            </button>
            <input
              ref={modelInputRef}
              type="file"
              accept=".vrm,.glb,.gltf"
              style={{ display: 'none' }}
              multiple
              onChange={(e) => {
                if (e.target.files) handleUploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        ) : tab === 'animations' ? (
          <>
            <button
              className="vs-upload-animation"
              style={uploadBtn}
              disabled={uploading}
              onClick={() => animInputRef.current?.click()}
            >
              {uploading ? t('upload.uploading') : t('upload.animation')}
            </button>
            <input
              ref={animInputRef}
              type="file"
              accept=".fbx,.bvh"
              style={{ display: 'none' }}
              multiple
              onChange={(e) => {
                if (e.target.files) handleUploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        ) : tab === 'images' ? (
          <>
            <button
              className="vs-upload-image"
              style={uploadBtn}
              disabled={uploading}
              onClick={() => imageInputRef.current?.click()}
            >
              {uploading ? t('upload.uploading') : t('upload.image')}
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.webp,.gif,.avif"
              style={{ display: 'none' }}
              multiple
              onChange={(e) => {
                if (e.target.files) handleUploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        ) : tab === 'videos' ? (
          <>
            <button
              className="vs-upload-video"
              style={uploadBtn}
              disabled={uploading}
              onClick={() => videoInputRef.current?.click()}
            >
              {uploading ? t('upload.uploading') : t('upload.video')}
            </button>
            <input
              ref={videoInputRef}
              type="file"
              accept=".mp4,.webm,.mov,.m4v,.ogv"
              style={{ display: 'none' }}
              multiple
              onChange={(e) => {
                if (e.target.files) handleUploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        ) : tab === 'audio' ? (
          <>
            <button
              className="vs-upload-audio"
              style={uploadBtn}
              disabled={uploading}
              onClick={() => audioInputRef.current?.click()}
            >
              {uploading ? t('upload.uploading') : t('upload.audio')}
            </button>
            <input
              ref={audioInputRef}
              type="file"
              accept=".mp3,.wav,.ogg,.m4a,.aac,.flac"
              style={{ display: 'none' }}
              multiple
              onChange={(e) => {
                if (e.target.files) handleUploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        ) : null}
      </div>

      {tab === 'create' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <CreatePalette />
        </div>
      ) : tab === 'clips' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <TrackClipTimeline />
        </div>
      ) : tab === 'presets' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <PresetLibrary />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {/* Components tab */}
          {tab === 'components' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {!selectedNode && (
                <div
                  style={{
                    color: '#555',
                    fontSize: 12,
                    textAlign: 'center',
                    paddingTop: 12,
                  }}
                >
                  {t('empty.selectNode')}
                </div>
              )}
              {selectedNode &&
                (() => {
                  const compatible = behaviorKinds.filter((ct) =>
                    behaviorCompatibleWith(ct.applicableTo, selectedNode.kind)
                  );
                  const incompatible = behaviorKinds.filter(
                    (ct) =>
                      !behaviorCompatibleWith(
                        ct.applicableTo,
                        selectedNode.kind
                      )
                  );
                  return (
                    <>
                      <div style={cardGrid}>
                        {compatible.map((ct) => renderBehaviorCard(ct, false))}
                      </div>
                      {incompatible.length > 0 && (
                        <>
                          <div style={sectionLabel}>
                            {t('behaviors.otherBehaviors', {
                              kind: selectedNode.kind,
                            })}
                          </div>
                          <div style={cardGrid}>
                            {incompatible.map((ct) =>
                              renderBehaviorCard(ct, true)
                            )}
                          </div>
                        </>
                      )}
                    </>
                  );
                })()}
            </div>
          )}

          {/* Effects tab */}
          {tab === 'effects' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(!selectedNode || selectedNode.kind !== 'camera') && (
                <div
                  style={{
                    color: '#555',
                    fontSize: 12,
                    textAlign: 'center',
                    paddingTop: 12,
                  }}
                >
                  {t('empty.selectCamera')}
                </div>
              )}
              {selectedNode && selectedNode.kind === 'camera' && (
                <div style={cardGrid}>
                  {CAMERA_EFFECT_KINDS.map((ek) => {
                    const alreadyAdded = cameraEffects.some(
                      (e) => e.nodeId === selectedNode.id && e.kind === ek.kind
                    );
                    return (
                      <div
                        key={ek.kind}
                        style={{
                          background: '#1e1e1e',
                          border: '1px solid #2a2a2a',
                          borderRadius: 6,
                          padding: '10px 12px',
                          display: 'flex',
                          gap: 10,
                          alignItems: 'flex-start',
                        }}
                      >
                        <span
                          style={{
                            display: 'inline-flex',
                            lineHeight: 1,
                            marginTop: 2,
                            color: '#cfcfcf',
                          }}
                        >
                          {(() => {
                            const I = ek.icon;
                            return <I size={20} />;
                          })()}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              color: '#e0e0e0',
                              marginBottom: 3,
                            }}
                          >
                            {t(`kinds:effect.${ek.kind}.label`, {
                              defaultValue: ek.label,
                            })}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: '#666',
                              lineHeight: 1.4,
                            }}
                          >
                            {t(`kinds:effect.${ek.kind}.description`, {
                              defaultValue: ek.description,
                            })}
                          </div>
                        </div>
                        <button
                          style={{
                            background: alreadyAdded ? '#1a2a1a' : '#1a3a1a',
                            border: 'none',
                            color: alreadyAdded ? '#4a7' : '#5b9',
                            borderRadius: 4,
                            padding: '3px 10px',
                            cursor: alreadyAdded ? 'default' : 'pointer',
                            fontSize: 11,
                            flexShrink: 0,
                            marginTop: 2,
                          }}
                          disabled={alreadyAdded}
                          onClick={() => handleAddEffect(ek.kind)}
                          title={
                            alreadyAdded
                              ? t('card.alreadyAdded')
                              : t('card.addToNode', { name: selectedNode.name })
                          }
                        >
                          {alreadyAdded ? t('card.added') : t('card.add')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Models / Animations / Images / Videos / Audio tabs */}
          {(tab === 'models' ||
            tab === 'animations' ||
            tab === 'images' ||
            tab === 'videos' ||
            tab === 'audio') &&
            (() => {
              const all =
                tab === 'models'
                  ? models
                  : tab === 'animations'
                    ? animations
                    : tab === 'images'
                      ? images
                      : tab === 'videos'
                        ? videos
                        : audioAssets;
              const q = assetQuery.trim().toLowerCase();
              const list = q
                ? all.filter((a) => a.name.toLowerCase().includes(q))
                : all;
              if (all.length === 0)
                return (
                  <div
                    style={{
                      color: '#555',
                      fontSize: 12,
                      textAlign: 'center',
                      paddingTop: 20,
                    }}
                  >
                    {t('empty.noAssets', { tab: t(`tabs.${tab}`) })}
                  </div>
                );
              if (list.length === 0)
                return (
                  <div
                    style={{
                      color: '#555',
                      fontSize: 12,
                      textAlign: 'center',
                      paddingTop: 20,
                    }}
                  >
                    {t('empty.noMatch', {
                      tab: t(`tabs.${tab}`),
                      query: assetQuery,
                    })}
                  </div>
                );
              const cardStyle: React.CSSProperties = {
                background: '#1e1e1e',
                border: '1px solid #2a2a2a',
                borderRadius: 6,
                padding: '8px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                minWidth: 0,
              };
              const extBadge: React.CSSProperties = {
                display: 'inline-block',
                background: '#2a2a2a',
                borderRadius: 3,
                padding: '1px 6px',
                fontSize: 10,
                color: '#888',
                alignSelf: 'flex-start',
              };
              return (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fill, minmax(150px, 1fr))',
                    gap: 10,
                  }}
                >
                  {list.map((asset) => (
                    <div
                      key={asset.id}
                      style={{ ...cardStyle, cursor: 'grab' }}
                      draggable
                      title={t('card.dragHint')}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'copy';
                        e.dataTransfer.setData(DND_ASSET, asset.id);
                      }}
                    >
                      {/* Thumbnail (image preview, lazy 3D render for models) */}
                      <AssetThumb asset={asset} />
                      <div
                        style={{
                          fontSize: 13,
                          color: '#e0e0e0',
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {asset.name}
                      </div>
                      <div style={extBadge}>
                        {asset.name.split('.').pop()?.toUpperCase()}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: 6,
                          marginTop: 2,
                          flexWrap: 'wrap',
                        }}
                      >
                        {asset.kind === 'model' && (
                          <button
                            className="vs-asset-add-to-scene"
                            style={{
                              background: '#1a3a5a',
                              border: 'none',
                              color: '#7ab',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            onClick={() => handleAddToScene(asset)}
                          >
                            {t('actions.addToScene')}
                          </button>
                        )}
                        {asset.kind === 'model' && canApplyModel && (
                          <button
                            className="vs-asset-apply-model"
                            style={{
                              background: '#1a3a2a',
                              border: 'none',
                              color: '#7c9',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyToNodeTitle', {
                              name: selectedNode!.name,
                            })}
                            onClick={() => handleApplyModel(asset)}
                          >
                            {t('actions.applyToNode', {
                              name: selectedNode!.name,
                            })}
                          </button>
                        )}
                        {asset.kind === 'animation' && canApplyAnim && (
                          <button
                            className="vs-asset-apply-animation"
                            style={{
                              background: '#1a3a2a',
                              border: 'none',
                              color: '#7c9',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyAnimIdleTitle', {
                              name: selectedNode!.name,
                            })}
                            onClick={() => handleApplyAnimation(asset)}
                          >
                            {t('actions.applyAnimIdle')}
                          </button>
                        )}
                        {asset.kind === 'animation' && canApplyAnim && (
                          <button
                            className="vs-asset-apply-animation-base"
                            style={{
                              background: '#2a2a4a',
                              border: 'none',
                              color: '#99c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyAnimBaseTitle', {
                              name: selectedNode!.name,
                            })}
                            onClick={() => handleApplyAnimationAsBase(asset)}
                          >
                            {t('actions.applyAnimBase')}
                          </button>
                        )}
                        {asset.kind === 'animation' && !canApplyAnim && (
                          <span
                            style={{
                              fontSize: 10,
                              color: '#555',
                              alignSelf: 'center',
                            }}
                          >
                            {t('empty.selectAvatar')}
                          </span>
                        )}
                        {asset.kind === 'image' && (
                          <button
                            className="vs-asset-add-image"
                            style={{
                              background: '#1a2a4a',
                              border: 'none',
                              color: '#78b',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={
                              composeMode
                                ? t('actions.addAsBillboardTitle')
                                : t('actions.addAsBillboard3dTitle')
                            }
                            onClick={() =>
                              composeMode
                                ? handleAddAsLayer(asset, 'image')
                                : handleAddAsBillboard(asset)
                            }
                          >
                            {composeMode
                              ? t('actions.addAsLayer')
                              : t('actions.addAsBillboard')}
                          </button>
                        )}
                        {asset.kind === 'image' && canApplyTexture && (
                          <button
                            className="vs-asset-apply-texture"
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyTextureTitle', {
                              name: selectedNode!.name,
                            })}
                            onClick={() => handleApplyTexture(asset)}
                          >
                            {t('actions.applyTexture', {
                              name: selectedNode!.name,
                            })}
                          </button>
                        )}
                        {asset.kind === 'image' && canApplyCameraBg && (
                          <button
                            className="vs-asset-set-camera-bg"
                            style={{
                              background: '#1a2a1a',
                              border: 'none',
                              color: '#7c9',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.setAsBgTitle', {
                              name: selectedNode!.name,
                            })}
                            onClick={() => handleApplyCameraBg(asset)}
                          >
                            {t('actions.setAsBg')}
                          </button>
                        )}
                        {asset.kind === 'image' && canApplyImageLayer && (
                          <button
                            className="vs-asset-apply-image-layer"
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyToLayerTitle', {
                              name: selectedComposeLayer!.name,
                            })}
                            onClick={() => handleApplyMediaSourceToLayer(asset)}
                          >
                            {t('actions.applyToLayer', {
                              name: selectedComposeLayer!.name,
                            })}
                          </button>
                        )}
                        {asset.kind === 'image' &&
                          !canApplyTexture &&
                          !canApplyCameraBg &&
                          selectedNode && (
                            <span
                              style={{
                                fontSize: 10,
                                color: '#555',
                                alignSelf: 'center',
                              }}
                            >
                              {t('empty.selectBillboardOrCamera')}
                            </span>
                          )}
                        {asset.kind === 'video' && (
                          <button
                            className="vs-asset-add-video"
                            style={{
                              background: '#1a2a4a',
                              border: 'none',
                              color: '#78b',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={
                              composeMode
                                ? t('actions.addAsVideoLayerTitle')
                                : t('actions.addAsVideo3dTitle')
                            }
                            onClick={() =>
                              composeMode
                                ? handleAddAsLayer(asset, 'video')
                                : handleAddAsVideo(asset)
                            }
                          >
                            {composeMode
                              ? t('actions.addAsLayer')
                              : t('actions.addAsVideo')}
                          </button>
                        )}
                        {asset.kind === 'video' && canApplyVideo && (
                          <button
                            className="vs-asset-apply-video"
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyVideoTitle', {
                              name: selectedNode!.name,
                            })}
                            onClick={() =>
                              handleApplyMediaSource(asset, 'video')
                            }
                          >
                            {t('actions.applyToNode', {
                              name: selectedNode!.name,
                            })}
                          </button>
                        )}
                        {asset.kind === 'video' && canApplyVideoLayer && (
                          <button
                            className="vs-asset-apply-video-layer"
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyToLayerTitle', {
                              name: selectedComposeLayer!.name,
                            })}
                            onClick={() => handleApplyMediaSourceToLayer(asset)}
                          >
                            {t('actions.applyToLayer', {
                              name: selectedComposeLayer!.name,
                            })}
                          </button>
                        )}
                        {asset.kind === 'audio' && (
                          <button
                            className="vs-asset-add-audio"
                            style={{
                              background: '#1a3a2a',
                              border: 'none',
                              color: '#7c9',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            onClick={() => handleAddAsAudio(asset)}
                          >
                            {t('actions.addAsAudio')}
                          </button>
                        )}
                        {asset.kind === 'audio' && canApplyAudio && (
                          <button
                            className="vs-asset-apply-audio"
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyAudioTitle', {
                              name: selectedNode!.name,
                            })}
                            onClick={() =>
                              handleApplyMediaSource(asset, 'audio')
                            }
                          >
                            {t('actions.applyToNode', {
                              name: selectedNode!.name,
                            })}
                          </button>
                        )}
                        {asset.kind === 'audio' && canApplyAudioLayer && (
                          <button
                            className="vs-asset-apply-audio-layer"
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyToLayerTitle', {
                              name: selectedComposeLayer!.name,
                            })}
                            onClick={() => handleApplyMediaSourceToLayer(asset)}
                          >
                            {t('actions.applyToLayer', {
                              name: selectedComposeLayer!.name,
                            })}
                          </button>
                        )}
                        <button
                          className="vs-asset-delete"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#666',
                            cursor: 'pointer',
                            fontSize: 14,
                            padding: '0 2px',
                          }}
                          onClick={() => handleDelete(asset)}
                          title={t('card.remove')}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
        </div>
      )}
    </div>
  );
}

/** 4px hit-strip along the top edge of the bottom dock. Dragging up enlarges
 *  the dock; the height is clamped in the store action. Highlights on hover so
 *  the user can find it. */
export function BottomDockResizeHandle() {
  const { t } = useTranslation('assets');
  const setBottomDockHeight = useEditorStore((s) => s.setBottomDockHeight);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = useEditorStore.getState().bottomDockHeight;
    const onMove = (me: PointerEvent) => {
      setBottomDockHeight(startH + (startY - me.clientY));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      onPointerDown={onPointerDown}
      title={t('resize.dragTitle')}
      style={{
        position: 'absolute',
        top: -2,
        left: 0,
        right: 0,
        height: 6,
        cursor: 'ns-resize',
        zIndex: 10,
      }}
    />
  );
}
