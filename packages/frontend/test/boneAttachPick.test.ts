/**
 * boneAttachPick.test.ts — unit tests for the shared bone-attachment math used
 * by compose attach-on-drop:
 *  - worldToBoneLocalTransform: re-parenting under the bone preserves the
 *    object's world position/rotation/scale.
 *  - worldTransform: decomposes the object's world matrix (top-level detach).
 *  - humanoidBoneFor: resolves an arbitrary skeleton bone up to its humanoid
 *    ancestor.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import {
  worldToBoneLocalTransform,
  worldTransform,
  humanoidBoneFor,
} from '../src/components/editor/boneAttachPick';

describe('worldToBoneLocalTransform', () => {
  it('round-trips: re-parenting under the bone preserves the world transform', () => {
    const scene = new THREE.Scene();
    const bone = new THREE.Object3D();
    bone.position.set(1, 2, 3);
    bone.rotation.set(0, Math.PI / 2, 0);
    bone.scale.set(2, 2, 2);
    scene.add(bone);

    const obj = new THREE.Object3D();
    obj.position.set(-1, 0.5, 4);
    obj.rotation.set(0.3, -0.4, 0.1);
    scene.add(obj);
    scene.updateMatrixWorld(true);

    const worldPosBefore = obj.getWorldPosition(new THREE.Vector3());
    const worldQuatBefore = obj.getWorldQuaternion(new THREE.Quaternion());

    const local = worldToBoneLocalTransform(obj, bone);

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
    expect(Math.abs(worldQuatAfter.dot(worldQuatBefore))).toBeCloseTo(1, 5);
  });
});

describe('worldTransform', () => {
  it('returns the object world transform (top-level detach keeps placement)', () => {
    const scene = new THREE.Scene();
    // Object nested under a transformed parent — its world transform differs
    // from its local one.
    const parent = new THREE.Object3D();
    parent.position.set(5, 0, 0);
    parent.rotation.set(0, Math.PI / 2, 0);
    scene.add(parent);
    const obj = new THREE.Object3D();
    obj.position.set(0, 1, 0);
    parent.add(obj);
    scene.updateMatrixWorld(true);

    const worldBefore = obj.getWorldPosition(new THREE.Vector3());
    const local = worldTransform(obj);

    // Re-mount at scene root with the returned transform → same world position.
    const rebuilt = new THREE.Object3D();
    rebuilt.position.set(local.x, local.y, local.z);
    rebuilt.rotation.set(local.rx, local.ry, local.rz);
    scene.add(rebuilt);
    scene.updateMatrixWorld(true);
    const worldAfter = rebuilt.getWorldPosition(new THREE.Vector3());

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 5);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 5);
    expect(worldAfter.z).toBeCloseTo(worldBefore.z, 5);
  });
});

describe('humanoidBoneFor', () => {
  it('resolves a humanoid bone directly, and a non-humanoid child up to it', () => {
    const hips = new THREE.Bone();
    const spine = new THREE.Bone();
    const sleeve = new THREE.Bone(); // non-humanoid accessory bone under spine
    hips.add(spine);
    spine.add(sleeve);

    const vrm = {
      humanoid: {
        getRawBoneNode: (name: string) =>
          name === 'hips' ? hips : name === 'spine' ? spine : null,
      },
    } as unknown as VRM;

    expect(humanoidBoneFor(vrm, spine)?.name).toBe('spine');
    // The sleeve bone isn't humanoid → resolves to its nearest humanoid ancestor.
    expect(humanoidBoneFor(vrm, sleeve)?.name).toBe('spine');
    expect(humanoidBoneFor(vrm, hips)?.name).toBe('hips');
  });

  it('returns null when the bone leaves the humanoid rig', () => {
    const orphan = new THREE.Bone();
    const vrm = {
      humanoid: { getRawBoneNode: () => null },
    } as unknown as VRM;
    expect(humanoidBoneFor(vrm, orphan)).toBeNull();
  });
});
