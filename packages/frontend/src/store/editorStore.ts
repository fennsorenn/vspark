import { create } from 'zustand'
import type { AssetFile } from '../api/client'

export type { AssetFile }

export interface NodeRecord {
  id: string
  sceneId: string
  parentId: string | null
  name: string
  kind: string
  filePath?: string | null
  components: Record<string, unknown>
}

export interface SceneItem {
  id: string
  name: string
}

export interface NodeComponent {
  id: string
  nodeId: string
  kind: string
  enabled: boolean
  config: Record<string, unknown>
}

let _compSeq = 0
export const newComponentId = () => `comp-${++_compSeq}-${Date.now()}`

interface EditorState {
  projectId: string | null
  projectName: string
  scenes: SceneItem[]
  activeSceneId: string | null
  nodes: NodeRecord[]
  selectedNodeId: string | null
  selectedComponentId: string | null
  assets: AssetFile[]
  nodeComponents: NodeComponent[]
  vmcStatus: Record<string, boolean>   // componentId → connected
  vmcTracking: Record<string, boolean>  // componentId → tracking active
  vrmBonesByNode: Record<string, string[]>        // nodeId → VRM humanoid bone names
  vrmExpressionsByNode: Record<string, string[]>   // nodeId → VRM expression names
  vrmMorphTargetsByNode: Record<string, string[]>  // nodeId → mesh morph target names
  hoveredBoneName: string | null
  activeGraphId: string | null
  selectedSignalNodeId: string | null
  boneListExpanded: Record<string, boolean>   // nodeId → bone list open in SceneGraph
  fbxDebugVisible: Record<string, boolean>    // nodeId → FBX debug model shown

  // Actions
  setProject: (id: string, name: string) => void
  setScenes: (scenes: SceneItem[]) => void
  setActiveScene: (id: string | null) => void
  setNodes: (nodes: NodeRecord[]) => void
  addNode: (node: NodeRecord) => void
  updateNode: (id: string, updates: Partial<NodeRecord>) => void
  deleteNode: (id: string) => void
  selectNode: (id: string | null) => void
  selectComponent: (id: string | null) => void
  setAssets: (assets: AssetFile[]) => void
  addAsset: (asset: AssetFile) => void
  deleteAsset: (id: string) => void
  activeSceneNodes: () => NodeRecord[]
  setNodeComponents: (comps: NodeComponent[]) => void
  addNodeComponent: (comp: NodeComponent) => void
  updateNodeComponent: (id: string, updates: Partial<Omit<NodeComponent, 'id' | 'nodeId'>>) => void
  removeNodeComponent: (id: string) => void
  nodeComponentsFor: (nodeId: string) => NodeComponent[]
  setVmcStatus: (componentId: string, connected: boolean) => void
  setVmcTracking: (componentId: string, tracking: boolean) => void
  setVrmBonesForNode: (nodeId: string, bones: string[]) => void
  clearVrmBonesForNode: (nodeId: string) => void
  setVrmExpressionsForNode: (nodeId: string, expressions: string[]) => void
  clearVrmExpressionsForNode: (nodeId: string) => void
  setVrmMorphTargetsForNode: (nodeId: string, names: string[]) => void
  clearVrmMorphTargetsForNode: (nodeId: string) => void
  setHoveredBone: (name: string | null) => void
  setActiveGraph: (id: string | null) => void
  setSelectedSignalNode: (id: string | null) => void
  setBoneListExpanded: (nodeId: string, expanded: boolean) => void
  setFbxDebugVisible: (nodeId: string, visible: boolean) => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
  projectId: null,
  projectName: '',
  scenes: [],
  activeSceneId: null,
  nodes: [],
  selectedNodeId: null,
  selectedComponentId: null,
  assets: [],
  nodeComponents: [],
  vmcStatus: {},
  vmcTracking: {},
  vrmBonesByNode: {},
  vrmExpressionsByNode: {},
  vrmMorphTargetsByNode: {},
  hoveredBoneName: null,
  activeGraphId: null,
  selectedSignalNodeId: null,
  boneListExpanded: {},
  fbxDebugVisible: {},

  setProject: (id, name) => set({ projectId: id, projectName: name }),
  setScenes: (scenes) => set({ scenes }),
  setActiveScene: (id) => set({ activeSceneId: id }),
  setNodes: (nodes) => set({ nodes }),
  addNode: (node) => set((s) => ({ nodes: [...s.nodes, node] })),
  updateNode: (id, updates) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...updates } : n)),
    })),
  deleteNode: (id) =>
    set((s) => {
      const removedComps = new Set(s.nodeComponents.filter((c) => c.nodeId === id).map((c) => c.id))
      return {
        nodes: s.nodes.filter((n) => n.id !== id),
        selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        selectedComponentId: removedComps.has(s.selectedComponentId ?? '') ? null : s.selectedComponentId,
        nodeComponents: s.nodeComponents.filter((c) => c.nodeId !== id),
      }
    }),
  selectNode: (id) => set({ selectedNodeId: id, selectedComponentId: null }),
  selectComponent: (id) => set({ selectedComponentId: id }),
  setAssets: (assets) => set({ assets }),
  addAsset: (asset) => set((s) => ({ assets: [...s.assets, asset] })),
  deleteAsset: (id) => set((s) => ({ assets: s.assets.filter((a) => a.id !== id) })),
  activeSceneNodes: () => {
    const { nodes, activeSceneId } = get()
    return nodes.filter((n) => n.sceneId === activeSceneId)
  },
  setNodeComponents: (comps) => set({ nodeComponents: comps }),
  addNodeComponent: (comp) => set((s) => ({ nodeComponents: [...s.nodeComponents, comp] })),
  updateNodeComponent: (id, updates) =>
    set((s) => ({
      nodeComponents: s.nodeComponents.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    })),
  removeNodeComponent: (id) =>
    set((s) => ({
      nodeComponents: s.nodeComponents.filter((c) => c.id !== id),
      selectedComponentId: s.selectedComponentId === id ? null : s.selectedComponentId,
    })),
  nodeComponentsFor: (nodeId) => get().nodeComponents.filter((c) => c.nodeId === nodeId),
  setVmcStatus: (componentId, connected) =>
    set((s) => ({ vmcStatus: { ...s.vmcStatus, [componentId]: connected } })),
  setVmcTracking: (componentId, tracking) =>
    set((s) => ({ vmcTracking: { ...s.vmcTracking, [componentId]: tracking } })),
  setVrmBonesForNode: (nodeId, bones) =>
    set((s) => ({ vrmBonesByNode: { ...s.vrmBonesByNode, [nodeId]: bones } })),
  clearVrmBonesForNode: (nodeId) =>
    set((s) => {
      const next = { ...s.vrmBonesByNode }
      delete next[nodeId]
      return { vrmBonesByNode: next }
    }),
  setVrmExpressionsForNode: (nodeId, expressions) =>
    set((s) => ({ vrmExpressionsByNode: { ...s.vrmExpressionsByNode, [nodeId]: expressions } })),
  clearVrmExpressionsForNode: (nodeId) =>
    set((s) => {
      const next = { ...s.vrmExpressionsByNode }
      delete next[nodeId]
      return { vrmExpressionsByNode: next }
    }),
  setVrmMorphTargetsForNode: (nodeId, names) =>
    set((s) => ({ vrmMorphTargetsByNode: { ...s.vrmMorphTargetsByNode, [nodeId]: names } })),
  clearVrmMorphTargetsForNode: (nodeId) =>
    set((s) => {
      const next = { ...s.vrmMorphTargetsByNode }
      delete next[nodeId]
      return { vrmMorphTargetsByNode: next }
    }),
  setHoveredBone: (name) => set({ hoveredBoneName: name }),
  setActiveGraph: (id) => set({ activeGraphId: id, selectedSignalNodeId: null }),
  setSelectedSignalNode: (id) => set({ selectedSignalNodeId: id }),
  setBoneListExpanded: (nodeId, expanded) =>
    set((s) => ({ boneListExpanded: { ...s.boneListExpanded, [nodeId]: expanded } })),
  setFbxDebugVisible: (nodeId, visible) =>
    set((s) => ({ fbxDebugVisible: { ...s.fbxDebugVisible, [nodeId]: visible } })),
}))
