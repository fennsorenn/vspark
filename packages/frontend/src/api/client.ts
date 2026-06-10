const BASE = '/api';

/** Thrown by `request()` on a non-ok response. `status` is the HTTP status so
 *  callers can branch on 404 / 503 / etc; `code` is the backend's error code. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) {
    const status = json?.error?.status ?? res.status;
    const code = json?.error?.code ?? 'UNKNOWN';
    const msg = json?.error?.message ?? `API error ${status}`;
    throw new ApiError(status, msg, code);
  }
  return json.data as T;
}

// Strip legacy absolute backend origin from stored paths so they route through the Vite proxy.
function normalizeFilePath(raw: unknown): string | null {
  if (!raw) return null;
  let s = raw as string;
  try {
    const u = new URL(s);
    // If it points to localhost (any port), keep only the path so it routes via proxy.
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      s = u.pathname + u.search;
  } catch {
    /* not an absolute URL — already relative, keep as-is */
  }
  return s;
}

// snake_case → camelCase for rows coming out of SQLite
function mapNode(
  r: Record<string, unknown>,
  rootSceneNodeId?: string
): StageObject {
  const components =
    typeof r.components === 'string'
      ? JSON.parse(r.components as string)
      : (r.components ?? {});
  // Normalize any localhost URLs nested inside component blobs (e.g. animation.idleUrl)
  if (
    components.animation &&
    typeof (components.animation as Record<string, unknown>).idleUrl ===
      'string'
  ) {
    (components.animation as Record<string, unknown>).idleUrl =
      normalizeFilePath(
        (components.animation as Record<string, unknown>).idleUrl
      );
  }
  const properties =
    typeof r.properties === 'string'
      ? JSON.parse(r.properties as string)
      : (r.properties ?? {});
  return {
    id: r.id as string,
    // backend may return snake_case (from SQLite rows) or camelCase (from INSERT response)
    rootSceneNodeId: (r.root_scene_node_id ??
      r.rootSceneNodeId ??
      rootSceneNodeId ??
      '') as string,
    projectId: (r.project_id ?? r.projectId ?? '') as string,
    parentId: (r.parent_id ?? r.parentId ?? null) as string | null,
    boneAttachment: (r.bone_attachment ?? r.boneAttachment ?? null) as
      | string
      | null,
    name: r.name as string,
    kind: r.kind as string,
    filePath: normalizeFilePath(r.file_path ?? r.filePath),
    components,
    properties,
    hidden: Boolean(r.hidden),
  };
}

function mapScene(r: Record<string, unknown>): SceneItem {
  const raw = (r.runtime_settings ?? r.runtimeSettings ?? '{}') as
    | string
    | Record<string, unknown>;
  let runtimeSettings: SceneRuntimeSettings = {};
  if (typeof raw === 'string') {
    try {
      runtimeSettings = JSON.parse(raw || '{}') as SceneRuntimeSettings;
    } catch {
      /* keep default */
    }
  } else {
    runtimeSettings = raw as SceneRuntimeSettings;
  }
  return {
    id: r.id as string,
    name: r.name as string,
    runtimeSettings,
  };
}

function mapProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description ?? undefined) as string | undefined,
    createdAt: (r.created_at ?? '') as string,
    updatedAt: (r.updated_at ?? '') as string,
  };
}

function mapAsset(r: Record<string, unknown>): AssetFile {
  return {
    id: r.id as string,
    projectId: (r.project_id ?? '') as string,
    name: (r.original_name ?? '') as string,
    storedPath: (r.stored_path ?? '') as string,
    url: r.stored_path as string,
    mimeType: (r.mime_type ?? '') as string,
    kind: guessAssetKind((r.original_name as string) ?? ''),
  };
}

function guessAssetKind(name: string): AssetKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['fbx', 'bvh'].includes(ext)) return 'animation';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext))
    return 'image';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio';
  return 'model';
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SceneRuntimeSettings {
  /** Broadcast Bus tick rate in Hz. Defaults to 60 when undefined. */
  broadcastTickHz?: number;
}

export interface SceneItem {
  id: string;
  name: string;
  runtimeSettings: SceneRuntimeSettings;
}

/** Per-node free-form properties stored in scene_nodes.properties.
 *  Mirrors the shared `SceneNodeProperties` shape — kind-specific keys live here. */
export interface NodeProperties {
  /** VRM avatar: seconds to ramp between override and additive when the bus flips
   *  blend mode (e.g. on tracking loss). Default 0.5. */
  blendTransitionTime?: number;
  /** VRM avatar: resting expression weights (expression name → 0..1) applied as a
   *  baseline each frame; live blendshape broadcasts override them per-key. */
  defaultExpressions?: Record<string, number>;
  /** VRM avatar: per-material shader/param overrides (MToon ⇄ PBR), keyed by a
   *  stable material identity. See components/editor/materialOverrides.ts. */
  materialOverrides?: import('../components/editor/materialOverrides').MaterialOverrides;
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
}

export type AssetKind = 'model' | 'animation' | 'image' | 'video' | 'audio';

export interface AssetFile {
  id: string;
  projectId: string;
  name: string;
  storedPath: string;
  url: string;
  mimeType: string;
  kind: AssetKind;
}

export interface BehaviorRecord {
  id: string;
  nodeId: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface CameraEffectRecord {
  id: string;
  nodeId: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export type ComposeLayerKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'browser'
  | 'group'
  | 'compose_scene'
  | 'scene_include'
  | 'camera_view'
  | 'text'
  | 'feed';
export type ComposeAnchorH = 'left' | 'right';
export type ComposeAnchorV = 'top' | 'bottom';

export interface ComposeLayerRecord {
  id: string;
  projectId: string;
  rootComposeSceneId: string | null;
  cameraNodeId: string | null;
  parentId: string | null;
  name: string;
  kind: ComposeLayerKind;
  assetId: string | null;
  config: Record<string, unknown>;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  anchorH: ComposeAnchorH;
  anchorV: ComposeAnchorV;
  sceneOrder: number;
  cameraOrder: number;
  visible: boolean;
}

// ─── Track clips ─────────────────────────────────────────────────────────────

export type TrackClipMode = 'override' | 'relative';
export type TrackClipTargetKind = 'scene_node' | 'compose_layer';
export type TrackClipEasing = 'linear' | 'step' | 'bezier';

export interface TrackClipKeyframeRecord {
  id: string;
  t: number;
  value: number;
  easing: TrackClipEasing;
  /** Bezier handle offsets as fractions of the adjoining segment.
   *  Resolved to absolute (Δt, Δv) at use time using neighbouring keyframes. */
  inHandleTFraction: number | null;
  inHandleVFraction: number | null;
  outHandleTFraction: number | null;
  outHandleVFraction: number | null;
}

export interface TrackClipLaneRecord {
  id: string;
  clipId: string;
  targetKind: TrackClipTargetKind;
  targetId: string;
  paramPath: string;
  defaultValue: number;
  keyframes: TrackClipKeyframeRecord[];
}

export interface TrackClipEventRecord {
  id: string;
  t: number;
  action: string;
  targetKind: TrackClipTargetKind;
  targetId: string;
  payload: Record<string, unknown> | null;
}

export interface TrackClipRecord {
  id: string;
  /** Owner is exactly one of these (the other is null). */
  ownerNodeId: string | null;
  ownerLayerId: string | null;
  name: string;
  duration: number;
  loop: boolean;
  mode: TrackClipMode;
  autoplay: boolean;
  startedAt: number | null;
  lanes: TrackClipLaneRecord[];
  events: TrackClipEventRecord[];
}

// Projects
export const getProjects = () =>
  request<Record<string, unknown>[]>('/projects').then((rows) =>
    rows.map(mapProject)
  );

export const createProject = (name: string, description?: string) =>
  request<Record<string, unknown>>('/projects', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  }).then(mapProject);

export const deleteProject = (id: string) =>
  request<void>(`/projects/${id}`, { method: 'DELETE' });

export const updateProject = (id: string, name: string, description?: string) =>
  request<void>(`/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, description }),
  });

export function mapBehavior(r: Record<string, unknown>): BehaviorRecord {
  return {
    id: r.id as string,
    nodeId: (r.node_id ?? r.nodeId ?? '') as string,
    kind: r.kind as string,
    enabled: Boolean(r.enabled),
    config:
      typeof r.config === 'string' ? JSON.parse(r.config) : (r.config ?? {}),
  };
}

function mapCameraEffect(r: Record<string, unknown>): CameraEffectRecord {
  return {
    id: r.id as string,
    nodeId: (r.node_id ?? r.nodeId ?? '') as string,
    kind: r.kind as string,
    enabled: Boolean(r.enabled),
    config:
      typeof r.config === 'string' ? JSON.parse(r.config) : (r.config ?? {}),
  };
}

function pickFractional(
  r: Record<string, unknown>,
  snake: string,
  camel: string
): number | null {
  if (r[snake] != null) return Number(r[snake]);
  if (r[camel] != null) return Number(r[camel]);
  return null;
}

export function mapTrackClipKeyframe(
  r: Record<string, unknown>
): TrackClipKeyframeRecord {
  return {
    id: r.id as string,
    t: Number(r.t ?? 0),
    value: Number(r.value ?? 0),
    easing: (r.easing ?? 'linear') as TrackClipEasing,
    inHandleTFraction: pickFractional(
      r,
      'in_handle_t_fraction',
      'inHandleTFraction'
    ),
    inHandleVFraction: pickFractional(
      r,
      'in_handle_v_fraction',
      'inHandleVFraction'
    ),
    outHandleTFraction: pickFractional(
      r,
      'out_handle_t_fraction',
      'outHandleTFraction'
    ),
    outHandleVFraction: pickFractional(
      r,
      'out_handle_v_fraction',
      'outHandleVFraction'
    ),
  };
}

export function mapTrackClipLane(
  r: Record<string, unknown>
): TrackClipLaneRecord {
  const rawKfs = (r.keyframes as Record<string, unknown>[] | undefined) ?? [];
  return {
    id: r.id as string,
    clipId: (r.clip_id ?? r.clipId ?? '') as string,
    targetKind: (r.target_kind ?? r.targetKind) as TrackClipTargetKind,
    targetId: (r.target_id ?? r.targetId) as string,
    paramPath: (r.param_path ?? r.paramPath) as string,
    defaultValue: Number(r.default_value ?? r.defaultValue ?? 0),
    keyframes: rawKfs.map(mapTrackClipKeyframe),
  };
}

export function mapTrackClipEvent(
  r: Record<string, unknown>
): TrackClipEventRecord {
  return {
    id: r.id as string,
    t: Number(r.t ?? 0),
    action: (r.action ?? 'play') as string,
    targetKind: (r.target_kind ??
      r.targetKind ??
      'scene_node') as TrackClipTargetKind,
    targetId: (r.target_id ?? r.targetId ?? '') as string,
    payload: (r.payload ?? null) as Record<string, unknown> | null,
  };
}

export function mapTrackClip(r: Record<string, unknown>): TrackClipRecord {
  const rawLanes = (r.lanes as Record<string, unknown>[] | undefined) ?? [];
  const rawEvents = (r.events as Record<string, unknown>[] | undefined) ?? [];
  return {
    id: r.id as string,
    ownerNodeId: (r.owner_node_id ?? r.ownerNodeId ?? null) as string | null,
    ownerLayerId: (r.owner_layer_id ?? r.ownerLayerId ?? null) as string | null,
    name: r.name as string,
    duration: Number(r.duration ?? 2),
    loop: r.loop === undefined ? false : Boolean(r.loop),
    mode: (r.mode ?? 'override') as TrackClipMode,
    autoplay: r.autoplay === undefined ? false : Boolean(r.autoplay),
    startedAt:
      r.started_at != null
        ? Number(r.started_at)
        : r.startedAt != null
          ? Number(r.startedAt)
          : null,
    lanes: rawLanes.map(mapTrackClipLane),
    events: rawEvents.map(mapTrackClipEvent),
  };
}

export function mapComposeLayer(
  r: Record<string, unknown>
): ComposeLayerRecord {
  return {
    id: r.id as string,
    projectId: (r.project_id ?? r.projectId ?? '') as string,
    rootComposeSceneId: (r.root_compose_scene_id ??
      r.rootComposeSceneId ??
      null) as string | null,
    cameraNodeId: (r.camera_node_id ?? r.cameraNodeId ?? null) as string | null,
    parentId: (r.parent_id ?? r.parentId ?? null) as string | null,
    name: r.name as string,
    kind: r.kind as ComposeLayerKind,
    assetId: (r.asset_id ?? r.assetId ?? null) as string | null,
    config:
      typeof r.config === 'string'
        ? JSON.parse(r.config)
        : ((r.config ?? {}) as Record<string, unknown>),
    x: Number(r.x ?? 0),
    y: Number(r.y ?? 0),
    width: Number(r.width ?? 320),
    height: Number(r.height ?? 180),
    rotation: Number(r.rotation ?? 0),
    anchorH: (r.anchor_h ?? r.anchorH ?? 'left') as ComposeAnchorH,
    anchorV: (r.anchor_v ?? r.anchorV ?? 'top') as ComposeAnchorV,
    sceneOrder: Number(r.scene_order ?? r.sceneOrder ?? 0),
    cameraOrder: Number(r.camera_order ?? r.cameraOrder ?? 0),
    visible: r.visible === undefined ? true : Boolean(r.visible),
  };
}

// Scenes — backend returns { scenes, nodes, behaviors, cameraEffects, composeLayers, trackClips }
export const getScenes = (projectId: string) =>
  request<{
    scenes: Record<string, unknown>[];
    nodes: Record<string, unknown>[];
    behaviors?: Record<string, unknown>[];
    cameraEffects?: Record<string, unknown>[];
    composeLayers?: Record<string, unknown>[];
    trackClips?: Record<string, unknown>[];
  }>(`/projects/${projectId}/scenes`).then(
    ({
      scenes,
      nodes,
      behaviors,
      cameraEffects,
      composeLayers,
      trackClips,
    }) => ({
      scenes: scenes.map(mapScene),
      nodes: nodes.map((n) => mapNode(n)),
      behaviors: (behaviors ?? []).map(mapBehavior),
      cameraEffects: (cameraEffects ?? []).map(mapCameraEffect),
      composeLayers: (composeLayers ?? []).map(mapComposeLayer),
      trackClips: (trackClips ?? []).map(mapTrackClip),
    })
  );

export const createScene = (projectId: string, name: string) =>
  request<Record<string, unknown>>(`/projects/${projectId}/scenes`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  }).then(mapScene);

export const updateScene = (
  sceneId: string,
  patch: { name?: string; runtimeSettings?: SceneRuntimeSettings }
) =>
  request<Record<string, unknown>>(`/scenes/${sceneId}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

export const deleteScene = (sceneId: string) =>
  request<Record<string, unknown>>(`/scenes/${sceneId}`, {
    method: 'DELETE',
  });

// Nodes
export const getNodes = (sceneId: string) =>
  request<Record<string, unknown>[]>(`/scenes/${sceneId}/nodes`).then((rows) =>
    rows.map((r) => mapNode(r, sceneId))
  );

/** Phase 6: a registered hook that diverts edits of a *writable remote* node to
 *  its owner over the mesh instead of this server's REST API. Returns true if it
 *  handled the op (REST is then skipped). Keeps api/client decoupled from the
 *  stores + mesh modules; set at startup, null when remote-edit isn't active. */
export type RemoteWriteRouter = (
  op: 'update' | 'delete',
  id: string,
  data?: Partial<Omit<StageObject, 'id' | 'rootSceneNodeId' | 'projectId'>>
) => boolean;
let remoteWriteRouter: RemoteWriteRouter | null = null;
export function setRemoteWriteRouter(r: RemoteWriteRouter | null): void {
  remoteWriteRouter = r;
}

export const createNode = (
  sceneId: string,
  data: Omit<StageObject, 'id' | 'rootSceneNodeId' | 'projectId'>
) =>
  request<Record<string, unknown>>(`/scenes/${sceneId}/nodes`, {
    method: 'POST',
    body: JSON.stringify({
      name: data.name,
      kind: data.kind,
      parentId: data.parentId,
      boneAttachment: data.boneAttachment,
      filePath: data.filePath,
      components: data.components,
      properties: data.properties,
    }),
  }).then((r) => mapNode(r, sceneId));

export const updateNode = (
  id: string,
  data: Partial<Omit<StageObject, 'id' | 'rootSceneNodeId' | 'projectId'>>
) => {
  if (remoteWriteRouter?.('update', id, data)) return Promise.resolve();
  const body: Record<string, unknown> = {};
  if (data.name !== undefined) body.name = data.name;
  if (data.parentId !== undefined) body.parentId = data.parentId;
  if (data.kind !== undefined) body.kind = data.kind;
  if (data.filePath !== undefined) body.filePath = data.filePath;
  if (data.components !== undefined) body.components = data.components;
  if (data.properties !== undefined) body.properties = data.properties;
  // boneAttachment must be sent explicitly even when null (to support detach)
  if ('boneAttachment' in data)
    body.boneAttachment = data.boneAttachment ?? null;
  if ('hidden' in data) body.hidden = data.hidden ?? false;
  return request<void>(`/scene-nodes/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
};

export const deleteNode = (id: string) =>
  remoteWriteRouter?.('delete', id)
    ? Promise.resolve()
    : request<void>(`/scene-nodes/${id}`, { method: 'DELETE' });

// Assets
export const getAssets = (projectId: string) =>
  request<Record<string, unknown>[]>(`/projects/${projectId}/assets`).then(
    (rows) => rows.map(mapAsset)
  );

export const uploadAsset = (projectId: string, file: File) =>
  new Promise<AssetFile>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      try {
        const row = await request<Record<string, unknown>>(
          `/projects/${projectId}/assets`,
          {
            method: 'POST',
            body: JSON.stringify({
              name: file.name,
              mimeType: file.type,
              data: base64,
            }),
          }
        );
        resolve(mapAsset(row));
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export const deleteAsset = (id: string) =>
  request<void>(`/assets/${id}`, { method: 'DELETE' });

// Node Components
export const createBehavior = (
  nodeId: string,
  comp: Omit<BehaviorRecord, 'nodeId'>
) =>
  request<Record<string, unknown>>(`/scene-nodes/${nodeId}/behaviors`, {
    method: 'POST',
    body: JSON.stringify({
      id: comp.id,
      kind: comp.kind,
      enabled: comp.enabled,
      config: comp.config,
    }),
  }).then(mapBehavior);

export const updateBehavior = (
  id: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> }
) =>
  request<void>(`/behaviors/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

export const deleteBehavior = (id: string) =>
  request<void>(`/behaviors/${id}`, { method: 'DELETE' });

// Camera Effects
export const createCameraEffect = (
  nodeId: string,
  effect: Omit<CameraEffectRecord, 'nodeId'>
) =>
  request<Record<string, unknown>>(`/scene-nodes/${nodeId}/effects`, {
    method: 'POST',
    body: JSON.stringify({
      id: effect.id,
      kind: effect.kind,
      enabled: effect.enabled,
      config: effect.config,
    }),
  }).then(mapCameraEffect);

export const updateCameraEffect = (
  id: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> }
) =>
  request<void>(`/camera-effects/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

export const deleteCameraEffect = (id: string) =>
  request<void>(`/camera-effects/${id}`, { method: 'DELETE' });

// Compose Layers
export const updateComposeLayer = (
  id: string,
  patch: Partial<
    Omit<
      ComposeLayerRecord,
      'id' | 'projectId' | 'rootComposeSceneId' | 'cameraNodeId' | 'kind'
    >
  >
) =>
  request<Record<string, unknown>>(`/compose-layers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  }).then(mapComposeLayer);

export const deleteComposeLayer = (id: string) =>
  request<{
    id: string;
    reanchored?: { id: string; sceneOrder: number; cameraOrder: number }[];
  }>(`/compose-layers/${id}`, { method: 'DELETE' });

export const reorderComposeLayers = (
  updates: { id: string; sceneOrder: number; cameraOrder: number }[]
) =>
  request<void>('/compose-layers/reorder', {
    method: 'POST',
    body: JSON.stringify({ updates }),
  });

// Compose Scenes
export const getComposeScenes = (projectId: string) =>
  request<Record<string, unknown>[]>(
    `/projects/${projectId}/compose-scenes`
  ).then((rows) => rows.map(mapComposeLayer));

export const createComposeScene = (
  projectId: string,
  body: { name: string; [key: string]: unknown }
) =>
  request<Record<string, unknown>>(`/projects/${projectId}/compose-scenes`, {
    method: 'POST',
    body: JSON.stringify(body),
  }).then(mapComposeLayer);

export const getComposeSceneLayers = (composeSceneId: string) =>
  request<Record<string, unknown>[]>(
    `/compose-scenes/${composeSceneId}/layers`
  ).then((rows) => rows.map(mapComposeLayer));

export const createComposeSceneLayer = (
  composeSceneId: string,
  layer: Partial<ComposeLayerRecord> & { name: string; kind: ComposeLayerKind }
) =>
  request<Record<string, unknown>>(`/compose-scenes/${composeSceneId}/layers`, {
    method: 'POST',
    body: JSON.stringify(layer),
  }).then(mapComposeLayer);

// Track clips
type CreateTrackClipBody = {
  name: string;
  duration?: number;
  loop?: boolean;
  mode?: TrackClipMode;
  autoplay?: boolean;
};

/** Create a clip owned by a scene node (scene roots included). */
/** Fetch the full list of track clips owned by a scene node, each with its
 *  lanes + keyframes hydrated. Useful when a bulk paste did many inserts
 *  via lane / keyframe endpoints and the caller needs a consistent local
 *  snapshot rather than reconstructing from WS broadcasts. */
export const getTrackClipsForNode = (nodeId: string) =>
  request<Record<string, unknown>[]>(`/scene-nodes/${nodeId}/track-clips`).then(
    (rows) => rows.map(mapTrackClip)
  );

export const getTrackClipsForLayer = (layerId: string) =>
  request<Record<string, unknown>[]>(
    `/compose-layers/${layerId}/track-clips`
  ).then((rows) => rows.map(mapTrackClip));

export const createTrackClipForNode = (
  nodeId: string,
  body: CreateTrackClipBody
) =>
  request<Record<string, unknown>>(`/scene-nodes/${nodeId}/track-clips`, {
    method: 'POST',
    body: JSON.stringify(body),
  }).then(mapTrackClip);

/** Create a clip owned by a compose layer. */
export const createTrackClipForLayer = (
  layerId: string,
  body: CreateTrackClipBody
) =>
  request<Record<string, unknown>>(`/compose-layers/${layerId}/track-clips`, {
    method: 'POST',
    body: JSON.stringify(body),
  }).then(mapTrackClip);

export const updateTrackClip = (
  id: string,
  patch: {
    name?: string;
    duration?: number;
    loop?: boolean;
    mode?: TrackClipMode;
    autoplay?: boolean;
  }
) =>
  request<Record<string, unknown>>(`/track-clips/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  }).then(mapTrackClip);

export const deleteTrackClip = (id: string) =>
  request<void>(`/track-clips/${id}`, { method: 'DELETE' });

export const createTrackClipLane = (
  clipId: string,
  body: {
    targetKind: TrackClipTargetKind;
    targetId: string;
    paramPath: string;
    defaultValue?: number;
  }
) =>
  request<Record<string, unknown>>(`/track-clips/${clipId}/lanes`, {
    method: 'POST',
    body: JSON.stringify(body),
  }).then(mapTrackClipLane);

export const updateTrackClipLane = (
  id: string,
  patch: {
    targetKind?: TrackClipTargetKind;
    targetId?: string;
    paramPath?: string;
    defaultValue?: number;
  }
) =>
  request<Record<string, unknown>>(`/track-clip-lanes/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  }).then(mapTrackClipLane);

export const deleteTrackClipLane = (id: string) =>
  request<void>(`/track-clip-lanes/${id}`, { method: 'DELETE' });

export const replaceTrackClipKeyframes = (
  laneId: string,
  keyframes: Array<
    Partial<TrackClipKeyframeRecord> & { t: number; value: number }
  >
) =>
  request<{ laneId: string; keyframes: Record<string, unknown>[] }>(
    `/track-clip-lanes/${laneId}/keyframes`,
    {
      method: 'PUT',
      body: JSON.stringify({ keyframes }),
    }
  ).then((r) => ({
    laneId: r.laneId,
    keyframes: r.keyframes.map(mapTrackClipKeyframe),
  }));

export const replaceTrackClipEvents = (
  clipId: string,
  events: Array<
    Partial<TrackClipEventRecord> & {
      t: number;
      action: string;
      targetId: string;
    }
  >
) =>
  request<{ clipId: string; events: Record<string, unknown>[] }>(
    `/track-clips/${clipId}/events`,
    {
      method: 'PUT',
      body: JSON.stringify({ events }),
    }
  ).then((r) => ({
    clipId: r.clipId,
    events: r.events.map(mapTrackClipEvent),
  }));

export const triggerTrackClip = (id: string) =>
  request<void>(`/track-clips/${id}/trigger`, { method: 'POST' });

export const stopTrackClip = (id: string) =>
  request<void>(`/track-clips/${id}/stop`, { method: 'POST' });

export const pauseTrackClip = (id: string) =>
  request<void>(`/track-clips/${id}/pause`, { method: 'POST' });

export const resumeTrackClip = (id: string) =>
  request<void>(`/track-clips/${id}/resume`, { method: 'POST' });

export const seekTrackClip = (id: string, t: number) =>
  request<void>(`/track-clips/${id}/seek`, {
    method: 'POST',
    body: JSON.stringify({ t }),
  });

// System
export const getLocalIps = () =>
  request<{ ips: string[] }>('/system/local-ips').then((d) => d.ips);

/** Returns the uncalibrated NormalizedPose at the body_calibration node's
 *  input for this component.  Bone keys are VRMBoneNames. */
export const getBodyCalibState = (behaviorId: string) =>
  request<{ bones: Record<string, [number, number, number, number]> }>(
    `/behaviors/${behaviorId}/body-calib-state`
  ).then((d) => d.bones);

export const getSignalGraphs = () =>
  request<import('@vspark/shared/signal').GraphDescriptor[]>('/signal/graphs');

export const getSignalNodeKinds = () =>
  request<import('@vspark/shared/signal').NodeKindMeta[]>('/signal/node-kinds');

export interface BehaviorKindMeta {
  kind: string;
  label: string;
  icon: string;
  description: string;
  applicableTo: string[];
  defaultConfig: Record<string, unknown>;
}

export const getBehaviorKinds = () =>
  request<BehaviorKindMeta[]>('/behavior-kinds');

// Update / config
export const getUpdateStatus = () =>
  request<import('@vspark/shared').UpdateStatus>('/update-status');

export const startUpdateDownload = () =>
  request<{ started: boolean }>('/update/download', { method: 'POST' });

export const applyUpdate = () =>
  request<{ ok: boolean }>('/update/apply', { method: 'POST' });

export const getConfig = () =>
  request<import('@vspark/shared').AppConfig>('/config');

export const putConfig = (cfg: Partial<import('@vspark/shared').AppConfig>) =>
  request<import('@vspark/shared').AppConfig>('/config', {
    method: 'PUT',
    body: JSON.stringify(cfg),
  });

export const getSignalGraphStates = (graphId: string) =>
  request<import('@vspark/shared/signal').GraphStateSnapshot>(
    `/signal/graphs/${encodeURIComponent(graphId)}/node-states`
  );

export const fireSignalEvent = (
  graphId: string,
  nodeId: string,
  port: string
) =>
  request<void>(`/signal/graphs/${encodeURIComponent(graphId)}/fire`, {
    method: 'POST',
    body: JSON.stringify({ nodeId, port }),
  });

// ─── Project graphs ──────────────────────────────────────────────────────────

export const getProjectLogic = (projectId: string) =>
  request<LogicRecord[]>(`/projects/${projectId}/logic`);

export const createProjectLogic = (projectId: string, name: string) =>
  request<LogicRecord>(`/projects/${projectId}/logic`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

/** A scene-node- or compose-layer-scoped graph, tagged with its owner's
 *  display name for listing in the Graphs panel's Scoped section. */
export interface ScopedLogicRecord extends LogicRecord {
  ownerName: string;
  ownerNodeKind?: string;
}

export const getProjectScopedLogic = (projectId: string) =>
  request<ScopedLogicRecord[]>(`/projects/${projectId}/scoped-logic`);

// ─── Overlive: app credentials ───────────────────────────────────────────────

export interface OverliveAppCredentialRecord {
  id: string;
  projectId: string;
  label: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  createdAt?: string;
  updatedAt?: string;
}

export const getOverliveAppCredentials = (projectId: string) =>
  request<OverliveAppCredentialRecord[]>(
    `/projects/${projectId}/overlive-app-credentials`
  );

export const createOverliveAppCredential = (
  projectId: string,
  body: {
    label: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }
) =>
  request<OverliveAppCredentialRecord>(
    `/projects/${projectId}/overlive-app-credentials`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );

export const updateOverliveAppCredential = (
  id: string,
  patch: Partial<{
    label: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }>
) =>
  request<OverliveAppCredentialRecord>(`/overlive-app-credentials/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

export const deleteOverliveAppCredential = (id: string) =>
  request<Record<string, never>>(`/overlive-app-credentials/${id}`, {
    method: 'DELETE',
  });

export const copyOverliveAppCredentialsFromProject = (
  projectId: string,
  sourceProjectId: string
) =>
  request<OverliveAppCredentialRecord[]>(
    `/projects/${projectId}/overlive-app-credentials/copy-from/${sourceProjectId}`,
    { method: 'POST' }
  );

// ─── Overlive: login accounts ────────────────────────────────────────────────

export type OverlivePlatform = 'twitch' | 'streamelements';
export type OverliveAccountStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'reconnecting'
  | 'error'
  | 'needs_reauth';

export interface OverliveAccountRecord {
  id: string;
  projectId: string;
  platform: OverlivePlatform;
  label: string;
  appCredentialId: string | null;
  credentials: Record<string, unknown>;
  broadcasterId: string | null;
  broadcasterLogin: string | null;
  status: OverliveAccountStatus;
  statusReason: string | null;
  statusMessage: string | null;
  /** Exactly one account per project is the default. Overlive signal nodes
   *  with an empty `account` config fall back to this. */
  isDefault?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const getOverliveAccounts = (projectId: string) =>
  request<OverliveAccountRecord[]>(`/projects/${projectId}/overlive-accounts`);

export const createOverliveAccount = (
  projectId: string,
  body: {
    platform: OverlivePlatform;
    label: string;
    appCredentialId?: string | null;
    credentials?: Record<string, unknown>;
    broadcasterId?: string;
    broadcasterLogin?: string;
  }
) =>
  request<OverliveAccountRecord>(`/projects/${projectId}/overlive-accounts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const updateOverliveAccount = (
  id: string,
  patch: Partial<{
    label: string;
    credentials: Record<string, unknown>;
    broadcasterId: string | null;
    broadcasterLogin: string | null;
    status: OverliveAccountStatus;
    statusReason: string | null;
    statusMessage: string | null;
  }>
) =>
  request<OverliveAccountRecord>(`/overlive-accounts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

export const deleteOverliveAccount = (id: string) =>
  request<Record<string, never>>(`/overlive-accounts/${id}`, {
    method: 'DELETE',
  });

/** Mark this account as the project's default. Clears the flag on every
 *  other account in the same project atomically. */
export const setDefaultOverliveAccount = (id: string) =>
  request<OverliveAccountRecord>(`/overlive-accounts/${id}/set-default`, {
    method: 'POST',
  });

// ─── Overlive: OAuth (Twitch) ────────────────────────────────────────────────

/**
 * Fetch the Twitch authorize URL the user's browser should navigate to.
 * The caller is expected to open the URL in a popup; the OAuth callback
 * server-side renders an HTML page that posts a message back to
 * `window.opener` and closes the popup.
 *
 * Pass `accountId` to enter the reconnect flow (updates an existing row
 * in place instead of inserting). Otherwise a new account row is created.
 */
export const startTwitchOAuth = (params: {
  projectId: string;
  appCredentialId: string;
  accountId?: string;
}) => {
  const qs = new URLSearchParams({
    projectId: params.projectId,
    appCredentialId: params.appCredentialId,
    ...(params.accountId ? { accountId: params.accountId } : {}),
  });
  return request<{ authorizeUrl: string }>(
    `/auth/twitch/start?${qs.toString()}`
  );
};

// ─── Presets ─────────────────────────────────────────────────────────────────

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

export interface PresetRecord extends PresetSummary {
  payload: unknown;
}

export interface LogicRecord {
  id: string;
  ownerKind: string;
  ownerId: string;
  name: string;
  enabled: boolean;
  descriptor: import('@vspark/shared/signal').GraphDescriptor;
  createdAt?: string;
  updatedAt?: string;
}

export const getPresets = (projectId: string) =>
  request<PresetSummary[]>(`/projects/${projectId}/presets`);

export const createPreset = (
  projectId: string,
  body: {
    name: string;
    description?: string;
    rootKind: string;
    rootId: string;
    embedAssets?: boolean;
  }
) =>
  request<PresetRecord>(`/projects/${projectId}/presets`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const getPreset = (id: string) =>
  request<PresetRecord>(`/presets/${id}`);

export interface BuiltinPresetSummary {
  id: string;
  name: string;
  description: string;
  rootKind: 'scene_node' | 'compose_layer';
  builtin: true;
}

export const getBuiltinPresets = () =>
  request<BuiltinPresetSummary[]>(`/presets/builtin`);

export const getBuiltinPreset = (id: string) =>
  request<BuiltinPresetSummary & { payload: unknown }>(
    `/presets/builtin/${id}`
  );

export const deletePreset = (id: string) =>
  request<void>(`/presets/${id}`, { method: 'DELETE' });

export const serializePreset = (
  rootKind: string,
  rootId: string,
  embedAssets?: boolean
) =>
  request<unknown>(`/presets/serialize`, {
    method: 'POST',
    body: JSON.stringify({ rootKind, rootId, embedAssets }),
  });

export const instantiatePreset = (
  payload: unknown,
  projectId: string,
  rootSceneNodeId: string,
  rootComposeSceneId?: string | null,
  parentId?: string | null,
  /** Optional: when set and rootKind = 'scene_node', the inserted root gets
   *  bone_attachment = this bone name. Used by the editor's "paste node
   *  onto bone" path. */
  boneAttachment?: string | null
) =>
  request<{
    rootId: string;
    idMap: Record<string, string>;
    missingAssets: string[];
  }>(`/presets/instantiate`, {
    method: 'POST',
    body: JSON.stringify({
      payload,
      projectId,
      rootSceneNodeId,
      rootComposeSceneId,
      parentId,
      boneAttachment,
    }),
  });

// ─── Graphs (node/layer scoped) ─────────────────────────────────────────────

/** Generic graph fetch by id — works for any owner kind. Used by the canvas
 *  so it can open a graph without first knowing its scope. */
export const getLogic = (id: string) => request<LogicRecord>(`/logic/${id}`);

export const getNodeLogic = (nodeId: string) =>
  request<LogicRecord[]>(`/scene-nodes/${nodeId}/logic`);

export const createNodeLogic = (nodeId: string, name: string) =>
  request<LogicRecord>(`/scene-nodes/${nodeId}/logic`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

export const getLayerLogic = (layerId: string) =>
  request<LogicRecord[]>(`/compose-layers/${layerId}/logic`);

export const createLayerLogic = (layerId: string, name: string) =>
  request<LogicRecord>(`/compose-layers/${layerId}/logic`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

export const updateLogic = (
  id: string,
  patch: Partial<{
    name: string;
    enabled: boolean;
    descriptor: import('@vspark/shared/signal').GraphDescriptor;
  }>
) =>
  request<LogicRecord>(`/logic/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

export const deleteLogic = (id: string) =>
  request<Record<string, never>>(`/logic/${id}`, { method: 'DELETE' });

export const api = {
  getUpdateStatus,
  startUpdateDownload,
  applyUpdate,
  getConfig,
  putConfig,
  getProjects,
  createProject,
  deleteProject,
  updateProject,
  getScenes,
  createScene,
  updateScene,
  deleteScene,
  getNodes,
  createNode,
  updateNode,
  deleteNode,
  getAssets,
  uploadAsset,
  deleteAsset,
  createBehavior,
  updateBehavior,
  deleteBehavior,
  createCameraEffect,
  updateCameraEffect,
  deleteCameraEffect,
  updateComposeLayer,
  deleteComposeLayer,
  reorderComposeLayers,
  getComposeScenes,
  createComposeScene,
  getComposeSceneLayers,
  createComposeSceneLayer,
  getTrackClipsForNode,
  getTrackClipsForLayer,
  createTrackClipForNode,
  createTrackClipForLayer,
  updateTrackClip,
  deleteTrackClip,
  createTrackClipLane,
  updateTrackClipLane,
  deleteTrackClipLane,
  replaceTrackClipKeyframes,
  replaceTrackClipEvents,
  triggerTrackClip,
  stopTrackClip,
  pauseTrackClip,
  resumeTrackClip,
  seekTrackClip,
  getLocalIps,
  getBodyCalibState,
  getSignalGraphs,
  getSignalNodeKinds,
  getSignalGraphStates,
  fireSignalEvent,
  getBehaviorKinds,
  getProjectLogic,
  createProjectLogic,
  getProjectScopedLogic,
  getOverliveAppCredentials,
  createOverliveAppCredential,
  updateOverliveAppCredential,
  deleteOverliveAppCredential,
  copyOverliveAppCredentialsFromProject,
  getOverliveAccounts,
  createOverliveAccount,
  updateOverliveAccount,
  deleteOverliveAccount,
  setDefaultOverliveAccount,
  startTwitchOAuth,
  getPresets,
  createPreset,
  getPreset,
  getBuiltinPresets,
  getBuiltinPreset,
  deletePreset,
  serializePreset,
  instantiatePreset,
  getLogic,
  getNodeLogic,
  createNodeLogic,
  getLayerLogic,
  createLayerLogic,
  updateLogic,
  deleteLogic,
};

// --- Multiplayer / connections (Phase 5) -----------------------------------

export interface ConnectionIdentity {
  peerId: string;
  publicKey: string;
}
export interface ConnectionStatus {
  enabled: boolean;
  status: 'idle' | 'connecting' | 'ready' | 'closed';
  peerId: string | null;
  connected: string[];
}
export interface ConnectionPeer {
  peerId: string;
  publicKey: string;
  displayName: string;
  pairedAt: string;
  lastSeen: string | null;
  blocked: boolean;
  sessionGranted: boolean;
  connected: boolean;
}

export const getConnectionIdentity = () =>
  request<ConnectionIdentity>('/connections/identity');
export const getConnectionStatus = () =>
  request<ConnectionStatus>('/connections/status');
export const getConnectionPeers = () =>
  request<ConnectionPeer[]>('/connections/peers');
export const pairCreate = () =>
  request<{ code: string }>('/connections/pair/create', { method: 'POST' });
export const pairJoin = (code: string) =>
  request<ConnectionPeer>('/connections/pair/join', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
export const peerConnect = (peerId: string) =>
  request<{ peerId: string }>(`/connections/peers/${peerId}/connect`, {
    method: 'POST',
  });
export const peerDisconnect = (peerId: string) =>
  request<{ peerId: string }>(`/connections/peers/${peerId}/disconnect`, {
    method: 'POST',
  });
export const peerAccept = (peerId: string) =>
  request<{ peerId: string }>(`/connections/peers/${peerId}/accept`, {
    method: 'POST',
  });
export const peerReject = (peerId: string) =>
  request<{ peerId: string }>(`/connections/peers/${peerId}/reject`, {
    method: 'POST',
  });
export const peerUpdate = (
  peerId: string,
  patch: { displayName?: string; blocked?: boolean }
) =>
  request<ConnectionPeer>(`/connections/peers/${peerId}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
export const peerRemove = (peerId: string) =>
  request<{ peerId: string }>(`/connections/peers/${peerId}`, {
    method: 'DELETE',
  });

export const getConnectionDisplayName = (projectId: string) =>
  request<{ displayName: string }>(`/connections/display-name/${projectId}`);
export const setConnectionDisplayName = (projectId: string, name: string) =>
  request<{ displayName: string }>(`/connections/display-name/${projectId}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  });

// --- object sharing --------------------------------------------------------

/** Peer ids (and maybe '*') an object is currently shared with. */
export const getObjectGrantees = (objectId: string) =>
  request<string[]>(`/connections/objects/${objectId}/grantees`);
/** Grant a peer ('*' = everyone) access to one of my objects. */
export const shareObject = (
  objectId: string,
  granteePeerId: string,
  shareKind: 'object' | 'scene' = 'object'
) =>
  request<{ grantees: string[] }>(`/connections/objects/${objectId}/share`, {
    method: 'POST',
    body: JSON.stringify({ granteePeerId, shareKind }),
  });
/** Revoke a peer's ('*' = everyone) access to one of my objects. */
export const unshareObject = (objectId: string, granteePeerId: string) =>
  request<{ grantees: string[] }>(`/connections/objects/${objectId}/unshare`, {
    method: 'POST',
    body: JSON.stringify({ granteePeerId }),
  });
/** Receiver: subscribe to (place) a peer's shared object. */
export const peerSubscribe = (peerId: string, objectId: string) =>
  request<{ peerId: string; objectId: string }>(
    `/connections/peers/${peerId}/subscribe`,
    { method: 'POST', body: JSON.stringify({ objectId }) }
  );
/** Receiver: unsubscribe from (remove) a peer's shared object. */
export const peerUnsubscribe = (peerId: string, objectId: string) =>
  request<{ peerId: string; objectId: string }>(
    `/connections/peers/${peerId}/unsubscribe`,
    { method: 'POST', body: JSON.stringify({ objectId }) }
  );
