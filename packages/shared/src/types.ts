// Core identity types
export type NodeKind = 'avatar' | 'model' | 'light' | 'camera' | 'trigger' | 'particle' | 'sfx' | 'fx' | 'prop' | 'godray_caster' | 'billboard';

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

export type Component = AnimationComponent | TransformComponent | VisibilityComponent;

/** Per-node free-form properties stored in the `scene_nodes.properties` JSON column.
 *  Kind-specific fields are namespaced on this object; readers should treat unknown
 *  keys as opaque so different node kinds can carry their own settings. */
export interface SceneNodeProperties {
  /** Seconds to ramp between override and additive when the broadcast bus flips
   *  blend modes for this avatar. Applies to VRM avatar nodes. Default 0.5. */
  blendTransitionTime?: number;
}

// A node in a scene tree
export interface SceneNode {
  id: string;
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

/** Per-scene runtime parameters that live in the `scenes.runtime_settings` JSON column. */
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
  nodes: SceneNode[];
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  scenes: Scene[];
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
  bone: string
  /** Bones to solve, ordered root→tip. Tip must equal `bone`. */
  chain: string[]
  /** Target position, relative to the frame's `referenceBone` world position. */
  position?: [number, number, number]
  /** Target orientation in world space (optional). */
  orientation?: [number, number, number, number]
  /** Landmark visibility confidence 0–1. */
  confidence: number
}

/** A frame of IK targets broadcast per tracking update. */
export interface IkTargetFrame {
  nodeId: string
  /** VRM bone whose world position is the coordinate origin for all target positions. */
  referenceBone: string
  /** Distance between the source skeleton's shoulders (e.g. tracked human), in the same units
   *  as `targets[].position`. Used by consumers to scale the input frame to fit the target rig. */
  sourceShoulderWidth?: number
  /** Source skeleton's left shoulder position, expressed in the same reference frame as `targets[].position`
   *  (i.e. relative to `referenceBone`). Lets consumers correct for shoulder-to-chest offsets that
   *  differ between source and target rigs while keeping a single chest anchor. */
  sourceLeftShoulder?:  [number, number, number]
  sourceRightShoulder?: [number, number, number]
  targets: IkTarget[]
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
  | 'server_update';

export type UpdateChannel = 'stable' | 'recent' | 'experimental';

export interface UpdateStatus {
  updateAvailable: boolean;
  downloadReady: boolean;
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
  componentId: string;
  visemes: Record<string, number>;
}

export interface LipsyncStatusMessage {
  kind: 'lipsync_status';
  componentId: string;
  active: boolean;
  error?: string;
}

export interface TrackingInputMessage {
  kind: 'tracking_input';
  componentId: string;
  face?: Landmark[];      // 478 points
  leftHand?: Landmark[];  // 21 points
  rightHand?: Landmark[]; // 21 points
  pose?: Landmark[];      // 33 points
}

export interface TrackingStatusMessage {
  kind: 'tracking_status';
  componentId: string;
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
  componentId: string;
  queue: ApiAnimationQueueEntry[];
  loopMode: ApiAnimationLoopMode;
  /** ms epoch when the queue started; null when stopped. */
  startedAt: number | null;
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
