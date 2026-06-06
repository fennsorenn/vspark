import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import type { AssetFile } from '../../api/client';
import type { BottomDockTab, Behavior } from '../../store/editorStore';
import { newBehaviorId, CAMERA_EFFECT_KINDS } from '../../store/editorStore';
import { TrackClipTimeline } from './TrackClipTimeline';
import { PresetLibrary } from './PresetLibrary';
import { CreatePalette } from './CreatePalette';
import { AssetThumb } from './AssetThumb';
import { DND_ASSET } from './dnd';
import { behaviorCompatibleWith } from './createKinds';
import { HelpButton } from '../../help/HelpButton';

export function AssetManager() {
  const { t } = useTranslation('assets');
  const {
    assets,
    addAsset,
    deleteAsset,
    activeSceneId,
    addNode,
    projectId,
    selectedNodeId,
    nodes,
    updateNode: storeUpdateNode,
    addBehavior,
    behaviors,
    behaviorKinds,
    cameraEffects,
    addCameraEffect,
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
  const addComposeLayer = useEditorStore((s) => s.addComposeLayer);
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

  const handleUpload = async (file: File) => {
    if (!projectId) {
      alert(t('alerts.noProject'));
      return;
    }
    setUploading(true);
    try {
      const asset = await api.uploadAsset(projectId, file);
      addAsset(asset);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

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
    if (failures.length > 0) alert(t('alerts.uploadFailedFiles', { files: failures.join(', ') }));
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
      const node = await api.createNode(activeSceneId, {
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
      if (useEditorStore.getState().nodes.every((n) => n.id !== node.id))
        addNode(node);
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
      const node = await api.createNode(activeSceneId, {
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
            facing: 'screen',
            backface: 'none',
            width: 1,
            height: 1,
            alpha: 1,
            textureUrl: asset.url,
          },
        },
      });
      if (useEditorStore.getState().nodes.every((n) => n.id !== node.id))
        addNode(node);
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
      const node = await api.createNode(activeSceneId, {
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
      if (useEditorStore.getState().nodes.every((n) => n.id !== node.id))
        addNode(node);
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
      const node = await api.createNode(activeSceneId, {
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
      if (useEditorStore.getState().nodes.every((n) => n.id !== node.id))
        addNode(node);
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
      const created = await api.createComposeSceneLayer(activeComposeSceneId, {
        name: asset.name,
        kind,
        assetId: asset.id,
        config,
      });
      addComposeLayer(created);
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
      await api.updateNode(selectedNode.id, {
        components,
        filePath: asset.url,
      });
      storeUpdateNode(selectedNode.id, { components, filePath: asset.url });
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
      await api.updateComposeLayer(layer.id, { assetId: asset.id });
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
      await api.updateNode(selectedNode.id, { components });
      storeUpdateNode(selectedNode.id, { components });
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
      await api.updateNode(selectedNode.id, { components });
      storeUpdateNode(selectedNode.id, { components });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.applyCameraBgFailed'));
    }
  };

  const handleApplyModel = async (asset: AssetFile) => {
    if (!selectedNode) return;
    try {
      await api.updateNode(selectedNode.id, { filePath: asset.url });
      storeUpdateNode(selectedNode.id, { filePath: asset.url });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : t('alerts.applyModelFailed'));
    }
  };

  const handleApplyAnimation = async (asset: AssetFile) => {
    if (!selectedNode) return;
    const components = {
      ...selectedNode.components,
      animation: { idleUrl: asset.url },
    };
    try {
      await api.updateNode(selectedNode.id, { components });
      storeUpdateNode(selectedNode.id, { components });
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
    addCameraEffect(effect);
    try {
      await api.createCameraEffect(selectedNode.id, effect);
    } catch {
      /* non-fatal */
    }
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
        <span style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}>
          {ct.icon}
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
            {ct.label}
          </div>
          <div style={{ fontSize: 11, color: '#666', lineHeight: 1.4 }}>
            {ct.description}
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
            alreadyAdded ? t('card.alreadyAdded') : t('card.addToNode', { name: selectedNode!.name })
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
        <button style={tabBtn('create')} onClick={() => setTab('create')}>
          {t('tabs.create')}
        </button>
        <button style={tabBtn('models')} onClick={() => setTab('models')}>
          {t('tabs.models')}
        </button>
        <HelpButton topic="avatar" anchor="loading" tip={t('help.models')} size={12} />
        <button
          style={tabBtn('animations')}
          onClick={() => setTab('animations')}
        >
          {t('tabs.animations')}
        </button>
        <HelpButton topic="avatar" anchor="animation" tip={t('help.animations')} size={12} />
        <button style={tabBtn('images')} onClick={() => setTab('images')}>
          {t('tabs.images')}
        </button>
        <button style={tabBtn('videos')} onClick={() => setTab('videos')}>
          {t('tabs.videos')}
        </button>
        <button style={tabBtn('audio')} onClick={() => setTab('audio')}>
          {t('tabs.audio')}
        </button>
        <button
          style={tabBtn('components')}
          onClick={() => setTab('components')}
        >
          {t('tabs.components')}
        </button>
        <HelpButton topic="behaviors" anchor="vmc" tip={t('help.behaviors')} size={12} />
        <button style={tabBtn('effects')} onClick={() => setTab('effects')}>
          {t('tabs.effects')}
        </button>
        <button style={tabBtn('clips')} onClick={() => setTab('clips')}>
          {t('tabs.clips')}
        </button>
        <button style={tabBtn('presets')} onClick={() => setTab('presets')}>
          {t('tabs.presets')}
        </button>
        <HelpButton topic="assets" anchor="what" tip={t('help.assets')} size={12} />
        <div style={{ flex: 1 }} />
        {(tab === 'models' ||
          tab === 'animations' ||
          tab === 'images' ||
          tab === 'videos' ||
          tab === 'audio') && (
          <input
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
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
                e.target.value = '';
              }}
            />
          </>
        ) : tab === 'animations' ? (
          <>
            <button
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
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
                e.target.value = '';
              }}
            />
          </>
        ) : tab === 'images' ? (
          <>
            <button
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
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
                e.target.value = '';
              }}
            />
          </>
        ) : tab === 'videos' ? (
          <>
            <button
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
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
                e.target.value = '';
              }}
            />
          </>
        ) : tab === 'audio' ? (
          <>
            <button
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
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
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
                            {t('behaviors.otherBehaviors', { kind: selectedNode.kind })}
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
                          style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}
                        >
                          {ek.icon}
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
                            {ek.label}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: '#666',
                              lineHeight: 1.4,
                            }}
                          >
                            {ek.description}
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
                    {t('empty.noAssets', { tab })}
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
                    {t('empty.noMatch', { tab, query: assetQuery })}
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
                            style={{
                              background: '#1a3a2a',
                              border: 'none',
                              color: '#7c9',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyToNodeTitle', { name: selectedNode!.name })}
                            onClick={() => handleApplyModel(asset)}
                          >
                            {t('actions.applyToNode', { name: selectedNode!.name })}
                          </button>
                        )}
                        {asset.kind === 'animation' && canApplyAnim && (
                          <button
                            style={{
                              background: '#1a3a2a',
                              border: 'none',
                              color: '#7c9',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyAnimTitle', { name: selectedNode!.name })}
                            onClick={() => handleApplyAnimation(asset)}
                          >
                            {t('actions.applyToNode', { name: selectedNode!.name })}
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
                            {composeMode ? t('actions.addAsLayer') : t('actions.addAsBillboard')}
                          </button>
                        )}
                        {asset.kind === 'image' && canApplyTexture && (
                          <button
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyTextureTitle', { name: selectedNode!.name })}
                            onClick={() => handleApplyTexture(asset)}
                          >
                            {t('actions.applyTexture', { name: selectedNode!.name })}
                          </button>
                        )}
                        {asset.kind === 'image' && canApplyCameraBg && (
                          <button
                            style={{
                              background: '#1a2a1a',
                              border: 'none',
                              color: '#7c9',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.setAsBgTitle', { name: selectedNode!.name })}
                            onClick={() => handleApplyCameraBg(asset)}
                          >
                            {t('actions.setAsBg')}
                          </button>
                        )}
                        {asset.kind === 'image' && canApplyImageLayer && (
                          <button
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyToLayerTitle', { name: selectedComposeLayer!.name })}
                            onClick={() => handleApplyMediaSourceToLayer(asset)}
                          >
                            {t('actions.applyToLayer', { name: selectedComposeLayer!.name })}
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
                            {composeMode ? t('actions.addAsLayer') : t('actions.addAsVideo')}
                          </button>
                        )}
                        {asset.kind === 'video' && canApplyVideo && (
                          <button
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyVideoTitle', { name: selectedNode!.name })}
                            onClick={() =>
                              handleApplyMediaSource(asset, 'video')
                            }
                          >
                            {t('actions.applyToNode', { name: selectedNode!.name })}
                          </button>
                        )}
                        {asset.kind === 'video' && canApplyVideoLayer && (
                          <button
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyToLayerTitle', { name: selectedComposeLayer!.name })}
                            onClick={() => handleApplyMediaSourceToLayer(asset)}
                          >
                            {t('actions.applyToLayer', { name: selectedComposeLayer!.name })}
                          </button>
                        )}
                        {asset.kind === 'audio' && (
                          <button
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
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyAudioTitle', { name: selectedNode!.name })}
                            onClick={() =>
                              handleApplyMediaSource(asset, 'audio')
                            }
                          >
                            {t('actions.applyToNode', { name: selectedNode!.name })}
                          </button>
                        )}
                        {asset.kind === 'audio' && canApplyAudioLayer && (
                          <button
                            style={{
                              background: '#2a1a3a',
                              border: 'none',
                              color: '#a7c',
                              borderRadius: 4,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              fontSize: 11,
                            }}
                            title={t('actions.applyToLayerTitle', { name: selectedComposeLayer!.name })}
                            onClick={() => handleApplyMediaSourceToLayer(asset)}
                          >
                            {t('actions.applyToLayer', { name: selectedComposeLayer!.name })}
                          </button>
                        )}
                        <button
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
