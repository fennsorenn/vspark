/**
 * boneAttachPick.test.ts — unit tests for the stage "attach on drop" math:
 *  - worldToBoneLocalTransform: world→bone-local round-trips (re-parenting under
 *    the bone preserves world position/rotation/scale).
 *  - pickBoneForDrop: a ray through a dropped object onto a skinned mesh resolves
 *    to the humanoid bone with the highest skin weight at the surface, and
 *    returns null when the drop lands over nothing.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import {
  pickBoneForDrop,
  worldToBoneLocalTransform,
  type AttachCandidate,
} from '../src/components/editor/boneAttachPick';

describe('worldToBoneLocalTransform', () => {
  it('round-trips: re-parenting under the bone preserves the world transform', () => {
    const scene = new THREE.Scene();
    // A bone with a non-trivial world transform.
    const bone = new THREE.Object3D();
    bone.position.set(1, 2, 3);
    bone.rotation.set(0, Math.PI / 2, 0);
    bone.scale.set(2, 2, 2);
    scene.add(bone);

    // An object sitting somewhere in the world (as a scene-root child).
    const obj = new THREE.Object3D();
    obj.position.set(-1, 0.5, 4);
    obj.rotation.set(0.3, -0.4, 0.1);
    scene.add(obj);
    scene.updateMatrixWorld(true);

    const worldPosBefore = obj.getWorldPosition(new THREE.Vector3());
    const worldQuatBefore = obj.getWorldQuaternion(new THREE.Quaternion());

    const local = worldToBoneLocalTransform(obj, bone);

    // Re-create the object with the computed bone-local transform, parent it
    // under the bone, and confirm the world transform is unchanged.
    const rebuilt = new THREE.Object3D();
    rebuilt.position.set(local.x, local.y, local.z);
    rebuilt.rotation.set(local.rx, local.ry, local.rz);
    rebuilt.scale.set(local.sx, local.sy, local.sz);
    bone.add(rebuilt);
    scene.updateMatrixWorld(true);

    const worldPosAfter = rebuilt.getWorldPosition(new THREE.Vector3());
    const worldQuatAfter = rebuilt.getWorldQuaternion(new THREE.Quaternion());

    expect(worldPosAfter.x).toBeCloseTo(worldPosBefore.x, 5);
    expect(worldPosAfter.y).toBeCloseTo(worldPosBefore.y, 5);
    expect(worldPosAfter.z).toBeCloseTo(worldPosBefore.z, 5);
    // Quaternion equality up to sign.
    const dot = Math.abs(worldQuatAfter.dot(worldQuatBefore));
    expect(dot).toBeCloseTo(1, 5);
  });
});

/** Build a one-triangle skinned mesh in the z=0 plane whose every vertex is
 *  fully weighted to `bones[1]` (the child), wrapped in a fake VRM whose
 *  humanoid maps hips→bones[0], spine→bones[1]. */
function makeSkinnedAvatar(): { candidate: AttachCandidate; root: THREE.Group } {
  const bones = [new THREE.Bone(), new THREE.Bone()];
  bones[0].add(bones[1]);
  const skeleton = new THREE.Skeleton(bones);

  const geo = new THREE.BufferGeometry();
  // A triangle around the origin, facing +z.
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-1, -1, 0, 1, -1, 0, 0, 1, 0],
      3
    )
  );
  // All three vertices fully weighted to bone index 1.
  geo.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4)
  );
  geo.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4)
  );

  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  mesh.add(bones[0]);
  mesh.bind(skeleton);

  const root = new THREE.Group();
  root.add(mesh);
  root.updateMatrixWorld(true);

  const vrm = {
    scene: root,
    humanoid: {
      getRawBoneNode: (name: string) =>
        name === 'hips' ? bones[0] : name === 'spine' ? bones[1] : null,
    },
  } as unknown as VRM;

  return { candidate: { nodeId: 'avatar-1', vrm }, root };
}

describe('pickBoneForDrop', () => {
  it('resolves the highest-weight humanoid bone under the drop', () => {
    const { candidate } = makeSkinnedAvatar();

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    // Object resting at the centre of the triangle.
    const pick = pickBoneForDrop(camera, new THREE.Vector3(0, 0, 0), [
      candidate,
    ]);

    expect(pick).not.toBeNull();
    expect(pick!.avatarNodeId).toBe('avatar-1');
    expect(pick!.boneName).toBe('spine');
  });

  it('returns null when the drop lands over nothing', () => {
    const { candidate } = makeSkinnedAvatar();

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    // Object far off to the side — its projected ray misses the triangle.
    const pick = pickBoneForDrop(camera, new THREE.Vector3(50, 50, 0), [
      candidate,
    ]);

    expect(pick).toBeNull();
  });

  it('returns null with no candidate avatars', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    expect(
      pickBoneForDrop(camera, new THREE.Vector3(0, 0, 0), [])
    ).toBeNull();
  });
});
