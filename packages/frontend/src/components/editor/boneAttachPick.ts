import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { VRM_BONE_NAMES } from '@vspark/shared/signal';

/** A dragged object that came to rest over a model, resolved to the humanoid
 *  bone that drives the surface under the drop point. */
export interface BonePick {
  avatarNodeId: string;
  boneName: VRMHumanBoneName;
  boneNode: THREE.Object3D;
}

export interface AttachCandidate {
  nodeId: string;
  vrm: VRM;
}

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

/** Walk up `bone`'s parent chain until an object registered as a humanoid bone
 *  is found; returns its VRM bone name (or null if the chain leaves the rig). */
function resolveHumanoidBone(
  bone: THREE.Object3D,
  boneMap: Map<THREE.Object3D, VRMHumanBoneName>
): VRMHumanBoneName | null {
  let cur: THREE.Object3D | null = bone;
  while (cur) {
    const name = boneMap.get(cur);
    if (name) return name;
    cur = cur.parent;
  }
  return null;
}

/** Index of the highest-weight bone influencing vertex `vi` of `mesh`, or -1
 *  if the vertex has no skin weights. */
function dominantBoneIndex(mesh: THREE.SkinnedMesh, vi: number): number {
  const skinIndex = mesh.geometry.attributes.skinIndex as
    | THREE.BufferAttribute
    | undefined;
  const skinWeight = mesh.geometry.attributes.skinWeight as
    | THREE.BufferAttribute
    | undefined;
  if (!skinIndex || !skinWeight) return -1;
  let best = -1;
  let bestW = 0;
  for (let k = 0; k < 4; k++) {
    const w = skinWeight.getComponent(vi, k);
    if (w > bestW) {
      bestW = w;
      best = skinIndex.getComponent(vi, k);
    }
  }
  return best;
}

const _tmpV = new THREE.Vector3();

/** Posed world position of vertex `vi` of a skinned mesh (applies the current
 *  skinning transform, matching what the raycast hit). */
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
 * Given a dragged object's resting world position, cast a ray from the camera
 * through that point onto the candidate avatars' skinned meshes and resolve the
 * humanoid bone driving the surface under the drop — i.e. the bone with the
 * highest skin weight at the nearest vertex of the hit triangle.
 *
 * Returns null when the drop does not land over any model (normal free move).
 */
export function pickBoneForDrop(
  camera: THREE.Camera,
  objectWorldPos: THREE.Vector3,
  candidates: AttachCandidate[],
  raycaster: THREE.Raycaster = new THREE.Raycaster()
): BonePick | null {
  const ndc = objectWorldPos.clone().project(camera);
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);

  let best: {
    hit: THREE.Intersection;
    candidate: AttachCandidate;
  } | null = null;
  for (const candidate of candidates) {
    const hits = raycaster.intersectObject(candidate.vrm.scene, true);
    for (const hit of hits) {
      if (!(hit.object as THREE.SkinnedMesh).isSkinnedMesh) continue;
      if (hit.face == null) continue;
      if (!best || hit.distance < best.hit.distance) {
        best = { hit, candidate };
      }
      break; // hits are sorted near→far; first skinned hit per candidate wins
    }
  }
  if (!best) return null;

  const mesh = best.hit.object as THREE.SkinnedMesh;
  const face = best.hit.face!;
  // Pick whichever of the triangle's three vertices is closest to the exact hit
  // point — that's the vertex whose skin weights best describe "the part it was
  // dropped on".
  let vi = face.a;
  let bestD = Infinity;
  for (const idx of [face.a, face.b, face.c]) {
    const d = posedVertexWorld(mesh, idx, _tmpV).distanceToSquared(
      best.hit.point
    );
    if (d < bestD) {
      bestD = d;
      vi = idx;
    }
  }

  const boneIdx = dominantBoneIndex(mesh, vi);
  if (boneIdx < 0 || !mesh.skeleton.bones[boneIdx]) return null;
  const boneNode = mesh.skeleton.bones[boneIdx];
  const boneName = resolveHumanoidBone(boneNode, humanoidBoneMap(best.candidate.vrm));
  if (!boneName) return null;
  const humanoidNode = best.candidate.vrm.humanoid.getRawBoneNode(boneName);
  if (!humanoidNode) return null;

  return {
    avatarNodeId: best.candidate.nodeId,
    boneName,
    boneNode: humanoidNode,
  };
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
  _m.decompose(_p, _q, _s);
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
