import { create } from 'zustand'
import type { AssetFile, ComponentKindMeta, CameraEffectRecord } from '../api/client'
import type { UpdateChannel } from '@vspark/shared'

export type { AssetFile, ComponentKindMeta, CameraEffectRecord }

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

export interface SceneRuntimeSettings {
  broadcastTickHz?: number
}

export interface SceneItem {
  id: string
  name: string
  runtimeSettings: SceneRuntimeSettings
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

export interface CameraEffectKind {
  kind: string
  label: string
  icon: string
  description: string
  defaultConfig: Record<string, unknown>
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
    defaultConfig: { intensity: 1.0, luminanceThreshold: 0.9, luminanceSmoothing: 0.025, mipmapBlur: true },
  },
  {
    kind: 'fx_depth_of_field',
    label: 'Depth of Field',
    icon: '📷',
    description: 'Bokeh blur outside the focal plane',
    defaultConfig: {
      worldFocusDistance: 3, worldFocusRange: 2, bokehScale: 2,
      autofocus: false,
      afMode: 'point',        // 'point' | 'percentile'
      afPointX: 0.5, afPointY: 0.5,
      afPercentile: 15,
      afSpeed: 4,             // convergence speed (higher = faster)
      afDelay: 0.2,           // seconds before AF starts moving
      afOvershoot: 0.15,      // fraction of delta to overshoot by
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
    defaultConfig: { intensity: 1.5, radius: 0.2, bias: 0.025, rings: 4, samples: 30 },
  },
  // --- Stylization ---
  {
    kind: 'fx_outline',
    label: 'Edge Outline',
    icon: '🖊',
    description: 'Depth-buffer edge detection outlines',
    defaultConfig: { color: '#000000', threshold: 0.001, thickness: 1.0, alpha: 1.0, normalStrength: 1.0, blendMode: 'NORMAL' },
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
    defaultConfig: { characters: ' .:-+*=%@#', fontSize: 54, cellSize: 16, color: '#ffffff', invert: false },
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
    defaultConfig: { delay: [1.5, 3.5], duration: [0.06, 0.3], strength: [0.3, 1.0], columns: 0.05, ratio: 0.85 },
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
]

interface EditorState {
  projectId: string | null
  projectName: string
  scenes: SceneItem[]
  activeSceneId: string | null
  nodes: NodeRecord[]
  selectedNodeId: string | null
  sceneSelected: boolean
  selectedComponentId: string | null
  assets: AssetFile[]
  nodeComponents: NodeComponent[]
  vmcStatus: Record<string, boolean>   // componentId → connected
  vmcTracking: Record<string, boolean>  // componentId → tracking active
  vrmBonesByNode: Record<string, string[]>        // nodeId → VRM humanoid bone names
  vrmExpressionsByNode: Record<string, string[]>   // nodeId → VRM expression names
  vrmMorphTargetsByNode: Record<string, string[]>  // nodeId → mesh morph target names
  hoveredBoneName: string | null
  componentKinds: ComponentKindMeta[]
  activeGraphId: string | null
  selectedSignalNodeId: string | null
  boneListExpanded: Record<string, boolean>   // nodeId → bone list open in SceneGraph
  fbxDebugVisible: Record<string, boolean>    // nodeId → FBX debug model shown
  cameraEffects: CameraEffectRecord[]
  previewEffectsCamera: string | null         // nodeId of the camera with Preview Effects active
  selectedEffect: { nodeId: string; kind: string } | null

  // Actions
  setProject: (id: string, name: string) => void
  setScenes: (scenes: SceneItem[]) => void
  updateSceneItem: (sceneId: string, updates: Partial<Omit<SceneItem, 'id'>>) => void
  setActiveScene: (id: string | null) => void
  setSceneSelected: (selected: boolean) => void
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
  setComponentKinds: (kinds: ComponentKindMeta[]) => void
  setActiveGraph: (id: string | null) => void
  setSelectedSignalNode: (id: string | null) => void
  setBoneListExpanded: (nodeId: string, expanded: boolean) => void
  setFbxDebugVisible: (nodeId: string, visible: boolean) => void
  toggleNodeHidden: (nodeId: string) => void
  setCameraEffects: (effects: CameraEffectRecord[]) => void
  addCameraEffect: (effect: CameraEffectRecord) => void
  updateCameraEffect: (id: string, updates: Partial<Omit<CameraEffectRecord, 'id' | 'nodeId'>>) => void
  removeCameraEffect: (id: string) => void
  cameraEffectsFor: (nodeId: string) => CameraEffectRecord[]
  setPreviewEffectsCamera: (nodeId: string | null) => void
  selectEffect: (nodeId: string, kind: string) => void
  clearSelectedEffect: () => void

  // Update state
  updateAvailable: boolean
  updateInfo: { latestVersion: string; releaseNotes: string | null; channel: UpdateChannel } | null
  pendingReload: boolean
  setUpdateAvailable: (available: boolean, info: EditorState['updateInfo']) => void
  setPendingReload: (pending: boolean) => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
  projectId: null,
  projectName: '',
  scenes: [],
  activeSceneId: null,
  nodes: [],
  selectedNodeId: null,
  sceneSelected: false,
  selectedComponentId: null,
  assets: [],
  nodeComponents: [],
  vmcStatus: {},
  vmcTracking: {},
  vrmBonesByNode: {},
  vrmExpressionsByNode: {},
  vrmMorphTargetsByNode: {},
  hoveredBoneName: null,
  componentKinds: [],
  activeGraphId: null,
  selectedSignalNodeId: null,
  boneListExpanded: {},
  fbxDebugVisible: {},

  cameraEffects: [],
  previewEffectsCamera: null,
  selectedEffect: null,

  setProject: (id, name) => set({ projectId: id, projectName: name }),
  setScenes: (scenes) => set({ scenes }),
  updateSceneItem: (sceneId, updates) =>
    set((s) => ({ scenes: s.scenes.map((sc) => (sc.id === sceneId ? { ...sc, ...updates } : sc)) })),
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
      const removedComps = new Set(s.nodeComponents.filter((c) => c.nodeId === id).map((c) => c.id))
      return {
        nodes: s.nodes.filter((n) => n.id !== id),
        selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        selectedComponentId: removedComps.has(s.selectedComponentId ?? '') ? null : s.selectedComponentId,
        nodeComponents: s.nodeComponents.filter((c) => c.nodeId !== id),
      }
    }),
  selectNode: (id) => set({ selectedNodeId: id, sceneSelected: false, selectedComponentId: null, selectedEffect: null }),
  selectComponent: (id) => set({ selectedComponentId: id, selectedEffect: null }),
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
  setComponentKinds: (kinds) => set({ componentKinds: kinds }),
  setActiveGraph: (id) => set({ activeGraphId: id, selectedSignalNodeId: null }),
  setSelectedSignalNode: (id) => set({ selectedSignalNodeId: id }),
  setBoneListExpanded: (nodeId, expanded) =>
    set((s) => ({ boneListExpanded: { ...s.boneListExpanded, [nodeId]: expanded } })),
  setFbxDebugVisible: (nodeId, visible) =>
    set((s) => ({ fbxDebugVisible: { ...s.fbxDebugVisible, [nodeId]: visible } })),
  toggleNodeHidden: (nodeId) =>
    set((s) => ({ nodes: s.nodes.map((n) => n.id === nodeId ? { ...n, hidden: !n.hidden } : n) })),
  setCameraEffects: (effects) => set({ cameraEffects: effects }),
  addCameraEffect: (effect) => set((s) => ({ cameraEffects: [...s.cameraEffects, effect] })),
  updateCameraEffect: (id, updates) =>
    set((s) => ({ cameraEffects: s.cameraEffects.map((e) => e.id === id ? { ...e, ...updates } : e) })),
  removeCameraEffect: (id) =>
    set((s) => ({ cameraEffects: s.cameraEffects.filter((e) => e.id !== id) })),
  cameraEffectsFor: (nodeId) => get().cameraEffects.filter((e) => e.nodeId === nodeId),
  setPreviewEffectsCamera: (nodeId) =>
    set((s) => ({ previewEffectsCamera: s.previewEffectsCamera === nodeId ? null : nodeId })),
  selectEffect: (nodeId, kind) => set({ selectedEffect: { nodeId, kind }, selectedComponentId: null }),
  clearSelectedEffect: () => set({ selectedEffect: null }),

  updateAvailable: false,
  updateInfo: null,
  pendingReload: false,
  setUpdateAvailable: (available, info) => set({ updateAvailable: available, updateInfo: info }),
  setPendingReload: (pending) => set({ pendingReload: pending }),
}))
