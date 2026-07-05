/**
 * composeRotate.test.ts — the compose 3D gizmo's rotation pivot.
 *
 * The key property (the one that distinguishes "centre" from "origin"): rotation
 * spins around the geometry's bounding-box centre, which can sit off to one side
 * of the transform origin.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  objectWorldCenter,
  rotateAroundWorldAxis,
} from '../src/components/editor/composeRotate';

/** A group whose origin is (0,0,0) but whose only mesh is a unit box centred at
 *  local (2,0,0) — so its geometric centre is offset two units from its origin. */
function offCenterGroup(): THREE.Object3D {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.position.set(2, 0, 0);
  group.add(mesh);
  scene.add(group);
  scene.updateMatrixWorld(true);
  return group;
}

describe('objectWorldCenter', () => {
  it('is the geometry centre, not the transform origin', () => {
    const group = offCenterGroup();
    const c = objectWorldCenter(group, new THREE.Vector3());
    expect(c.x).toBeCloseTo(2, 5);
    expect(c.y).toBeCloseTo(0, 5);
    expect(c.z).toBeCloseTo(0, 5);
  });

  it('follows the group when it moves', () => {
    const group = offCenterGroup();
    group.position.set(0, 1, 0);
    group.updateMatrixWorld(true);
    const c = objectWorldCenter(group, new THREE.Vector3());
    expect(c.x).toBeCloseTo(2, 5);
    expect(c.y).toBeCloseTo(1, 5);
  });

  it('ignores invisible meshes (e.g. editor helpers)', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    const visible = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); // at origin
    const helper = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    helper.position.set(10, 0, 0); // far off to one side
    helper.visible = false;
    group.add(visible, helper);
    scene.add(group);
    scene.updateMatrixWorld(true);
    const c = objectWorldCenter(group, new THREE.Vector3());
    // The hidden helper is ignored, so the centre stays on the visible box.
    expect(c.x).toBeCloseTo(0, 5);
    expect(c.y).toBeCloseTo(0, 5);
  });
});

describe('rotateAroundWorldAxis about the centre', () => {
  it('keeps the geometric centre fixed and swings the origin around it', () => {
    const group = offCenterGroup();
    const center = objectWorldCenter(group, new THREE.Vector3()); // (2,0,0)

    // 180° about Y through the centre.
    rotateAroundWorldAxis(group, new THREE.Vector3(0, 1, 0), Math.PI, center);
    group.updateMatrixWorld(true);

    // Centre is unchanged...
    const after = objectWorldCenter(group, new THREE.Vector3());
    expect(after.x).toBeCloseTo(2, 4);
    expect(after.y).toBeCloseTo(0, 4);
    expect(after.z).toBeCloseTo(0, 4);

    // ...but the origin, which was 2 units −X of the centre, has swung to +X.
    const origin = group.getWorldPosition(new THREE.Vector3());
    expect(origin.x).toBeCloseTo(4, 4);
    expect(origin.z).toBeCloseTo(0, 4);
  });

  it('with no pivot rotates about the origin (position untouched)', () => {
    const group = offCenterGroup();
    group.position.set(3, 0, 0);
    group.updateMatrixWorld(true);
    rotateAroundWorldAxis(group, new THREE.Vector3(0, 1, 0), Math.PI / 2);
    group.updateMatrixWorld(true);
    const origin = group.getWorldPosition(new THREE.Vector3());
    // Origin (position) is unchanged; only orientation rotated.
    expect(origin.x).toBeCloseTo(3, 5);
    expect(origin.y).toBeCloseTo(0, 5);
    expect(origin.z).toBeCloseTo(0, 5);
  });
});
