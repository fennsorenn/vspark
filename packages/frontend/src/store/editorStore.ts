import { create } from 'zustand';
import type {
  AssetFile,
  BehaviorKindMeta,
  CameraEffectRecord,
  ComposeLayerRecord,
  TrackClipRecord,
  TrackClipLaneRecord,
  TrackClipKeyframeRecord,
  TrackClipEventRecord,
} from '../api/client';
import type {
  UpdateChannel,
  ApiAnimationLoopMode,
  ApiAnimationQueueEntry,
} from '@vspark/shared';

export interface ApiAnimationState {
  queue: ApiAnimationQueueEntry[];
  loopMode: ApiAnimationLoopMode;
  startedAt: number | null;
}

export type {
  AssetFile,
  BehaviorKindMeta,
  CameraEffectRecord,
  ComposeLayerRecord,
  TrackClipRecord,
  TrackClipLaneRecord,
  TrackClipKeyframeRecord,
  TrackClipEventRecord,
};

/** Active playback for one track clip — either playing (wall clock advances from
 *  `startedAt`) or paused at a fixed `pausedAtT` seconds.
 *  `clockOffsetMs = serverNow − clientNow` sampled when the anchor was received,
 *  used to keep evaluation in phase with the backend-authoritative playhead. */
export type TrackClipPlayback =
  | {
      kind: 'playing';
      startedAt: number; // ms epoch in server clock
      loop: boolean;
      clockOffsetMs: number;
    }
  | {
      kind: 'paused';
      pausedAtT: number; // seconds into the clip
      loop: boolean;
      clockOffsetMs: number;
    };

/** Per-node ephemeral transform overrides produced by the track-clip evaluator.
 *  Never persisted; cleared each frame the evaluator decides to stop driving a param.
 *  Read by Viewport.tsx inside an existing useFrame and applied directly to Three.js objects. */
export interface NodeTransformOverride {
  position?: { x?: number; y?: number; z?: number };
  rotation?: { x?: number; y?: number; z?: number };
  scale?: { x?: number; y?: number; z?: number };
  /** Uniform descendant-mesh opacity (applied by the viewport's per-frame
   *  material walk). 1 = fully opaque; <1 forces material.transparent = true. */
  opacity?: number;
}

/** Per-compose-layer ephemeral DOM-space overrides produced by the evaluator. */
export interface ComposeLayerOverride {
  x?: number;
  y?: number;
  rotation?: number;
  width?: number;
  height?: number;
  opacity?: number;
}

/** Runtime overrides driven by signal-graph nodes (set_*_param, set_text, etc.).
 *  Parallel to the track-clip override slices above; keyed by paramPath (e.g.
 *  "position.x", "opacity", "text.content") with the value's scalar type.
 *  Conflict policy with track-clip overrides on transform paths: track-clip
 *  wins, so an in-progress clip is not interrupted by a stale runtime
 *  override. Non-transform paths (opacity, text.content, width, height) have
 *  no track-clip surface and read from here directly.
 *  See dev-notes/modules/runtime-overrides.md. */
export type RuntimeOverrideValue = number | string | boolean;
export type RuntimeOverrideMap = Record<string, RuntimeOverrideValue>;

export type LeftDockTab = 'scene' | 'compose' | 'logic';
export type BottomDockTab =
  | 'create'
  | 'models'
  | 'animations'
  | 'images'
  | 'videos'
  | 'audio'
  | 'behaviors'
  | 'effects'
  | 'clips'
  | 'presets';

// ── Dock-layout persistence ────────────────────────────────────────────────
// The active tabs + dock height are session-spanning UI prefs, persisted to
// localStorage so the editor reopens the way the user left it. Guarded so a
// disabled/again unavailable storage never throws.
const LS = {
  leftTab: 'vspark.leftTab',
  bottomTab: 'vspark.bottomTab',
  bottomDockHeight: 'vspark.bottomDockHeight',
};
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — ignore */
  }
}
const LEFT_TABS: LeftDockTab[] = ['scene', 'compose', 'logic'];
const BOTTOM_TABS: BottomDockTab[] = [
  'create',
  'models',
  'animations',
  'images',
  'videos',
  'audio',
  'behaviors',
  'effects',
  'clips',
  'presets',
];
function initialLeftTab(): LeftDockTab {
  const v = lsGet(LS.leftTab) as LeftDockTab | null;
  return v && LEFT_TABS.includes(v) ? v : 'scene';
}
function initialBottomTab(): BottomDockTab {
  const v = lsGet(LS.bottomTab) as BottomDockTab | null;
  return v && BOTTOM_TABS.includes(v) ? v : 'models';
}
function initialBottomDockHeight(): number {
  const n = Number(lsGet(LS.bottomDockHeight));
  return Number.isFinite(n) && n >= 120 && n <= 800 ? n : 200;
}

/** Per-node free-form properties (mirror of backend `scene_nodes.properties`). */
export interface NodeProperties {
  /** VRM avatar: seconds to ramp between override and additive on bus mode flip. */
  blendTransitionTime?: number;
  /** VRM avatar: resting expression weights (expression name → 0..1) applied as a
   *  baseline each frame; live blendshape broadcasts override them per-key. */
  defaultExpressions?: Record<string, number>;
  /** VRM avatar: per-material shader/param overrides (MToon ⇄ PBR), keyed by a
   *  stable material identity. See components/editor/materialOverrides.ts. */
  materialOverrides?: import('../components/editor/materialOverrides').MaterialOverrides;
}

export interface NodeRecord {
  id: string;
  rootSceneNodeId: string;
  projectId: string;
  parentId: string | null;
  boneAttachment?: string | null;
  name: string;
  kind: string;
  filePath?: string | null;
  components: Record<string, unknown>;
  properties?: NodeProperties;
  hidden?: boolean;
}

export interface SceneRuntimeSettings {
  broadcastTickHz?: number;
}

export interface SceneItem {
  id: string;
  name: string;
  runtimeSettings: SceneRuntimeSettings;
}

export interface Behavior {
  id: string;
  nodeId: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface PresetSummary {
  id: string;
  projectId: string;
  name: string;
  description: string;
  rootKind: 'scene_node' | 'compose_layer';
  thumbnailPath: string | null;
  createdAt: string;
  updatedAt: string;
}

let _compSeq = 0;
export const newBehaviorId = () => `comp-${++_compSeq}-${Date.now()}`;

export interface CameraEffectKind {
  kind: string;
  label: string;
  icon: string;
  description: string;
  defaultConfig: Record<string, unknown>;
}

export const CAMERA_EFFECT_KINDS: CameraEffectKind[] = [
  // --- Color & Tone ---
  {
    kind: 'fx_tone_mapping',
    label: 'Tone Mapping',
    icon: '🎚',
    description: 'Controls how HDR values are mapped to the display',
    defaultConfig: { mode: 6 }, // 6 = ACES_FILMIC
  },
  {
    kind: 'fx_brightness_contrast',
    label: 'Brightness / Contrast',
    icon: '☀',
    description: 'Adjusts overall image brightness and contrast',
    defaultConfig: { brightness: 0, contrast: 0 },
  },
  {
    kind: 'fx_hue_saturation',
    label: 'Hue / Saturation',
    icon: '🎨',
    description: 'Shifts hue and scales color saturation',
    defaultConfig: { hue: 0, saturation: 0 },
  },
  {
    kind: 'fx_sepia',
    label: 'Sepia',
    icon: '🟫',
    description: 'Warm brownish cinematic tint',
    defaultConfig: { intensity: 1.0 },
  },
  // --- Depth & Atmosphere ---
  {
    kind: 'fx_bloom',
    label: 'Bloom',
    icon: '✨',
    description: 'Glowing highlights bleed from bright areas',
    defaultConfig: {
      intensity: 1.0,
      luminanceThreshold: 0.9,
      luminanceSmoothing: 0.025,
      mipmapBlur: true,
    },
  },
  {
    kind: 'fx_depth_of_field',
    label: 'Depth of Field',
    icon: '📷',
    description: 'Bokeh blur outside the focal plane',
    defaultConfig: {
      worldFocusDistance: 3,
      worldFocusRange: 2,
      bokehScale: 2,
      autofocus: false,
      afMode: 'point', // 'point' | 'percentile'
      afPointX: 0.5,
      afPointY: 0.5,
      afPercentile: 15,
      afSpeed: 4, // convergence speed (higher = faster)
      afDelay: 0.2, // seconds before AF starts moving
      afOvershoot: 0.15, // fraction of delta to overshoot by
    },
  },
  {
    kind: 'fx_chromatic_aberration',
    label: 'Chromatic Aberration',
    icon: '🌈',
    description: 'RGB channel fringing along edges, like a real lens',
    defaultConfig: { offsetX: 0.002, offsetY: 0.002 },
  },
  {
    kind: 'fx_ssao',
    label: 'Ambient Occlusion',
    icon: '🌑',
    description: 'Screen-space contact shadows in crevices',
    defaultConfig: {
      intensity: 1.5,
      radius: 0.2,
      bias: 0.025,
      rings: 4,
      samples: 30,
    },
  },
  // --- Stylization ---
  {
    kind: 'fx_outline',
    label: 'Edge Outline',
    icon: '🖊',
    description: 'Depth-buffer edge detection outlines',
    defaultConfig: {
      color: '#000000',
      threshold: 0.001,
      thickness: 1.0,
      alpha: 1.0,
      normalStrength: 1.0,
      blendMode: 'NORMAL',
    },
  },
  {
    kind: 'fx_vignette',
    label: 'Vignette',
    icon: '🔲',
    description: 'Darkened edges around the frame',
    defaultConfig: { offset: 0.5, darkness: 0.5 },
  },
  {
    kind: 'fx_noise',
    label: 'Noise',
    icon: '📺',
    description: 'Film grain overlay',
    defaultConfig: { opacity: 0.2 },
  },
  {
    kind: 'fx_scanline',
    label: 'Scanline',
    icon: '📟',
    description: 'CRT horizontal scanline overlay',
    defaultConfig: { density: 1.25, opacity: 0.1 },
  },
  {
    kind: 'fx_pixelation',
    label: 'Pixelation',
    icon: '🟦',
    description: 'Retro pixel art look',
    defaultConfig: { granularity: 8 },
  },
  {
    kind: 'fx_ascii',
    label: 'ASCII',
    icon: '🔤',
    description: 'Renders the scene as ASCII characters',
    defaultConfig: {
      characters: ' .:-+*=%@#',
      fontSize: 54,
      cellSize: 16,
      color: '#ffffff',
      invert: false,
    },
  },
  {
    kind: 'fx_dot_screen',
    label: 'Dot Screen',
    icon: '🔵',
    description: 'Halftone dot pattern overlay',
    defaultConfig: { angle: 1.57, scale: 1.0 },
  },
  {
    kind: 'fx_glitch',
    label: 'Glitch',
    icon: '⚡',
    description: 'Digital glitch distortion',
    defaultConfig: {
      delay: [1.5, 3.5],
      duration: [0.06, 0.3],
      strength: [0.3, 1.0],
      columns: 0.05,
      ratio: 0.85,
    },
  },
  {
    kind: 'fx_smaa',
    label: 'SMAA',
    icon: '🔍',
    description: 'Subpixel morphological antialiasing',
    defaultConfig: {},
  },
  {
    kind: 'fx_tilt_shift',
    label: 'Tilt Shift',
    icon: '📸',
    description: 'Miniature / tilt-shift blur effect',
    defaultConfig: { offset: 0.0, rotation: 0.0, focusArea: 0.4, feather: 0.3 },
  },
  {
    kind: 'fx_water',
    label: 'Water',
    icon: '🌊',
    description: 'Watery ripple distortion',
    defaultConfig: { factor: 1.0 },
  },
];

interface EditorState {
  projectId: string | null;
  projectName: string;
  scenes: SceneItem[];
  activeSceneId: string | null;
  nodes: NodeRecord[];
  selectedNodeId: string | null;
  sceneSelected: boolean;
  selectedBehaviorId: string | null;
  assets: AssetFile[];
  behaviors: Behavior[];
  vmcStatus: Record<string, boolean>; // behaviorId → connected
  vmcTracking: Record<string, boolean>; // behaviorId → tracking active
  apiAnimationByNode: Record<string, ApiAnimationState>; // nodeId → current api-driven animation queue
  vrmBonesByNode: Record<string, string[]>; // nodeId → VRM humanoid bone names
  vrmExpressionsByNode: Record<string, string[]>; // nodeId → VRM expression names
  vrmMorphTargetsByNode: Record<string, string[]>; // nodeId → mesh morph target names
  hoveredBoneName: string | null;
  behaviorKinds: BehaviorKindMeta[];
  /** Overlive login accounts for the current project. Populated lazily by Editor.tsx;
   *  consumed by signal-graph Account port dropdowns. */
  overliveAccounts: import('../api/client').OverliveAccountRecord[];
  activeLogicId: string | null;
  /** True when the active graph is a writable standalone project graph;
   *  false when it's a behavior-owned (read-only) graph or no graph is active.
   *  Set by SignalGraphCanvas after it resolves the descriptor source. */
  activeLogicWritable: boolean;
  selectedSignalNodeId: string | null;
  boneListExpanded: Record<string, boolean>; // nodeId → bone list open in SceneGraph
  fbxDebugVisible: Record<string, boolean>; // nodeId → FBX debug model shown
  cameraEffects: CameraEffectRecord[];
  previewEffectsCamera: string | null; // nodeId of the camera with Preview Effects active
  selectedEffect: { nodeId: string; kind: string } | null;

  // Compose view
  composeScenes: ComposeLayerRecord[];
  activeComposeSceneId: string | null;
  composeLayers: ComposeLayerRecord[];
  leftTab: LeftDockTab;
  bottomTab: BottomDockTab;
  /** Bumped (to a fresh timestamp) every time something asks the bottom dock to
   *  draw attention to its currently-active tab — e.g. the scene "+" button
   *  routing the user to the Create tab, or a Properties picker button routing
   *  to an asset tab. The dock tab bar watches this and briefly pulses. */
  bottomTabFlash: number;
  /** Bumped every time something wants the Properties name field to take focus
   *  and select its text — e.g. right after creating a node so the user can
   *  immediately rename it. */
  focusNameNonce: number;
  /** In-memory mirror of the OS clipboard. Written on every editor copy;
   *  read synchronously by context menus to decide which Paste items are
   *  applicable. Null when the editor hasn't seen a copy in this session
   *  (a paste can still succeed via async OS-clipboard read). See
   *  packages/frontend/src/clipboard.ts. */
  clipboardPayload: import('../clipboard').ClipboardPayload | null;
  /** Height of the bottom dock (AssetManager / NodePalette) in pixels.
   *  Persisted in-session only; clamped at the call site. */
  bottomDockHeight: number;
  /** Whether audio (audio nodes + unmuted video) is audible in the EDITOR
   *  viewport. Off by default so authoring isn't noisy; the viewer/output page
   *  always plays audio regardless. Session-only, not persisted. */
  editorAudioPreviewEnabled: boolean;
  selectedComposeLayerId: string | null;

  // Track clips
  trackClips: TrackClipRecord[];
  selectedTrackClipId: string | null;
  /** clipId → active playback anchor */
  trackClipPlayback: Record<string, TrackClipPlayback>;
  /** nodeId → ephemeral transform override produced by the evaluator (never persisted) */
  nodeTransformOverrides: Record<string, NodeTransformOverride>;
  /** composeLayerId → ephemeral DOM-space override produced by the evaluator */
  composeLayerOverrides: Record<string, ComposeLayerOverride>;
  /** nodeId → paramPath → value, driven by signal-graph nodes via the runtime
   *  override bus. Parallel to nodeTransformOverrides; see RuntimeOverrideMap. */
  runtimeNodeOverrides: Record<string, RuntimeOverrideMap>;
  /** composeLayerId → paramPath → value, same as above for compose layers. */
  runtimeLayerOverrides: Record<string, RuntimeOverrideMap>;
  /** scope → (field → last-published value), fed by the data-channel bus
   *  (`set_data` node → WS `data_channel_*`). Consumed by `feed` compose layers
   *  (and the 3D billboard), which expose every in-scope field to a user template
   *  by its bare name. scope `''` is GLOBAL; other scopes are a consumer's own id
   *  (a layer/node id). A consumer reads `global ∪ its-own-id`. */
  dataChannels: Record<string, Record<string, unknown>>;
  /** Per-(target, param) suppression set: while a key is present, the evaluator
   *  must NOT apply that lane's value as an override, and the existing override
   *  slot for it should be cleared. Set when the user edits a numeric input on
   *  a driven param; cleared when the clip is triggered / paused / scrubbed
   *  (any track_clip_started or track_clip_paused WS arrival), at which point
   *  the override is re-asserted on the next evaluator tick.
   *  Key format: `${targetKind}:${targetId}:${paramPath}` */
  suppressedOverrides: Set<string>;

  // Actions
  setProject: (id: string, name: string) => void;
  setScenes: (scenes: SceneItem[]) => void;
  updateSceneItem: (
    sceneId: string,
    updates: Partial<Omit<SceneItem, 'id'>>
  ) => void;
  removeScene: (sceneId: string) => void;
  setActiveScene: (id: string | null) => void;
  setSceneSelected: (selected: boolean) => void;
  setNodes: (nodes: NodeRecord[]) => void;
  addNode: (node: NodeRecord) => void;
  updateNode: (id: string, updates: Partial<NodeRecord>) => void;
  deleteNode: (id: string) => void;
  selectNode: (id: string | null) => void;
  selectBehavior: (id: string | null) => void;
  setAssets: (assets: AssetFile[]) => void;
  addAsset: (asset: AssetFile) => void;
  deleteAsset: (id: string) => void;
  activeSceneNodes: () => NodeRecord[];
  setBehaviors: (comps: Behavior[]) => void;
  addBehavior: (comp: Behavior) => void;
  updateBehavior: (
    id: string,
    updates: Partial<Omit<Behavior, 'id' | 'nodeId'>>
  ) => void;
  removeBehavior: (id: string) => void;
  behaviorsFor: (nodeId: string) => Behavior[];
  setVmcStatus: (behaviorId: string, connected: boolean) => void;
  setVmcTracking: (behaviorId: string, tracking: boolean) => void;
  setApiAnimation: (nodeId: string, state: ApiAnimationState | null) => void;
  setVrmBonesForNode: (nodeId: string, bones: string[]) => void;
  clearVrmBonesForNode: (nodeId: string) => void;
  setVrmExpressionsForNode: (nodeId: string, expressions: string[]) => void;
  clearVrmExpressionsForNode: (nodeId: string) => void;
  setVrmMorphTargetsForNode: (nodeId: string, names: string[]) => void;
  clearVrmMorphTargetsForNode: (nodeId: string) => void;
  setHoveredBone: (name: string | null) => void;
  setBehaviorKinds: (kinds: BehaviorKindMeta[]) => void;
  setOverliveAccounts: (
    accounts: import('../api/client').OverliveAccountRecord[]
  ) => void;
  setActiveLogic: (id: string | null) => void;
  setActiveLogicWritable: (writable: boolean) => void;
  setSelectedSignalNode: (id: string | null) => void;
  setBoneListExpanded: (nodeId: string, expanded: boolean) => void;
  setFbxDebugVisible: (nodeId: string, visible: boolean) => void;
  toggleNodeHidden: (nodeId: string) => void;
  setCameraEffects: (effects: CameraEffectRecord[]) => void;
  addCameraEffect: (effect: CameraEffectRecord) => void;
  updateCameraEffect: (
    id: string,
    updates: Partial<Omit<CameraEffectRecord, 'id' | 'nodeId'>>
  ) => void;
  removeCameraEffect: (id: string) => void;
  cameraEffectsFor: (nodeId: string) => CameraEffectRecord[];
  setPreviewEffectsCamera: (nodeId: string | null) => void;
  selectEffect: (nodeId: string, kind: string) => void;
  clearSelectedEffect: () => void;

  setComposeScenes: (scenes: ComposeLayerRecord[]) => void;
  addComposeScene: (scene: ComposeLayerRecord) => void;
  selectComposeScene: (id: string | null) => void;
  setComposeLayers: (layers: ComposeLayerRecord[]) => void;
  addComposeLayer: (layer: ComposeLayerRecord) => void;
  updateComposeLayerLocal: (
    id: string,
    patch: Partial<ComposeLayerRecord>
  ) => void;
  removeComposeLayer: (id: string) => void;
  removeComposeScene: (id: string) => void;
  setLeftTab: (tab: LeftDockTab) => void;
  setBottomTab: (tab: BottomDockTab) => void;
  /** Switch the bottom dock to `tab` and pulse it as a hint. */
  flashBottomTab: (tab: BottomDockTab) => void;
  /** Ask the Properties name field to focus + select-all. */
  requestFocusName: () => void;
  setBottomDockHeight: (h: number) => void;
  setEditorAudioPreviewEnabled: (on: boolean) => void;
  setClipboard: (
    payload: import('../clipboard').ClipboardPayload | null
  ) => void;
  selectComposeLayer: (id: string | null) => void;

  // Track clip actions
  setTrackClips: (clips: TrackClipRecord[]) => void;
  addTrackClip: (clip: TrackClipRecord) => void;
  updateTrackClipLocal: (clip: TrackClipRecord) => void;
  removeTrackClip: (id: string) => void;
  selectTrackClip: (id: string | null) => void;
  addTrackClipLane: (clipId: string, lane: TrackClipLaneRecord) => void;
  updateTrackClipLaneLocal: (lane: TrackClipLaneRecord) => void;
  removeTrackClipLane: (laneId: string, clipId?: string | null) => void;
  replaceTrackClipLaneKeyframes: (
    laneId: string,
    keyframes: TrackClipKeyframeRecord[]
  ) => void;
  replaceTrackClipEvents: (
    clipId: string,
    events: TrackClipEventRecord[]
  ) => void;
  setTrackClipPlayback: (
    clipId: string,
    entry: TrackClipPlayback | null
  ) => void;
  /** Bulk replace (used by playback snapshot on (re)connect). */
  replaceTrackClipPlayback: (
    entries: Record<string, TrackClipPlayback>
  ) => void;
  setNodeTransformOverride: (
    nodeId: string,
    override: NodeTransformOverride | null
  ) => void;
  setComposeLayerOverride: (
    layerId: string,
    override: ComposeLayerOverride | null
  ) => void;
  /** Apply a single runtime override broadcast from the runtime-override bus. */
  setRuntimeOverride: (
    targetKind: 'scene_node' | 'compose_layer',
    targetId: string,
    paramPath: string,
    value: RuntimeOverrideValue
  ) => void;
  /** Clear a single runtime override, or every override for the target when
   *  paramPath is omitted. */
  clearRuntimeOverride: (
    targetKind: 'scene_node' | 'compose_layer',
    targetId: string,
    paramPath?: string
  ) => void;
  /** Bulk apply a snapshot (used on WS (re)connect). Replaces both maps. */
  replaceRuntimeOverrides: (
    entries: Array<{
      targetKind: 'scene_node' | 'compose_layer';
      targetId: string;
      paramPath: string;
      value: RuntimeOverrideValue;
    }>
  ) => void;
  /** Mark a (target, param) as user-edited so the evaluator stops overwriting it
   *  until the next clip event. `paramPath` matches the lane's param path. */
  suppressOverride: (
    targetKind: 'scene_node' | 'compose_layer',
    targetId: string,
    paramPath: string
  ) => void;
  /** Drop all suppressions — called when a clip is triggered / paused / scrubbed. */
  clearOverrideSuppressions: () => void;

  // Data channels (generic graph → frontend publish surface)
  /** Merge a published field-set into a scope (data-channel bus broadcast). */
  mergeDataChannels: (scope: string, fields: Record<string, unknown>) => void;
  /** Clear one field in a scope, or the whole scope when `field` is omitted. */
  clearDataChannels: (scope: string, field?: string) => void;
  /** Bulk apply a snapshot (used on WS (re)connect). Replaces the whole map. */
  replaceDataChannels: (
    entries: Array<{ scope: string; fields: Record<string, unknown> }>
  ) => void;

  // Presets
  presets: PresetSummary[];
  setPresets: (presets: PresetSummary[]) => void;
  addPreset: (preset: PresetSummary) => void;
  removePreset: (id: string) => void;

  // Update state
  updateAvailable: boolean;
  updateInfo: {
    latestVersion: string;
    releaseNotes: string | null;
    channel: UpdateChannel;
  } | null;
  pendingReload: boolean;
  setUpdateAvailable: (
    available: boolean,
    info: EditorState['updateInfo']
  ) => void;
  setPendingReload: (pending: boolean) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  projectId: null,
  projectName: '',
  scenes: [],
  activeSceneId: null,
  nodes: [],
  selectedNodeId: null,
  sceneSelected: false,
  selectedBehaviorId: null,
  assets: [],
  behaviors: [],
  vmcStatus: {},
  vmcTracking: {},
  apiAnimationByNode: {},
  vrmBonesByNode: {},
  vrmExpressionsByNode: {},
  vrmMorphTargetsByNode: {},
  hoveredBoneName: null,
  behaviorKinds: [],
  overliveAccounts: [],
  activeLogicWritable: false,
  activeLogicId: null,
  selectedSignalNodeId: null,
  boneListExpanded: {},
  fbxDebugVisible: {},

  cameraEffects: [],
  previewEffectsCamera: null,
  selectedEffect: null,

  composeScenes: [],
  activeComposeSceneId: null,
  composeLayers: [],
  leftTab: initialLeftTab(),
  bottomTab: initialBottomTab(),
  bottomTabFlash: 0,
  focusNameNonce: 0,
  bottomDockHeight: initialBottomDockHeight(),
  editorAudioPreviewEnabled: false,
  clipboardPayload: null,
  selectedComposeLayerId: null,

  trackClips: [],
  selectedTrackClipId: null,
  trackClipPlayback: {},
  nodeTransformOverrides: {},
  composeLayerOverrides: {},
  runtimeNodeOverrides: {},
  runtimeLayerOverrides: {},
  dataChannels: {},
  suppressedOverrides: new Set<string>(),

  setProject: (id, name) => set({ projectId: id, projectName: name }),
  setScenes: (scenes) => set({ scenes }),
  updateSceneItem: (sceneId, updates) =>
    set((s) => ({
      scenes: s.scenes.map((sc) =>
        sc.id === sceneId ? { ...sc, ...updates } : sc
      ),
    })),
  removeScene: (sceneId) =>
    set((s) => {
      const remainingScenes = s.scenes.filter((sc) => sc.id !== sceneId);
      const removedNodeIds = new Set(
        s.nodes.filter((n) => n.rootSceneNodeId === sceneId).map((n) => n.id)
      );
      // The scene node owns itself by id; clips can be owned by it or any child.
      removedNodeIds.add(sceneId);
      const wasActive = s.activeSceneId === sceneId;
      return {
        scenes: remainingScenes,
        nodes: s.nodes.filter((n) => n.rootSceneNodeId !== sceneId),
        behaviors: s.behaviors.filter(
          (c) => !removedNodeIds.has(c.nodeId)
        ),
        cameraEffects: s.cameraEffects.filter(
          (e) => !removedNodeIds.has(e.nodeId)
        ),
        trackClips: s.trackClips.filter(
          (t) => !(t.ownerNodeId != null && removedNodeIds.has(t.ownerNodeId))
        ),
        activeSceneId: wasActive
          ? (remainingScenes[0]?.id ?? null)
          : s.activeSceneId,
        selectedNodeId: removedNodeIds.has(s.selectedNodeId ?? '')
          ? null
          : s.selectedNodeId,
        sceneSelected: wasActive ? false : s.sceneSelected,
      };
    }),
  setActiveScene: (id) => set({ activeSceneId: id }),
  setSceneSelected: (selected) => set({ sceneSelected: selected }),
  setNodes: (nodes) => set({ nodes }),
  addNode: (node) => set((s) => ({ nodes: [...s.nodes, node] })),
  updateNode: (id, updates) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...updates } : n)),
    })),
  deleteNode: (id) =>
    set((s) => {
      const removedComps = new Set(
        s.behaviors.filter((c) => c.nodeId === id).map((c) => c.id)
      );
      return {
        nodes: s.nodes.filter((n) => n.id !== id),
        selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        selectedBehaviorId: removedComps.has(s.selectedBehaviorId ?? '')
          ? null
          : s.selectedBehaviorId,
        behaviors: s.behaviors.filter((c) => c.nodeId !== id),
      };
    }),
  selectNode: (id) =>
    set((s) => ({
      selectedNodeId: id,
      // Only clear the scene selection when actually selecting a node, not when clearing.
      sceneSelected: id != null ? false : s.sceneSelected,
      selectedBehaviorId: null,
      selectedEffect: null,
    })),
  selectBehavior: (id) =>
    set({ selectedBehaviorId: id, selectedEffect: null }),
  setAssets: (assets) => set({ assets }),
  addAsset: (asset) => set((s) => ({ assets: [...s.assets, asset] })),
  deleteAsset: (id) =>
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) })),
  activeSceneNodes: () => {
    const { nodes, activeSceneId } = get();
    return nodes.filter((n) => n.rootSceneNodeId === activeSceneId);
  },
  setBehaviors: (comps) => set({ behaviors: comps }),
  addBehavior: (comp) =>
    set((s) => ({ behaviors: [...s.behaviors, comp] })),
  updateBehavior: (id, updates) =>
    set((s) => ({
      behaviors: s.behaviors.map((c) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    })),
  removeBehavior: (id) =>
    set((s) => ({
      behaviors: s.behaviors.filter((c) => c.id !== id),
      selectedBehaviorId:
        s.selectedBehaviorId === id ? null : s.selectedBehaviorId,
    })),
  behaviorsFor: (nodeId) =>
    get().behaviors.filter((c) => c.nodeId === nodeId),
  setVmcStatus: (behaviorId, connected) =>
    set((s) => ({ vmcStatus: { ...s.vmcStatus, [behaviorId]: connected } })),
  setVmcTracking: (behaviorId, tracking) =>
    set((s) => ({
      vmcTracking: { ...s.vmcTracking, [behaviorId]: tracking },
    })),
  setApiAnimation: (nodeId, state) =>
    set((s) => {
      const next = { ...s.apiAnimationByNode };
      if (state === null) delete next[nodeId];
      else next[nodeId] = state;
      return { apiAnimationByNode: next };
    }),
  setVrmBonesForNode: (nodeId, bones) =>
    set((s) => ({ vrmBonesByNode: { ...s.vrmBonesByNode, [nodeId]: bones } })),
  clearVrmBonesForNode: (nodeId) =>
    set((s) => {
      const next = { ...s.vrmBonesByNode };
      delete next[nodeId];
      return { vrmBonesByNode: next };
    }),
  setVrmExpressionsForNode: (nodeId, expressions) =>
    set((s) => ({
      vrmExpressionsByNode: {
        ...s.vrmExpressionsByNode,
        [nodeId]: expressions,
      },
    })),
  clearVrmExpressionsForNode: (nodeId) =>
    set((s) => {
      const next = { ...s.vrmExpressionsByNode };
      delete next[nodeId];
      return { vrmExpressionsByNode: next };
    }),
  setVrmMorphTargetsForNode: (nodeId, names) =>
    set((s) => ({
      vrmMorphTargetsByNode: { ...s.vrmMorphTargetsByNode, [nodeId]: names },
    })),
  clearVrmMorphTargetsForNode: (nodeId) =>
    set((s) => {
      const next = { ...s.vrmMorphTargetsByNode };
      delete next[nodeId];
      return { vrmMorphTargetsByNode: next };
    }),
  setHoveredBone: (name) => set({ hoveredBoneName: name }),
  setBehaviorKinds: (kinds) => set({ behaviorKinds: kinds }),
  setOverliveAccounts: (accounts) => set({ overliveAccounts: accounts }),
  setActiveLogicWritable: (writable) => set({ activeLogicWritable: writable }),
  setActiveLogic: (id) => {
    // Opening a graph (from any list — including scoped graphs in the scene /
    // compose trees) follows the main view to the Logic tab, so the canvas is
    // what's actually shown. Clearing the active graph leaves the current tab
    // alone (the toggle-off path shouldn't yank the user away).
    if (id != null) lsSet(LS.leftTab, 'logic');
    set((s) => ({
      activeLogicId: id,
      selectedSignalNodeId: null,
      activeLogicWritable: false,
      leftTab: id != null ? 'logic' : s.leftTab,
    }));
  },
  setSelectedSignalNode: (id) => set({ selectedSignalNodeId: id }),
  setBoneListExpanded: (nodeId, expanded) =>
    set((s) => ({
      boneListExpanded: { ...s.boneListExpanded, [nodeId]: expanded },
    })),
  setFbxDebugVisible: (nodeId, visible) =>
    set((s) => ({
      fbxDebugVisible: { ...s.fbxDebugVisible, [nodeId]: visible },
    })),
  toggleNodeHidden: (nodeId) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId ? { ...n, hidden: !n.hidden } : n
      ),
    })),
  setCameraEffects: (effects) => set({ cameraEffects: effects }),
  addCameraEffect: (effect) =>
    set((s) => ({ cameraEffects: [...s.cameraEffects, effect] })),
  updateCameraEffect: (id, updates) =>
    set((s) => ({
      cameraEffects: s.cameraEffects.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      ),
    })),
  removeCameraEffect: (id) =>
    set((s) => ({ cameraEffects: s.cameraEffects.filter((e) => e.id !== id) })),
  cameraEffectsFor: (nodeId) =>
    get().cameraEffects.filter((e) => e.nodeId === nodeId),
  setPreviewEffectsCamera: (nodeId) =>
    set((s) => ({
      previewEffectsCamera: s.previewEffectsCamera === nodeId ? null : nodeId,
    })),
  selectEffect: (nodeId, kind) =>
    set({ selectedEffect: { nodeId, kind }, selectedBehaviorId: null }),
  clearSelectedEffect: () => set({ selectedEffect: null }),

  setComposeScenes: (scenes) => set({ composeScenes: scenes }),
  addComposeScene: (scene) =>
    set((s) =>
      s.composeScenes.some((cs) => cs.id === scene.id)
        ? {}
        : { composeScenes: [...s.composeScenes, scene] }
    ),
  selectComposeScene: (id) => set({ activeComposeSceneId: id }),
  setComposeLayers: (layers) => set({ composeLayers: layers }),
  addComposeLayer: (layer) =>
    set((s) =>
      s.composeLayers.some((l) => l.id === layer.id)
        ? {}
        : { composeLayers: [...s.composeLayers, layer] }
    ),
  updateComposeLayerLocal: (id, patch) =>
    set((s) => ({
      composeLayers: s.composeLayers.map((l) =>
        l.id === id ? { ...l, ...patch } : l
      ),
    })),
  removeComposeLayer: (id) =>
    set((s) => ({
      composeLayers: s.composeLayers.filter((l) => l.id !== id),
      selectedComposeLayerId:
        s.selectedComposeLayerId === id ? null : s.selectedComposeLayerId,
    })),
  removeComposeScene: (id) =>
    set((s) => {
      const remaining = s.composeScenes.filter((cs) => cs.id !== id);
      return {
        composeScenes: remaining,
        // Drop layers that belonged to the removed compose scene.
        composeLayers: s.composeLayers.filter(
          (l) => l.rootComposeSceneId !== id
        ),
        activeComposeSceneId:
          s.activeComposeSceneId === id
            ? (remaining[0]?.id ?? null)
            : s.activeComposeSceneId,
      };
    }),
  setLeftTab: (tab) => {
    lsSet(LS.leftTab, tab);
    set({ leftTab: tab });
  },
  setBottomTab: (tab) => {
    lsSet(LS.bottomTab, tab);
    set({ bottomTab: tab });
  },
  flashBottomTab: (tab) => {
    lsSet(LS.bottomTab, tab);
    set({ bottomTab: tab, bottomTabFlash: Date.now() });
  },
  requestFocusName: () =>
    set((s) => ({ focusNameNonce: s.focusNameNonce + 1 })),
  setClipboard: (payload) => set({ clipboardPayload: payload }),
  setBottomDockHeight: (h) => {
    const clamped = Math.max(120, Math.min(800, Math.round(h)));
    lsSet(LS.bottomDockHeight, String(clamped));
    set({ bottomDockHeight: clamped });
  },
  setEditorAudioPreviewEnabled: (on) => set({ editorAudioPreviewEnabled: on }),
  selectComposeLayer: (id) => set({ selectedComposeLayerId: id }),

  setTrackClips: (clips) => set({ trackClips: clips }),
  addTrackClip: (clip) =>
    set((s) =>
      s.trackClips.some((c) => c.id === clip.id)
        ? {}
        : { trackClips: [...s.trackClips, clip] }
    ),
  updateTrackClipLocal: (clip) =>
    set((s) => ({
      trackClips: s.trackClips.map((c) => (c.id === clip.id ? clip : c)),
    })),
  removeTrackClip: (id) =>
    set((s) => {
      const nextPlayback = { ...s.trackClipPlayback };
      delete nextPlayback[id];

      // Drop any overrides/suppressions this clip's lanes left behind so the
      // deleted clip can't keep governing a layer/node's position.
      const clip = s.trackClips.find((c) => c.id === id);
      const nextLayerOverrides = { ...s.composeLayerOverrides };
      const nextNodeOverrides = { ...s.nodeTransformOverrides };
      let suppressionsTouched = false;
      const nextSuppressed = new Set(s.suppressedOverrides);
      for (const lane of clip?.lanes ?? []) {
        if (lane.targetKind === 'compose_layer')
          delete nextLayerOverrides[lane.targetId];
        else if (lane.targetKind === 'scene_node')
          delete nextNodeOverrides[lane.targetId];
        const key = `${lane.targetKind}:${lane.targetId}:${lane.paramPath}`;
        if (nextSuppressed.delete(key)) suppressionsTouched = true;
      }

      return {
        trackClips: s.trackClips.filter((c) => c.id !== id),
        selectedTrackClipId:
          s.selectedTrackClipId === id ? null : s.selectedTrackClipId,
        trackClipPlayback: nextPlayback,
        composeLayerOverrides: nextLayerOverrides,
        nodeTransformOverrides: nextNodeOverrides,
        ...(suppressionsTouched ? { suppressedOverrides: nextSuppressed } : {}),
      };
    }),
  selectTrackClip: (id) => set({ selectedTrackClipId: id }),
  addTrackClipLane: (clipId, lane) =>
    set((s) => ({
      trackClips: s.trackClips.map((c) =>
        c.id === clipId
          ? {
              ...c,
              lanes: c.lanes.some((l) => l.id === lane.id)
                ? c.lanes
                : [...c.lanes, lane],
            }
          : c
      ),
    })),
  updateTrackClipLaneLocal: (lane) =>
    set((s) => ({
      trackClips: s.trackClips.map((c) =>
        c.id === lane.clipId
          ? { ...c, lanes: c.lanes.map((l) => (l.id === lane.id ? lane : l)) }
          : c
      ),
    })),
  removeTrackClipLane: (laneId, clipId) =>
    set((s) => ({
      trackClips: s.trackClips.map((c) =>
        clipId == null || c.id === clipId
          ? { ...c, lanes: c.lanes.filter((l) => l.id !== laneId) }
          : c
      ),
    })),
  replaceTrackClipLaneKeyframes: (laneId, keyframes) =>
    set((s) => ({
      trackClips: s.trackClips.map((c) => ({
        ...c,
        lanes: c.lanes.map((l) => (l.id === laneId ? { ...l, keyframes } : l)),
      })),
    })),
  replaceTrackClipEvents: (clipId, events) =>
    set((s) => ({
      trackClips: s.trackClips.map((c) =>
        c.id === clipId ? { ...c, events } : c
      ),
    })),
  setTrackClipPlayback: (clipId, entry) =>
    set((s) => {
      const next = { ...s.trackClipPlayback };
      if (entry == null) delete next[clipId];
      else next[clipId] = entry;
      return { trackClipPlayback: next };
    }),
  replaceTrackClipPlayback: (entries) => set({ trackClipPlayback: entries }),
  setNodeTransformOverride: (nodeId, override) =>
    set((s) => {
      const next = { ...s.nodeTransformOverrides };
      if (override == null) delete next[nodeId];
      else next[nodeId] = override;
      return { nodeTransformOverrides: next };
    }),
  suppressOverride: (targetKind, targetId, paramPath) =>
    set((s) => {
      const key = `${targetKind}:${targetId}:${paramPath}`;
      if (s.suppressedOverrides.has(key)) return {};
      const next = new Set(s.suppressedOverrides);
      next.add(key);
      return { suppressedOverrides: next };
    }),
  clearOverrideSuppressions: () =>
    set((s) =>
      s.suppressedOverrides.size === 0
        ? {}
        : { suppressedOverrides: new Set<string>() }
    ),
  setComposeLayerOverride: (layerId, override) =>
    set((s) => {
      const next = { ...s.composeLayerOverrides };
      if (override == null) delete next[layerId];
      else next[layerId] = override;
      return { composeLayerOverrides: next };
    }),
  setRuntimeOverride: (targetKind, targetId, paramPath, value) =>
    set((s) => {
      const slice =
        targetKind === 'scene_node'
          ? s.runtimeNodeOverrides
          : s.runtimeLayerOverrides;
      const next = { ...slice };
      const prev = next[targetId] ?? {};
      if (prev[paramPath] === value) return {};
      next[targetId] = { ...prev, [paramPath]: value };
      return targetKind === 'scene_node'
        ? { runtimeNodeOverrides: next }
        : { runtimeLayerOverrides: next };
    }),
  clearRuntimeOverride: (targetKind, targetId, paramPath) =>
    set((s) => {
      const slice =
        targetKind === 'scene_node'
          ? s.runtimeNodeOverrides
          : s.runtimeLayerOverrides;
      const prev = slice[targetId];
      if (!prev) return {};
      const next = { ...slice };
      if (paramPath === undefined) {
        delete next[targetId];
      } else {
        if (!(paramPath in prev)) return {};
        const { [paramPath]: _, ...rest } = prev;
        if (Object.keys(rest).length === 0) delete next[targetId];
        else next[targetId] = rest;
      }
      return targetKind === 'scene_node'
        ? { runtimeNodeOverrides: next }
        : { runtimeLayerOverrides: next };
    }),
  replaceRuntimeOverrides: (entries) =>
    set(() => {
      const nodes: Record<string, RuntimeOverrideMap> = {};
      const layers: Record<string, RuntimeOverrideMap> = {};
      for (const e of entries) {
        const bucket = e.targetKind === 'scene_node' ? nodes : layers;
        const prev = bucket[e.targetId] ?? {};
        bucket[e.targetId] = { ...prev, [e.paramPath]: e.value };
      }
      return { runtimeNodeOverrides: nodes, runtimeLayerOverrides: layers };
    }),
  mergeDataChannels: (scope, fields) =>
    set((s) => ({
      dataChannels: {
        ...s.dataChannels,
        [scope]: { ...(s.dataChannels[scope] ?? {}), ...fields },
      },
    })),
  clearDataChannels: (scope, field) =>
    set((s) => {
      const bucket = s.dataChannels[scope];
      if (!bucket) return {};
      if (field === undefined) {
        const { [scope]: _, ...rest } = s.dataChannels;
        return { dataChannels: rest };
      }
      if (!(field in bucket)) return {};
      const { [field]: _, ...restFields } = bucket;
      const next = { ...s.dataChannels };
      if (Object.keys(restFields).length === 0) delete next[scope];
      else next[scope] = restFields;
      return { dataChannels: next };
    }),
  replaceDataChannels: (entries) =>
    set(() => {
      const next: Record<string, Record<string, unknown>> = {};
      for (const e of entries) next[e.scope] = { ...e.fields };
      return { dataChannels: next };
    }),

  presets: [],
  setPresets: (presets) => set({ presets }),
  addPreset: (preset) => set((s) => ({ presets: [preset, ...s.presets] })),
  removePreset: (id) =>
    set((s) => ({ presets: s.presets.filter((p) => p.id !== id) })),

  updateAvailable: false,
  updateInfo: null,
  pendingReload: false,
  setUpdateAvailable: (available, info) =>
    set({ updateAvailable: available, updateInfo: info }),
  setPendingReload: (pending) => set({ pendingReload: pending }),
}));
