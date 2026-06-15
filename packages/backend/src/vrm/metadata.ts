import { readGlbJson } from './skeleton.js';
import type { VrmAssetMetadata } from '@vspark/shared';

// ──────────────────────────────────────────────────────────────────────────────
// Asset metadata extraction — bones, materials, morph targets (blendshapes) and
// expressions, read straight from the embedded glTF JSON chunk. Zero runtime
// deps (shares readGlbJson with skeleton.ts). Used at upload time and refreshed
// by discoverAssets so the frontend can populate UI lists without loading the
// VRM in the viewport.
// ──────────────────────────────────────────────────────────────────────────────

interface GltfMeshPrimitive {
  extras?: { targetNames?: string[] };
}
interface GltfMesh {
  extras?: { targetNames?: string[] };
  primitives?: GltfMeshPrimitive[];
}
interface GltfJson {
  materials?: Array<{ name?: string }>;
  meshes?: GltfMesh[];
  extensions?: {
    // VRM 0.x
    VRM?: {
      humanoid?: { humanBones?: Array<{ bone: string }> };
      blendShapeMaster?: { blendShapeGroups?: Array<{ name?: string }> };
    };
    // VRM 1.0
    VRMC_vrm?: {
      humanoid?: { humanBones?: Record<string, unknown> };
      expressions?: {
        preset?: Record<string, unknown>;
        custom?: Record<string, unknown>;
      };
    };
  };
}

/** Dedupe + drop empties, preserving first-seen order. */
function uniq(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function extractBones(gltf: GltfJson): string[] {
  const vrm1 = gltf.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (vrm1) return Object.keys(vrm1);
  const vrm0 = gltf.extensions?.VRM?.humanoid?.humanBones;
  if (vrm0) return uniq(vrm0.map((b) => b.bone));
  return [];
}

function extractMaterials(gltf: GltfJson): string[] {
  return uniq((gltf.materials ?? []).map((m) => m.name));
}

function extractMorphTargets(gltf: GltfJson): string[] {
  const names: Array<string | undefined> = [];
  for (const mesh of gltf.meshes ?? []) {
    // glTF allows targetNames on the mesh.extras or per-primitive.extras.
    for (const n of mesh.extras?.targetNames ?? []) names.push(n);
    for (const prim of mesh.primitives ?? [])
      for (const n of prim.extras?.targetNames ?? []) names.push(n);
  }
  return uniq(names);
}

function extractExpressions(gltf: GltfJson): string[] {
  const vrm1 = gltf.extensions?.VRMC_vrm?.expressions;
  if (vrm1)
    return uniq([
      ...Object.keys(vrm1.preset ?? {}),
      ...Object.keys(vrm1.custom ?? {}),
    ]);
  const vrm0 = gltf.extensions?.VRM?.blendShapeMaster?.blendShapeGroups;
  if (vrm0) return uniq(vrm0.map((g) => g.name));
  return [];
}

/**
 * Extract UI-population metadata from a GLB/VRM file. Returns null for files we
 * can't parse as GLB (e.g. a .glb that isn't binary glTF). A valid GLB with no
 * VRM humanoid still returns a (mostly empty) object — non-VRM models simply
 * have empty bone/expression lists.
 */
export function extractVrmMetadata(filePath: string): VrmAssetMetadata | null {
  let gltf: GltfJson;
  try {
    gltf = readGlbJson<GltfJson>(filePath);
  } catch {
    return null;
  }
  return {
    bones: extractBones(gltf),
    materials: extractMaterials(gltf),
    morphTargets: extractMorphTargets(gltf),
    expressions: extractExpressions(gltf),
  };
}
