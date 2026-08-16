import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import type {
  AssetFile,
  BundleFileInput,
  Live2dBundleReport,
} from '../../api/client';
import type { BottomDockTab, Behavior } from '../../store/editorStore';
import { newBehaviorId, CAMERA_EFFECT_KINDS } from '../../store/editorStore';
import {
  BEHAVIOR_ICON,
  BEHAVIOR_FALLBACK,
  CAMERA_EFFECT_ICON,
  CAMERA_EFFECT_FALLBACK,
} from '../icons';
import { TrackClipTimeline } from './TrackClipTimeline';
import { PresetLibrary } from './PresetLibrary';
import { CreatePalette } from './CreatePalette';
import { AssetThumb } from './AssetThumb';
import { DND_ASSET } from './dnd';
import { behaviorCompatibleWith, createNodeFromLive2dAsset } from './createKinds';
import { HelpButton } from '../../help/HelpButton';
import { Live2dBundleReportWindow } from './Live2dBundleReportWindow';
import { Live2dManifestPicker } from './Live2dManifestPicker';
import {
  readDroppedFiles,
  expandZip,
  isZipFile,
  findManifests,
  stripCommonPrefix,
  selectBundle,
  planRelocations,
  ZipError,
} from '../../lib/live2dBundle';
import type { Relocation, AmbiguousRelocation } from '../../lib/live2dBundle';

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
  const canApplyLive2d = selectedNode?.kind === 'live2d';
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
    if (selectedNode.kind === 'live2d') relevantTabs.add('models');
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
  const live2dInputRef = useRef<HTMLInputElement>(null);
  const live2dZipInputRef = useRef<HTMLInputElement>(null);
  // Open when a Live2D bundle's manifest referenced files the upload lacked.
  // `pending` holds the picked files for the retry; null when the bundle was
  // accepted and the report is only a warning.
  const [live2dReport, setLive2dReport] = useState<{
    report: Live2dBundleReport;
    rootName: string;
    pending: BundleFileInput[] | null;
    relocations: Relocation[];
    ambiguousRelocations: AmbiguousRelocation[];
  } | null>(null);
  // Open when a folder/archive held several models and one must be chosen.
  const [live2dPicker, setLive2dPicker] = useState<{
    files: BundleFileInput[];
    rootName: string;
    manifests: string[];
  } | null>(null);
  const animInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  // A Live2D model is a folder (manifest + moc3 + textures), not a single file;
  // `webkitdirectory` isn't in React's input attribute types, so set it directly.
  //
  // Depends on `tab`: the input is only RENDERED while the Models tab is open,
  // so a mount-only effect ran when the ref was still null, silently left the
  // attribute unset, and the picker offered single files — which made the whole
  // bundle flow look broken.
  useEffect(() => {
    const el = live2dInputRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, [tab]);

  // The Models tab holds both 3D models (vrm/glb) and Live2D bundles.
  const models = assets.filter(
    (a) => a.kind === 'model' || a.kind === 'live2d'
  );
  const animations = assets.filter((a) => a.kind === 'animation');
  const images = assets.filter((a) => a.kind === 'image');
  const videos = assets.filter((a) => a.kind === 'video');
  const audioAssets = assets.filter((a) => a.kind === 'audio');

  // ── Live2D bundle ingestion ────────────────────────────────────────────────
  //
  // A Live2D model is a folder of files that only work together, and it reaches
  // us three ways: the folder picker, a folder dropped on the dock, or a zip
  // (expanded in the browser). All three converge on `uploadLive2dBundle` with
  // paths relative to the model root — those paths ARE the model, so everything
  // here exists to keep them intact.
  //
  // The backend resolves the manifest's FileReferences against the arriving
  // files. Missing moc3/textures reject the upload outright (nothing is stored)
  // and missing motions/expressions upload with a warning — either way the
  // report opens naming the files, instead of leaving the user to discover a
  // blank puppet later.

  /** Post a bundle, then route the outcome to the report window. */
  const uploadBundle = async (files: BundleFileInput[], rootName: string) => {
    if (!projectId) {
      alert(t('alerts.noProject'));
      return;
    }
    setUploading(true);
    try {
      const { asset, missingOptional } = await api.uploadLive2dBundle(
        projectId,
        rootName,
        files
      );
      addAsset(asset);
      setTab('models');
      setLive2dReport(
        missingOptional.length === 0
          ? null
          : {
              rootName,
              // Already stored and rendering — nothing to supply, so no
              // pending set and no retry.
              pending: null,
              relocations: [],
              ambiguousRelocations: [],
              report: {
                manifest: asset.name,
                refs: missingOptional,
                missingRequired: [],
                missingOptional,
                errors: [],
              },
            }
      );
    } catch (e: unknown) {
      const report = api.live2dBundleReport(e);
      // Hold the picked files so the completion window can top them up rather
      // than making the user re-select everything they already chose. Before
      // asking for anything, check whether the "missing" files are simply
      // sitting at the wrong path — a rearranged folder still has them all.
      if (report) {
        const { relocations, ambiguous } = planRelocations(
          files.map((f) => f.relPath),
          [...report.missingRequired, ...report.missingOptional].map(
            (r) => r.relPath
          ),
          report.refs.map((r) => r.relPath)
        );
        setLive2dReport({
          rootName,
          report,
          pending: files,
          relocations,
          ambiguousRelocations: ambiguous,
        });
      } else
        alert(e instanceof Error ? e.message : t('alerts.live2dUploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  /**
   * Take a candidate file set through prefix-stripping and model selection,
   * then upload. An archive usually wraps the model in one folder; several
   * manifests means the user has to say which model they meant.
   */
  const ingestLive2dBundle = async (
    raw: BundleFileInput[],
    fallbackName: string
  ) => {
    const { files, prefix } = stripCommonPrefix(raw);
    const rootName = prefix ?? fallbackName;
    const manifests = findManifests(files);
    if (manifests.length > 1) {
      setLive2dPicker({ files, rootName, manifests });
      return;
    }
    await uploadBundle(files, rootName);
  };

  const handleUploadLive2dFolder = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    await ingestLive2dBundle(
      list.map((f) => ({ relPath: f.webkitRelativePath || f.name, file: f })),
      'live2d-model'
    );
  };

  const handleUploadLive2dZip = async (file: File) => {
    setUploading(true);
    let expanded: BundleFileInput[];
    try {
      expanded = await expandZip(file);
    } catch (e) {
      setUploading(false);
      alert(e instanceof ZipError ? e.message : t('alerts.live2dZipFailed'));
      return;
    }
    setUploading(false);
    if (findManifests(expanded).length === 0) {
      alert(t('alerts.live2dZipNoManifest'));
      return;
    }
    await ingestLive2dBundle(expanded, file.name.replace(/\.zip$/i, ''));
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
    if (failures.length > 0)
      alert(t('alerts.uploadFailedFiles', { files: failures.join(', ') }));
  };

  // Only react to OS file drags (dataTransfer carries "Files"); internal asset/
  // tile drags use custom MIME types and must pass straight through.
  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files');

  /**
   * Route a drop: a Live2D bundle (dropped folder or zip containing a manifest)
   * takes the bundle path; anything else keeps the existing per-file upload, so
   * dropping images/video/audio/VRMs works exactly as before.
   *
   * `e.dataTransfer` must be read synchronously — the event's data is cleared
   * once the handler yields, so the walk starts before any `await`.
   */
  const handleDrop = async (dataTransfer: DataTransfer) => {
    const { files, hadDirectory } = await readDroppedFiles(dataTransfer);
    if (files.length === 0) return;

    // A lone zip: expand it and see whether it is a model.
    if (files.length === 1 && isZipFile(files[0].file)) {
      const zip = files[0].file;
      let expanded: BundleFileInput[] = [];
      try {
        expanded = await expandZip(zip);
      } catch {
        // Unreadable archive — fall through and store it as a plain file
        // rather than refusing a drop the user may have meant literally.
      }
      if (findManifests(expanded).length > 0) {
        await ingestLive2dBundle(expanded, zip.name.replace(/\.zip$/i, ''));
        return;
      }
      await handleUploadFiles([zip]);
      return;
    }

    // A dropped folder holding a manifest is a bundle; a folder of ordinary
    // media is just several files.
    if (hadDirectory && findManifests(files).length > 0) {
      await ingestLive2dBundle(files, 'live2d-model');
      return;
    }
    await handleUploadFiles(files.map((f) => f.file));
  };

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
            facing: 'world',
            backface: 'mirror',
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

  const handleAddAsLive2d = async (asset: AssetFile) => {
    if (!activeSceneId) {
      alert('No active scene.');
      return;
    }
    try {
      await createNodeFromLive2dAsset(asset, activeSceneId);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to add Live2D model');
    }
  };

  const handleApplyLive2dModel = async (asset: AssetFile) => {
    if (!selectedNode) return;
    const existing = (selectedNode.components?.live2d ?? {}) as Record<
      string,
      unknown
    >;
    const components = {
      ...selectedNode.components,
      live2d: { type: 'live2d', ...existing, modelUrl: asset.url },
    };
    try {
      await api.updateNode(selectedNode.id, { components, filePath: asset.url });
      storeUpdateNode(selectedNode.id, { components, filePath: asset.url });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed to set Live2D model');
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
      await api.updateNode(selectedNode.id, { components, properties });
      storeUpdateNode(selectedNode.id, { components, properties });
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
      await api.updateNode(selectedNode.id, { properties });
      storeUpdateNode(selectedNode.id, { properties });
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
        handleDrop(e.dataTransfer);
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
      {live2dReport && (
        <Live2dBundleReportWindow
          report={live2dReport.report}
          rootName={live2dReport.rootName}
          pending={live2dReport.pending}
          relocations={live2dReport.relocations}
          ambiguousRelocations={live2dReport.ambiguousRelocations}
          busy={uploading}
          onRetry={(files) => {
            const { rootName } = live2dReport;
            setLive2dReport(null);
            uploadBundle(files, rootName);
          }}
          onClose={() => setLive2dReport(null)}
        />
      )}
      {live2dPicker && (
        <Live2dManifestPicker
          manifests={live2dPicker.manifests}
          rootName={live2dPicker.rootName}
          onPick={(manifest) => {
            const { files, rootName } = live2dPicker;
            setLive2dPicker(null);
            uploadBundle(selectBundle(files, manifest), rootName);
          }}
          onClose={() => setLive2dPicker(null)}
        />
      )}
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
            <button
              className="vs-upload-live2d"
              style={uploadBtn}
              disabled={uploading}
              title={t('upload.live2dTitle')}
              onClick={() => live2dInputRef.current?.click()}
            >
              {uploading ? t('upload.uploading') : t('upload.live2d')}
            </button>
            <input
              ref={live2dInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0)
                  handleUploadLive2dFolder(e.target.files);
                e.target.value = '';
              }}
            />
            {/* A separate control from the folder picker above: a
                `webkitdirectory` input can only choose directories, so a zip
                needs an input of its own. */}
            <button
              className="vs-upload-live2d-zip"
              style={uploadBtn}
              disabled={uploading}
              title={t('upload.live2dZipTitle')}
              onClick={() => live2dZipInputRef.current?.click()}
            >
              {uploading ? t('upload.uploading') : t('upload.live2dZip')}
            </button>
            <input
              ref={live2dZipInputRef}
              type="file"
              accept=".zip,application/zip"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUploadLive2dZip(file);
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
                            const I = CAMERA_EFFECT_ICON[ek.kind] ?? CAMERA_EFFECT_FALLBACK;
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
                      data-attach-kind="asset"
                      data-attach-id={asset.id}
                      data-attach-name={asset.name}
                      data-attach-url={asset.url}
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
                        {asset.kind === 'live2d' && (
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
                            onClick={() => handleAddAsLive2d(asset)}
                          >
                            Add to Scene
                          </button>
                        )}
                        {asset.kind === 'live2d' && canApplyLive2d && (
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
                            title={`Set as model for "${selectedNode!.name}"`}
                            onClick={() => handleApplyLive2dModel(asset)}
                          >
                            Apply to {selectedNode!.name}
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
