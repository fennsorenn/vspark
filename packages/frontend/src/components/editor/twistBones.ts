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
  opts: { force: boolean; excludeSleeves?: boolean; gradient?: number }
): void {
  teardownForearmTwist(nodeId);
  // Fully inert unless the avatar opts in. (Driving a model's *own* twist bone
  // is unsolved — it has its own rest orientation and rig — so we don't touch
  // it; we only synthesize where one is missing.)
  if (!opts.force) return;
  const gradient = opts.gradient ?? DEFAULT_GRADIENT;

  // Build the twist bones against the REST pose, not whatever pose tracking has
  // the avatar in right now. The synthesized bone's bind matrix and the
  // elbow→wrist axis must agree with every other bone's bind reference; reading
  // them off a live, posed skeleton bakes the current pose in and the forearm
  // deforms. The next frame re-applies the real pose.
  vrm.humanoid.resetNormalizedPose();
  (vrm.humanoid as unknown as { update?: () => void }).update?.();
  vrm.scene.updateMatrixWorld(true);

  const sides: SideTwist[] = [];
  for (const side of ['left', 'right'] as Side[]) {
    const lowerArm = vrm.humanoid.getRawBoneNode(
      `${side}LowerArm` as VRMHumanBoneName
    );
    const hand = vrm.humanoid.getRawBoneNode(`${side}Hand` as VRMHumanBoneName);
    if (!lowerArm || !hand) continue;

    // Leave a model's own forearm twist bone alone — the model rigs/drives it.
    if (detectTwistBone(lowerArm, hand)) {
      console.info(
        `[twistBones] ${side}: model already has a twist bone — skipping`
      );
      continue;
    }

    // Forearm axis + wrist position, both in lowerArm-local space (rest pose).
    const handWorld = new THREE.Vector3();
    hand.getWorldPosition(handWorld);
    const wristLocal = lowerArm.worldToLocal(handWorld.clone());
    if (wristLocal.lengthSq() < 1e-9) continue;
    const axis = wristLocal.clone().normalize();

    const twist = new THREE.Bone();
    twist.name = `${lowerArm.name}__synthTwist`;
    twist.position.copy(wristLocal).multiplyScalar(SYNTH_FRACTION);
    lowerArm.add(twist);
    lowerArm.updateMatrixWorld(true);
    const side2 = attachSide(lowerArm, twist, hand, axis, gradient, true);
    reskinForearm(vrm, lowerArm, twist, wristLocal, side2, !!opts.excludeSleeves);
    sides.push(side2);
  }

  if (sides.length) registry.set(nodeId, { sides });
  console.info(`[twistBones] ${nodeId}: synthesized ${sides.length} side(s)`);
}

export function teardownForearmTwist(nodeId: string): void {
  const avatar = registry.get(nodeId);
  if (!avatar) return;
  // Delete up-front so a mid-teardown throw can't leave the per-frame drive
  // running against half-restored state.
  registry.delete(nodeId);
  let meshes = 0;
  try {
    for (const s of avatar.sides) {
      // Fold the twist bone's rotation back into lowerArm before removing it.
      // The drive left lowerArm de-rolled (q·T⁻ᵍ) with the twist bone holding
      // Tᵍ; lowerArm·twistBone = q, so this restores the original roll. Without
      // it the forearm stays under-rolled until the next pose frame (and looks
      // twisted if the pose isn't re-applied that instant).
      s.lowerArm.quaternion.multiply(s.twistBone.quaternion);
      s.twistBone.quaternion.identity();

      // Restore mesh skinning (synthesized only).
      for (const b of s.meshBackups) {
        b.mesh.bind(b.skeleton, b.bindMatrix);
        const gi = b.mesh.geometry.getAttribute('skinIndex');
        const gw = b.mesh.geometry.getAttribute('skinWeight');
        (gi.array as Float32Array).set(b.skinIndex as ArrayLike<number>);
        (gw.array as Float32Array).set(b.skinWeight as ArrayLike<number>);
        gi.needsUpdate = true;
        gw.needsUpdate = true;
        meshes++;
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
    console.info(
      `[twistBones] ${nodeId}: torn down ${avatar.sides.length} side(s), ${meshes} mesh(es) restored`
    );
  } catch (err) {
    console.error('[twistBones] teardown failed', err);
  }
}

// ── Per-frame drive ──────────────────────────────────────────────────────────

const _q0 = new THREE.Quaternion();
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
    const a = s.axis;
    // Swing–twist about the FIXED forearm axis: the twist is the component of q
    // around `a`, found by projecting the quaternion's vector part onto a. This
    // stays stable and sign-correct near the straight pose — a pure elbow/wave
    // swing (perpendicular to a) yields zero twist, where a shortest-arc swing
    // would leave a spurious twist that flips and makes the forearm jitter.
    const d = _q0.x * a.x + _q0.y * a.y + _q0.z * a.z;
    _twist.set(a.x * d, a.y * d, a.z * d, _q0.w);
    const n2 =
      _twist.x * _twist.x +
      _twist.y * _twist.y +
      _twist.z * _twist.z +
      _twist.w * _twist.w;
    if (n2 < 1e-8) _twist.identity();
    else _twist.normalize();
    // Split by gradient: twistBone = Tᵍ, lowerArm = q · T⁻ᵍ ⇒ product = q, so
    // the hand's world transform is preserved for any gradient.
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
  side: SideTwist,
  excludeSleeves: boolean
): void {
  twist.updateMatrixWorld(true);
  const twistInverse = twist.matrixWorld.clone().invert();
  const wristLen2 = wristLocal.lengthSq();

  // Seed bones for sleeve exclusion: the hand and every finger bone (always
  // skin, never sleeve). `hand` is already reparented under `twist`, so its
  // subtree is exactly hand + fingers.
  const seedBones: THREE.Bone[] = [];
  side.hand.traverse((o) => {
    if ((o as THREE.Bone).isBone) seedBones.push(o as THREE.Bone);
  });

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

    if (excludeSleeves) {
      const seedIndices = seedBones
        .map((b) => skel.bones.indexOf(b))
        .filter((i) => i >= 0);
      excludeSleevesForMesh(mesh, lowerIndex, entry.twistIndex, seedIndices);
    }

    si.needsUpdate = true;
    sw.needsUpdate = true;
  });
}

// Weight a vertex carries for a given bone index (0 if absent).
function weightOf(
  si: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  sw: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  k: number,
  index: number
): number {
  for (let j = 0; j < 4; j++) {
    if (si.getComponent(k, j) === index) return sw.getComponent(k, j);
  }
  return 0;
}

function setWeightForIndex(
  si: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  sw: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  k: number,
  index: number,
  value: number
): void {
  for (let j = 0; j < 4; j++) {
    if (si.getComponent(k, j) === index) {
      sw.setComponent(k, j, value);
      return;
    }
  }
}

// Sleeve exclusion: keep twist weight only on geometry reachable from the hand
// through a connected run of twist-weighted vertices. A loose sleeve is a
// separate shell (own mesh, or a disjoint island) so it never gets reached and
// its twist weight is rolled back onto lowerArm. Vertices are welded by position
// first so UV/material seams don't break connectivity.
const SLEEVE_WELD_EPS = 1e-5;
const SLEEVE_SEED_WEIGHT = 0.5; // hand/finger weight that marks a vertex as skin
const SLEEVE_KEEP_GUARD = 0.1; // if a seeded mesh keeps < this fraction, skip

function excludeSleevesForMesh(
  mesh: THREE.SkinnedMesh,
  lowerIndex: number,
  twistIndex: number,
  seedIndices: number[]
): void {
  const geom = mesh.geometry;
  const index = geom.getIndex();
  const pos = geom.getAttribute('position');
  const si = geom.getAttribute('skinIndex');
  const sw = geom.getAttribute('skinWeight');
  if (!index || !pos) return; // need topology to flood-fill
  const count = pos.count;

  // Weld vertices by quantized position into nodes.
  const keyToNode = new Map<string, number>();
  const vNode = new Int32Array(count);
  let nodeCount = 0;
  const _p = new THREE.Vector3();
  for (let k = 0; k < count; k++) {
    _p.fromBufferAttribute(pos, k);
    const key = `${Math.round(_p.x / SLEEVE_WELD_EPS)}_${Math.round(
      _p.y / SLEEVE_WELD_EPS
    )}_${Math.round(_p.z / SLEEVE_WELD_EPS)}`;
    let n = keyToNode.get(key);
    if (n === undefined) {
      n = nodeCount++;
      keyToNode.set(key, n);
    }
    vNode[k] = n;
  }

  // Per-node flags: has twist weight, is a hand/finger (skin) seed.
  const nodeTwist = new Uint8Array(nodeCount);
  const nodeSeed = new Uint8Array(nodeCount);
  for (let k = 0; k < count; k++) {
    const n = vNode[k];
    if (weightOf(si, sw, k, twistIndex) > 1e-6) nodeTwist[n] = 1;
    if (!nodeSeed[n]) {
      for (const sIdx of seedIndices) {
        if (weightOf(si, sw, k, sIdx) > SLEEVE_SEED_WEIGHT) {
          nodeSeed[n] = 1;
          break;
        }
      }
    }
  }

  // Edge adjacency over welded nodes.
  const adj: Array<Set<number>> = Array.from(
    { length: nodeCount },
    () => new Set<number>()
  );
  const ia = index.array;
  const link = (a: number, b: number) => {
    if (a !== b) {
      adj[a].add(b);
      adj[b].add(a);
    }
  };
  for (let i = 0; i + 2 < ia.length; i += 3) {
    const a = vNode[ia[i]];
    const b = vNode[ia[i + 1]];
    const c = vNode[ia[i + 2]];
    link(a, b);
    link(b, c);
    link(a, c);
  }

  // BFS from seeds; step into a node only if it carries twist weight.
  const keep = new Uint8Array(nodeCount);
  const visited = new Uint8Array(nodeCount);
  const queue: number[] = [];
  let hasSeed = false;
  for (let n = 0; n < nodeCount; n++) {
    if (nodeSeed[n]) {
      visited[n] = 1;
      hasSeed = true;
      if (nodeTwist[n]) keep[n] = 1;
      queue.push(n);
    }
  }
  while (queue.length) {
    const n = queue.pop()!;
    for (const m of adj[n]) {
      if (visited[m]) continue;
      visited[m] = 1;
      if (nodeTwist[m]) {
        keep[m] = 1;
        queue.push(m);
      }
    }
  }

  // Safety: a mesh that HAS skin seeds but keeps almost nothing is a
  // connectivity artifact (e.g. body skin under the sleeve deleted) — skip
  // rather than nuke the twist. A mesh with no seeds at all (a separate sleeve
  // mesh) correctly excludes everything.
  let twistNodes = 0;
  let keptNodes = 0;
  for (let n = 0; n < nodeCount; n++) {
    if (nodeTwist[n]) {
      twistNodes++;
      if (keep[n]) keptNodes++;
    }
  }
  if (hasSeed && twistNodes > 0 && keptNodes < SLEEVE_KEEP_GUARD * twistNodes)
    return;

  // Roll back twist weight on non-kept vertices: twist slot → lowerArm.
  for (let k = 0; k < count; k++) {
    const n = vNode[k];
    if (!nodeTwist[n] || keep[n]) continue;
    const w = weightOf(si, sw, k, twistIndex);
    if (w <= 1e-6) continue;
    setWeightForIndex(si, sw, k, twistIndex, 0);
    addWeight(si, sw, k, lowerIndex, w);
  }
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
