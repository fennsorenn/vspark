import type { IdMap } from './idMap.js';

// Core identity types
export type NodeKind =
  | 'scene'
  | 'scene_instance'
  | 'avatar'
  | 'model'
  | 'light'
  | 'camera'
  | 'trigger'
  | 'particle'
  | 'sfx'
  | 'fx'
  | 'prop'
  | 'godray_caster'
  | 'billboard'
  | 'video'
  | 'audio'
  | 'group'
  | 'text_troika'
  | 'text_canvas'
  | 'feed';

// Animation tracking: tracks which clip is playing and when it started
export interface AnimationState {
  clipId: string;
  startedAt: number; // performance.now() timestamp
}

// A component carries animation state per node
export interface AnimationComponent {
  kind: 'animation';
  state: AnimationState | null;
}

export interface TransformComponent {
  kind: 'transform';
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface VisibilityComponent {
  kind: 'visibility';
  visible: boolean;
}

export type Component =
  | AnimationComponent
  | TransformComponent
  | VisibilityComponent;

// --- Media playback control (video / audio entities) ---

/** Target kinds a media command may address (scene-node entity or compose layer). */
export type MediaTargetKind = 'scene_node' | 'compose_layer';

/** Fire-and-forget media playback actions. Carried over the media-command bus
 *  (graph → frontend) and fired directly by the track-clip event lane. */
export type MediaAction =
  | 'play'
  | 'pause'
  | 'stop'
  | 'restart'
  | 'seek'
  | 'setVolume'
  | 'mute'
  | 'unmute';

export interface MediaCommand {
  action: MediaAction;
  /** Seconds — only for `action: 'seek'`. */
  t?: number;
  /** 0..1 — only for `action: 'setVolume'`. */
  volume?: number;
}

/** Payload of the `media_control` WS message (graph → frontend). */
export interface MediaControlMessage {
  targetKind: MediaTargetKind;
  targetId: string;
  command: MediaCommand;
}

/** Per-node free-form properties stored in the `scene_nodes.properties` JSON column.
 *  Kind-specific fields are namespaced on this object; readers should treat unknown
 *  keys as opaque so different node kinds can carry their own settings. */
export interface SceneNodeProperties {
  /** Seconds to ramp between override and additive when the broadcast bus flips
   *  blend modes for this avatar. Applies to VRM avatar nodes. Default 0.5. */
  blendTransitionTime?: number;
  /** Seconds a tracking dropout is tolerated before the avatar is considered
   *  untracked and falls back to its idle animation. Paired with
   *  `blendTransitionTime`: this is *when* the transition starts, that is how
   *  fast it runs. Every tracking source on the node (vmc_receiver,
   *  mediapipe_tracker) honours it, so the avatar cannot hold two conflicting
   *  windows. Applies to VRM avatar nodes. Default 2.
   *  Moved here from the per-behavior config in migration 035. */
  trackingGracePeriod?: number;
  /** Resting expression weights (VRM expression preset name → 0..1) applied to
   *  the avatar every frame as a baseline. Live blendshape broadcasts (VMC,
   *  lipsync, tracking) override them per-key. Applies to VRM avatar nodes. */
  defaultExpressions?: Record<string, number>;
  /** Broadcast Bus tick rate in Hz. Applies to kind='scene' nodes. Default 60. */
  broadcastTickHz?: number;
  /** References another kind='scene' node. Applies to kind='scene_instance' nodes. */
  sourceSceneId?: string;
  /** Second-order "snappiness" dynamics applied to broadcast bone rotations on
   *  the frontend, after the jitter-smoothing filter. Applies to VRM avatar
   *  nodes. Disabled by default. */
  poseDynamics?: PoseDynamics;
  /** Synthesize forearm twist bones when the model lacks them, so wrist
   *  pronation spreads along the forearm instead of pinching at the elbow.
   *  Models with their own twist bones are driven automatically regardless.
   *  Applies to VRM avatar nodes. Default false. */
  forceTwistBone?: boolean;
  /** When synthesizing forearm twist bones, keep their weight off loose sleeve /
   *  cuff geometry: twist weight is retained only on mesh reachable from the
   *  hand through connected twist-weighted vertices. Applies to VRM avatar
   *  nodes. Default false. */
  excludeSleeves?: boolean;
  /** Per-body-section pose source blending ("partial tracking"): each section
   *  carries an animation influence and a live-tracking influence, letting e.g.
   *  legs follow an animation clip while the upper body follows tracking. Absent
   *  sections default to { anim: 1, track: 1 } (tracking replaces animation where
   *  present, which is the legacy behaviour). Applies to VRM avatar nodes. */
  poseSource?: PoseSource;
}

/** The body sections that can independently blend animation vs. live tracking. */
export type PoseSection = 'legs' | 'body' | 'arms' | 'head' | 'gaze' | 'hands';

/** Per-section influence weights. `anim` pulls the section from its rest pose
 *  toward the animation clip; `track` then pulls it toward the live tracking
 *  pose (scaled by the global blend ramp). Both 0..1. anim=1/track=1 = tracking
 *  wins where present (legacy); anim=1/track=0 = animation only; anim=0/track=1
 *  = tracking only; anim=0/track=0 = rest. */
export interface PoseSectionInfluence {
  anim: number;
  track: number;
}

export type PoseSource = Partial<Record<PoseSection, PoseSectionInfluence>>;

/** Per-bone second-order (spring–damper) dynamics that add anticipatory snap /
 *  overshoot to broadcast pose without becoming choppy. See the frontend
 *  `secondOrderDynamics` module for the implementation. */
export interface PoseDynamics {
  enabled: boolean;
  /** Natural frequency in Hz. Higher = faster / snappier. */
  frequency: number;
  /** Damping ratio ζ. <1 overshoots, 1 critical, >1 sluggish. */
  damping: number;
  /** Response r. 0 = none, >0 anticipatory lead, <0 wind-up. */
  response: number;
}

// A node in a scene tree
export interface StageObject {
  id: string;
  projectId: string;
  rootSceneNodeId: string;
  parentId: string | null;
  boneAttachment: string | null; // VRM bone name if this node is pinned to a bone on its parent
  name: string;
  kind: NodeKind;
  filePath: string | null; // local path to asset file
  components: Record<string, Component>;
  properties: SceneNodeProperties;
  createdAt: string;
  updatedAt: string;
}

/** Per-scene runtime parameters that live in the scene node's `properties` JSON column. */
export interface SceneRuntimeSettings {
  /** Broadcast Bus tick rate in Hz. Defaults to 60. */
  broadcastTickHz?: number;
}

/** How the frontend should composite a broadcast pose against the active animation clip. */
export type AnimationBlendMode = 'override' | 'additive';

export interface Scene {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  runtimeSettings: SceneRuntimeSettings;
  nodes: StageObject[];
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  scenes: Scene[];
}

// --- Compose layers (2D overlays composited with the 3D scene render) ---

export type ComposeLayerKind =
  | 'compose_scene'
  | 'scene_include'
  | 'camera_view'
  | 'image'
  | 'video'
  | 'audio'
  | 'browser'
  | 'text'
  | 'feed'
  | 'group';
export type ComposeAnchorH = 'left' | 'right';
export type ComposeAnchorV = 'top' | 'bottom';

export interface ComposeLayer {
  id: string;
  projectId: string;
  /** null = this IS a compose_scene; non-null = belongs to this compose_scene */
  rootComposeSceneId: string | null;
  /** References a camera scene_node for kind='camera_view' */
  cameraNodeId: string | null;
  /** null = root layer; set to nest under another layer */
  parentId: string | null;
  name: string;
  kind: ComposeLayerKind;
  assetId: string | null;
  /** kind-specific: { url?: string; opacity?: number; objectFit?: 'cover'|'contain'|'fill'; ... } */
  config: Record<string, unknown>;
  x: number;
  y: number;
  width: number;
  height: number;
  /** degrees, clockwise around layer center */
  rotation: number;
  anchorH: ComposeAnchorH;
  anchorV: ComposeAnchorV;
  /** Sibling order: a string fractional key, sorted lexicographically and
   *  tie-broken by `id`. Ascending = back→front. Scoped to the sibling set
   *  (rootComposeSceneId, parentId). See fracIndex. */
  orderKey: string;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Logic (user-built signal graphs with owner scoping) ---

export type LogicOwnerKind = 'project' | 'scene_node' | 'compose_layer';

export interface Logic {
  id: string;
  ownerKind: LogicOwnerKind;
  ownerId: string;
  name: string;
  enabled: boolean;
  descriptor: unknown;
  nodeState?: unknown;
  createdAt: string;
  updatedAt: string;
}

// --- Track clips (timeline-based parameter animation) ---

export type TrackClipMode = 'override' | 'relative';
export type TrackClipTargetKind = 'scene_node' | 'compose_layer';
export type TrackClipEasing = 'linear' | 'step' | 'bezier';

/** Scalar parameter paths supported in v1.
 *  Scene node:    'position.x' | 'position.y' | 'position.z'
 *                | 'rotation.x' | 'rotation.y' | 'rotation.z'
 *                | 'scale.x'    | 'scale.y'    | 'scale.z'
 *  Compose layer: 'x' | 'y' | 'rotation' */
export type TrackClipParamPath = string;

/** The clip document's child collections are id-keyed, not arrays: an array is
 *  a single path, so two peers editing different keyframes would clobber each
 *  other. See idMap.ts for the reasoning and the read helpers. */
export interface TrackClipKeyframe {
  id: string;
  t: number; // seconds from clip start
  value: number;
  easing: TrackClipEasing;
  /** Bezier handle offsets stored as fractions of the adjoining segment (only
   *  present for easing='bezier'). The absolute (Δt, Δv) used by the evaluator
   *  is resolved at use time as:
   *     out: dt = outHandleTFraction * (next.t  - kf.t)
   *          dv = outHandleVFraction * (next.value  - kf.value)
   *     in:  dt = -inHandleTFraction * (kf.t   - prev.t)        (negative)
   *          dv = -inHandleVFraction * (kf.value   - prev.value)
   *  When the adjoining neighbour is missing the handle is hidden / no curve
   *  is drawn on that side (the segment is flat). Δt fractions are clamped to
   *  [0, 1]; Δv fractions are unbounded. */
  inHandleTFraction: number | null;
  inHandleVFraction: number | null;
  outHandleTFraction: number | null;
  outHandleVFraction: number | null;
}

export interface TrackClipLane {
  id: string;
  clipId: string;
  targetKind: TrackClipTargetKind;
  targetId: string;
  paramPath: TrackClipParamPath;
  /** "Rest" value the keyframes are offsets from when the clip is in relative mode. */
  defaultValue: number;
  /** Keyed by keyframe id so each one is its own mesh path — two people can
   *  drag different keyframes on the same lane without one losing. Read with
   *  `sortedBy(kfs, k => k.t)`; the map itself has no order. */
  keyframes: IdMap<TrackClipKeyframe>;
}

/** A discrete marker on a track clip that fires a fire-and-forget media command
 *  when the playhead crosses time `t` (re-armed each loop). Unlike lanes (scalar
 *  interpolation), events are one-shot. Evaluated client-side and dispatched to
 *  the media registry. See dev-notes/modules/track-clips.md. */
export interface TrackClipEvent {
  id: string;
  /** Seconds from clip start. */
  t: number;
  action: MediaAction;
  targetKind: MediaTargetKind;
  /** Scene-node or compose-layer id of the media entity to control. */
  targetId: string;
  /** Optional extra args (e.g. { t } for seek, { volume } for setVolume). */
  payload: Record<string, unknown> | null;
}

export interface TrackClip {
  id: string;
  /** Owner is exactly one of these: a scene node (scene roots included) or a
   *  compose layer. The other is null. */
  ownerNodeId: string | null;
  ownerLayerId: string | null;
  name: string;
  duration: number; // seconds
  loop: boolean;
  mode: TrackClipMode;
  /** When true AND loop=true, playback resumes at boot — the anchor lives on
   *  the clip's `clip_playback` document, not here. */
  autoplay: boolean;
  createdAt: string;
  /** Keyed by lane id — see the note on `TrackClipLane.keyframes`. */
  lanes: IdMap<TrackClipLane>;
  /** Timed media-command markers (event lane), keyed by event id. */
  events: IdMap<TrackClipEvent>;
}

// Player/identity
export interface Player {
  id: string;
  username: string;
  email: string;
  displayAvatarId: string | null;
  createdAt: string;
}

// Session & presence
export interface Session {
  id: string;
  playerId: string;
  sceneId: string;
  token: string;
  wsConnected: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface PresenceState {
  sessionId: string;
  nodeId: string;
  position: [number, number, number];
  rotation: [number, number, number];
  updatedAt: string;
}

// Avatar and asset
export interface Avatar {
  id: string;
  playerId: string;
  vrmFilePath: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
}

/**
 * UI-population metadata extracted from a VRM/GLB at upload time (and refreshed
 * when the file's content hash drifts). Lets the frontend list bones, materials,
 * blendshapes and expressions without loading the model in the viewport. Not
 * used for live rendering. All lists are deduped; non-VRM models simply have
 * empty bone/expression lists.
 */
export interface VrmAssetMetadata {
  bones: string[]; // VRM humanoid bone names
  materials: string[]; // glTF material names
  morphTargets: string[]; // morph target (blendshape) names
  expressions: string[]; // VRM expression / blendshape-group names
}

export interface AssetFile {
  id: string;
  projectId: string;
  originalName: string;
  storedPath: string;
  mimeType: string;
  size: number;
  hash: string;
  isDeduplicated: boolean;
  createdAt: string;
  metadata: VrmAssetMetadata | null;
}

// Animation clip
export interface AnimationClip {
  id: string;
  name: string;
  sourceNodeId: string;
  sourceFilePath: string;
  clipIndex: number;
  label: string;
  startTime: number;
  endTime: number;
  duration: number;
  fps: number;
  createdAt: string;
}

// Trigger
export interface Trigger {
  id: string;
  nodeId: string;
  kind: string;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

// Preference
export interface Preference {
  id: string;
  playerId: string;
  key: string;
  value: string;
  updatedAt: string;
}

// Audit log
export interface AuditLog {
  id: string;
  projectId: string;
  playerId: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

// WebSocket message types
/** A single IK end-effector target. */
export interface IkTarget {
  /** VRM bone name being targeted (end-effector). */
  bone: string;
  /** Bones to solve, ordered root→tip. Tip must equal `bone`. */
  chain: string[];
  /** Target position, relative to the frame's `referenceBone` world position. */
  position?: [number, number, number];
  /** Target orientation in world space (optional). */
  orientation?: [number, number, number, number];
  /** Landmark visibility confidence 0–1. */
  confidence: number;
}

/** A frame of IK targets broadcast per tracking update. */
export interface IkTargetFrame {
  nodeId: string;
  /** VRM bone whose world position is the coordinate origin for all target positions. */
  referenceBone: string;
  /** Distance between the source skeleton's shoulders (e.g. tracked human), in the same units
   *  as `targets[].position`. Used by consumers to scale the input frame to fit the target rig. */
  sourceShoulderWidth?: number;
  /** Source skeleton's left shoulder position, expressed in the same reference frame as `targets[].position`
   *  (i.e. relative to `referenceBone`). Lets consumers correct for shoulder-to-chest offsets that
   *  differ between source and target rigs while keeping a single chest anchor. */
  sourceLeftShoulder?: [number, number, number];
  sourceRightShoulder?: [number, number, number];
  targets: IkTarget[];
}

export type WSMessageKind =
  | 'node_update'
  | 'node_add'
  | 'node_remove'
  | 'presence_move'
  | 'presence_join'
  | 'presence_leave'
  | 'animation_play'
  | 'trigger_fire'
  | 'scene_dirty'
  | 'lipsync_input'
  | 'lipsync_status'
  | 'tracking_input'
  | 'tracking_status'
  | 'pose_ik_targets'
  | 'server_update'
  | 'behavior_added'
  | 'compose_layer_added'
  | 'compose_layer_updated'
  | 'compose_layer_removed'
  | 'compose_layer_reordered'
  | 'compose_layer_preview'
  | 'track_clip_added'
  | 'track_clip_updated'
  | 'track_clip_removed'
  | 'track_clip_lane_added'
  | 'track_clip_lane_updated'
  | 'track_clip_lane_removed'
  | 'track_clip_keyframes_replaced'
  | 'track_clip_events_replaced'
  | 'track_clip_started'
  | 'track_clip_paused'
  | 'track_clip_stopped'
  | 'track_clip_playback_snapshot'
  | 'media_control';

export type UpdateChannel = 'stable' | 'recent' | 'experimental';

export interface UpdateStatus {
  updateAvailable: boolean;
  downloadReady: boolean;
  /** Bytes downloaded so far while a download is in progress (else null). */
  downloadedBytes: number | null;
  /** Total bytes to download, from Content-Length (null if unknown). */
  totalBytes: number | null;
  currentVersion: string;
  latestVersion: string | null;
  releaseNotes: string | null;
  channel: UpdateChannel;
}

export interface AppConfig {
  channel: UpdateChannel;
}

export interface WSMessage {
  kind: WSMessageKind;
  payload: Record<string, unknown>;
  timestamp: number;
}

// Raw landmark point as emitted by MediaPipe
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface LipsyncInputMessage {
  kind: 'lipsync_input';
  behaviorId: string;
  visemes: Record<string, number>;
}

export interface LipsyncStatusMessage {
  kind: 'lipsync_status';
  behaviorId: string;
  active: boolean;
  error?: string;
}

export interface TrackingInputMessage {
  kind: 'tracking_input';
  behaviorId: string;
  face?: Landmark[]; // 478 points
  leftHand?: Landmark[]; // 21 points
  rightHand?: Landmark[]; // 21 points
  pose?: Landmark[]; // 33 points
  faceBlendshapes?: Record<string, number>; // 52 ARKit shapes (name → 0..1)
}

export interface TrackingStatusMessage {
  kind: 'tracking_status';
  behaviorId: string;
  active: boolean;
  error?: string;
}

// API controller — frontend-driven animation playback synced via startedAt.
export type ApiAnimationLoopMode = 'none' | 'last' | 'queue';

export interface ApiAnimationQueueEntry {
  /** Animation clip id. */
  animationId: string;
  /** Resolved URL of the clip source file (so the frontend can load directly). */
  sourceUrl: string;
  /** Duration in seconds (used to schedule queue advancement). */
  duration: number;
}

/** Frontend → backend report of the VRM expression list for a loaded avatar node. */
export interface AvatarExpressionsReportMessage {
  kind: 'avatar_expressions_report';
  nodeId: string;
  /** Empty array signals the avatar was unloaded. */
  expressions: string[];
}

export interface ApiAnimationMessage {
  nodeId: string;
  behaviorId: string;
  queue: ApiAnimationQueueEntry[];
  loopMode: ApiAnimationLoopMode;
  /** ms epoch when the queue started; null when stopped. */
  startedAt: number | null;
}

// --- Presets ---

export type PresetRootKind = 'scene_node' | 'compose_layer';

export interface Preset {
  id: string;
  projectId: string;
  name: string;
  description: string;
  rootKind: PresetRootKind;
  payload: unknown;
  thumbnailPath: string | null;
  createdAt: string;
  updatedAt: string;
}

// API response types
export interface APIError {
  status: number;
  message: string;
  code: string;
}

export type APIResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: APIError };
