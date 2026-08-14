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
  | 'feed'
  | 'live2d';

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

/** scene_order = 0 is the 3D render slot. Negative paints above the 3D, positive paints behind.
 *  Camera-specific layers carry a non-zero camera_order to interleave within a scene_order slot. */
export const SCENE_RENDER_SLOT = 0;

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
  sceneOrder: number;
  cameraOrder: number;
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
  keyframes: TrackClipKeyframe[];
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
  /** When true AND loop=true, playback auto-resumes on backend boot using the persisted startedAt. */
  autoplay: boolean;
  /** ms-epoch anchor for an active loop+autoplay playhead; null when not autoplaying. */
  startedAt: number | null;
  createdAt: string;
  lanes: TrackClipLane[];
  /** Timed media-command markers (event lane). */
  events: TrackClipEvent[];
}

/** WS payload broadcast when a clip begins playback. Clients compute their own clock offset
 *  from (serverNow - Date.now()) on the first such message and evaluate locally thereafter. */
export interface TrackClipStartedMessage {
  clipId: string;
  startedAt: number;
  loop: boolean;
  serverNow: number;
}

export interface TrackClipPlaybackEntry {
  clipId: string;
  loop: boolean;
  /** ms epoch anchor when playing; null when paused. */
  startedAt?: number;
  /** seconds-into-clip when paused; null when playing. */
  pausedAtT?: number;
}

/** Snapshot of currently-active playback, sent to each freshly-connected WS client. */
export interface TrackClipPlaybackSnapshot {
  entries: TrackClipPlaybackEntry[];
  serverNow: number;
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
  | 'node_transform_preview'
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
  | 'data_channel_set'
  | 'data_channel_clear'
  | 'data_channel_snapshot'
  | 'media_control'
  // OBS. Browser-source bridge: obs_event / obs_command forward the page's
  // window.obsstudio surface; client_hello / client_status carry render-client
  // lifecycle. obs_connection_status reports the backend's obs-websocket link.
  | 'obs_event'
  | 'obs_command'
  | 'client_hello'
  | 'client_status'
  | 'obs_connection_status'
  // Assistant (in-app agent). Inbound: assistant_user_message, assistant_reset.
  // Outbound (per-connection): the rest.
  | 'assistant_user_message'
  | 'assistant_reset'
  | 'assistant_text'
  | 'assistant_tool_call'
  | 'assistant_tool_result'
  | 'assistant_error'
  | 'assistant_done'
  // UI-control channel. Outbound session_hello hands the client its session id;
  // inbound ui_register tags the session with its project; outbound ui_action
  // drives the editor (select entity, open panel/help/window, highlight control).
  | 'session_hello'
  | 'ui_register'
  | 'ui_action';

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

/** In-app assistant (agent) configuration. Points at any OpenAI-compatible
 *  chat endpoint (vLLM, Ollama, OpenAI, …). Persisted in config.json; the
 *  apiKey is redacted when read back over the API. */
export interface AssistantConfig {
  enabled: boolean;
  baseUrl: string;
  /** Bearer token for the LLM endpoint. Optional for keyless local servers. */
  apiKey: string;
  model: string;
}

export interface AppConfig {
  channel: UpdateChannel;
  /**
   * Whether the user has acknowledged the Live2D Cubism SDK license. The
   * proprietary Cubism Core is fetched at runtime (never bundled) only after
   * this opt-in. See dev-notes/plans/live2d-integration.md.
   */
  live2dLicenseAccepted?: boolean;
  assistant?: AssistantConfig;
}

/** An editor element the user attached to an assistant message via the attach
 *  picker, so the agent can resolve "this/that" references to a concrete id. */
export interface AssistantAttachment {
  kind: 'asset' | 'scene_node' | 'compose_layer';
  id: string;
  name: string;
  /** For assets: the served /uploads URL (usable in feed CSS / as filePath). */
  url?: string;
}

/** Shape of the assistant config exposed over the API — apiKey replaced by a
 *  boolean so the secret never leaves the backend. */
export interface AssistantConfigPublic {
  enabled: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  model: string;
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

// ── OBS browser-source bridge ────────────────────────────────────────────────
// vspark runs as an OBS Browser Source; the page in that source has access to
// the `window.obsstudio` JS API. Those interactions live in the browser, but
// the signal graph lives in the backend — so the frontend bridge forwards OBS
// events to the backend as `obs_event` and the backend pushes control calls
// back as `obs_command`. See dev-notes/modules/obs.md.

/** The OBS output whose run-state changed (folded into one event family). */
export type ObsOutputKind =
  | 'streaming'
  | 'recording'
  | 'replay'
  | 'virtualcam';

/** Run-state transition for an OBS output. `saved` only occurs for `replay`. */
export type ObsOutputState =
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'paused'
  | 'unpaused'
  | 'saved';

/** An event surfaced by the OBS browser-source JS API, normalised for routing. */
export type ObsEvent =
  | {
      type: 'scene_changed';
      /** Active program scene name. */
      name: string;
      width?: number;
      height?: number;
    }
  | {
      type: 'output_state';
      output: ObsOutputKind;
      state: ObsOutputState;
      /** Whether the output is active after this transition. */
      active: boolean;
    };

/** Frontend → backend: an OBS event observed in this browser source. */
export interface ObsEventMessage {
  kind: 'obs_event';
  event: ObsEvent;
}

/** A control call the backend asks the browser source to invoke on
 *  `window.obsstudio`. `verb` maps 1:1 to an obsstudio method. */
export interface ObsCommand {
  verb:
    | 'setCurrentScene'
    | 'setCurrentTransition'
    | 'startStreaming'
    | 'stopStreaming'
    | 'startRecording'
    | 'stopRecording'
    | 'pauseRecording'
    | 'unpauseRecording'
    | 'startReplayBuffer'
    | 'stopReplayBuffer'
    | 'saveReplayBuffer'
    | 'startVirtualcam'
    | 'stopVirtualcam';
  /** Scene/transition name argument, when the verb takes one. */
  arg?: string;
}

/** Backend → frontend: invoke an obsstudio control call. */
export interface ObsCommandMessage {
  kind: 'obs_command';
  command: ObsCommand;
}

// ── OBS power tier (obs-websocket connection) ────────────────────────────────
// A per-project, backend-held obs-websocket connection unlocks OBS control the
// browser-source API can't reach (audio volume/mute, replay path, source
// control). Credentials live in the Accounts UI. See
// dev-notes/plans/obs-websocket-tier.md.

/** Connection state, mirroring the overlive account status vocabulary. */
export type ObsConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

/** Backend → frontend: an obs-websocket connection's status changed. */
export interface ObsConnectionStatusMessage {
  kind: 'obs_connection_status';
  connectionId: string;
  projectId: string;
  status: ObsConnectionStatus;
  reason: string | null;
  message: string | null;
}

// ── Render-client lifecycle ──────────────────────────────────────────────────
// A render client (a browser tab or OBS browser source showing a vspark scene)
// announces itself on connect with a stable `target` marker so logic graphs can
// react to it appearing/disappearing. The WS socket itself is ephemeral and
// project-anonymous, so identity must be carried explicitly here.

/** Frontend → backend: sent once per (re)connection to identify the client. */
export interface ClientHelloMessage {
  kind: 'client_hello';
  projectId: string;
  /** Stable, user/route-assigned render-target id (e.g. compose-scene id or an
   *  `?obsTarget=` URL param). Empty string when unscoped. */
  target: string;
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
