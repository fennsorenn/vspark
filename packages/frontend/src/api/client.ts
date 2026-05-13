const BASE = 'http://localhost:3001/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.error?.message ?? 'API error')
  return json.data as T
}

// snake_case → camelCase for rows coming out of SQLite
function mapNode(r: Record<string, unknown>, sceneId?: string): NodeRecord {
  const components = typeof r.components === 'string'
    ? JSON.parse(r.components as string)
    : (r.components ?? {})
  return {
    id: r.id as string,
    // backend may return snake_case (from SQLite rows) or camelCase (from INSERT response)
    sceneId: (r.scene_id ?? r.sceneId ?? sceneId ?? '') as string,
    parentId: (r.parent_id ?? r.parentId ?? null) as string | null,
    name: r.name as string,
    kind: r.kind as string,
    filePath: (r.file_path ?? r.filePath ?? null) as string | null,
    components,
  }
}

function mapScene(r: Record<string, unknown>): SceneItem {
  return {
    id: r.id as string,
    name: r.name as string,
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
    url: `http://localhost:3001${r.stored_path}`,
    mimeType: (r.mime_type ?? '') as string,
    kind: guessAssetKind((r.original_name as string) ?? ''),
  }
}

function guessAssetKind(name: string): 'model' | 'animation' {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['fbx', 'bvh'].includes(ext)) return 'animation'
  return 'model'
}

export interface Project {
  id: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
}

export interface SceneItem {
  id: string
  name: string
}

export interface NodeRecord {
  id: string
  sceneId: string
  parentId: string | null
  name: string
  kind: string
  filePath?: string | null
  components: Record<string, unknown>
}

export interface AssetFile {
  id: string
  projectId: string
  name: string
  storedPath: string
  url: string
  mimeType: string
  kind: 'model' | 'animation'
}

export interface NodeComponentRecord {
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

// Scenes — backend returns { scenes: [], nodes: [], nodeComponents: [] }
export const getScenes = (projectId: string) =>
  request<{ scenes: Record<string, unknown>[]; nodes: Record<string, unknown>[]; nodeComponents?: Record<string, unknown>[] }>(
    `/projects/${projectId}/scenes`
  ).then(({ scenes, nodes, nodeComponents }) => ({
    scenes: scenes.map(mapScene),
    nodes: nodes.map((n) => mapNode(n)),
    nodeComponents: (nodeComponents ?? []).map(mapNodeComponent),
  }))

export const createScene = (projectId: string, name: string) =>
  request<Record<string, unknown>>(`/projects/${projectId}/scenes`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  }).then(mapScene)

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
      filePath: data.filePath,
      components: data.components,
    }),
  }).then((r) => mapNode(r, sceneId))

export const updateNode = (id: string, data: Partial<Omit<NodeRecord, 'id' | 'sceneId'>>) =>
  request<void>(`/scene-nodes/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: data.name,
      parentId: data.parentId,
      kind: data.kind,
      filePath: data.filePath,
      components: data.components,
    }),
  })

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
  getLocalIps,
  getBodyCalibState,
  getSignalGraphs,
  getSignalNodeKinds,
  getSignalGraphStates,
  fireSignalEvent,
}
