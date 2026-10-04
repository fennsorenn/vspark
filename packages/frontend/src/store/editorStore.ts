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
import type { UpdateChannel } from '@vspark/shared';
import type { ClipPlaybackDoc } from '@vspark/shared/clipPlayback';
import { useHelpStore } from '../help/helpStore';
import { useAssistantStore } from './assistantStore';
import { highlightControl } from '../lib/uiHighlight';

/** One entry on an avatar's animation timeline (a scheduled_animation doc). */
export interface ScheduledAnimation {
  id: string;
  avatarNodeId: string;
  clipId: string;
  /** Clock-anchored start time (ms). Translated to this client's clock. */
  startEpoch: number;
  speed: number;
  loop: boolean;
}

/** A track clip's transport state (a clip_playback doc), keyed by clip id.
 *
 *  The playhead is DERIVED, not stored: while playing it is
 *  `(now - startEpoch) * speed / 1000`, and while paused it is `pausedAtT`.
 *  Nothing streams evaluated frames — every peer holds the clip and this, and
 *  evaluates for itself (principle 1 in dev-notes/modules/mesh.md).
 *
 *  `state: 'stopped'` is a real entry, not an absent one; a clip that has never
 *  been played simply has no entry at all. */
export type ClipPlayback = ClipPlaybackDoc;

/** A content-addressed animation clip (an animation_clip doc). The avatar
 *  animation driver resolves a timeline/idle `clipId` to its source asset URL
 *  (already localized per-server) and authored `duration`. Fed from the mesh
 *  replica, keyed by clip id. */
export interface AnimationClipMeta {
  id: string;
  sourceNodeId: string;
  sourceFilePath: string;
  duration: number;
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

/** Backend output-window runtime state (mirrors the backend's OutputRuntimeStatus). */
export type OutputWindowStatus =
  | { state: 'idle' }
  | { state: 'downloading'; progress: number }
  | { state: 'ready' }
  | { state: 'error'; message: string }
  | { state: 'unavailable' };

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

export type LeftDockTab = 'scene' | 'compose' | 'graphs';
export type BottomDockTab =
  | 'create'
  | 'models'
  | 'animations'
  | 'images'
  | 'videos'
  | 'audio'
  | 'components'
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
  composeSnap: 'vspark.composeSnap',
  composeAttach: 'vspark.composeAttach',
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
const LEFT_TABS: LeftDockTab[] = ['scene', 'compose', 'graphs'];
const BOTTOM_TABS: BottomDockTab[] = [
  'create',
  'models',
  'animations',
  'images',
  'videos',
  'audio',
  'components',
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
function initialComposeSnap(): boolean {
  return lsGet(LS.composeSnap) !== '0'; // default on
}
function initialComposeAttach(): boolean {
  return lsGet(LS.composeAttach) === '1'; // default off (deliberate mode)
}

/** Per-node free-form properties (mirror of backend `scene_nodes.properties`). */
export interface NodeProperties {
  /** VRM avatar: seconds to ramp between override and additive on bus mode flip. */
  blendTransitionTime?: number;
  /** VRM avatar: seconds a tracking dropout is tolerated before the avatar is
   *  treated as untracked and falls back to idle. Pairs with
   *  `blendTransitionTime` — this is when the return starts, that is how fast it
   *  runs. Shared by every tracking source on the node. Default 2. */
  trackingGracePeriod?: number;
  /** VRM avatar: resting expression weights (expression name → 0..1) applied as a
   *  baseline each frame; live blendshape broadcasts override them per-key. */
  defaultExpressions?: Record<string, number>;
  /** VRM avatar: per-material shader/param overrides (MToon ⇄ PBR), keyed by a
   *  stable material identity. See components/editor/materialOverrides.ts. */
  materialOverrides?: import('../components/editor/materialOverrides').MaterialOverrides;
  /** Avatar animation config. `idle` is the content-addressed resting loop
   *  (animation_clip id + speed); the scheduled timeline layers over it. `base`
   *  is the loop live tracking stacks onto while a source is connected (raw url
   *  slot; falls back to `idle` when unset). */
  animation?: {
    idle?: { clipId: string; speed: number };
    base?: { clipId?: string; url?: string; speed?: number };
  };
  /** VRM avatar: second-order "snappiness" dynamics applied to broadcast bone
   *  rotations after the jitter-smoothing filter. Disabled by default. */
  poseDynamics?: import('../secondOrderDynamics').PoseDynamicsConfig;
  /** VRM avatar: synthesize forearm twist bones when the model lacks them, so
   *  wrist pronation spreads along the forearm instead of pinching at the
   *  elbow. Models with their own twist bones are driven regardless. */
  forceTwistBone?: boolean;
  /** VRM avatar: when synthesizing twist bones, keep their weight off loose
   *  sleeve/cuff geometry (twist kept only on mesh reachable from the hand
   *  through connected twist-weighted vertices). */
  excludeSleeves?: boolean;
  /** VRM avatar: per-body-section animation/tracking influence ("partial
   *  tracking"). Absent sections default to { anim: 1, track: 1 }. */
  poseSource?: import('@vspark/shared').PoseSource;
}

export interface StageObject {
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
  /** True for nodes projected from a peer's shared object (multiplayer). These
   *  live only in memory, are not persisted, and should be treated read-only:
   *  they're cleared on reload, unshare, or disconnect and restocked from the
   *  owner's live snapshot. `remoteOwnerPeerId` is the sharing peer. */
  remote?: boolean;
  remoteOwnerPeerId?: string;
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

export {
  CAMERA_EFFECT_KINDS,
  type CameraEffectKind,
} from '@vspark/shared/cameraEffects';

export interface EditorState {
  projectId: string | null;
  projectName: string;
  activeSceneId: string | null;
  /** Nodes projected from a peer's placed object (Phase 6, see
   *  sync/sharedProjection.ts) — a derived view, read with the project's own
   *  nodes through mesh/nodes.ts. Goes with the Phase-6 legacy (W7). */
  projectedNodes: StageObject[];
  /** What this tab shows for a node's transform while a local gesture or a
   *  received preview's tween is running, before the documents catch up. View
   *  state, merged over the documents by mesh/nodes.ts. */
  liveNodes: Record<string, Record<string, number>>;
  selectedNodeId: string | null;
  sceneSelected: boolean;
  selectedBehaviorId: string | null;
  assets: AssetFile[];
  vrmBonesByNode: Record<string, string[]>; // nodeId → VRM humanoid bone names
  vrmExpressionsByNode: Record<string, string[]>; // nodeId → VRM expression names
  vrmMorphTargetsByNode: Record<string, string[]>; // nodeId → mesh morph target names
  live2dParamsByNode: Record<string, string[]>; // nodeId → Live2D parameter ids
  vrmMaterialsByNode: Record<string, string[]>; // nodeId → VRM material (surface) names
  hoveredBoneName: string | null;
  behaviorKinds: BehaviorKindMeta[];
  /** Overlive login accounts for the current project. Populated lazily by Editor.tsx;
   *  consumed by signal-graph Account port dropdowns. */
  overliveAccounts: import('../api/client').OverliveAccountRecord[];
  /** OBS (obs-websocket) connections for the current project. Populated lazily
   *  by the OBS Connections modal; status kept live by `server_status` docs. */
  obsConnections: import('../api/client').ObsConnectionRecord[];
  /** Backend Electron runtime state for OBS window capture (`server_status`
   *  document `output_window:main`). */
  outputWindowStatus: OutputWindowStatus | null;
  activeLogicId: string | null;
  /** True when the active graph is a writable standalone project graph;
   *  false when it's a behavior-owned (read-only) graph or no graph is active.
   *  Set by SignalGraphCanvas after it resolves the descriptor source. */
  activeLogicWritable: boolean;
  selectedSignalNodeId: string | null;
  boneListExpanded: Record<string, boolean>; // nodeId → bone list open in SceneGraph
  fbxDebugVisible: Record<string, boolean>; // nodeId → FBX debug model shown
  previewEffectsCamera: string | null; // nodeId of the camera with Preview Effects active
  selectedEffect: { nodeId: string; kind: string } | null;

  // Compose view. The layers themselves are mesh documents (mesh/compose.ts).
  activeComposeSceneId: string | null;
  /** What this tab shows for a layer while a local gesture or a received
   *  preview's tween is running, before the documents catch up. View state:
   *  merged over the documents by the compose hooks, cleared when it ends. */
  liveLayers: Record<string, Partial<ComposeLayerRecord>>;
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
  /** Compose editor: snap layers to their parent's edges/centre while dragging
   *  or resizing. Persisted to localStorage. */
  composeSnapEnabled: boolean;
  /** Compose view: when on, dragging a 3D node inside a camera-view layer and
   *  dropping it over a model binds it to the bone under the drop (world→
   *  bone-local); dropping it clear of any model sends it back to top level.
   *  Holding Shift during a drag does the same as a one-shot. Persisted. */
  composeAttachEnabled: boolean;
  selectedComposeLayerId: string | null;

  // Track clips
  selectedTrackClipId: string | null;
  /** clipId → active playback anchor */
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
   *  (`set_data` node → the mesh `data_field` collection). Consumed by `feed` compose layers
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
  setActiveScene: (id: string | null) => void;
  setSceneSelected: (selected: boolean) => void;
  /** Upsert / drop a projected node (sync/sharedProjection.ts). */
  putProjectedNode: (node: StageObject) => void;
  dropProjectedNode: (id: string) => void;
  /** Merge live transform fields for a node; `null` drops them. */
  setLiveNode: (id: string, fields: Record<string, number> | null) => void;
  selectNode: (id: string | null) => void;
  selectBehavior: (id: string | null) => void;
  setAssets: (assets: AssetFile[]) => void;
  addAsset: (asset: AssetFile) => void;
  deleteAsset: (id: string) => void;
  setVrmBonesForNode: (nodeId: string, bones: string[]) => void;
  clearVrmBonesForNode: (nodeId: string) => void;
  setVrmExpressionsForNode: (nodeId: string, expressions: string[]) => void;
  clearVrmExpressionsForNode: (nodeId: string) => void;
  setVrmMorphTargetsForNode: (nodeId: string, names: string[]) => void;
  clearVrmMorphTargetsForNode: (nodeId: string) => void;
  setLive2dParamsForNode: (nodeId: string, paramIds: string[]) => void;
  clearLive2dParamsForNode: (nodeId: string) => void;
  setVrmMaterialsForNode: (nodeId: string, names: string[]) => void;
  clearVrmMaterialsForNode: (nodeId: string) => void;
  setHoveredBone: (name: string | null) => void;
  setBehaviorKinds: (kinds: BehaviorKindMeta[]) => void;
  setOverliveAccounts: (
    accounts: import('../api/client').OverliveAccountRecord[]
  ) => void;
  setObsConnections: (
    connections: import('../api/client').ObsConnectionRecord[]
  ) => void;
  /** Patch one connection's live status from an obs_connection_status message. */
  patchObsConnectionStatus: (patch: {
    connectionId: string;
    status: import('../api/client').ObsConnectionStatus;
    reason: string | null;
    message: string | null;
  }) => void;
  setOutputWindowStatus: (status: OutputWindowStatus) => void;
  setActiveLogic: (id: string | null) => void;
  setActiveLogicWritable: (writable: boolean) => void;
  setSelectedSignalNode: (id: string | null) => void;
  setBoneListExpanded: (nodeId: string, expanded: boolean) => void;
  setFbxDebugVisible: (nodeId: string, visible: boolean) => void;
  setPreviewEffectsCamera: (nodeId: string | null) => void;
  selectEffect: (nodeId: string, kind: string) => void;
  clearSelectedEffect: () => void;

  selectComposeScene: (id: string | null) => void;
  /** Merge live display fields for a layer; `null` drops them. */
  setLiveLayer: (id: string, patch: Partial<ComposeLayerRecord> | null) => void;
  setLeftTab: (tab: LeftDockTab) => void;
  setBottomTab: (tab: BottomDockTab) => void;
  /** Switch the bottom dock to `tab` and pulse it as a hint. */
  flashBottomTab: (tab: BottomDockTab) => void;
  /** Top-bar windows, store-driven so the assistant can open them via a
   *  ui_action (open_window). */
  accountsModalOpen: boolean;
  setAccountsModalOpen: (open: boolean) => void;
  mediaModalOpen: boolean;
  setMediaModalOpen: (open: boolean) => void;
  connectionsModalOpen: boolean;
  setConnectionsModalOpen: (open: boolean) => void;
  updateDialogOpen: boolean;
  setUpdateDialogOpen: (open: boolean) => void;
  /** Ask the Properties name field to focus + select-all. */
  requestFocusName: () => void;
  setBottomDockHeight: (h: number) => void;
  setEditorAudioPreviewEnabled: (on: boolean) => void;
  setComposeSnapEnabled: (on: boolean) => void;
  setComposeAttachEnabled: (on: boolean) => void;
  setClipboard: (
    payload: import('../clipboard').ClipboardPayload | null
  ) => void;
  selectComposeLayer: (id: string | null) => void;

  /** Apply a UI-control action pushed by the assistant agent over the
   *  ui_action WS message (select entity, open panel/help/window, highlight). */
  dispatchUiAction: (action: unknown) => void;

  // Track clip actions
  selectTrackClip: (id: string | null) => void;
  /** Bulk replace (used by playback snapshot on (re)connect). */
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
  /** Merge a published field-set into a scope. */
  mergeDataChannels: (scope: string, fields: Record<string, unknown>) => void;
  /** Clear one field in a scope, or the whole scope when `field` is omitted. */
  clearDataChannels: (scope: string, field?: string) => void;

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
  activeSceneId: null,
  projectedNodes: [],
  liveNodes: {},
  selectedNodeId: null,
  sceneSelected: false,
  selectedBehaviorId: null,
  assets: [],
  vrmBonesByNode: {},
  vrmExpressionsByNode: {},
  live2dParamsByNode: {},
  vrmMorphTargetsByNode: {},
  vrmMaterialsByNode: {},
  hoveredBoneName: null,
  behaviorKinds: [],
  overliveAccounts: [],
  obsConnections: [],
  outputWindowStatus: null,
  activeLogicWritable: false,
  activeLogicId: null,
  selectedSignalNodeId: null,
  boneListExpanded: {},
  fbxDebugVisible: {},

  previewEffectsCamera: null,
  selectedEffect: null,

  activeComposeSceneId: null,
  liveLayers: {},
  leftTab: initialLeftTab(),
  bottomTab: initialBottomTab(),
  bottomTabFlash: 0,
  focusNameNonce: 0,
  bottomDockHeight: initialBottomDockHeight(),
  editorAudioPreviewEnabled: false,
  composeSnapEnabled: initialComposeSnap(),
  composeAttachEnabled: initialComposeAttach(),
  clipboardPayload: null,
  selectedComposeLayerId: null,

  selectedTrackClipId: null,
  nodeTransformOverrides: {},
  composeLayerOverrides: {},
  runtimeNodeOverrides: {},
  runtimeLayerOverrides: {},
  dataChannels: {},
  suppressedOverrides: new Set<string>(),

  setProject: (id, name) => set({ projectId: id, projectName: name }),
  setActiveScene: (id) => set({ activeSceneId: id }),
  setSceneSelected: (selected) => set({ sceneSelected: selected }),
  putProjectedNode: (node) =>
    set((s) => ({
      projectedNodes: s.projectedNodes.some((n) => n.id === node.id)
        ? s.projectedNodes.map((n) => (n.id === node.id ? node : n))
        : [...s.projectedNodes, node],
    })),
  dropProjectedNode: (id) =>
    set((s) => ({
      projectedNodes: s.projectedNodes.filter((n) => n.id !== id),
    })),
  setLiveNode: (id, fields) =>
    set((s) => {
      const next = { ...s.liveNodes };
      if (fields) next[id] = { ...next[id], ...fields };
      else delete next[id];
      return { liveNodes: next };
    }),
  selectNode: (id) =>
    set((s) => ({
      selectedNodeId: id,
      // Only clear the scene selection when actually selecting a node, not when clearing.
      sceneSelected: id != null ? false : s.sceneSelected,
      selectedBehaviorId: null,
      selectedEffect: null,
    })),
  selectBehavior: (id) => set({ selectedBehaviorId: id, selectedEffect: null }),
  setAssets: (assets) => set({ assets }),
  addAsset: (asset) => set((s) => ({ assets: [...s.assets, asset] })),
  deleteAsset: (id) =>
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) })),

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
  setLive2dParamsForNode: (nodeId, paramIds) =>
    set((s) => ({
      live2dParamsByNode: { ...s.live2dParamsByNode, [nodeId]: paramIds },
    })),
  clearLive2dParamsForNode: (nodeId) =>
    set((s) => {
      const next = { ...s.live2dParamsByNode };
      delete next[nodeId];
      return { live2dParamsByNode: next };
    }),
  setVrmMaterialsForNode: (nodeId, names) =>
    set((s) => ({
      vrmMaterialsByNode: { ...s.vrmMaterialsByNode, [nodeId]: names },
    })),
  clearVrmMaterialsForNode: (nodeId) =>
    set((s) => {
      const next = { ...s.vrmMaterialsByNode };
      delete next[nodeId];
      return { vrmMaterialsByNode: next };
    }),
  setHoveredBone: (name) => set({ hoveredBoneName: name }),
  setBehaviorKinds: (kinds) => set({ behaviorKinds: kinds }),
  setOverliveAccounts: (accounts) => set({ overliveAccounts: accounts }),
  setObsConnections: (connections) => set({ obsConnections: connections }),
  setOutputWindowStatus: (status) => set({ outputWindowStatus: status }),
  patchObsConnectionStatus: (patch) =>
    set((s) => ({
      obsConnections: s.obsConnections.map((c) =>
        c.id === patch.connectionId
          ? {
              ...c,
              status: patch.status,
              statusReason: patch.reason,
              statusMessage: patch.message,
            }
          : c
      ),
    })),
  setActiveLogicWritable: (writable) => set({ activeLogicWritable: writable }),
  setActiveLogic: (id) => {
    // Opening a graph (from any list — including scoped graphs in the scene /
    // compose trees) follows the main view to the Graphs tab, so the canvas is
    // what's actually shown. Clearing the active graph leaves the current tab
    // alone (the toggle-off path shouldn't yank the user away).
    if (id != null) lsSet(LS.leftTab, 'graphs');
    set((s) => ({
      activeLogicId: id,
      selectedSignalNodeId: null,
      activeLogicWritable: false,
      leftTab: id != null ? 'graphs' : s.leftTab,
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
  setPreviewEffectsCamera: (nodeId) =>
    set((s) => ({
      previewEffectsCamera: s.previewEffectsCamera === nodeId ? null : nodeId,
    })),
  selectEffect: (nodeId, kind) =>
    set({ selectedEffect: { nodeId, kind }, selectedBehaviorId: null }),
  clearSelectedEffect: () => set({ selectedEffect: null }),

  selectComposeScene: (id) => set({ activeComposeSceneId: id }),
  setLiveLayer: (id, patch) =>
    set((s) => {
      const next = { ...s.liveLayers };
      if (patch) next[id] = { ...next[id], ...patch };
      else delete next[id];
      return { liveLayers: next };
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
  accountsModalOpen: false,
  setAccountsModalOpen: (open) => set({ accountsModalOpen: open }),
  mediaModalOpen: false,
  setMediaModalOpen: (open) => set({ mediaModalOpen: open }),
  connectionsModalOpen: false,
  setConnectionsModalOpen: (open) => set({ connectionsModalOpen: open }),
  updateDialogOpen: false,
  setUpdateDialogOpen: (open) => set({ updateDialogOpen: open }),
  requestFocusName: () =>
    set((s) => ({ focusNameNonce: s.focusNameNonce + 1 })),
  setClipboard: (payload) => set({ clipboardPayload: payload }),
  setBottomDockHeight: (h) => {
    const clamped = Math.max(120, Math.min(800, Math.round(h)));
    lsSet(LS.bottomDockHeight, String(clamped));
    set({ bottomDockHeight: clamped });
  },
  setEditorAudioPreviewEnabled: (on) => set({ editorAudioPreviewEnabled: on }),
  setComposeSnapEnabled: (on) => {
    lsSet(LS.composeSnap, on ? '1' : '0');
    set({ composeSnapEnabled: on });
  },
  setComposeAttachEnabled: (on) => {
    lsSet(LS.composeAttach, on ? '1' : '0');
    set({ composeAttachEnabled: on });
  },
  selectComposeLayer: (id) => set({ selectedComposeLayerId: id }),

  dispatchUiAction: (action) => {
    if (!action || typeof action !== 'object') return;
    const a = action as Record<string, unknown>;
    const s = get();
    switch (a.type) {
      case 'select_entity': {
        const id = typeof a.id === 'string' ? a.id : null;
        if (a.entityKind === 'scene_node') {
          s.setLeftTab('scene');
          s.selectNode(id);
        } else if (a.entityKind === 'compose_layer') {
          s.setLeftTab('compose');
          s.selectComposeLayer(id);
        } else if (a.entityKind === 'scene') {
          if (id) s.setActiveScene(id);
          s.setSceneSelected(true);
        } else if (a.entityKind === 'compose_scene') {
          s.setLeftTab('compose');
          s.selectComposeScene(id);
        } else if (a.entityKind === 'behavior') {
          s.selectBehavior(id);
        }
        break;
      }
      case 'select_effect': {
        if (typeof a.nodeId === 'string' && typeof a.kind === 'string') {
          s.selectNode(a.nodeId);
          s.selectEffect(a.nodeId, a.kind);
        }
        break;
      }
      case 'open_logic': {
        if (typeof a.id === 'string') {
          s.setLeftTab('graphs');
          s.setActiveLogic(a.id);
        }
        break;
      }
      case 'open_panel': {
        const tab = a.tab;
        if (a.dock === 'left' && LEFT_TABS.includes(tab as LeftDockTab))
          s.setLeftTab(tab as LeftDockTab);
        else if (
          a.dock === 'bottom' &&
          BOTTOM_TABS.includes(tab as BottomDockTab)
        )
          s.flashBottomTab(tab as BottomDockTab);
        break;
      }
      case 'open_help': {
        if (typeof a.topic === 'string')
          useHelpStore
            .getState()
            .openHelp(a.topic, typeof a.anchor === 'string' ? a.anchor : null);
        break;
      }
      case 'open_window': {
        if (a.window === 'assistant') {
          const as = useAssistantStore.getState();
          if (a.open === false) as.closeAssistant();
          else as.openAssistant();
        } else if (a.window === 'accounts') {
          s.setAccountsModalOpen(a.open !== false);
        } else if (a.window === 'media') {
          s.setMediaModalOpen(a.open !== false);
        } else if (a.window === 'connections') {
          s.setConnectionsModalOpen(a.open !== false);
        } else if (a.window === 'update') {
          s.setUpdateDialogOpen(a.open !== false);
        }
        break;
      }
      case 'highlight_control': {
        if (typeof a.handle === 'string') highlightControl(a.handle);
        break;
      }
    }
  },

  selectTrackClip: (id) => set({ selectedTrackClipId: id }),
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

// Dev-only handle for debugging / e2e harnesses (inspect or poke store state
// from the console or Playwright). Never present in production builds.
if (import.meta.env.DEV) {
  (
    globalThis as unknown as { __editorStore?: typeof useEditorStore }
  ).__editorStore = useEditorStore;
}
