const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.error?.message ?? 'API error')
  return json.data as T
}

// Strip legacy absolute backend origin from stored paths so they route through the Vite proxy.
function normalizeFilePath(raw: unknown): string | null {
  if (!raw) return null
  let s = raw as string
  try {
    const u = new URL(s)
    // If it points to localhost (any port), keep only the path so it routes via proxy.
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') s = u.pathname + u.search
  } catch { /* not an absolute URL — already relative, keep as-is */ }
  return s
}

// snake_case → camelCase for rows coming out of SQLite
function mapNode(r: Record<string, unknown>, sceneId?: string): NodeRecord {
  const components = typeof r.components === 'string'
    ? JSON.parse(r.components as string)
    : (r.components ?? {})
  // Normalize any localhost URLs nested inside component blobs (e.g. animation.idleUrl)
  if (components.animation && typeof (components.animation as Record<string, unknown>).idleUrl === 'string') {
    (components.animation as Record<string, unknown>).idleUrl =
      normalizeFilePath((components.animation as Record<string, unknown>).idleUrl)
  }
  return {
    id: r.id as string,
    // backend may return snake_case (from SQLite rows) or camelCase (from INSERT response)
    sceneId: (r.scene_id ?? r.sceneId ?? sceneId ?? '') as string,
    parentId: (r.parent_id ?? r.parentId ?? null) as string | null,
    boneAttachment: (r.bone_attachment ?? r.boneAttachment ?? null) as string | null,
    name: r.name as string,
    kind: r.kind as string,
    filePath: normalizeFilePath(r.file_path ?? r.filePath),
    components,
    hidden: Boolean(r.hidden),
  }
}

function mapScene(r: Record<string, unknown>): SceneItem {
  const raw = (r.runtime_settings ?? r.runtimeSettings ?? '{}') as string | Record<string, unknown>
  let runtimeSettings: SceneRuntimeSettings = {}
  if (typeof raw === 'string') {
    try { runtimeSettings = JSON.parse(raw || '{}') as SceneRuntimeSettings } catch { /* keep default */ }
  } else {
    runtimeSettings = raw as SceneRuntimeSettings
  }
  return {
    id: r.id as string,
    name: r.name as string,
    runtimeSettings,
  }
}

function mapProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description ?? undefined) as string | undefined,
    createdAt: (r.created_at ?? '') as string,
    updatedAt: (r.updated_at ?? '') as string,
  }
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
  }
}

function guessAssetKind(name: string): 'model' | 'animation' | 'image' {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['fbx', 'bvh'].includes(ext)) return 'animation'
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext)) return 'image'
  return 'model'
}

export interface Project {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
}

export interface SceneRuntimeSettings {
  /** Broadcast Bus tick rate in Hz. Defaults to 60 when undefined. */
  broadcastTickHz?: number
}

export interface SceneItem {
  id: string
  name: string
  runtimeSettings: SceneRuntimeSettings
}

export interface NodeRecord {
  id: string
  sceneId: string
  parentId: string | null
  boneAttachment?: string | null
  name: string
  kind: string
  filePath?: string | null
  components: Record<string, unknown>
  hidden?: boolean
}

export interface AssetFile {
  id: string
  projectId: string
  name: string
  storedPath: string
  url: string
  mimeType: string
  kind: 'model' | 'animation' | 'image'
}

export interface NodeComponentRecord {
  id: string
  nodeId: string
  kind: string
  enabled: boolean
  config: Record<string, unknown>
}

export interface CameraEffectRecord {
  id: string
  nodeId: string
  kind: string
  enabled: boolean
  config: Record<string, unknown>
}

// Projects
export const getProjects = () =>
  request<Record<string, unknown>[]>('/projects').then((rows) => rows.map(mapProject))

export const createProject = (name: string, description?: string) =>
  request<Record<string, unknown>>('/projects', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  }).then(mapProject)

export const deleteProject = (id: string) =>
  request<void>(`/projects/${id}`, { method: 'DELETE' })

export const updateProject = (id: string, name: string, description?: string) =>
  request<void>(`/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, description }),
  })

function mapNodeComponent(r: Record<string, unknown>): NodeComponentRecord {
  return {
    id: r.id as string,
    nodeId: (r.node_id ?? r.nodeId ?? '') as string,
    kind: r.kind as string,
    enabled: Boolean(r.enabled),
    config: typeof r.config === 'string' ? JSON.parse(r.config) : (r.config ?? {}),
  }
}

function mapCameraEffect(r: Record<string, unknown>): CameraEffectRecord {
  return {
    id: r.id as string,
    nodeId: (r.node_id ?? r.nodeId ?? '') as string,
    kind: r.kind as string,
    enabled: Boolean(r.enabled),
    config: typeof r.config === 'string' ? JSON.parse(r.config) : (r.config ?? {}),
  }
}

// Scenes — backend returns { scenes: [], nodes: [], nodeComponents: [], cameraEffects: [] }
export const getScenes = (projectId: string) =>
  request<{ scenes: Record<string, unknown>[]; nodes: Record<string, unknown>[]; nodeComponents?: Record<string, unknown>[]; cameraEffects?: Record<string, unknown>[] }>(
    `/projects/${projectId}/scenes`
  ).then(({ scenes, nodes, nodeComponents, cameraEffects }) => ({
    scenes: scenes.map(mapScene),
    nodes: nodes.map((n) => mapNode(n)),
    nodeComponents: (nodeComponents ?? []).map(mapNodeComponent),
    cameraEffects: (cameraEffects ?? []).map(mapCameraEffect),
  }))

export const createScene = (projectId: string, name: string) =>
  request<Record<string, unknown>>(`/projects/${projectId}/scenes`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  }).then(mapScene)

export const updateScene = (
  sceneId: string,
  patch:   { name?: string; runtimeSettings?: SceneRuntimeSettings },
) =>
  request<Record<string, unknown>>(`/scenes/${sceneId}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })

// Nodes
export const getNodes = (sceneId: string) =>
  request<Record<string, unknown>[]>(`/scenes/${sceneId}/nodes`).then((rows) =>
    rows.map((r) => mapNode(r, sceneId))
  )

export const createNode = (sceneId: string, data: Omit<NodeRecord, 'id' | 'sceneId'>) =>
  request<Record<string, unknown>>(`/scenes/${sceneId}/nodes`, {
    method: 'POST',
    body: JSON.stringify({
      name: data.name,
      kind: data.kind,
      parentId: data.parentId,
      boneAttachment: data.boneAttachment,
      filePath: data.filePath,
      components: data.components,
    }),
  }).then((r) => mapNode(r, sceneId))

export const updateNode = (id: string, data: Partial<Omit<NodeRecord, 'id' | 'sceneId'>>) => {
  const body: Record<string, unknown> = {}
  if (data.name      !== undefined) body.name       = data.name
  if (data.parentId  !== undefined) body.parentId   = data.parentId
  if (data.kind      !== undefined) body.kind       = data.kind
  if (data.filePath  !== undefined) body.filePath   = data.filePath
  if (data.components !== undefined) body.components = data.components
  // boneAttachment must be sent explicitly even when null (to support detach)
  if ('boneAttachment' in data) body.boneAttachment = data.boneAttachment ?? null
  if ('hidden' in data) body.hidden = data.hidden ?? false
  return request<void>(`/scene-nodes/${id}`, { method: 'PUT', body: JSON.stringify(body) })
}

export const deleteNode = (id: string) =>
  request<void>(`/scene-nodes/${id}`, { method: 'DELETE' })

// Assets
export const getAssets = (projectId: string) =>
  request<Record<string, unknown>[]>(`/projects/${projectId}/assets`).then((rows) =>
    rows.map(mapAsset)
  )

export const uploadAsset = (projectId: string, file: File) =>
  new Promise<AssetFile>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1]
      try {
        const row = await request<Record<string, unknown>>(`/projects/${projectId}/assets`, {
          method: 'POST',
          body: JSON.stringify({ name: file.name, mimeType: file.type, data: base64 }),
        })
        resolve(mapAsset(row))
      } catch (e) {
        reject(e)
      }
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

export const deleteAsset = (id: string) =>
  request<void>(`/assets/${id}`, { method: 'DELETE' })

// Node Components
export const createNodeComponent = (nodeId: string, comp: Omit<NodeComponentRecord, 'nodeId'>) =>
  request<Record<string, unknown>>(`/scene-nodes/${nodeId}/components`, {
    method: 'POST',
    body: JSON.stringify({ id: comp.id, kind: comp.kind, enabled: comp.enabled, config: comp.config }),
  }).then(mapNodeComponent)

export const updateNodeComponent = (id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) =>
  request<void>(`/node-components/${id}`, { method: 'PUT', body: JSON.stringify(patch) })

export const deleteNodeComponent = (id: string) =>
  request<void>(`/node-components/${id}`, { method: 'DELETE' })

// Camera Effects
export const createCameraEffect = (nodeId: string, effect: Omit<CameraEffectRecord, 'nodeId'>) =>
  request<Record<string, unknown>>(`/scene-nodes/${nodeId}/effects`, {
    method: 'POST',
    body: JSON.stringify({ id: effect.id, kind: effect.kind, enabled: effect.enabled, config: effect.config }),
  }).then(mapCameraEffect)

export const updateCameraEffect = (id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) =>
  request<void>(`/camera-effects/${id}`, { method: 'PUT', body: JSON.stringify(patch) })

export const deleteCameraEffect = (id: string) =>
  request<void>(`/camera-effects/${id}`, { method: 'DELETE' })

// System
export const getLocalIps = () =>
  request<{ ips: string[] }>('/system/local-ips').then((d) => d.ips)

/** Returns the uncalibrated NormalizedPose at the body_calibration node's
 *  input for this component.  Bone keys are VRMBoneNames. */
export const getBodyCalibState = (componentId: string) =>
  request<{ bones: Record<string, [number, number, number, number]> }>(
    `/node-components/${componentId}/body-calib-state`,
  ).then((d) => d.bones)

export const getSignalGraphs = () =>
  request<import('@vspark/shared/signal').GraphDescriptor[]>('/signal/graphs')

export const getSignalNodeKinds = () =>
  request<import('@vspark/shared/signal').NodeKindMeta[]>('/signal/node-kinds')

export interface ComponentKindMeta {
  kind:          string
  label:         string
  icon:          string
  description:   string
  applicableTo:  string[]
  defaultConfig: Record<string, unknown>
}

export const getComponentKinds = () =>
  request<ComponentKindMeta[]>('/component-kinds')

// Update / config
export const getUpdateStatus = () =>
  request<import('@vspark/shared').UpdateStatus>('/update-status')

export const startUpdateDownload = () =>
  request<{ started: boolean }>('/update/download', { method: 'POST' })

export const applyUpdate = () =>
  request<{ ok: boolean }>('/update/apply', { method: 'POST' })

export const getConfig = () =>
  request<import('@vspark/shared').AppConfig>('/config')

export const putConfig = (cfg: Partial<import('@vspark/shared').AppConfig>) =>
  request<import('@vspark/shared').AppConfig>('/config', { method: 'PUT', body: JSON.stringify(cfg) })

export const getSignalGraphStates = (graphId: string) =>
  request<import('@vspark/shared/signal').GraphStateSnapshot>(
    `/signal/graphs/${encodeURIComponent(graphId)}/node-states`,
  )

export const fireSignalEvent = (graphId: string, nodeId: string, port: string) =>
  request<void>(`/signal/graphs/${encodeURIComponent(graphId)}/fire`, {
    method: 'POST',
    body: JSON.stringify({ nodeId, port }),
  })

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
  getNodes,
  createNode,
  updateNode,
  deleteNode,
  getAssets,
  uploadAsset,
  deleteAsset,
  createNodeComponent,
  updateNodeComponent,
  deleteNodeComponent,
  createCameraEffect,
  updateCameraEffect,
  deleteCameraEffect,
  getLocalIps,
  getBodyCalibState,
  getSignalGraphs,
  getSignalNodeKinds,
  getSignalGraphStates,
  fireSignalEvent,
  getComponentKinds,
}
