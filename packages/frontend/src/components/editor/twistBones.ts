import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

// ─────────────────────────────────────────────────────────────────────────────
// Forearm twist bones
//
// The VRM standard humanoid has a single `lowerArm` bone, so forearm
// pronation/supination (the roll the backend bakes into `lowerArm`) lands
// entirely at the elbow → the "candy-wrapper" pinch. A real twist bone spreads
// that roll along the forearm.
//
// This module, per side:
//   • detects the model's own twist bone (name match), or
//   • synthesizes one (insert a bone between lowerArm and hand, reparent the
//     hand under it, and re-skin the forearm vertices so they blend from
//     lowerArm at the elbow to the twist bone toward the wrist), and
//   • each frame, decomposes the lowerArm's local rotation into swing + twist
//     about the forearm axis and routes the twist onto the twist bone, leaving
//     the elbow with swing only. The hand's world orientation is preserved.
//
// It is purely additive and gated: when no twist bone is set up nothing runs and
// the backend's upper-arm/forearm roll split stands unchanged. The rest pose is
// visually identical (at rest the twist is identity, and splitting a vertex
// between two bones that both resolve to identity changes nothing).
// ─────────────────────────────────────────────────────────────────────────────

const TWIST_NAME_RE = /twist|roll/i;
// Where the synthesized bone sits along the forearm (0 = elbow, 1 = wrist). The
// roll is pivot-invariant along the forearm centreline, so this only affects the
// re-skin falloff midpoint, not correctness.
const SYNTH_FRACTION = 0.55;
// Share of the forearm roll the twist bone absorbs (the remainder stays on
// lowerArm). 1 fully de-rolls the elbow.
const DEFAULT_GRADIENT = 1.0;

type Side = 'left' | 'right';

interface MeshBackup {
  mesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  bindMatrix: THREE.Matrix4;
  skinIndex: ArrayLike<number>;
  skinWeight: ArrayLike<number>;
}

interface SideTwist {
  lowerArm: THREE.Object3D;
  twistBone: THREE.Object3D;
  hand: THREE.Object3D;
  axis: THREE.Vector3; // unit forearm direction in lowerArm-local space
  gradient: number;
  synthesized: boolean;
  // teardown state
  handOrigParent: THREE.Object3D | null;
  handOrigPos: THREE.Vector3;
  handOrigQuat: THREE.Quaternion;
  twistOrigParent: THREE.Object3D | null; // null for synthesized (we created it)
  meshBackups: MeshBackup[];
}

interface AvatarTwist {
  sides: SideTwist[];
}

const registry = new Map<string, AvatarTwist>();

export function hasForearmTwist(nodeId: string): boolean {
  return (registry.get(nodeId)?.sides.length ?? 0) > 0;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

export function setupForearmTwist(
  nodeId: string,
  vrm: VRM,
  opts: { force: boolean; gradient?: number }
): void {
  teardownForearmTwist(nodeId);
  const gradient = opts.gradient ?? DEFAULT_GRADIENT;
  vrm.scene.updateMatrixWorld(true);

  const sides: SideTwist[] = [];
  for (const side of ['left', 'right'] as Side[]) {
    const lowerArm = vrm.humanoid.getRawBoneNode(
      `${side}LowerArm` as VRMHumanBoneName
    );
    const hand = vrm.humanoid.getRawBoneNode(`${side}Hand` as VRMHumanBoneName);
    if (!lowerArm || !hand) continue;

    // Forearm axis + wrist position, both in lowerArm-local space.
    const handWorld = new THREE.Vector3();
    hand.getWorldPosition(handWorld);
    const wristLocal = lowerArm.worldToLocal(handWorld.clone());
    if (wristLocal.lengthSq() < 1e-9) continue;
    const axis = wristLocal.clone().normalize();

    const detected = detectTwistBone(lowerArm, hand);
    if (detected) {
      sides.push(attachSide(lowerArm, detected, hand, axis, gradient, false));
    } else if (opts.force) {
      const twist = new THREE.Bone();
      twist.name = `${lowerArm.name}__synthTwist`;
      twist.position.copy(wristLocal).multiplyScalar(SYNTH_FRACTION);
      lowerArm.add(twist);
      lowerArm.updateMatrixWorld(true);
      const side2 = attachSide(lowerArm, twist, hand, axis, gradient, true);
      reskinForearm(vrm, lowerArm, twist, wristLocal, side2);
      sides.push(side2);
    }
  }

  if (sides.length) registry.set(nodeId, { sides });
}

export function teardownForearmTwist(nodeId: string): void {
  const avatar = registry.get(nodeId);
  if (!avatar) return;
  for (const s of avatar.sides) {
    // Restore mesh skinning (synthesized only).
    for (const b of s.meshBackups) {
      b.mesh.bind(b.skeleton, b.bindMatrix);
      const gi = b.mesh.geometry.getAttribute('skinIndex');
      const gw = b.mesh.geometry.getAttribute('skinWeight');
      (gi.array as Float32Array).set(b.skinIndex as ArrayLike<number>);
      (gw.array as Float32Array).set(b.skinWeight as ArrayLike<number>);
      gi.needsUpdate = true;
      gw.needsUpdate = true;
    }
    // Reparent the hand back, preserving its world transform, then restore rest.
    if (s.handOrigParent) {
      s.handOrigParent.attach(s.hand);
      s.hand.position.copy(s.handOrigPos);
      s.hand.quaternion.copy(s.handOrigQuat);
    }
    // Remove a bone we created; leave a detected bone in place.
    if (s.synthesized) s.twistBone.removeFromParent();
  }
  registry.delete(nodeId);
}

// ── Per-frame drive ──────────────────────────────────────────────────────────

const _q0 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _swing = new THREE.Quaternion();
const _twist = new THREE.Quaternion();
const _tg = new THREE.Quaternion();
const _tgInv = new THREE.Quaternion();
const _id = new THREE.Quaternion();

export function driveForearmTwist(nodeId: string): void {
  const avatar = registry.get(nodeId);
  if (!avatar) return;
  for (const s of avatar.sides) {
    // q = lowerArm local rotation (the backend roll is baked in here).
    _q0.copy(s.lowerArm.quaternion);
    // Swing = shortest arc that carries the rest forearm axis to where q sends it.
    _v.copy(s.axis).applyQuaternion(_q0);
    _swing.setFromUnitVectors(s.axis, _v);
    // Twist = S⁻¹ · q  → the residual rotation about the forearm axis.
    _twist.copy(_swing).invert().multiply(_q0);
    // Hand under twistBone keeps full orientation for any gradient g:
    //   lowerArm = q · T⁻ᵍ , twistBone = Tᵍ  ⇒  lowerArm · twistBone = q.
    _tg.copy(_id).slerp(_twist, s.gradient);
    s.twistBone.quaternion.copy(_tg);
    _tgInv.copy(_tg).invert();
    s.lowerArm.quaternion.copy(_q0).multiply(_tgInv);
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function detectTwistBone(
  lowerArm: THREE.Object3D,
  hand: THREE.Object3D
): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  lowerArm.traverse((o) => {
    if (found || o === lowerArm || o === hand) return;
    if ((o as THREE.Bone).isBone && TWIST_NAME_RE.test(o.name)) found = o;
  });
  return found;
}

// Reparent the hand under the twist bone (preserving world transform) and record
// the state needed to undo it.
function attachSide(
  lowerArm: THREE.Object3D,
  twist: THREE.Object3D,
  hand: THREE.Object3D,
  axis: THREE.Vector3,
  gradient: number,
  synthesized: boolean
): SideTwist {
  const handOrigParent = hand.parent;
  const handOrigPos = hand.position.clone();
  const handOrigQuat = hand.quaternion.clone();
  twist.updateMatrixWorld(true);
  twist.attach(hand); // keeps the hand's world transform

  return {
    lowerArm,
    twistBone: twist,
    hand,
    axis,
    gradient,
    synthesized,
    handOrigParent,
    handOrigPos,
    handOrigQuat,
    twistOrigParent: synthesized ? null : twist.parent,
    meshBackups: [],
  };
}

// Re-skin every forearm SkinnedMesh: vertices weighted to lowerArm hand part of
// their weight to the twist bone, ramped 0→1 along the elbow→wrist axis.
function reskinForearm(
  vrm: VRM,
  lowerArm: THREE.Object3D,
  twist: THREE.Object3D,
  wristLocal: THREE.Vector3,
  side: SideTwist
): void {
  twist.updateMatrixWorld(true);
  const twistInverse = twist.matrixWorld.clone().invert();
  const wristLen2 = wristLocal.lengthSq();

  // One new Skeleton per shared skeleton instance (twist bone appended at end).
  const newSkeletons = new Map<
    THREE.Skeleton,
    { skel: THREE.Skeleton; twistIndex: number; lowerIndex: number }
  >();
  const _v = new THREE.Vector3();
  const _m = new THREE.Matrix4();

  vrm.scene.traverse((obj) => {
    const mesh = obj as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const skel = mesh.skeleton;
    const lowerIndex = skel.bones.indexOf(lowerArm as THREE.Bone);
    if (lowerIndex < 0) return;
    const si = mesh.geometry.getAttribute('skinIndex');
    const sw = mesh.geometry.getAttribute('skinWeight');
    const pos = mesh.geometry.getAttribute('position');
    if (!si || !sw || !pos) return;

    let entry = newSkeletons.get(skel);
    if (!entry) {
      const bones = [...skel.bones, twist as THREE.Bone];
      const inverses = [
        ...skel.boneInverses.map((m) => m.clone()),
        twistInverse.clone(),
      ];
      entry = {
        skel: new THREE.Skeleton(bones, inverses),
        twistIndex: skel.bones.length,
        lowerIndex,
      };
      newSkeletons.set(skel, entry);
    }

    // Back up before mutating, then rebind to the grown skeleton.
    side.meshBackups.push({
      mesh,
      skeleton: skel,
      bindMatrix: mesh.bindMatrix.clone(),
      skinIndex: (si.array as Float32Array).slice(),
      skinWeight: (sw.array as Float32Array).slice(),
    });
    mesh.bind(entry.skel, mesh.bindMatrix.clone());

    // vertex(geometry) → lowerArm-bind-local: boneInverse · bindMatrix.
    _m.copy(skel.boneInverses[lowerIndex]).multiply(mesh.bindMatrix);
    const count = pos.count;
    for (let k = 0; k < count; k++) {
      let slot = -1;
      for (let j = 0; j < 4; j++) {
        if (si.getComponent(k, j) === lowerIndex && sw.getComponent(k, j) > 0) {
          slot = j;
          break;
        }
      }
      if (slot < 0) continue;
      _v.fromBufferAttribute(pos, k).applyMatrix4(_m);
      let t = wristLen2 > 1e-12 ? _v.dot(wristLocal) / wristLen2 : 0;
      t = Math.min(1, Math.max(0, t));
      if (t <= 1e-4) continue;
      const w = sw.getComponent(k, slot);
      sw.setComponent(k, slot, w * (1 - t));
      addWeight(si, sw, k, entry.twistIndex, w * t);
    }
    si.needsUpdate = true;
    sw.needsUpdate = true;
  });
}

// Add `weight` for `index` into a vertex's 4 skin slots: merge if present, else
// take a free slot, else replace the smallest if this weight is larger.
function addWeight(
  si: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  sw: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  k: number,
  index: number,
  weight: number
): void {
  for (let j = 0; j < 4; j++) {
    if (si.getComponent(k, j) === index) {
      sw.setComponent(k, j, sw.getComponent(k, j) + weight);
      return;
    }
  }
  for (let j = 0; j < 4; j++) {
    if (sw.getComponent(k, j) <= 1e-6) {
      si.setComponent(k, j, index);
      sw.setComponent(k, j, weight);
      return;
    }
  }
  let mj = 0;
  let mw = sw.getComponent(k, 0);
  for (let j = 1; j < 4; j++) {
    const wj = sw.getComponent(k, j);
    if (wj < mw) {
      mw = wj;
      mj = j;
    }
  }
  if (weight > mw) {
    si.setComponent(k, mj, index);
    sw.setComponent(k, mj, weight);
  }
}
