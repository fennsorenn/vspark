import { readFileSync } from 'fs'

// ──────────────────────────────────────────────────────────────────────────────
// GLB / GLTF parsing — only the skeleton data we need, no external deps
// ──────────────────────────────────────────────────────────────────────────────

interface GltfNode {
  name?:        string
  translation?: [number, number, number]
  rotation?:    [number, number, number, number]  // xyzw
  scale?:       [number, number, number]
  children?:    number[]
}

interface GltfJson {
  nodes?: GltfNode[]
  extensions?: {
    // VRM 0.x
    VRM?: { humanoid?: { humanBones?: Array<{ bone: string; node: number }> } }
    // VRM 1.0
    VRMC_vrm?: { humanoid?: { humanBones?: Record<string, { node: number }> } }
  }
}

function parseGlb(filePath: string): GltfJson {
  const buf = readFileSync(filePath)
  // GLB magic: "glTF" = 0x46546C67 LE
  if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error(`Not a GLB file: ${filePath}`)
  const jsonLen  = buf.readUInt32LE(12)
  const jsonType = buf.readUInt32LE(16)
  if (jsonType !== 0x4E4F534A) throw new Error('GLB chunk 0 is not JSON')
  return JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)) as GltfJson
}

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

export interface VrmBoneEntry {
  /** Position relative to parent bone, in parent's LOCAL rest space. */
  localTranslation: [number, number, number]
  /** Rest rotation in parent's LOCAL space (identity for most VRM 1.0 bones). */
  localRotation:    [number, number, number, number]  // xyzw
  /** VRM bone name of the parent, or null for the root (hips). */
  parent:           string | null
}

/** Keyed by VRM humanoid bone name (camelCase, e.g. 'leftUpperArm'). */
export type VrmSkeletonData = Record<string, VrmBoneEntry>

// ──────────────────────────────────────────────────────────────────────────────
// Loader
// ──────────────────────────────────────────────────────────────────────────────

export function loadVrmSkeleton(filePath: string): VrmSkeletonData {
  const gltf  = parseGlb(filePath)
  const nodes = gltf.nodes ?? []

  // VRM bone name → GLTF node index
  const boneToNode = new Map<string, number>()
  const vrm1 = gltf.extensions?.VRMC_vrm?.humanoid?.humanBones
  const vrm0 = gltf.extensions?.VRM?.humanoid?.humanBones
  if (vrm1) {
    for (const [bone, info] of Object.entries(vrm1)) boneToNode.set(bone, info.node)
  } else if (vrm0) {
    for (const b of vrm0) boneToNode.set(b.bone, b.node)
  }
  if (boneToNode.size === 0) throw new Error('No VRM humanoid bones found in file')

  // GLTF node index → parent index
  const nodeParent = new Map<number, number>()
  for (let i = 0; i < nodes.length; i++) {
    for (const child of nodes[i].children ?? []) nodeParent.set(child, i)
  }

  // GLTF node index → VRM bone name (reverse lookup)
  const nodeToBone = new Map<number, string>()
  for (const [bone, idx] of boneToNode) nodeToBone.set(idx, bone)

  const skeleton: VrmSkeletonData = {}

  for (const [boneName, nodeIdx] of boneToNode) {
    const node = nodes[nodeIdx]
    if (!node) continue

    // Find VRM parent by walking up the GLTF node hierarchy
    let parentBone: string | null = null
    let cur = nodeParent.get(nodeIdx)
    while (cur !== undefined) {
      const pb = nodeToBone.get(cur)
      if (pb) { parentBone = pb; break }
      cur = nodeParent.get(cur)
    }

    skeleton[boneName] = {
      localTranslation: (node.translation ?? [0, 0, 0]) as [number, number, number],
      localRotation:    (node.rotation    ?? [0, 0, 0, 1]) as [number, number, number, number],
      parent: parentBone,
    }
  }

  return skeleton
}
