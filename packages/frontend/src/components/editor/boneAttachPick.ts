import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { VRM_BONE_NAMES } from '@vspark/shared/signal';

/** Shared bone-attachment math used when binding/unbinding a scene node to an
 *  avatar bone (see ComposeSceneInteractions' attach-on-drop). Kept view-neutral
 *  and pure so it can be unit-tested without a live scene. */

/** Build a map from every humanoid bone's raw Object3D to its VRM bone name so
 *  an arbitrary skeleton bone (which may be a non-humanoid child such as a
 *  sleeve or twist bone) can be resolved to the nearest humanoid ancestor. */
function humanoidBoneMap(vrm: VRM): Map<THREE.Object3D, VRMHumanBoneName> {
  const map = new Map<THREE.Object3D, VRMHumanBoneName>();
  for (const name of VRM_BONE_NAMES as unknown as VRMHumanBoneName[]) {
    const node = vrm.humanoid.getRawBoneNode(name);
    if (node) map.set(node, name);
  }
  return map;
}

/**
 * Resolve an arbitrary skeleton bone to the VRM humanoid bone that drives it:
 * walk up the bone's parent chain until an object registered as a humanoid bone
 * is found. Returns the humanoid bone name + its node, or null if the chain
 * leaves the rig (e.g. a mesh bound to a non-humanoid accessory skeleton).
 */
export function humanoidBoneFor(
  vrm: VRM,
  bone: THREE.Object3D
): { name: VRMHumanBoneName; node: THREE.Object3D } | null {
  const boneMap = humanoidBoneMap(vrm);
  let cur: THREE.Object3D | null = bone;
  while (cur) {
    const name = boneMap.get(cur);
    if (name) return { name, node: cur };
    cur = cur.parent;
  }
  return null;
}

const _pv = new THREE.Vector3();

/** Posed world position of vertex `vi` of a skinned mesh — applies the live
 *  skinning transform, so it matches the animated surface the ray actually hit. */
function posedVertexWorld(
  mesh: THREE.SkinnedMesh,
  vi: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  out.fromBufferAttribute(pos, vi);
  mesh.applyBoneTransform(vi, out);
  return out.applyMatrix4(mesh.matrixWorld);
}

/**
 * The skeleton bone that drives the surface a ray hit: of the hit triangle's
 * three vertices, take the one closest to the exact (posed) hit point and return
 * its highest-skin-weight bone. This is the geometry-accurate, animation-aware
 * answer to "which bone steers the part it was dropped on" — it reads the real
 * skin weights at the surface rather than approximating with per-bone boxes.
 */
export function dominantBoneForHit(
  mesh: THREE.SkinnedMesh,
  face: { a: number; b: number; c: number },
  worldPoint: THREE.Vector3
): THREE.Object3D | null {
  const skinIndex = mesh.geometry.attributes.skinIndex as
    | THREE.BufferAttribute
    | undefined;
  const skinWeight = mesh.geometry.attributes.skinWeight as
    | THREE.BufferAttribute
    | undefined;
  if (!skinIndex || !skinWeight || !mesh.skeleton) return null;

  let vi = face.a;
  let bestD = Infinity;
  for (const idx of [face.a, face.b, face.c]) {
    const d = posedVertexWorld(mesh, idx, _pv).distanceToSquared(worldPoint);
    if (d < bestD) {
      bestD = d;
      vi = idx;
    }
  }

  let boneIdx = -1;
  let bestW = 0;
  for (let k = 0; k < 4; k++) {
    const w = skinWeight.getComponent(vi, k);
    if (w > bestW) {
      bestW = w;
      boneIdx = skinIndex.getComponent(vi, k);
    }
  }
  if (boneIdx < 0) return null;
  return mesh.skeleton.bones[boneIdx] ?? null;
}

export interface LocalTransform {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  sx: number;
  sy: number;
  sz: number;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

function decompose(matrix: THREE.Matrix4): LocalTransform {
  matrix.decompose(_p, _q, _s);
  _e.setFromQuaternion(_q, 'XYZ');
  return {
    x: _p.x,
    y: _p.y,
    z: _p.z,
    rx: _e.x,
    ry: _e.y,
    rz: _e.z,
    sx: _s.x,
    sy: _s.y,
    sz: _s.z,
  };
}

/**
 * Express `object`'s current world transform in `boneNode`'s local space, so
 * that re-parenting the object under the bone preserves its world position,
 * rotation and scale (world → bone-local).
 */
export function worldToBoneLocalTransform(
  object: THREE.Object3D,
  boneNode: THREE.Object3D
): LocalTransform {
  object.updateWorldMatrix(true, false);
  boneNode.updateWorldMatrix(true, false);
  _m.copy(boneNode.matrixWorld).invert().multiply(object.matrixWorld);
  return decompose(_m);
}

/**
 * The object's transform relative to the world origin (its scene-root-local
 * transform). Used when detaching a node back to the top level so it keeps its
 * world placement — top-level scene nodes render under the identity scene root,
 * so world space and their local space coincide.
 */
export function worldTransform(object: THREE.Object3D): LocalTransform {
  object.updateWorldMatrix(true, false);
  _m.copy(object.matrixWorld);
  return decompose(_m);
}
