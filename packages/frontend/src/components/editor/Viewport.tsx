import {
  useRef,
  useEffect,
  useState,
  useMemo,
  useContext,
  useCallback,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Move,
  RotateCw,
  Scaling,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  OrbitControls,
  Grid,
  Line,
  TransformControls,
  Billboard,
} from '@react-three/drei';
import { SafeEnvironment } from '../SafeEnvironment';
import {
  EffectComposer,
  Bloom,
  Vignette,
  ToneMapping,
  BrightnessContrast,
  HueSaturation,
  Sepia,
  DepthOfField,
  ChromaticAberration,
  Pixelation,
  Noise,
  Scanline,
  EffectComposerContext,
  ASCII,
  DotScreen,
  Glitch,
  SMAA,
  TiltShift,
  WaterEffect,
} from '@react-three/postprocessing';
import { SSAOEffect, BlendFunction } from 'postprocessing';
import { DepthEdgeEffect } from './DepthEdgeEffect';
import { GodRaysEffectFixed as GodRaysEffect } from './GodRaysEffectFixed';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { Text as TroikaText } from 'troika-three-text';
import DOMPurify from 'dompurify';
import html2canvas from 'html2canvas';
import { TEXT_SANITIZE_OPTS } from '../../lib/textSanitize';
import { compositeScalars, type ScalarLayer } from '../../compositor';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  compileTemplate,
  FeedContent,
  FeedErrorBoundary,
} from '../../lib/feedTemplate';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import type { VRM, VRMHumanBoneName, VRMPose } from '@pixiv/three-vrm';
import { useEditorStore } from '../../store/editorStore';
import type {
  StageObject,
  Behavior,
  ScheduledAnimation,
  AnimationClipMeta,
} from '../../store/editorStore';
import { editorWsRef, sendNodeTransformPreview } from '../../hooks/useWsSync';
import { useSceneFadeIn } from '../../hooks/useSceneFadeIn';

import type { AnimEntry } from '../../animRegistry';
import {
  getVmcPose,
  getVmcHipOffset,
  getVmcPoseTime,
  getVmcPoseBlendMode,
  getVmcBlendshapes,
} from '../../vmcPoseStore';
import { getIkTargets, getIkTargetsTime } from '../../ikTargetStore';
import { vrmRegistry } from '../../vrmRegistry';
import {
  setupForearmTwist,
  teardownForearmTwist,
  driveForearmTwist,
} from './twistBones';
import {
  applyMaterialOverrides,
  disposeMaterialOverrides,
  getMaterialSlots,
  type MaterialOverrides,
} from './materialOverrides';
import {
  applyArmCalib,
  upperArmNormRotFromTarget,
  DEFAULT_CALIBRATION,
} from '../../calibration';
import type { VmcCalibration } from '../../calibration';
import { VRM_BONE_NAMES } from '@vspark/shared/signal';
import type {
  PoseSection,
  PoseSectionInfluence,
  PoseSource,
} from '@vspark/shared';
import { registerMedia } from './mediaRegistry';
import {
  stackBoneRotation,
  composeHipsPosition,
  trackedComposeActive,
  crossfadeAnimPose,
  crossfadeHipsPosition,
  SourceFade,
  composeBonePose,
  composeHipsPositionBlended,
  TrackedPoseLatch,
} from './poseComposition';
import {
  makeVideoMaterial,
  updateVideoMaterial,
  applyVideoBlend,
  readChroma,
  type VideoBlend3D,
} from './videoFx';
import { api } from '../../api/client';
import { BoneFilterBank } from '../../oneEuroFilter';
import {
  BoneDynamicsBank,
  DEFAULT_POSE_DYNAMICS,
} from '../../secondOrderDynamics';
import {
  mergeParticleConfig,
  createParticlePool,
  tickParticles,
} from '../../particleUtils';
import type { ParticlePool } from '../../particleUtils';
import { resolveParticleTextureUrl } from '../../particleTextures';

type GizmoMode = 'translate' | 'rotate' | 'scale';

// Maps nodeId → outermost Three.js groups for that node. A node can have
// multiple registered groups concurrently when the Scene tab's Viewport and the
// Compose tab's Canvas both mount their own copy of <SceneNodes>. The Scene
// tab's group registers first and stays primary; lookups prefer the first entry.
const nodeGroupRegistry = new Map<string, THREE.Group[]>();

function registerNodeGroup(nodeId: string, group: THREE.Group): () => void {
  const existing = nodeGroupRegistry.get(nodeId);
  if (existing) existing.push(group);
  else nodeGroupRegistry.set(nodeId, [group]);
  return () => {
    const list = nodeGroupRegistry.get(nodeId);
    if (!list) return;
    const idx = list.indexOf(group);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) nodeGroupRegistry.delete(nodeId);
  };
}

/** Walk up an Object3D's parent chain and return the nodeId of the first ancestor
 *  registered as a scene-node root group, or null if none. Lets click handlers
 *  inside the R3F scene map a raycast hit back to its owning scene node. */
export function findNodeIdForObject(obj: THREE.Object3D | null): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    for (const [nodeId, groups] of nodeGroupRegistry) {
      if (groups.includes(cur as THREE.Group)) return nodeId;
    }
    cur = cur.parent;
  }
  return null;
}

/** Get the Three.js group for a given scene node id, or null if unmounted.
 *  Returns the first registered group (the Scene tab's, since it mounts first). */
export function getNodeGroup(nodeId: string): THREE.Group | null {
  const list = nodeGroupRegistry.get(nodeId);
  return list && list.length > 0 ? list[0] : null;
}

/** The registered group for `nodeId` that lives inside `sceneRoot`'s canvas.
 *  Each node is rendered once per Canvas (the always-mounted stage Viewport plus
 *  every camera_view CameraCanvas), so it has one registered group per canvas.
 *  Anything that manipulates a group in a *specific* canvas (e.g. BoneAttacher,
 *  which must reparent the copy in its own scene, not some other canvas's) has
 *  to disambiguate by scene ancestry — `getNodeGroup` alone returns whichever
 *  mounted first and would corrupt the other canvases. */
export function getNodeGroupForScene(
  nodeId: string,
  sceneRoot: THREE.Object3D
): THREE.Group | null {
  const list = nodeGroupRegistry.get(nodeId);
  if (!list) return null;
  for (const g of list) {
    let p: THREE.Object3D | null = g;
    while (p) {
      if (p === sceneRoot) return g;
      p = p.parent;
    }
  }
  return null;
}

/** The VRM instance for an avatar node in a specific canvas. The avatar's group
 *  carries its own per-canvas VRM on `userData.__vrm` (set at load) — unlike the
 *  global `vrmRegistry`, which is last-write-wins across canvases. */
export function getVrmForScene(
  avatarNodeId: string,
  sceneRoot: THREE.Object3D
): VRM | null {
  const group = getNodeGroupForScene(avatarNodeId, sceneRoot);
  return (group?.userData.__vrm as VRM | undefined) ?? null;
}

/** Enumerate `(nodeId, group)` pairs for every registered group. Lets the
 *  Compose interaction layer walk all candidate hit targets cheaply, e.g. to
 *  AABB-test instead of triangle-raycasting the whole scene. */
export function listRegisteredNodeGroups(): Array<[string, THREE.Group]> {
  const out: Array<[string, THREE.Group]> = [];
  for (const [nodeId, groups] of nodeGroupRegistry) {
    for (const g of groups) out.push([nodeId, g]);
  }
  return out;
}

// ── Two-bone analytical IK ──────────────────────────────────────────────────
// Solves root→mid chain so that mid's child (tip) reaches targetWorld.
// Uses the cosine rule. Pole vector = current mid position (preserves elbow side).
// Writes local quaternions directly to the raw bone nodes.

// ─────────────────────────────────────────────────────────────────────────────
// Two-bone IK solver.
//
// Approach: work entirely in the root bone's PARENT-space (i.e. the shoulder's frame).
// In that space, the bone "rest" directions are fixed (root→mid is wherever the upper
// arm points at rest, mid→tip is wherever the forearm points at rest). We solve the
// triangle, then express the final root/mid orientations as local quaternions that
// rotate the rest directions to the solved directions.
//
// This avoids the trap of "apply delta in world space then convert to local" — which
// gets confused by the parent's own rotation contribution to the bone's world frame.
//
// Steps:
//   1. Measure rest-pose vectors u = (mid - root) and v = (tip - mid) in parent space.
//      These are constants for a given rig (assuming the bones don't translate).
//   2. Solve cosine triangle for the angles at A (root) and B (elbow).
//   3. Build target vector u' (root→mid direction in parent space) by:
//      - pointing the upper bone at the target direction tDir (in parent space)
//      - rotating by angA around the bend axis (perpendicular to tDir and pole)
//   4. Root local rotation = rotation that maps u → u'.
//   5. Mid local rotation = rotation that maps v (in root's child frame) → v'
//      where v' is computed in the same parent space as u', then expressed in
//      the now-rotated root's local frame.
// ─────────────────────────────────────────────────────────────────────────────
function _solveTwoBoneIk(
  vrm: VRM,
  rootBoneName: VRMHumanBoneName,
  midBoneName: VRMHumanBoneName,
  targetWorld: THREE.Vector3
): void {
  const rootBone = vrm.humanoid.getRawBoneNode(rootBoneName);
  const midBone = vrm.humanoid.getRawBoneNode(midBoneName);
  if (!rootBone || !midBone) return;
  const rootParent = rootBone.parent;
  if (!rootParent) return;

  const tipBone = midBone.children.find((c) => c instanceof THREE.Bone) as
    | THREE.Bone
    | undefined;

  // ── 1. Rest-pose bone vectors in parent space ─────────────────────────────
  // We use the *current* local position of midBone as the rest offset from root
  // (bones in a skeleton are typically translated, not at origin). Similarly for tip.
  // We assume bone translations are constant; only rotations vary.
  const restU = midBone.position.clone(); // mid offset in root's local space
  // ≡ root→mid direction (scaled) in root's REST local frame
  if (restU.lengthSq() < 1e-9) return;
  const lenAB = restU.length();
  restU.normalize();

  // restV: tip offset in mid's local space (i.e. mid→tip in mid's rest frame).
  let restV: THREE.Vector3;
  let lenBC: number;
  if (tipBone) {
    restV = tipBone.position.clone();
    lenBC = restV.length();
    if (lenBC < 1e-9) return;
    restV.normalize();
  } else {
    // No tip bone — assume forearm continues along upper arm direction
    restV = restU.clone();
    lenBC = lenAB;
  }

  // ── 2. Convert target into parent space ──────────────────────────────────
  // posA in parent space = rootBone's local position (since rootBone is a child of rootParent).
  // But for the math we just need (target - posA_world) expressed in parent space.
  const parentWorldInv = new THREE.Matrix4()
    .copy(rootParent.matrixWorld)
    .invert();
  const targetParent = targetWorld.clone().applyMatrix4(parentWorldInv);
  // root's position in parent space = rootBone.position (local).
  const rootInParent = rootBone.position.clone();
  const toTarget = targetParent.clone().sub(rootInParent);
  let lenAT = toTarget.length();
  if (lenAT < 1e-6) return;
  const maxReach = lenAB + lenBC - 1e-4;
  if (lenAT > maxReach) lenAT = maxReach;
  const tDir = toTarget.normalize(); // root→target direction, in parent space

  // ── 3. Cosine rule ────────────────────────────────────────────────────────
  const cosA =
    (lenAB * lenAB + lenAT * lenAT - lenBC * lenBC) / (2 * lenAB * lenAT);
  const angA = Math.acos(Math.max(-1, Math.min(1, cosA)));

  // ── 4. Bend axis ──────────────────────────────────────────────────────────
  // Pole hint in parent space: elbows should bend "behind" the chest. The chest's local
  // -Z is "behind", so in parent space we want -Z. We also want a small -Y so the elbow
  // points slightly down. We orthogonalise this against tDir to get the in-plane pole.
  const poleHint = new THREE.Vector3(0, -0.3, -1).normalize();
  const poleProj = poleHint
    .clone()
    .sub(tDir.clone().multiplyScalar(poleHint.dot(tDir)));
  let poleDir: THREE.Vector3;
  if (poleProj.lengthSq() < 1e-6) {
    // Target direction parallel to hint — fall back to using the current restU's perp
    const fallback = restU
      .clone()
      .sub(tDir.clone().multiplyScalar(restU.dot(tDir)));
    poleDir =
      fallback.lengthSq() > 1e-6
        ? fallback.normalize()
        : new THREE.Vector3(0, -1, 0);
  } else {
    poleDir = poleProj.normalize();
  }
  // bendAxis = cross(tDir, poleDir) — rotating tDir by +angA around bendAxis bends TOWARD pole.
  const bendAxis = new THREE.Vector3().crossVectors(tDir, poleDir).normalize();
  if (bendAxis.lengthSq() < 1e-6) return;

  // ── 5. Desired upper-arm direction in parent space ───────────────────────
  // Rotate tDir by angA around bendAxis (away from straight-at-target, toward pole).
  // Actually: root→mid direction = rotate tDir by -angA around bendAxis (the elbow's outside angle).
  // The triangle has vertex A; the angle at A is between sides AB and AT. So AB direction is
  // tDir rotated by angA AWAY from AT direction toward the side opposite the pole.
  // We want the elbow on the pole side, so AB should rotate by -angA around bendAxis
  // (since bendAxis was constructed as cross(tDir, poleDir), rotating tDir by +ang around it
  // moves toward poleDir).
  const qRotU = new THREE.Quaternion().setFromAxisAngle(bendAxis, angA);
  const desiredU = tDir.clone().applyQuaternion(qRotU).normalize();

  // Root local rotation: rotates restU → desiredU.
  const rootLocalQ = new THREE.Quaternion().setFromUnitVectors(restU, desiredU);
  rootBone.quaternion.copy(rootLocalQ);
  rootBone.updateWorldMatrix(true, false);

  // ── 6. Mid bone ──────────────────────────────────────────────────────────
  // Desired mid→tip direction in parent space:
  // The elbow is at A + desiredU * lenAB. The tip is at target (clamped to lenAT).
  // So mid→tip direction (parent space) = (rootInParent + tDir*lenAT) - (rootInParent + desiredU*lenAB)
  //                                     = tDir*lenAT - desiredU*lenAB, then normalize.
  const desiredVparent = tDir
    .clone()
    .multiplyScalar(lenAT)
    .sub(desiredU.clone().multiplyScalar(lenAB));
  if (desiredVparent.lengthSq() < 1e-6) return;
  desiredVparent.normalize();

  // We need this in the mid bone's parent space, which is the now-rotated rootBone's local space.
  // desiredVparent is in rootParent space. To get it in rootBone's local space:
  //   v_rootLocal = inv(rootLocalQ) * desiredVparent
  const desiredVrootLocal = desiredVparent
    .clone()
    .applyQuaternion(rootLocalQ.clone().invert());

  // Mid local rotation: rotates restV → desiredVrootLocal (both in mid's parent / root's local space).
  const midLocalQ = new THREE.Quaternion().setFromUnitVectors(
    restV,
    desiredVrootLocal
  );
  midBone.quaternion.copy(midLocalQ);
  midBone.updateWorldMatrix(true, false);
}

/** Imperatively parents a node's group into a VRM bone so it follows the bone's transform. */
function BoneAttacher({
  avatarNodeId,
  boneName,
  nodeId,
}: {
  avatarNodeId: string;
  boneName: string;
  nodeId: string;
}) {
  const { scene } = useThree();
  useEffect(() => {
    // Resolve the group AND the bone in *this* canvas only — the node and the
    // avatar are each rendered in every canvas, so using the global registries
    // here would reparent one canvas's group into another canvas's bone and
    // leave a stray flat-mounted copy behind (the "duplicate" bug).
    const group = getNodeGroupForScene(nodeId, scene);
    const vrm = getVrmForScene(avatarNodeId, scene);
    if (!group || !vrm) return;
    const bone = vrm.humanoid.getRawBoneNode(boneName as VRMHumanBoneName);
    if (!bone) return;
    // Re-parent under the bone without touching the group's local transform:
    // the node's position/rotation/scale (applied declaratively via props) then
    // become bone-local, so translation and rotation are relative to bone space
    // rather than being discarded.
    bone.add(group);
    return () => {
      // Restore to scene root on detach so Three.js doesn't orphan it
      scene.add(group);
    };
  });
  return null;
}

// Maps nodeId → sun mesh, used by the implicit GodRays postprocessing pass
const godrayCasterRegistry = new Map<string, THREE.Mesh>();

// Mixamo rig bone name → VRM humanoid bone name (used by FBX animation retargeting)
const MIXAMO_TO_VRM: Record<string, VRMHumanBoneName> = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
  mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
  mixamorigLeftHandThumb2: 'leftThumbProximal',
  mixamorigLeftHandThumb3: 'leftThumbDistal',
  mixamorigLeftHandIndex1: 'leftIndexProximal',
  mixamorigLeftHandIndex2: 'leftIndexIntermediate',
  mixamorigLeftHandIndex3: 'leftIndexDistal',
  mixamorigLeftHandMiddle1: 'leftMiddleProximal',
  mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
  mixamorigLeftHandMiddle3: 'leftMiddleDistal',
  mixamorigLeftHandRing1: 'leftRingProximal',
  mixamorigLeftHandRing2: 'leftRingIntermediate',
  mixamorigLeftHandRing3: 'leftRingDistal',
  mixamorigLeftHandPinky1: 'leftLittleProximal',
  mixamorigLeftHandPinky2: 'leftLittleIntermediate',
  mixamorigLeftHandPinky3: 'leftLittleDistal',
  mixamorigRightHandThumb1: 'rightThumbMetacarpal',
  mixamorigRightHandThumb2: 'rightThumbProximal',
  mixamorigRightHandThumb3: 'rightThumbDistal',
  mixamorigRightHandIndex1: 'rightIndexProximal',
  mixamorigRightHandIndex2: 'rightIndexIntermediate',
  mixamorigRightHandIndex3: 'rightIndexDistal',
  mixamorigRightHandMiddle1: 'rightMiddleProximal',
  mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
  mixamorigRightHandMiddle3: 'rightMiddleDistal',
  mixamorigRightHandRing1: 'rightRingProximal',
  mixamorigRightHandRing2: 'rightRingIntermediate',
  mixamorigRightHandRing3: 'rightRingDistal',
  mixamorigRightHandPinky1: 'rightLittleProximal',
  mixamorigRightHandPinky2: 'rightLittleIntermediate',
  mixamorigRightHandPinky3: 'rightLittleDistal',
};

// UE4 / Unreal Engine Mannequin skeleton
const UE4_TO_VRM: Record<string, VRMHumanBoneName> = {
  pelvis: 'hips',
  spine_01: 'spine',
  spine_02: 'chest',
  spine_03: 'upperChest',
  neck_01: 'neck',
  head: 'head',
  clavicle_l: 'leftShoulder',
  upperarm_l: 'leftUpperArm',
  lowerarm_l: 'leftLowerArm',
  hand_l: 'leftHand',
  clavicle_r: 'rightShoulder',
  upperarm_r: 'rightUpperArm',
  lowerarm_r: 'rightLowerArm',
  hand_r: 'rightHand',
  thigh_l: 'leftUpperLeg',
  calf_l: 'leftLowerLeg',
  foot_l: 'leftFoot',
  ball_l: 'leftToes',
  thigh_r: 'rightUpperLeg',
  calf_r: 'rightLowerLeg',
  foot_r: 'rightFoot',
  ball_r: 'rightToes',
  thumb_01_l: 'leftThumbMetacarpal',
  thumb_02_l: 'leftThumbProximal',
  thumb_03_l: 'leftThumbDistal',
  index_01_l: 'leftIndexProximal',
  index_02_l: 'leftIndexIntermediate',
  index_03_l: 'leftIndexDistal',
  middle_01_l: 'leftMiddleProximal',
  middle_02_l: 'leftMiddleIntermediate',
  middle_03_l: 'leftMiddleDistal',
  ring_01_l: 'leftRingProximal',
  ring_02_l: 'leftRingIntermediate',
  ring_03_l: 'leftRingDistal',
  pinky_01_l: 'leftLittleProximal',
  pinky_02_l: 'leftLittleIntermediate',
  pinky_03_l: 'leftLittleDistal',
  thumb_01_r: 'rightThumbMetacarpal',
  thumb_02_r: 'rightThumbProximal',
  thumb_03_r: 'rightThumbDistal',
  index_01_r: 'rightIndexProximal',
  index_02_r: 'rightIndexIntermediate',
  index_03_r: 'rightIndexDistal',
  middle_01_r: 'rightMiddleProximal',
  middle_02_r: 'rightMiddleIntermediate',
  middle_03_r: 'rightMiddleDistal',
  ring_01_r: 'rightRingProximal',
  ring_02_r: 'rightRingIntermediate',
  ring_03_r: 'rightRingDistal',
  pinky_01_r: 'rightLittleProximal',
  pinky_02_r: 'rightLittleIntermediate',
  pinky_03_r: 'rightLittleDistal',
};

// Combined map used at runtime — whichever bones are present in the FBX win.
const FBX_BONE_TO_VRM: Record<string, VRMHumanBoneName> = {
  ...MIXAMO_TO_VRM,
  ...UE4_TO_VRM,
};
// Hips bone names across all supported rigs (used for root position track).
const HIPS_BONE_NAMES = new Set(['mixamorigHips', 'pelvis']);

// ── Partial tracking: map every VRM humanoid bone to a body section so each
//    section can independently blend animation vs. live tracking. ────────────
const POSE_SECTION_BONES: Record<PoseSection, string[]> = {
  body: ['spine', 'chest', 'upperChest'],
  head: ['neck', 'head', 'jaw'],
  gaze: ['leftEye', 'rightEye'],
  arms: [
    'leftShoulder',
    'leftUpperArm',
    'leftLowerArm',
    'leftHand',
    'rightShoulder',
    'rightUpperArm',
    'rightLowerArm',
    'rightHand',
  ],
  // The hips lead the lower body, so both its rotation (here) and its root
  // position (see composeHipsPosition) follow the legs section.
  legs: [
    'hips',
    'leftUpperLeg',
    'leftLowerLeg',
    'leftFoot',
    'leftToes',
    'rightUpperLeg',
    'rightLowerLeg',
    'rightFoot',
    'rightToes',
  ],
  // Every remaining bone (all finger bones) belongs to 'hands'.
  hands: [],
};

/** boneName → section. Bones not explicitly listed fall under 'hands' (fingers). */
const BONE_TO_SECTION: Record<string, PoseSection> = (() => {
  const m: Record<string, PoseSection> = {};
  for (const [section, bones] of Object.entries(POSE_SECTION_BONES) as [
    PoseSection,
    string[],
  ][]) {
    for (const b of bones) m[b] = section;
  }
  for (const name of VRM_BONE_NAMES as unknown as string[]) {
    if (!(name in m)) m[name] = 'hands';
  }
  return m;
})();

const DEFAULT_SECTION_INFLUENCE: PoseSectionInfluence = { anim: 1, track: 1 };

/** Resolve a bone's { anim, track } influence from a node's poseSource map,
 *  defaulting absent sections to { anim: 1, track: 1 } (legacy behaviour). */
function sectionInfluenceForBone(
  boneName: string,
  poseSource: PoseSource | undefined
): PoseSectionInfluence {
  if (!poseSource) return DEFAULT_SECTION_INFLUENCE;
  const section = BONE_TO_SECTION[boneName];
  return poseSource[section] ?? DEFAULT_SECTION_INFLUENCE;
}

// Hips root-motion scratch (captured pre/post resetNormalizedPose, fed to
// composeHipsPosition). The per-frame loop is single-threaded, so module-scoped
// scratch avoids per-frame allocation.
const _hipsAnimPos = new THREE.Vector3();
const _hipsRestPos = new THREE.Vector3();

/**
 * Add the stylizer's body shift on top of whatever root motion already resolved.
 *
 * The offset arrives as fractions of the avatar's HIP HEIGHT rather than scene
 * units, so a rig authored on one model displaces proportionally on a taller or
 * shorter one. The rest hips height is the scale reference — for a VRM humanoid
 * the hips sit directly under the armature root, so its rest Y is the avatar's
 * hip height in its own units.
 *
 * Additive on purpose: root motion from a clip and a stylized weight-shift are
 * different things and should compose, not fight.
 */
function applyHipShift(
  offset: [number, number, number] | null,
  restPos: THREE.Vector3,
  outPos: THREE.Vector3
): void {
  if (!offset) return;
  const scale = Math.abs(restPos.y) || 1;
  outPos.x += offset[0] * scale;
  outPos.y += offset[1] * scale;
  outPos.z += offset[2] * scale;
}
// Scratch for the animation-source cross-fade (per-bone, single-threaded loop).
const _fadeScratchQ = new THREE.Quaternion();
const _fadeScratchV = new THREE.Vector3();

/**
 * A **shadow skeleton**: a bone-only hierarchy, name-matched to the VRM's raw
 * humanoid bones, that exists purely as the clip mixer's write target.
 *
 * ### Why this exists
 *
 * There is only ever one place a bone rotation lives — `bone.quaternion` on the
 * skeleton. `mixer.update()` writes into it, and the composition step's result is
 * written into it too. So the composition's *animation baseline* and its *output*
 * were the same memory, and each frame's output became the next frame's baseline.
 *
 * That stayed invisible only because Step 1's mixer overwrote the bones before
 * Step 2 read them. But `THREE.PropertyMixer` is **change-driven**: it caches the
 * value it last wrote and skips the write when the freshly interpolated value is
 * identical — and it compares against its own cache, not against the bone, so it
 * cannot tell that something else clobbered the bone in between.
 *
 * A clip whose playhead never moves therefore stops writing after its first
 * frame. A **static single-keyframe pose** (Mixamo "… Pose" exports: one rotation
 * key, so `_anchoredTime` returns 0 forever) hits this immediately, and from frame
 * 2 the baseline read back the previous frame's *composed* pose — i.e. tracking.
 * Observed as: Anim 1 / Track 0 showing the tracked pose, and Track 1 compounding
 * tracking onto itself every frame. Long animations hid the bug because their
 * playhead advances, so the mixer always writes.
 *
 * Pointing the mixer at its own hierarchy dissolves the whole class of problem
 * rather than timing around it: the animation pose gets a buffer nothing else
 * writes to. A skipped mixer write is then *correct* — the shadow bone simply
 * retains the right pose — so static and multi-key clips take an identical path
 * with no special-casing. `Object3D.quaternion` is read-only so the buffer cannot
 * be swapped in directly; a parallel hierarchy is the equivalent, and works
 * because `AnimationMixer` binds by name path (`${bone.name}.quaternion`).
 */
class ShadowSkeleton {
  /** Root of the shadow hierarchy — the mixer's binding root. */
  readonly root = new THREE.Object3D();
  private bones = new Map<VRMHumanBoneName, THREE.Bone>();
  /** VRM bone name → shadow bone name, for retarget track naming. */
  private nameOf = new Map<VRMHumanBoneName, string>();

  /**
   * Build a hierarchy mirroring the VRM's raw humanoid bones — same names, same
   * parent/child structure, no meshes or skinning. Parent links follow the VRM's
   * own bone parentage so a mixer-driven local rotation composes the same way.
   */
  constructor(vrm: VRM, boneNames: readonly VRMHumanBoneName[]) {
    const made = new Map<VRMHumanBoneName, THREE.Bone>();
    const realOf = new Map<VRMHumanBoneName, THREE.Object3D>();
    for (const name of boneNames) {
      const real = vrm.humanoid.getRawBoneNode(name);
      if (!real) continue;
      realOf.set(name, real);
      const b = new THREE.Bone();
      // Match the real bone's NAME so baked tracks (`${bone.name}.quaternion`)
      // bind here, and seed its rest transform so local→world math matches.
      b.name = real.name;
      b.position.copy(real.position);
      b.quaternion.copy(real.quaternion);
      b.scale.copy(real.scale);
      made.set(name, b);
      this.nameOf.set(name, real.name);
    }
    // Re-create parentage: attach each shadow bone under the shadow copy of its
    // real parent, falling back to the root when the parent isn't a humanoid bone.
    for (const [name, b] of made) {
      const real = realOf.get(name)!;
      let parentName: VRMHumanBoneName | null = null;
      for (const [otherName, otherReal] of realOf) {
        if (otherReal === real.parent) {
          parentName = otherName;
          break;
        }
      }
      const parent = parentName ? made.get(parentName) : null;
      (parent ?? this.root).add(b);
    }
    this.bones = made;
  }

  /** The shadow bone for a VRM humanoid bone, if it exists. */
  get(name: VRMHumanBoneName): THREE.Bone | undefined {
    return this.bones.get(name);
  }

  /** The clip-driven local rotation for a bone — the animation buffer. */
  rotation(name: VRMHumanBoneName): THREE.Quaternion | null {
    return this.bones.get(name)?.quaternion ?? null;
  }

  /** The clip-driven hips position (root motion). */
  hipsPosition(): THREE.Vector3 | null {
    return this.bones.get('hips')?.position ?? null;
  }

  /** How many humanoid bones this shadow mirrors (diagnostics). */
  get size(): number {
    return this.bones.size;
  }

  /** Names present, for verifying a clip's tracks resolve here. */
  boneNames(): string[] {
    return [...this.nameOf.values()];
  }
}

interface VmcRetarget {
  bonesInOrder: VRMHumanBoneName[];
  vrmBoneObj: Partial<Record<VRMHumanBoneName, THREE.Object3D>>;
  vrmBoneParent: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>>;
  vrmBindWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>;
  vrmBindWQInv: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>;
  curUnityWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>;
  curVRMWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>;
  normalizedPose: VRMPose;
  _q: THREE.Quaternion;
  _delta: THREE.Quaternion;
  _inv: THREE.Quaternion;
}

/**
 * Compute the Y rotation (radians) that makes a freshly-loaded VRM face the
 * camera (world +Z), derived from the rest-pose skeleton rather than the VRM
 * version flag.
 *
 * The avatar's anatomical front is `(leftUpperArm − rightUpperArm) × (hips →
 * head)`. Bone positions are read in `vrmScene`-local space (so the result is
 * independent of any node/group transform above it), the front is flattened to
 * the XZ plane, and we return the yaw that rotates it onto +Z. Falls back to
 * `Math.PI` (the historical default) if the needed bones are missing or the
 * skeleton is degenerate.
 */
function faceCameraYaw(vrm: VRM, vrmScene: THREE.Object3D): number {
  vrmScene.rotation.y = 0;
  vrmScene.updateWorldMatrix(true, true);
  const toLocal = new THREE.Matrix4().copy(vrmScene.matrixWorld).invert();
  const localPos = (name: VRMHumanBoneName): THREE.Vector3 | null => {
    const bone = vrm.humanoid.getRawBoneNode(name);
    if (!bone) return null;
    return bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(toLocal);
  };
  const lArm = localPos('leftUpperArm');
  const rArm = localPos('rightUpperArm');
  const hips = localPos('hips');
  const head = localPos('head') ?? localPos('neck') ?? localPos('upperChest');
  if (!lArm || !rArm || !hips || !head) return Math.PI;
  const right = lArm.sub(rArm);
  const up = head.sub(hips);
  const front = right.cross(up); // anatomical front in vrmScene-local space
  front.y = 0;
  if (front.lengthSq() < 1e-8) return Math.PI;
  // Yaw θ s.t. R_y(θ) maps the local front onto +Z (see derivation in fix notes).
  return Math.atan2(-front.x, front.z);
}

function buildVmcRetarget(vrm: VRM): VmcRetarget {
  const allNames = VRM_BONE_NAMES as unknown as VRMHumanBoneName[];

  const vrmBoneObj: Partial<Record<VRMHumanBoneName, THREE.Object3D>> = {};
  for (const n of allNames) {
    const b = vrm.humanoid.getRawBoneNode(n);
    if (b) vrmBoneObj[n] = b;
  }

  const nodeToName = new Map<THREE.Object3D, VRMHumanBoneName>();
  for (const [n, b] of Object.entries(vrmBoneObj))
    nodeToName.set(b!, n as VRMHumanBoneName);

  const vrmBoneParent: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>> = {};
  for (const n of allNames) {
    const b = vrmBoneObj[n];
    if (!b) continue;
    let par = b.parent,
      limit = 64;
    while (par && limit-- > 0) {
      const m = nodeToName.get(par);
      if (m) {
        vrmBoneParent[n] = m;
        break;
      }
      par = par.parent;
    }
  }

  const depthCache: Record<string, number> = {};
  const getDepth = (n: VRMHumanBoneName): number => {
    if (depthCache[n] !== undefined) return depthCache[n];
    return (depthCache[n] = vrmBoneParent[n]
      ? getDepth(vrmBoneParent[n]!) + 1
      : 0);
  };
  const bonesInOrder = allNames
    .filter((n) => vrmBoneObj[n])
    .sort((a, b) => getDepth(a) - getDepth(b));

  // VRM bind world Qs — same as FBX retargeting phase 2
  const vrmBindWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  const vrmBindWQInv: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  for (const vn of bonesInOrder) {
    const bone = vrmBoneObj[vn]!;
    const pWQ = vrmBoneParent[vn] ? vrmBindWQ[vrmBoneParent[vn]!] : undefined;
    const wq = pWQ
      ? pWQ.clone().multiply(bone.quaternion)
      : bone.quaternion.clone();
    vrmBindWQ[vn] = wq;
    vrmBindWQInv[vn] = wq.clone().invert();
  }

  const curUnityWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  const curVRMWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  for (const vn of bonesInOrder) {
    curUnityWQ[vn] = new THREE.Quaternion();
    curVRMWQ[vn] = new THREE.Quaternion();
  }

  return {
    bonesInOrder,
    vrmBoneObj,
    vrmBoneParent,
    vrmBindWQ,
    vrmBindWQInv,
    curUnityWQ,
    curVRMWQ,
    normalizedPose: {},
    _q: new THREE.Quaternion(),
    _delta: new THREE.Quaternion(),
    _inv: new THREE.Quaternion(),
  };
}

function addBoneAxes(root: THREE.Object3D, size: number) {
  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    const axes = new THREE.AxesHelper(size);
    const mat = axes.material as THREE.Material | THREE.Material[];
    const setDepth = (m: THREE.Material) => {
      m.depthTest = false;
      m.depthWrite = false;
    };
    Array.isArray(mat) ? mat.forEach(setDepth) : setDepth(mat);
    axes.renderOrder = 999;
    obj.add(axes);
  });
}
void addBoneAxes; // retained for debugging — re-enable calls above when needed

interface Transform {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  sx: number;
  sy: number;
  sz: number;
  /** Uniform descendant-mesh opacity (1 = fully opaque). Persisted on
   *  components.transform; applied per-frame by useApplyMeshFlags. */
  opacity: number;
  /** Whether this node's descendant meshes cast shadows. Only has a visible
   *  effect when the active camera has shadows enabled. Default true. */
  castShadow: boolean;
  /** Whether this node's descendant meshes receive shadows. Default true. */
  receiveShadow: boolean;
}

function getTransform(node: StageObject): Transform {
  const t = node.components?.transform as Partial<Transform> | undefined;
  return {
    x: t?.x ?? 0,
    y: t?.y ?? 0,
    z: t?.z ?? 0,
    rx: t?.rx ?? 0,
    ry: t?.ry ?? 0,
    rz: t?.rz ?? 0,
    sx: t?.sx ?? 1,
    sy: t?.sy ?? 1,
    sz: t?.sz ?? 1,
    opacity: t?.opacity ?? 1,
    castShadow: t?.castShadow ?? true,
    receiveShadow: t?.receiveShadow ?? true,
  };
}

/** Hook: subscribe to this node's track-clip and runtime overrides and return a
 *  transform with both merged on top of the persisted base. Per-node
 *  subscription keeps the re-render blast radius tight.
 *
 *  Resolution order per field: track-clip override > runtime override > base
 *  (the shared {@link compositeScalars} fold applies the clip layer last, so it
 *  wins). See dev-notes/plans/unified-sync-layer.md. */
function useTransformWithOverride(node: StageObject): Transform {
  const clipOverride = useEditorStore((s) => s.nodeTransformOverrides[node.id]);
  const runtimeOverride = useEditorStore(
    (s) => s.runtimeNodeOverrides[node.id]
  );
  const base = getTransform(node);
  if (!clipOverride && !runtimeOverride) return base;
  // Base + both override layers keyed by paramPath, folded low → high.
  const baseMap = {
    'position.x': base.x,
    'position.y': base.y,
    'position.z': base.z,
    'rotation.x': base.rx,
    'rotation.y': base.ry,
    'rotation.z': base.rz,
    'scale.x': base.sx,
    'scale.y': base.sy,
    'scale.z': base.sz,
    opacity: base.opacity,
  };
  const clipLayer: ScalarLayer = clipOverride
    ? {
        'position.x': clipOverride.position?.x,
        'position.y': clipOverride.position?.y,
        'position.z': clipOverride.position?.z,
        'rotation.x': clipOverride.rotation?.x,
        'rotation.y': clipOverride.rotation?.y,
        'rotation.z': clipOverride.rotation?.z,
        'scale.x': clipOverride.scale?.x,
        'scale.y': clipOverride.scale?.y,
        'scale.z': clipOverride.scale?.z,
        opacity: clipOverride.opacity,
      }
    : undefined;
  const r = compositeScalars(baseMap, [
    runtimeOverride as ScalarLayer,
    clipLayer,
  ]);
  return {
    ...base,
    x: r['position.x'],
    y: r['position.y'],
    z: r['position.z'],
    rx: r['rotation.x'],
    ry: r['rotation.y'],
    rz: r['rotation.z'],
    sx: r['scale.x'],
    sy: r['scale.y'],
    sz: r['scale.z'],
    opacity: r.opacity,
  };
}

/** Per-frame mesh-material opacity walk. Sets `transparent` + `opacity` on
 *  every descendant material, caching the last applied value per material so
 *  we skip writes when unchanged. When `opacity >= 1` we restore the
 *  material's original `transparent` flag (false), so opaque rendering stays
 *  cheap when not animating. Used by nodes that don't participate in shadows
 *  (text, billboards, particles); avatar/model nodes use useApplyMeshFlags. */
function useApplyOpacity(
  groupRef: React.RefObject<THREE.Object3D | null>,
  opacity: number
): void {
  const cacheRef = useRef(
    new WeakMap<
      THREE.Material,
      { lastOpacity: number; origTransparent: boolean }
    >()
  );
  useFrame(() => {
    const root = groupRef.current;
    if (!root) return;
    const cache = cacheRef.current;
    root.traverse((obj) => {
      const m = (obj as THREE.Mesh).material as
        | THREE.Material
        | THREE.Material[]
        | undefined;
      if (!m) return;
      const arr = Array.isArray(m) ? m : [m];
      for (const mat of arr) {
        let entry = cache.get(mat);
        if (!entry) {
          entry = { lastOpacity: 1, origTransparent: mat.transparent };
          cache.set(mat, entry);
        }
        if (entry.lastOpacity === opacity) continue;
        if (opacity >= 1) {
          mat.opacity = 1;
          mat.transparent = entry.origTransparent;
        } else {
          mat.opacity = Math.max(0, opacity);
          mat.transparent = true;
        }
        mat.needsUpdate = true;
        entry.lastOpacity = opacity;
      }
    });
  });
}

/** Per-frame mesh walk that applies descendant material opacity and the
 *  node's shadow cast/receive flags. Caches the last applied opacity per
 *  material so we skip writes when unchanged; for shadows we compare the
 *  cheap booleans on each mesh directly. When `opacity >= 1` we restore the
 *  material's original `transparent` flag (false), so opaque rendering stays
 *  cheap when not animating. Toggling `receiveShadow` forces a material
 *  recompile (shadow receiving is baked into the shader). */
function useApplyMeshFlags(
  groupRef: React.RefObject<THREE.Object3D | null>,
  opacity: number,
  castShadow: boolean,
  receiveShadow: boolean
): void {
  // Cache per-material: last opacity applied + the original `transparent` flag.
  const cacheRef = useRef(
    new WeakMap<
      THREE.Material,
      { lastOpacity: number; origTransparent: boolean }
    >()
  );
  useFrame(() => {
    const root = groupRef.current;
    if (!root) return;
    const cache = cacheRef.current;
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      const arr = Array.isArray(m) ? m : [m];

      // Shadow flags live on the mesh (Object3D). castShadow is a no-op until
      // the next shadow-map render; receiveShadow needs a shader recompile.
      if (mesh.castShadow !== castShadow) mesh.castShadow = castShadow;
      const recvChanged = mesh.receiveShadow !== receiveShadow;
      if (recvChanged) mesh.receiveShadow = receiveShadow;

      for (const mat of arr) {
        if (recvChanged) mat.needsUpdate = true;
        let entry = cache.get(mat);
        if (!entry) {
          entry = { lastOpacity: 1, origTransparent: mat.transparent };
          cache.set(mat, entry);
        }
        if (entry.lastOpacity === opacity) continue;
        if (opacity >= 1) {
          mat.opacity = 1;
          mat.transparent = entry.origTransparent;
        } else {
          mat.opacity = Math.max(0, opacity);
          mat.transparent = true;
        }
        mat.needsUpdate = true;
        entry.lastOpacity = opacity;
      }
    });
  });
}

/** Send the avatar's expression list to the backend so it can serve GET /expressions. */
function _sendExpressionsReport(nodeId: string, expressions: string[]): void {
  const ws = editorWsRef.current;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({ kind: 'avatar_expressions_report', nodeId, expressions })
  );
}

/** Playback layer driving a clock-anchored playhead. `startEpoch` is in this
 *  client's clock; 0 means "anchored to the epoch" (the idle base loop, so every
 *  client lands on the same phase). */
interface ActiveAnimLayer {
  startEpoch: number;
  speed: number;
  loop: boolean;
}

/** The playhead (seconds into the clip) for a layer at `nowMs`, given the clip's
 *  effective `duration`. Looping wraps modulo duration; a finite layer clamps
 *  (holds the last frame past its end). Speed is baked into the elapsed time, so
 *  the mixer is advanced with `update(0)` — never free-run. */
function _anchoredTime(
  nowMs: number,
  layer: ActiveAnimLayer,
  duration: number
): number {
  if (duration <= 0) return 0;
  const elapsed = ((nowMs - layer.startEpoch) / 1000) * layer.speed;
  if (layer.loop) {
    const m = elapsed % duration;
    return m < 0 ? m + duration : m;
  }
  return Math.min(Math.max(elapsed, 0), duration);
}

/**
 * Resolve which clip should play on an avatar right now from its idle config +
 * scheduled timeline, anchored to the synced clock (`nowMs`). The active entry
 * is the latest scheduled entry that has started, resolves to a known clip, and
 * (for a finite, non-looping entry) hasn't ended; otherwise the idle base loop.
 * Returns the clip URL to load, the playback layer, and ms until the active
 * entry next changes (for re-resolution scheduling) — any field may be null.
 */
function _resolveAvatarAnimation(
  nodeId: string,
  idle: { url: string; speed: number } | null,
  scheduled: ScheduledAnimation[],
  clips: Record<string, AnimationClipMeta>,
  nowMs: number
): {
  url: string | null;
  layer: ActiveAnimLayer | null;
  msUntilNext: number | null;
} {
  let active: { entry: ScheduledAnimation; clip: AnimationClipMeta } | null =
    null;
  let nextStartMs: number | null = null;
  for (const e of scheduled) {
    if (e.avatarNodeId !== nodeId) continue;
    const clip = clips[e.clipId];
    if (!clip) continue; // not yet synced/preloaded — re-resolves when it lands
    if (e.startEpoch > nowMs) {
      if (nextStartMs == null || e.startEpoch < nextStartMs)
        nextStartMs = e.startEpoch;
      continue;
    }
    const speed = e.speed > 0 ? e.speed : 1;
    const endMs = e.startEpoch + (clip.duration / speed) * 1000;
    if (!e.loop && endMs <= nowMs) continue; // finished, non-looping
    if (!active || e.startEpoch > active.entry.startEpoch)
      active = { entry: e, clip };
  }

  if (active) {
    const speed = active.entry.speed > 0 ? active.entry.speed : 1;
    const endMs = active.entry.loop
      ? null
      : active.entry.startEpoch + (active.clip.duration / speed) * 1000;
    const bounds = [endMs, nextStartMs].filter((x): x is number => x != null);
    return {
      url: active.clip.sourceFilePath,
      layer: {
        startEpoch: active.entry.startEpoch,
        speed,
        loop: active.entry.loop,
      },
      msUntilNext:
        bounds.length > 0 ? Math.max(0, Math.min(...bounds) - nowMs) : null,
    };
  }

  const msUntilNext =
    nextStartMs != null ? Math.max(0, nextStartMs - nowMs) : null;
  if (idle) {
    // Idle base loop anchored to the epoch (shared phase across clients).
    return {
      url: idle.url,
      layer: {
        startEpoch: 0,
        speed: idle.speed > 0 ? idle.speed : 1,
        loop: true,
      },
      msUntilNext,
    };
  }
  return { url: null, layer: null, msUntilNext };
}

/**
 * Resolve only the **scheduled** timeline entry active right now — no idle/base
 * fallback. Used to drive the `scheduled` clip slot independently of the loop
 * slots, so a one-shot can be faded against whatever loop is playing underneath
 * instead of replacing it outright.
 *
 * Same selection rules as `_resolveAvatarAnimation`: the latest entry that has
 * started, resolves to a known clip, and (when finite and non-looping) hasn't
 * ended. `endsAtMs` is null for a looping entry (it never retires on its own).
 */
function _resolveScheduledAnimation(
  nodeId: string,
  scheduled: ScheduledAnimation[],
  clips: Record<string, AnimationClipMeta>,
  nowMs: number
): {
  url: string | null;
  layer: ActiveAnimLayer | null;
  /** When this entry stops being active, for fade-out scheduling. */
  endsAtMs: number | null;
  /** When the next not-yet-started entry begins, for re-resolution. */
  nextStartMs: number | null;
} {
  let active: { entry: ScheduledAnimation; clip: AnimationClipMeta } | null =
    null;
  let nextStartMs: number | null = null;
  for (const e of scheduled) {
    if (e.avatarNodeId !== nodeId) continue;
    const clip = clips[e.clipId];
    if (!clip) continue; // not yet synced/preloaded — re-resolves when it lands
    if (e.startEpoch > nowMs) {
      if (nextStartMs == null || e.startEpoch < nextStartMs)
        nextStartMs = e.startEpoch;
      continue;
    }
    const speed = e.speed > 0 ? e.speed : 1;
    const endMs = e.startEpoch + (clip.duration / speed) * 1000;
    if (!e.loop && endMs <= nowMs) continue; // finished, non-looping
    if (!active || e.startEpoch > active.entry.startEpoch)
      active = { entry: e, clip };
  }
  if (!active) return { url: null, layer: null, endsAtMs: null, nextStartMs };
  const speed = active.entry.speed > 0 ? active.entry.speed : 1;
  return {
    url: active.clip.sourceFilePath,
    layer: {
      startEpoch: active.entry.startEpoch,
      speed,
      loop: active.entry.loop,
    },
    endsAtMs: active.entry.loop
      ? null
      : active.entry.startEpoch + (active.clip.duration / speed) * 1000,
    nextStartMs,
  };
}

/**
 * Retarget one FBX/BVH clip onto a VRM skeleton, baking the result into
 * VRM-space keyframe tracks. **Pure**: reads only its arguments, mutates nothing
 * outside them, touches no refs and no React state — so it can safely be run more
 * than once per avatar (idle and base each get their own bake).
 *
 * Extracted verbatim from the animation-load effect, which had grown to ~930
 * lines with this inline and could therefore only ever bake a single clip.
 *
 * The five phases and the world-space delta convention are documented in
 * dev-notes/modules/animation.md. Note the delta is taken against the FBX **bind**
 * pose (`fbxBindWQ`), not frame 0.
 *
 * @param fbx      the loaded FBX scene (also used for its bind pose)
 * @param clip     the source clip to bake (`fbx.animations[0]` at the call site)
 * @param vrm      the target VRM
 * @param frontYaw yaw that brings the VRM's rest front onto +Z (`faceCameraYaw`)
 * @returns baked VRM tracks plus the intermediates the caller needs for the
 *          duration clamp (`allTimes`, `outQVals`) and debug axes (`newCorrAxes`).
 */
function bakeRetargetedClip(
  fbx: THREE.Group,
  clip: THREE.AnimationClip,
  vrm: VRM,
  frontYaw: number,
  /** Bone local quaternions snapshotted at load time (FBX A-pose / bind). */
  loadTimeQ: Record<string, THREE.Quaternion>
): {
  vrmTracks: THREE.KeyframeTrack[];
  allTimes: number[];
  outQVals: Partial<Record<VRMHumanBoneName, Float32Array>>;
  newCorrAxes: THREE.Object3D[];
  VRM_TO_FBX: Partial<Record<VRMHumanBoneName, string>>;
} {
  // --- World-space hierarchical retargeting, baked offline ---
  //
  // Per bone per keyframe (root → leaf):
  //   fbxWorldQ  = parentFBXWorldQ × trackQ
  //   worldDelta = fbxWorldQ × fbxBindWQ⁻¹
  //   targetWQ   = worldDelta × vrmBindWQ
  //   vrmLocalQ  = vrmParentWorldQ⁻¹ × targetWQ

  // --- Phase 1: FBX bind world Qs (no scene rotation) ---
  // Skinned FBX: boneInverses are exact. Animation-only FBX (no SkinnedMesh):
  // Three.js places bones at bind pose on load, so we chain local Qs root→leaf.
  let skeleton: THREE.Skeleton | null = null;
  fbx.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skeleton)
      skeleton = (o as THREE.SkinnedMesh).skeleton;
  });
  let fbxHipsNode: THREE.Object3D | null = null;
  fbx.traverse((o) => {
    if (HIPS_BONE_NAMES.has(o.name) && !fbxHipsNode) fbxHipsNode = o;
  });

  const fbxBindWQ: Record<string, THREE.Quaternion> = {};
  const fbxBindWQInv: Record<string, THREE.Quaternion> = {};
  const fbxRestLocalQ: Record<string, THREE.Quaternion> = {};
  const fbxBoneParent: Record<string, string | null> = {};
  if (skeleton) {
    // Skinned FBX: use boneInverses for exact bind world Qs.
    const sk = skeleton as THREE.Skeleton;
    const _tp = new THREE.Vector3(),
      _tq = new THREE.Quaternion(),
      _ts = new THREE.Vector3();
    for (let i = 0; i < sk.bones.length; i++) {
      const bone = sk.bones[i];
      if (!FBX_BONE_TO_VRM[bone.name]) continue;
      sk.boneInverses[i].clone().invert().decompose(_tp, _tq, _ts);
      const wq = _tq.clone().normalize();
      fbxBindWQ[bone.name] = wq;
      fbxBindWQInv[bone.name] = wq.clone().invert();
      let par = bone.parent as THREE.Bone | null;
      while (par && !FBX_BONE_TO_VRM[par.name ?? ''])
        par = par.parent as THREE.Bone | null;
      fbxBoneParent[bone.name] = par?.name ?? null;
    }
    // Bind-local Qs for skinned FBX: parentBindWQ⁻¹ × childBindWQ (from boneInverses).
    // bone.quaternion is unreliable for skinned FBX (reflects animated frame, not bind pose).
    for (const name of Object.keys(fbxBindWQ)) {
      const pn = fbxBoneParent[name];
      fbxRestLocalQ[name] = pn
        ? fbxBindWQ[pn]!.clone().invert().multiply(fbxBindWQ[name]!)
        : fbxBindWQ[name]!.clone();
    }
  } else {
    // Animation-only FBX (no SkinnedMesh): Three.js places bones at their bind
    // pose on load, so we chain local quaternions root→leaf for the world Qs.
    const rigNodes: Record<string, THREE.Object3D> = {};
    fbx.traverse((o) => {
      if (FBX_BONE_TO_VRM[o.name]) rigNodes[o.name] = o;
    });
    for (const [name, node] of Object.entries(rigNodes)) {
      let par = node.parent;
      while (par && !rigNodes[par.name]) par = par.parent;
      fbxBoneParent[name] = par?.name ?? null;
    }
    const depthOf = (n: string): number => {
      let d = 0,
        cur: string | null = fbxBoneParent[n];
      while (cur) {
        d++;
        cur = fbxBoneParent[cur];
      }
      return d;
    };
    const curWQ: Record<string, THREE.Quaternion> = {};
    for (const name of Object.keys(rigNodes).sort(
      (a, b) => depthOf(a) - depthOf(b)
    )) {
      const localQ = loadTimeQ[name] ?? rigNodes[name].quaternion;
      const pWQ = fbxBoneParent[name] ? curWQ[fbxBoneParent[name]!] : undefined;
      const wq = pWQ ? pWQ.clone().multiply(localQ) : localQ.clone();
      curWQ[name] = wq;
      fbxBindWQ[name] = wq.clone();
      fbxBindWQInv[name] = wq.clone().invert();
      fbxRestLocalQ[name] = localQ.clone();
    }
  }

  // --- Phase 2: VRM bind world Qs (chain product, no scene rotation) ---
  // The bind reference below is read from each bone's *live* local
  // quaternion, so the rig must be at its rest pose when we bake. If a clip
  // was already playing (e.g. switching idle A→B without clearing first),
  // the bones still hold A's last pose and B would retarget against a
  // distorted reference. Reset both pose layers (whichever the prior clip
  // drove) to the model's rest pose so a direct switch bakes identically to
  // a fresh load, then refresh world matrices for the world-space reads.
  vrm.humanoid.resetNormalizedPose();
  vrm.humanoid.resetRawPose();
  vrm.humanoid.update();
  vrm.scene.updateMatrixWorld(true);
  const allVRMBoneNames = [
    ...new Set(Object.values(FBX_BONE_TO_VRM) as VRMHumanBoneName[]),
  ];
  const vrmBoneObj: Partial<Record<VRMHumanBoneName, THREE.Object3D>> = {};
  for (const n of allVRMBoneNames) {
    const b = vrm.humanoid.getRawBoneNode(n);
    if (b) vrmBoneObj[n] = b;
  }

  // Root reframe for the retarget: rotate the humanoid root by the same yaw
  // that orients the avatar at the camera (frontYawRef, from faceCameraYaw).
  // The clip is authored facing world +Z (e.g. Mixamo), and faceCameraYaw
  // rotates the avatar's rest front onto +Z too — so threading this yaw
  // through the bind (Phase 2) and per-frame (Phase 4) chains makes the
  // retarget's basis line up with the clip (`fullRot` collapses to just the
  // A-pose lean). The net rendered animation becomes `worldDelta × (camera-
  // facing rest pose)`, identical across VRM 0.x / 1.0 instead of flipped
  // 180° for whichever convention faces away from the clip. Identity when the
  // rest pose already faces +Z (the historical no-op case).
  const rootParentWQ = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    frontYaw
  );
  const rootParentWQInv = rootParentWQ.clone().invert();

  const vrmNodeToName = new Map<THREE.Object3D, VRMHumanBoneName>();
  for (const n of allVRMBoneNames) {
    const b = vrmBoneObj[n];
    if (b) vrmNodeToName.set(b, n);
  }
  const vrmBoneParent: Partial<
    Record<VRMHumanBoneName, VRMHumanBoneName | null>
  > = {};
  for (const n of allVRMBoneNames) {
    const b = vrmBoneObj[n];
    if (!b) continue;
    let par = b.parent,
      found: VRMHumanBoneName | null = null,
      limit = 64;
    while (par && limit-- > 0) {
      const m = vrmNodeToName.get(par);
      if (m) {
        found = m;
        break;
      }
      par = par.parent;
    }
    vrmBoneParent[n] = found;
  }

  const depthCache: Record<string, number> = {};
  const getDepth = (mb: string): number => {
    if (depthCache[mb] !== undefined) return depthCache[mb];
    const p = fbxBoneParent[mb];
    let d = 0,
      limit = 64;
    let cur = p;
    while (cur && limit-- > 0) {
      d++;
      cur = fbxBoneParent[cur];
    }
    return (depthCache[mb] = d);
  };
  const bonesInOrder = (Object.keys(FBX_BONE_TO_VRM) as string[])
    .filter(
      (mb) =>
        fbxBindWQ[mb] && vrmBoneObj[FBX_BONE_TO_VRM[mb] as VRMHumanBoneName]
    )
    .sort((a, b) => getDepth(a) - getDepth(b));

  const vrmBindWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  const vrmBindWQInv: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  for (const mb of bonesInOrder) {
    const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName;
    const bone = vrmBoneObj[vn]!;
    const pn = vrmBoneParent[vn];
    // Root bones (no humanoid parent) seed from the reframe rotation instead
    // of identity, so the whole bind chain is expressed in the clip-aligned
    // frame. See rootParentWQ above.
    const pWQ = pn ? vrmBindWQ[pn]! : rootParentWQ;
    const wq = pWQ.clone().multiply(bone.quaternion);
    vrmBindWQ[vn] = wq;
    vrmBindWQInv[vn] = wq.clone().invert();
  }

  // VRM bind-local Qs: vrmParentBindWQ⁻¹ × vrmBoneBindWQ
  const vrmBindLocalQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  for (const mb of bonesInOrder) {
    const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName;
    const vpn = vrmBoneParent[vn];
    vrmBindLocalQ[vn] = vpn
      ? vrmBindWQ[vpn]!.clone().invert().multiply(vrmBindWQ[vn]!)
      : vrmBindWQ[vn]!.clone();
  }

  // Log bind world Qs for arm bones to verify A-pose vs T-pose
  for (const [mb, vn] of [
    ['upperarm_l', 'leftUpperArm'],
    ['upperarm_r', 'rightUpperArm'],
  ] as const) {
    const fq = fbxBindWQ[mb];
    const vq = vrmBindWQ[vn as VRMHumanBoneName];
    if (fq)
      console.log(
        `[bindWQ] fbx ${mb} = (${fq.x.toFixed(3)},${fq.y.toFixed(3)},${fq.z.toFixed(3)},${fq.w.toFixed(3)})`
      );
    if (vq)
      console.log(
        `[bindWQ] vrm ${vn} = (${vq.x.toFixed(3)},${vq.y.toFixed(3)},${vq.z.toFixed(3)},${vq.w.toFixed(3)})`
      );
  }

  // --- A-pose correction: compute per-bone VRM world Q after applying the FBX A-pose ---
  // See memory:fbx-apose-retargeting. This is the same algorithm used in the bind-pose
  // visualization, but computed purely from data (positions + world Qs) without
  // touching any live Three.js objects, so it's available synchronously for Phase 4.
  const vrmAposeWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  const vrmAposeWQInv: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};

  const PREFERRED_VRM_CHILD: Partial<
    Record<VRMHumanBoneName, VRMHumanBoneName>
  > = {
    hips: 'spine',
    spine: 'chest',
    chest: 'upperChest',
    upperChest: 'neck',
    neck: 'head',
    leftShoulder: 'leftUpperArm',
    rightShoulder: 'rightUpperArm',
    leftUpperArm: 'leftLowerArm',
    rightUpperArm: 'rightLowerArm',
    leftLowerArm: 'leftHand',
    rightLowerArm: 'rightHand',
    leftUpperLeg: 'leftLowerLeg',
    rightUpperLeg: 'rightLowerLeg',
    leftLowerLeg: 'leftFoot',
    rightLowerLeg: 'rightFoot',
    leftFoot: 'leftToes',
    rightFoot: 'rightToes',
  };
  const VRM_TO_FBX: Partial<Record<VRMHumanBoneName, string>> = {};
  for (const [fb, vb] of Object.entries(FBX_BONE_TO_VRM)) {
    if (!fbxBindWQ[fb]) continue;
    if (!VRM_TO_FBX[vb as VRMHumanBoneName])
      VRM_TO_FBX[vb as VRMHumanBoneName] = fb;
  }
  const fbxChild: Record<string, string | null> = {};
  for (const name of Object.keys(fbxBindWQ)) {
    const vn = FBX_BONE_TO_VRM[name] as VRMHumanBoneName | undefined;
    const preferredV = vn ? PREFERRED_VRM_CHILD[vn] : undefined;
    fbxChild[name] = preferredV ? (VRM_TO_FBX[preferredV] ?? null) : null;
  }
  for (const name of Object.keys(fbxBindWQ)) {
    if (fbxChild[name]) continue;
    for (const candidate of Object.keys(fbxBindWQ)) {
      if (fbxBoneParent[candidate] === name) {
        fbxChild[name] = candidate;
        break;
      }
    }
  }
  const vrmChild: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>> = {};
  for (const n of allVRMBoneNames) {
    const preferred = PREFERRED_VRM_CHILD[n];
    if (preferred && vrmBoneObj[preferred]) {
      vrmChild[n] = preferred;
      continue;
    }
    for (const candidate of allVRMBoneNames) {
      if (vrmBoneParent[candidate] === n) {
        vrmChild[n] = candidate;
        break;
      }
    }
  }
  const fbxBoneNode: Record<string, THREE.Object3D> = {};
  fbx.traverse((o) => {
    if (FBX_BONE_TO_VRM[o.name] && !fbxBoneNode[o.name])
      fbxBoneNode[o.name] = o;
  });

  // Detect the FBX's "up axis" by looking at which world axis the hips→spine
  // direction most aligns with. UE4 has root with 90°X (Z-up→Y-up baked in) →
  // spine points +Y. UE5 has identity root → spine points +Z (Z-up native).
  // Build a coordinate-fix rotation that brings whatever the FBX considers "up"
  // back to world +Y. Apply this fix to ALL fbxBindWQ values.
  const hipsFbxName = VRM_TO_FBX.hips;
  const spineFbxName = VRM_TO_FBX.spine;
  const fbxCoordFix = new THREE.Quaternion();
  if (
    hipsFbxName &&
    spineFbxName &&
    fbxBindWQ[hipsFbxName] &&
    fbxBoneNode[spineFbxName]
  ) {
    const fbxSpineDir = fbxBoneNode[spineFbxName].position
      .clone()
      .normalize()
      .applyQuaternion(fbxBindWQ[hipsFbxName]!);
    // Find the world axis closest to fbxSpineDir
    const ax = Math.abs(fbxSpineDir.x),
      ay = Math.abs(fbxSpineDir.y),
      az = Math.abs(fbxSpineDir.z);
    let majorAxis = new THREE.Vector3(0, 1, 0);
    if (ax > ay && ax > az) majorAxis.set(Math.sign(fbxSpineDir.x), 0, 0);
    else if (az > ay) majorAxis.set(0, 0, Math.sign(fbxSpineDir.z));
    else majorAxis.set(0, Math.sign(fbxSpineDir.y), 0);
    // Rotation that maps majorAxis → world +Y
    fbxCoordFix.setFromUnitVectors(majorAxis, new THREE.Vector3(0, 1, 0));
    console.log(
      `[fbxCoordFix] spineDir=(${fbxSpineDir.x.toFixed(2)},${fbxSpineDir.y.toFixed(2)},${fbxSpineDir.z.toFixed(2)}) major=(${majorAxis.x.toFixed(0)},${majorAxis.y.toFixed(0)},${majorAxis.z.toFixed(0)}) fix=(${fbxCoordFix.x.toFixed(3)},${fbxCoordFix.y.toFixed(3)},${fbxCoordFix.z.toFixed(3)},${fbxCoordFix.w.toFixed(3)})`
    );
    // Apply the fix to all fbxBindWQ values: newWQ = fix × oldWQ
    for (const k of Object.keys(fbxBindWQ)) {
      const fixed = fbxCoordFix.clone().multiply(fbxBindWQ[k]);
      fbxBindWQ[k].copy(fixed);
      fbxBindWQInv[k].copy(fixed).invert();
    }
  }

  // 1. Hips: full 3-axis basis alignment.
  const lThighFbxName = VRM_TO_FBX.leftUpperLeg;
  const rThighFbxName = VRM_TO_FBX.rightUpperLeg;
  if (
    hipsFbxName &&
    spineFbxName &&
    lThighFbxName &&
    rThighFbxName &&
    vrmBoneObj.hips &&
    vrmBoneObj.spine &&
    vrmBoneObj.leftUpperLeg &&
    vrmBoneObj.rightUpperLeg &&
    fbxBoneNode[spineFbxName] &&
    fbxBoneNode[lThighFbxName] &&
    fbxBoneNode[rThighFbxName]
  ) {
    const hipsBindWQ = vrmBindWQ.hips!;
    const vUp = vrmBoneObj.spine.position
      .clone()
      .normalize()
      .applyQuaternion(hipsBindWQ);
    const vRight = new THREE.Vector3()
      .subVectors(
        vrmBoneObj.leftUpperLeg.position,
        vrmBoneObj.rightUpperLeg.position
      )
      .normalize()
      .applyQuaternion(hipsBindWQ);
    const vForward = new THREE.Vector3().crossVectors(vRight, vUp).normalize();
    const vRight2 = new THREE.Vector3().crossVectors(vUp, vForward).normalize();
    const vrmBasis = new THREE.Matrix4().makeBasis(vRight2, vUp, vForward);

    const hipsFbxWQ = fbxBindWQ[hipsFbxName]!;
    const fUp = fbxBoneNode[spineFbxName].position
      .clone()
      .normalize()
      .applyQuaternion(hipsFbxWQ);
    const fRight = new THREE.Vector3()
      .subVectors(
        fbxBoneNode[lThighFbxName].position,
        fbxBoneNode[rThighFbxName].position
      )
      .normalize()
      .applyQuaternion(hipsFbxWQ);
    const fForward = new THREE.Vector3().crossVectors(fRight, fUp).normalize();
    const fRight2 = new THREE.Vector3().crossVectors(fUp, fForward).normalize();
    const fbxBasis = new THREE.Matrix4().makeBasis(fRight2, fUp, fForward);

    const fullRot = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().multiplyMatrices(fbxBasis, vrmBasis.clone().invert())
    );
    vrmAposeWQ.hips = fullRot.clone().multiply(hipsBindWQ);
  } else {
    vrmAposeWQ.hips = vrmBindWQ.hips?.clone();
  }

  // 2. Other non-hips, non-leaf bones: single-axis swing aligning child direction.
  // Process root→leaf using bonesInOrder.
  for (const mb of bonesInOrder) {
    const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName;
    if (vn === 'hips') continue;
    const bindWQ = vrmBindWQ[vn];
    if (!bindWQ) continue;
    const childMb = fbxChild[mb];
    const childVn = vrmChild[vn];

    // Start from bind WQ, then apply parent's accumulated swing in world space.
    // The parent's "extra rotation" beyond bind = vrmAposeWQ[parent] × vrmBindWQInv[parent].
    const vpn = vrmBoneParent[vn];
    const parentExtra =
      vpn && vrmAposeWQ[vpn] && vrmBindWQInv[vpn]
        ? vrmAposeWQ[vpn]!.clone().multiply(vrmBindWQInv[vpn]!)
        : new THREE.Quaternion();
    const swungBoneBindWQ = parentExtra.clone().multiply(bindWQ);

    if (childMb && childVn && vrmBoneObj[childVn] && fbxBoneNode[childMb]) {
      const vrmChildPos = vrmBoneObj[childVn]!.position;
      const fbxChildPos = fbxBoneNode[childMb].position;
      if (vrmChildPos.lengthSq() > 1e-10 && fbxChildPos.lengthSq() > 1e-10) {
        const vrmDir = vrmChildPos
          .clone()
          .normalize()
          .applyQuaternion(swungBoneBindWQ);
        const fbxDir = fbxChildPos
          .clone()
          .normalize()
          .applyQuaternion(fbxBindWQ[mb]!);
        const swing = new THREE.Quaternion().setFromUnitVectors(vrmDir, fbxDir);
        // newWQ = swing × swungBoneBindWQ
        const newWQ = swing.multiply(swungBoneBindWQ);

        // Hand basis correction
        const isHand = vn === 'leftHand' || vn === 'rightHand';
        if (isHand) {
          const middleVn = (
            vn === 'leftHand' ? 'leftMiddleProximal' : 'rightMiddleProximal'
          ) as VRMHumanBoneName;
          const littleVn = (
            vn === 'leftHand' ? 'leftLittleProximal' : 'rightLittleProximal'
          ) as VRMHumanBoneName;
          const middleFbx = VRM_TO_FBX[middleVn];
          const littleFbx = VRM_TO_FBX[littleVn];
          if (
            vrmBoneObj[middleVn] &&
            vrmBoneObj[littleVn] &&
            middleFbx &&
            littleFbx &&
            fbxBoneNode[middleFbx] &&
            fbxBoneNode[littleFbx]
          ) {
            const vMid = vrmBoneObj[middleVn]!.position.clone()
              .normalize()
              .applyQuaternion(newWQ);
            const vLit = vrmBoneObj[littleVn]!.position.clone()
              .normalize()
              .applyQuaternion(newWQ);
            const fMid = fbxBoneNode[middleFbx].position
              .clone()
              .normalize()
              .applyQuaternion(fbxBindWQ[mb]!);
            const fLit = fbxBoneNode[littleFbx].position
              .clone()
              .normalize()
              .applyQuaternion(fbxBindWQ[mb]!);
            const vF = vMid.clone().normalize();
            const vS = vLit.clone().normalize();
            const vU = new THREE.Vector3().crossVectors(vF, vS).normalize();
            // Ensure vU and fU both point the same anatomical direction (palm normal
            // = downward in world for A-pose). Use fU's sign as the reference and
            // match vU to it so both bases represent the same palm orientation.
            const fF = fMid.clone().normalize();
            const fS = fLit.clone().normalize();
            const fU = new THREE.Vector3().crossVectors(fF, fS).normalize();
            // Canonical palm normal: whichever of ±fU points more downward (-Y)
            if (fU.y > 0) fU.multiplyScalar(-1);
            // Match vU chirality to fU
            if (vU.dot(fU) < 0) vU.multiplyScalar(-1);
            const vR = new THREE.Vector3().crossVectors(vU, vF).normalize();
            const vMat = new THREE.Matrix4().makeBasis(vR, vU, vF);
            const fR = new THREE.Vector3().crossVectors(fU, fF).normalize();
            const fMat = new THREE.Matrix4().makeBasis(fR, fU, fF);
            const handRot = new THREE.Quaternion().setFromRotationMatrix(
              new THREE.Matrix4().multiplyMatrices(fMat, vMat.invert())
            );
            vrmAposeWQ[vn] = handRot.multiply(newWQ);
            continue;
          }
        }
        vrmAposeWQ[vn] = newWQ;
        continue;
      }
    }
    // Leaf or no valid child: just inherit parent extra (= swungBoneBindWQ)
    vrmAposeWQ[vn] = swungBoneBindWQ;
  }

  for (const vn of Object.keys(vrmAposeWQ) as VRMHumanBoneName[]) {
    if (vrmAposeWQ[vn]) vrmAposeWQInv[vn] = vrmAposeWQ[vn]!.clone().invert();
  }
  console.log(
    '[apose] computed corrections for',
    Object.keys(vrmAposeWQ).length,
    'bones'
  );

  // --- Phase 3: Create interpolants, collect keyframe times ---
  const qInterp: Record<string, THREE.Interpolant> = {};
  let hipsPosTrack: THREE.KeyframeTrack | null = null;
  for (const track of clip.tracks) {
    const d = track.name.indexOf('.'),
      bone = track.name.slice(0, d),
      prop = track.name.slice(d + 1);
    if (prop === 'quaternion') qInterp[bone] = track.createInterpolant();
    if (prop === 'position' && HIPS_BONE_NAMES.has(bone)) hipsPosTrack = track;
  }
  const refTrack = clip.tracks.find((t) => t.name.endsWith('.quaternion'));
  const allTimes = refTrack ? Array.from(refTrack.times) : [];

  // --- Phase 4: Bake retargeted quaternions per-frame (world-space delta) ---
  //
  // Per bone per keyframe (root → leaf):
  //   fbxWorldQ  = parentFBXWorldQ × trackQ      (fbxRootQ seeds root bones)
  //   worldDelta = fbxWorldQ × fbxBindWQ⁻¹
  //   targetWQ   = worldDelta × vrmBindWQ
  //   vrmLocalQ  = vrmParentWorldQ⁻¹ × targetWQ
  //
  // fbxRootQ carries the FBXLoader's coordinate-system correction (e.g. Z-up→Y-up for
  // UE4). Using it as the root parent ensures our world Qs match what SkeletonHelper sees.
  const outQVals: Partial<Record<VRMHumanBoneName, Float32Array>> = {};
  for (const mb of bonesInOrder)
    outQVals[FBX_BONE_TO_VRM[mb] as VRMHumanBoneName] = new Float32Array(
      allTimes.length * 4
    );

  const curFBXWQ: Record<string, THREE.Quaternion> = {};
  const curVRMWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  for (const mb of bonesInOrder) {
    curFBXWQ[mb] = new THREE.Quaternion();
    curVRMWQ[FBX_BONE_TO_VRM[mb] as VRMHumanBoneName] = new THREE.Quaternion();
  }

  const IDQ = new THREE.Quaternion();
  const _q = new THREE.Quaternion();
  const _delta = new THREE.Quaternion();
  const _inv = new THREE.Quaternion();

  // DEAD CODE — computed but never read. The bake below uses `fbxBindWQInv`
  // (the FBX *bind* pose) as its reference, not this frame-0 chain. Kept for
  // now because the frame-0 scheme it implements may be wanted again, but the
  // stale claim that retargeting is frame-0-relative (here and in
  // animation.md) has already misled debugging more than once — treat
  // `fbxBindWQInv` at the `_delta` computation as the source of truth.
  const fbxRefWQ: Record<string, THREE.Quaternion> = {};
  const fbxRefWQInv: Record<string, THREE.Quaternion> = {};
  if (allTimes.length > 0) {
    const t0 = allTimes[0];
    const sortedBones = [...bonesInOrder];
    // bonesInOrder is already in parent-before-child order (sort by depth happens earlier)
    for (const mb of sortedBones) {
      let lq: THREE.Quaternion;
      if (qInterp[mb]) {
        const r = qInterp[mb].evaluate(t0);
        lq = new THREE.Quaternion(r[0], r[1], r[2], r[3]).normalize();
      } else {
        lq = (fbxRestLocalQ[mb] ?? new THREE.Quaternion()).clone();
      }
      const fbxPN = fbxBoneParent[mb];
      const parentWQ = fbxPN ? fbxRefWQ[fbxPN] : IDQ;
      const wq = parentWQ.clone().multiply(lq);
      fbxRefWQ[mb] = wq;
      fbxRefWQInv[mb] = wq.clone().invert();
    }
  } else {
    for (const mb of bonesInOrder) {
      fbxRefWQ[mb] = fbxBindWQ[mb]!.clone();
      fbxRefWQInv[mb] = fbxBindWQInv[mb]!.clone();
    }
  }

  // Log frame-0 track Q vs loadTimeQ for arm bones
  for (const mb of ['upperarm_l', 'upperarm_r']) {
    const lq = fbxRestLocalQ[mb];
    const interp = qInterp[mb];
    if (lq && interp && allTimes.length > 0) {
      const r = interp.evaluate(allTimes[0]);
      const tq = new THREE.Quaternion(r[0], r[1], r[2], r[3]).normalize();
      console.log(
        `[frame0] ${mb} loadTimeQ=(${lq.x.toFixed(3)},${lq.y.toFixed(3)},${lq.z.toFixed(3)},${lq.w.toFixed(3)}) trackQ[0]=(${tq.x.toFixed(3)},${tq.y.toFixed(3)},${tq.z.toFixed(3)},${tq.w.toFixed(3)})`
      );
    }
  }

  for (let ti = 0; ti < allTimes.length; ti++) {
    const t = allTimes[ti];
    for (const mb of bonesInOrder) {
      const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName;
      if (qInterp[mb]) {
        const r = qInterp[mb].evaluate(t);
        _q.set(r[0], r[1], r[2], r[3]).normalize();
      } else {
        _q.copy(IDQ);
      }
      const fbxPN = fbxBoneParent[mb];
      const parentFBXWQ = fbxPN ? curFBXWQ[fbxPN] : fbxCoordFix;
      curFBXWQ[mb].copy(parentFBXWQ).multiply(_q);
      _delta
        .copy(curFBXWQ[mb])
        .multiply(fbxBindWQInv[mb]!)
        .multiply(vrmAposeWQ[vn] ?? vrmBindWQ[vn]!);
      if (
        (ti === 0 ||
          ti === allTimes.length - 1 ||
          ti === allTimes.length - 2) &&
        (mb === 'upperarm_l' || mb === 'upperarm_r')
      ) {
        const fwq2 = curFBXWQ[mb];
        const bwq2 = fbxBindWQ[mb]!;
        console.log(
          `[ph4 ti=${ti}/${allTimes.length - 1} t=${t.toFixed(3)}] ${mb} curFBXWQ=(${fwq2.x.toFixed(3)},${fwq2.y.toFixed(3)},${fwq2.z.toFixed(3)},${fwq2.w.toFixed(3)}) bind=(${bwq2.x.toFixed(3)},${bwq2.y.toFixed(3)},${bwq2.z.toFixed(3)},${bwq2.w.toFixed(3)})`
        );
      }
      if (ti === 0 && (mb === 'upperarm_l' || mb === 'upperarm_r')) {
        const fwq = curFBXWQ[mb];
        const bwq = fbxBindWQ[mb]!;
        // angle of delta (how much frame0 rotated from bind)
        const dAngle =
          (2 * Math.acos(Math.min(1, Math.abs(_delta.w))) * 180) / Math.PI;
        // angle of bind (how rotated bind itself is from identity)
        const bAngle =
          (2 * Math.acos(Math.min(1, Math.abs(bwq.w))) * 180) / Math.PI;
        console.log(
          `[ph4 ti=0] ${mb} bind=(${bwq.x.toFixed(3)},${bwq.y.toFixed(3)},${bwq.z.toFixed(3)},${bwq.w.toFixed(3)})[${bAngle.toFixed(1)}°] frame0=(${fwq.x.toFixed(3)},${fwq.y.toFixed(3)},${fwq.z.toFixed(3)},${fwq.w.toFixed(3)}) delta[${dAngle.toFixed(1)}°]`
        );
      }
      curVRMWQ[vn]!.copy(_delta);
      const vrmPN = vrmBoneParent[vn];
      // Root bones convert to local against the reframe rotation (same seed
      // as the bind chain in Phase 2), so the baked track renders back to the
      // intended clip-aligned world pose. See rootParentWQ above.
      const parentVRMWQ = vrmPN ? curVRMWQ[vrmPN] : rootParentWQ;
      _inv.copy(parentVRMWQ ?? rootParentWQ).invert();
      _q.copy(_inv).multiply(_delta);
      const base = ti * 4,
        arr = outQVals[vn]!;
      arr[base] = _q.x;
      arr[base + 1] = _q.y;
      arr[base + 2] = _q.z;
      arr[base + 3] = _q.w;
    }
  }

  // --- Phase 5: Build VRM tracks ---
  const vrmTracks: THREE.KeyframeTrack[] = [];
  const newCorrAxes: THREE.Object3D[] = [];
  const _v = new THREE.Vector3();

  for (const mb of bonesInOrder) {
    const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName;
    const bone = vrmBoneObj[vn];
    if (!bone) continue;
    vrmTracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${bone.name}.quaternion`,
        allTimes,
        outQVals[vn]!
      )
    );
  }

  // Hips position
  if (hipsPosTrack && fbxHipsNode) {
    const fbxRestPos = (fbxHipsNode as THREE.Object3D).position.clone();
    const vrmHipsBone = vrmBoneObj['hips'];
    const vrmRestPos = vrmHipsBone
      ? vrmHipsBone.position.clone()
      : new THREE.Vector3();
    const values = new Float32Array(hipsPosTrack.values.length);
    for (let i = 0; i < hipsPosTrack.values.length; i += 3) {
      _v.set(
        hipsPosTrack.values[i],
        hipsPosTrack.values[i + 1],
        hipsPosTrack.values[i + 2]
      );
      // Delta from FBX rest, in FBX coordinate frame
      _v.sub(fbxRestPos);
      // Map FBX coord frame → VRM coord frame (e.g. Z-up → Y-up)
      _v.applyQuaternion(fbxCoordFix);
      // Re-express the translation in the reframed hips-local frame so it
      // matches the reframed rotation chain (identity when no reframe). See
      // rootParentWQ above.
      _v.applyQuaternion(rootParentWQInv);
      _v.multiplyScalar(0.01).add(vrmRestPos);
      values[i] = _v.x;
      values[i + 1] = _v.y;
      values[i + 2] = _v.z;
    }
    vrmTracks.push(
      new THREE.VectorKeyframeTrack(
        `${vrmHipsBone!.name}.position`,
        Array.from(hipsPosTrack.times),
        values
      )
    );
  }

  return { vrmTracks, allTimes, outQVals, newCorrAxes, VRM_TO_FBX };
}

/**
 * One loaded, baked, independently-playable clip: its own shadow skeleton (the
 * animation buffer — see ShadowSkeleton), its own mixer, and the playhead state
 * needed to drive it against the synced clock.
 *
 * An avatar holds one of these per **rotation source**, so the sources coexist
 * instead of overwriting each other in a single slot. That is what makes a
 * cross-fade possible: blending two poses requires both to be readable at once.
 */
interface ClipSlot {
  url: string;
  shadow: ShadowSkeleton;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  /** Trimmed VRM-clip duration — the loop-wrap period. */
  vrmDuration: number;
  /** Source FBX clip duration, for the FBX debug display + UI scrubber. */
  duration: number;
}

/** The three independent rotation sources an avatar composes from. */
type ClipSlotName = 'idle' | 'base' | 'scheduled';

/**
 * A frozen pose, used as the *outgoing* side of a cross-fade when the clip that
 * produced it is being discarded (a scheduled one-shot finishing, or a slot
 * reloading). Unlike idle/base — which keep animating through a fade and so need
 * live mixers — a retiring clip has nothing left to play, so holding its final
 * pose is both cheaper and semantically right.
 */
class FrozenPose {
  private q = new Map<VRMHumanBoneName, THREE.Quaternion>();
  private hips = new THREE.Vector3();
  private valid = false;

  /** Freeze the current contents of a shadow skeleton. */
  captureFrom(
    shadow: ShadowSkeleton,
    bones: readonly VRMHumanBoneName[]
  ): void {
    for (const name of bones) {
      const src = shadow.rotation(name);
      if (!src) continue;
      const stored = this.q.get(name);
      if (stored) stored.copy(src);
      else this.q.set(name, src.clone());
    }
    const hp = shadow.hipsPosition();
    if (hp) this.hips.copy(hp);
    this.valid = true;
  }

  rotation(name: VRMHumanBoneName): THREE.Quaternion | null {
    return (this.valid && this.q.get(name)) || null;
  }

  hipsPosition(): THREE.Vector3 | null {
    return this.valid ? this.hips : null;
  }

  get active(): boolean {
    return this.valid;
  }

  clear(): void {
    this.valid = false;
  }
}

function AvatarNode({
  node,
  children,
}: {
  node: StageObject;
  children?: React.ReactNode;
}) {
  const outerRef = useRef<THREE.Group>(null);
  const groupRef = useRef<THREE.Group>(null);
  const fbxGroupRef = useRef<THREE.Group>(null);
  const vrmHelperRef = useRef<THREE.Group>(null);
  const fbxHelperRef = useRef<THREE.Group>(null);
  const boneCylRef = useRef<THREE.Mesh>(null);
  const fbxMixerRef = useRef<THREE.AnimationMixer | null>(null);
  const vrmMixerRef = useRef<THREE.AnimationMixer | null>(null);
  // One independently-loaded, independently-played clip per rotation source, each
  // with its own animation buffer (see ClipSlot / ShadowSkeleton). Sources coexist
  // rather than sharing one slot, so two poses can be read at once — the
  // prerequisite for cross-fading between them.
  //
  // `scheduled` is declared but not yet populated: timeline one-shots still take
  // today's hard-switch path through `_resolveAvatarAnimation` and land in the
  // `base` slot. Wiring it up (plus the fades) is the follow-up.
  const slotsRef = useRef<Partial<Record<ClipSlotName, ClipSlot>>>({});
  // Slots no longer wanted but kept resident until any fade using them settles
  // (see retireSlot). Excluded from source selection, still ticked and readable.
  const retiredSlotsRef = useRef<Set<ClipSlotName>>(new Set());
  // Outgoing pose for a cross-fade whose source clip is being discarded.
  const frozenRef = useRef(new FrozenPose());
  // Per-slot playback layers (each source has its own clock anchor).
  const slotLayersRef = useRef<
    Partial<Record<ClipSlotName, ActiveAnimLayer | null>>
  >({});
  // Cross-fade between animation sources (idle ⇄ base ⇄ scheduled).
  const sourceFadeRef = useRef(new SourceFade<ClipSlotName>());
  // Tracked-mode weight: 0 = animation straight (untracked), 1 = levers applied +
  // tracking stacked. Ramps over blendTransitionTime so the tracked⇄untracked
  // boundary is continuous instead of a per-section jump. See composeBonePose.
  const modeWeightRef = useRef(0);
  // Last tracked pose that had bones — the fade-out's source (see TrackedPoseLatch).
  const trackedLatchRef = useRef(new TrackedPoseLatch());
  // Scene yaw applied to face the avatar at the camera (set at VRM load by
  // faceCameraYaw). The FBX retarget reuses it to reframe its root so the baked
  // animation faces the same way as the rest pose — see the retarget below.
  const frontYawRef = useRef(0);
  // Per-instance animation state read by this avatar's useFrame. Kept on a ref
  // (not a shared node.id-keyed map) so multiple AvatarNode instances for the
  // same avatar — the scene viewport plus every compose camera view — each drive
  // their own mixers instead of clobbering and evicting a single shared entry.
  //
  // Holds the FBX *debug display* clip only. The VRM-space playback lives in
  // `slotsRef` (one entry per rotation source); this ref no longer carries the
  // VRM mixer/action/shadow.
  const animEntryRef = useRef<AnimEntry | null>(null);
  // Which slot the composition currently treats as its animation source.
  const activeSlotRef = useRef<ClipSlotName>('idle');
  const vrmRef = useRef<VRM | null>(null);
  const corrAxesRef = useRef<THREE.Object3D[]>([]);
  const vmcCompRef = useRef<Behavior | null>(null);
  const lipsyncCompRef = useRef<Behavior | null>(null);
  const vmcRetargetRef = useRef<VmcRetarget | null>(null);
  const boneFiltersRef = useRef(new BoneFilterBank());
  const boneDynamicsRef = useRef(new BoneDynamicsBank());
  const poseWasActiveRef = useRef(false);
  // Mirrors `trackingActive` state for the useFrame loop (avoids a stale closure
  // read); the loop calls setTrackingActive only when this flips.
  const trackingActiveRef = useRef(false);
  // Active animation layer driving the clock-anchored playhead (read in useFrame).
  const activeLayerRef = useRef<ActiveAnimLayer | null>(null);
  const [vrmLoaded, setVrmLoaded] = useState(false);
  const t = useTransformWithOverride(node);
  useApplyMeshFlags(outerRef, t.opacity, t.castShadow, t.receiveShadow);

  const showBoneHelper = useEditorStore(
    (s) => s.boneListExpanded[node.id] ?? false
  );
  const showFbxDebug = useEditorStore(
    (s) => s.fbxDebugVisible[node.id] ?? false
  );

  useEffect(() => {
    if (!outerRef.current) return;
    return registerNodeGroup(node.id, outerRef.current);
  }, [node.id]);

  useEffect(() => {
    if (vrmHelperRef.current) vrmHelperRef.current.visible = showBoneHelper;
  }, [showBoneHelper]);

  useEffect(() => {
    if (fbxGroupRef.current) fbxGroupRef.current.visible = showFbxDebug;
    if (fbxHelperRef.current) fbxHelperRef.current.visible = showFbxDebug;
  }, [showFbxDebug]);

  // Track active pose-driving component without causing useFrame re-subscription
  const vmcComp = useEditorStore(
    (s) =>
      s
        .behaviorsFor(node.id)
        .find(
          (c) =>
            (c.kind === 'vmc_receiver' || c.kind === 'mediapipe_tracker') &&
            c.enabled
        ) ?? null
  );
  useEffect(() => {
    vmcCompRef.current = vmcComp;
  }, [vmcComp]);

  // Track active blendshape-driving component (lipsync, face tracking)
  const lipsyncComp = useEditorStore(
    (s) =>
      s
        .behaviorsFor(node.id)
        .find(
          (c) =>
            (c.kind === 'lipsync_processor' ||
              c.kind === 'mediapipe_tracker') &&
            c.enabled
        ) ?? null
  );
  useEffect(() => {
    lipsyncCompRef.current = lipsyncComp;
  }, [lipsyncComp]);

  const {
    setVrmBonesForNode,
    clearVrmBonesForNode,
    setVrmExpressionsForNode,
    clearVrmExpressionsForNode,
    setVrmMorphTargetsForNode,
    clearVrmMorphTargetsForNode,
    setVrmMaterialsForNode,
    clearVrmMaterialsForNode,
  } = useEditorStore();

  // name → all meshes+indices that have that morph target
  type MorphEntry = { mesh: THREE.SkinnedMesh; index: number };
  const morphMapRef = useRef<Map<string, MorphEntry[]>>(new Map());
  // Expression/morph names driven by the last broadcast frame. When a mapping
  // edit (or a producer going inactive) drops a key from the emitted set, the
  // weight would otherwise freeze at its last value — three-vrm persists unset
  // weights. Tracking the previous set lets us release the dropped keys to 0.
  const prevExprKeysRef = useRef<Set<string>>(new Set());
  const prevMorphKeysRef = useRef<Set<string>>(new Set());

  // --- Avatar animation resolution (clock-anchored, two-layer) ---
  // Idle base loop + a scheduled timeline (scheduled_animation docs), both
  // content-addressed by animation_clip id and anchored to the synced clock.
  // Idle prefers the new properties.animation.idle = { clipId, speed }; it falls
  // back to the legacy components.animation.idleUrl until that's migrated.
  const animIdle = (
    node.properties as
      | { animation?: { idle?: { clipId?: string; speed?: number } } }
      | undefined
  )?.animation?.idle;
  const legacyAnim = node.components?.animation as
    | { idleUrl?: string; speed?: number }
    | undefined;
  const scheduledMap = useEditorStore((s) => s.scheduledAnimations);
  const animationClips = useEditorStore((s) => s.animationClips);
  const scheduledForNode = useMemo(
    () => Object.values(scheduledMap).filter((e) => e.avatarNodeId === node.id),
    [scheduledMap, node.id]
  );
  const idleClip = animIdle?.clipId
    ? animationClips[animIdle.clipId]
    : undefined;
  const idle = idleClip
    ? { url: idleClip.sourceFilePath, speed: animIdle?.speed ?? 1 }
    : legacyAnim?.idleUrl
      ? { url: legacyAnim.idleUrl, speed: legacyAnim.speed ?? 1 }
      : null;

  // Base animation — the loop live tracking stacks onto while a source is
  // connected (see the stacking composition in useFrame). Falls back to the idle
  // when unset, so an avatar with only an idle keeps blending its idle under
  // tracking. `trackingActive` flips from the per-frame pose loop below.
  const animBaseCfg = (
    node.properties as
      | {
          animation?: {
            base?: { clipId?: string; url?: string; speed?: number };
          };
        }
      | undefined
  )?.animation?.base;
  const baseClip = animBaseCfg?.clipId
    ? animationClips[animBaseCfg.clipId]
    : undefined;
  const baseUrl = baseClip?.sourceFilePath ?? animBaseCfg?.url;
  const base = baseUrl
    ? { url: baseUrl, speed: animBaseCfg?.speed ?? 1 }
    : null;
  const [trackingActive, setTrackingActive] = useState(false);
  // While tracking is live use the base animation (if any) as the loop tracking
  // stacks onto; otherwise fall back to the idle. Scheduled clips still win.
  const animLoop = trackingActive && base ? base : idle;

  // Tick that re-fires when the active timeline entry should change.
  const [animTick, setAnimTick] = useState(0);
  // Scheduled one-shots resolve INDEPENDENTLY of the loops now: they own the
  // `scheduled` slot rather than displacing the loop's URL, so the frame loop can
  // fade between a one-shot and whatever loop plays underneath instead of cutting.
  const schedResolved = _resolveScheduledAnimation(
    node.id,
    scheduledForNode,
    animationClips,
    Date.now()
  );
  // Re-resolve when the active entry starts or ends. Both bounds matter: the end
  // is what retires a one-shot (and triggers its fade back to the loop).
  const schedNextChangeMs = (() => {
    const now = Date.now();
    const bounds = [schedResolved.endsAtMs, schedResolved.nextStartMs].filter(
      (x): x is number => x != null
    );
    return bounds.length > 0 ? Math.max(0, Math.min(...bounds) - now) : null;
  })();
  useEffect(() => {
    if (schedNextChangeMs == null) return;
    const handle = setTimeout(
      () => setAnimTick((n) => n + 1),
      schedNextChangeMs
    );
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedResolved.url, schedNextChangeMs, animTick]);
  // The loop layer (idle or base) — scheduled no longer participates here.
  const animResolved = _resolveAvatarAnimation(
    node.id,
    animLoop,
    [],
    animationClips,
    Date.now()
  );
  const animUrl = animResolved.url;
  // Hand the active layer to the per-frame anchored drive. Keep the ref current
  // even when the clip is the same but its start/speed/loop changed (e.g. the
  // queue was re-scheduled onto the same clip).
  const animLayer = animResolved.layer;
  const animLayerKey = animLayer
    ? `${animLayer.startEpoch}:${animLayer.speed}:${animLayer.loop}`
    : '';
  useEffect(() => {
    activeLayerRef.current = animLayer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animLayerKey]);
  // Each slot advances on its own playhead: the loops are epoch-anchored (shared
  // phase across clients) while a one-shot is anchored to its entry's startEpoch.
  // A single shared layer would have driven the one-shot at the loop's phase.
  const schedLayer = schedResolved.layer;
  const schedLayerKey = schedLayer
    ? `${schedLayer.startEpoch}:${schedLayer.speed}:${schedLayer.loop}`
    : '';
  useEffect(() => {
    slotLayersRef.current.scheduled = schedLayer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedLayerKey]);
  useEffect(() => {
    slotLayersRef.current.idle = animLayer;
    slotLayersRef.current.base = animLayer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animLayerKey]);

  // --- Idle migration: legacy idleUrl → content-addressed clip id ---
  // Once the matching animation_clip is registered (auto-registration probe),
  // upgrade components.animation.idleUrl → properties.animation.idle.clipId so
  // the idle loop is universal and syncs to collab peers (the legacy path was
  // the author's local URL, unresolvable elsewhere). Until then the legacy URL
  // still plays via the resolver fallback above. Owner-only; never on a
  // projected remote avatar.
  const legacyIdleUrl = legacyAnim?.idleUrl ?? null;
  useEffect(() => {
    if (node.remote || !legacyIdleUrl || animIdle?.clipId) return;
    const clip = Object.values(animationClips).find(
      (c) => c.sourceFilePath === legacyIdleUrl
    );
    if (!clip) return; // clip not registered yet — re-runs when it lands
    const speed = legacyAnim?.speed ?? 1;
    const prevProps = (node.properties as Record<string, unknown>) ?? {};
    const prevAnim =
      (prevProps.animation as Record<string, unknown> | undefined) ?? {};
    const properties = {
      ...prevProps,
      animation: { ...prevAnim, idle: { clipId: clip.id, speed } },
    };
    const components = { ...node.components, animation: undefined };
    useEditorStore.getState().updateNode(node.id, { properties, components });
    api.updateNode(node.id, { properties, components }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyIdleUrl, animIdle?.clipId, animationClips, node.id, node.remote]);

  // --- VRM load ---
  useEffect(() => {
    if (!node.filePath) return;
    let cancelled = false;
    setVrmLoaded(false);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(node.filePath, (gltf) => {
      if (cancelled || !groupRef.current) return;
      const vrm = gltf.userData.vrm as VRM | undefined;
      const vrmScene = gltf.scene;

      vrmRef.current = vrm ?? null;
      groupRef.current.clear();
      groupRef.current.add(vrmScene);
      // Disable frustum culling on every mesh. A SkinnedMesh is culled against
      // its *bind-pose* bounding sphere (three.js never re-derives it from the
      // live skeleton), so a bone-driven pose that moves a mesh away from bind —
      // e.g. a sitting clip dropping the head — leaves the face/hair spheres up
      // at the standing head while the real geometry is elsewhere. Zooming in
      // then frustum-culls those meshes even though they're on screen (the face
      // vanishes). The avatar is a single hero object, so always drawing it is
      // cheaper than the artifact.
      vrmScene.traverse((o) => {
        (o as THREE.Mesh).frustumCulled = false;
      });
      // Yaw the avatar to face the camera (world +Z). VRM 0.x faces +Z while
      // VRM 1.0 faces −Z by spec, so the old blanket `rotation.y = Math.PI` only
      // ever worked for one convention and left the other facing backwards.
      // Real-world models also don't always honour their version's convention,
      // so rather than branch on metaVersion (e.g. VRMUtils.rotateVRM0) we derive
      // the avatar's actual front from its rest-pose skeleton — the shoulder line
      // (left→right upper arm) crossed with the spine (hips→head) — and rotate
      // that front onto +Z. The FBX retarget reuses this yaw (frontYawRef) to
      // reframe its root, so animations face the same way as the rest pose.
      if (vrm) {
        const yaw = faceCameraYaw(vrm, vrmScene);
        vrmScene.rotation.y = yaw;
        frontYawRef.current = yaw;
      }

      if (vrmHelperRef.current) {
        vrmHelperRef.current.clear();
        const vrmHelper = new THREE.SkeletonHelper(vrmScene);
        (vrmHelper.material as THREE.LineBasicMaterial).color.set(0x00ffff);
        (vrmHelper.material as THREE.LineBasicMaterial).depthTest = false;
        vrmHelperRef.current.add(vrmHelper);
        vrmHelperRef.current.visible =
          useEditorStore.getState().boneListExpanded[node.id] ?? false;
      }
      // addBoneAxes(vrmScene, 0.05)

      if (vrm) {
        vmcRetargetRef.current = buildVmcRetarget(vrm);
        setVrmBonesForNode(node.id, Object.keys(vrm.humanoid.humanBones));

        // Expressions
        const exprMap = (
          vrm.expressionManager as unknown as {
            expressionMap?: Record<string, unknown>;
          } | null
        )?.expressionMap;
        const expressions = exprMap ? Object.keys(exprMap).sort() : [];
        setVrmExpressionsForNode(node.id, expressions);
        _sendExpressionsReport(node.id, expressions);

        // Morph targets — walk every SkinnedMesh in the scene
        const morphMap = new Map<
          string,
          Array<{ mesh: THREE.SkinnedMesh; index: number }>
        >();
        vrm.scene.traverse((obj) => {
          const mesh = obj as THREE.SkinnedMesh;
          if (
            !mesh.isSkinnedMesh ||
            !mesh.morphTargetDictionary ||
            !mesh.morphTargetInfluences
          )
            return;
          for (const [name, idx] of Object.entries(
            mesh.morphTargetDictionary
          )) {
            if (!morphMap.has(name)) morphMap.set(name, []);
            morphMap.get(name)!.push({ mesh, index: idx });
          }
        });
        morphMapRef.current = morphMap;
        setVrmMorphTargetsForNode(node.id, [...morphMap.keys()].sort());

        vrmRegistry.set(node.id, vrm);
        // Also stash this canvas's VRM on the avatar's own group so per-canvas
        // consumers (BoneAttacher, compose attach targeting) can resolve the
        // right instance instead of the global last-write-wins registry.
        if (outerRef.current) outerRef.current.userData.__vrm = vrm;
        // Materials: written LAST, after vrmRegistry.set, so the reactive
        // store slice that MaterialSection subscribes to only fires once the
        // registry it reads is guaranteed populated (fixes empty-until-reload).
        setVrmMaterialsForNode(
          node.id,
          getMaterialSlots(vrm).map((s) => s.key)
        );
      }
      setVrmLoaded(true);
    });

    return () => {
      cancelled = true;
      setVrmLoaded(false);
      if (vrmRef.current) disposeMaterialOverrides(vrmRef.current);
      vrmMixerRef.current?.stopAllAction();
      vrmMixerRef.current = null;
      vrmRef.current = null;
      vmcRetargetRef.current = null;
      boneFiltersRef.current.reset();
      vrmHelperRef.current?.clear();
      clearVrmBonesForNode(node.id);
      clearVrmExpressionsForNode(node.id);
      _sendExpressionsReport(node.id, []);
      clearVrmMorphTargetsForNode(node.id);
      clearVrmMaterialsForNode(node.id);
      morphMapRef.current.clear();
      teardownForearmTwist(node.id);
      if (outerRef.current) delete outerRef.current.userData.__vrm;
      vrmRegistry.delete(node.id);
    };
  }, [node.filePath]);

  // --- Material overrides (MToon ⇄ PBR + per-material params) ---
  // Re-apply whenever the override record changes or the VRM (re)loads. The
  // apply layer is idempotent and caches per-VRM slots, so this is cheap.
  const materialOverrides = node.properties?.materialOverrides as
    | MaterialOverrides
    | undefined;
  const materialOverridesKey = JSON.stringify(materialOverrides ?? null);
  useEffect(() => {
    if (!vrmLoaded) return;
    const vrm = vrmRef.current;
    if (!vrm) return;
    applyMaterialOverrides(vrm, materialOverrides);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vrmLoaded, materialOverridesKey]);

  // --- Forearm twist bones ---
  // Detect the model's own forearm twist bones, or (when "Force twist bone" is
  // on) synthesize them, so pronation reads along the forearm instead of
  // pinching at the elbow. Re-runs when the toggle flips; tears down (restoring
  // original skinning) on unmount / reload. The per-frame drive lives in the
  // useFrame below.
  const forceTwistBone = node.properties?.forceTwistBone === true;
  const excludeSleeves = node.properties?.excludeSleeves === true;
  useEffect(() => {
    if (!vrmLoaded) return;
    const vrm = vrmRef.current;
    if (!vrm) return;
    setupForearmTwist(node.id, vrm, {
      force: forceTwistBone,
      excludeSleeves,
    });
    return () => teardownForearmTwist(node.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vrmLoaded, forceTwistBone, excludeSleeves, node.id]);

  // --- Animation clip auto-registration ---
  // Once the avatar VRM is loaded, probe each .fbx asset in the project for its real
  // clip duration and POST an animation_clips row. The backend route upserts so this is
  // idempotent. Skips assets already registered for this node.
  const assetsForProbe = useEditorStore((s) => s.assets);
  useEffect(() => {
    if (!vrmLoaded || node.kind !== 'avatar') return;
    let cancelled = false;
    const fbxAssets = assetsForProbe.filter(
      (a) => a.kind === 'animation' && a.name.toLowerCase().endsWith('.fbx')
    );
    if (fbxAssets.length === 0) return;

    void (async () => {
      try {
        const listResp = await fetch(`/api/scene-nodes/${node.id}/clips`);
        const listJson = (await listResp.json()) as {
          ok: boolean;
          data?: Array<{ source_file_path: string; clip_index: number }>;
        };
        const registered = new Set(
          (listJson.data ?? []).map(
            (c) => `${c.source_file_path}#${c.clip_index ?? 0}`
          )
        );
        for (const asset of fbxAssets) {
          if (cancelled) return;
          if (registered.has(`${asset.url}#0`)) continue;
          await new Promise<void>((resolve) => {
            new FBXLoader().load(
              asset.url,
              (fbx) => {
                if (cancelled) return resolve();
                const clip = fbx.animations[0];
                if (!clip) return resolve();
                fetch(`/api/scene-nodes/${node.id}/clips`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    name: asset.name.replace(/\.fbx$/i, ''),
                    sourceFilePath: asset.url,
                    clipIndex: 0,
                    label: clip.name || asset.name,
                    startTime: 0,
                    endTime: clip.duration,
                    duration: clip.duration,
                    fps: 30,
                  }),
                })
                  .catch(() => {
                    /* non-fatal */
                  })
                  .finally(() => resolve());
              },
              undefined,
              () => resolve()
            );
          });
        }
      } catch {
        /* non-fatal */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [vrmLoaded, node.id, node.kind, assetsForProbe]);

  // Stop and drop whatever clip is currently driving this avatar: halt both
  // mixers, remove the debug correction axes, clear the FBX display, and clear
  // this instance's animation entry (what useFrame reads). Called at the swap
  // point and on unmount — never from the load effect's dep-change cleanup, so a
  // clip switch keeps playing until its replacement is ready.
  const teardownActiveAnim = useCallback(() => {
    fbxMixerRef.current?.stopAllAction();
    fbxMixerRef.current = null;
    vrmMixerRef.current?.stopAllAction();
    vrmMixerRef.current = null;
    corrAxesRef.current.forEach((g) => g.removeFromParent());
    corrAxesRef.current = [];
    fbxGroupRef.current?.clear();
    fbxHelperRef.current?.clear();
    animEntryRef.current = null;
    for (const name of Object.keys(slotsRef.current) as ClipSlotName[])
      slotsRef.current[name]?.mixer.stopAllAction();
    slotsRef.current = {};
    frozenRef.current.clear();
  }, []);

  /** Stop and drop a single slot, leaving the others playing. */
  const teardownSlot = useCallback((name: ClipSlotName) => {
    const slot = slotsRef.current[name];
    if (!slot) return;
    slot.mixer.stopAllAction();
    delete slotsRef.current[name];
    retiredSlotsRef.current.delete(name);
  }, []);

  /**
   * Mark a slot as no longer wanted, but keep it loaded and playable.
   *
   * A slot must outlive the decision to stop showing it: the frame loop needs it
   * resident for one more frame to freeze its pose as the outgoing side of the
   * cross-fade. Effects commit before the next frame, so tearing down here would
   * always beat the fade. The frame loop drops retired slots once no fade needs
   * them.
   */
  const retireSlot = useCallback((name: ClipSlotName) => {
    if (!slotsRef.current[name]) return;
    retiredSlotsRef.current.add(name);
  }, []);

  // --- Animation load (per slot) ---
  //
  // Loads one clip into one named slot. Each rotation source owns a slot, so
  // loading/replacing one leaves the others playing — that independence is what
  // lets two sources be read simultaneously for a cross-fade.
  //
  // Returns a cancel function; callers wire it into their effect cleanup so a
  // dep change abandons an in-flight load without tearing down the live clip.
  const loadClipIntoSlot = useCallback(
    (url: string, slot: ClipSlotName): (() => void) => {
      let cancelled = false;
      const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
      if (ext !== 'fbx') {
        teardownSlot(slot);
        return () => {};
      }

      new FBXLoader().load(url, (fbx) => {
        if (cancelled) return;
        const clip = fbx.animations[0];
        if (!clip) return;
        const vrm = vrmRef.current;
        if (!vrm) return;

        // Swap point: the outgoing clip in THIS slot is stopped in the same
        // synchronous callback that bakes and installs the incoming one (see the
        // teardownSlot call below), so the two never straddle a rendered frame.
        // Other slots are untouched. (Guards above return early without tearing
        // down, so a failed/empty load leaves the current clip playing.)

        // Snapshot bone local quaternions at load time (A-pose / bind pose for animation-only FBX).
        const loadTimeQ: Record<string, THREE.Quaternion> = {};
        fbx.traverse((o) => {
          if (FBX_BONE_TO_VRM[o.name]) loadTimeQ[o.name] = o.quaternion.clone();
        });

        // Snapshot bone WORLD quaternions at load time, in FBX-local space (before fbx.rotation.y
        // is set and before adding to fbxGroup). These include the 'root' node's coordinate-
        // system correction (Z-up→Y-up) but not any display transforms.
        fbx.updateWorldMatrix(true, true);
        const loadTimeWQ: Record<string, THREE.Quaternion> = {};
        const _wqLoad = new THREE.Quaternion();
        fbx.traverse((o) => {
          if (FBX_BONE_TO_VRM[o.name]) {
            o.getWorldQuaternion(_wqLoad);
            loadTimeWQ[o.name] = _wqLoad.clone();
          }
        });

        // FBXLoader's coordinate-system correction (e.g. Z-up→Y-up for UE4), captured before
        // we overwrite fbx.rotation.y with our display flip.  For Y-up FBX (Mixamo) this is
        // identity, so conjugating the world-space delta by it is a no-op for Mixamo.

        // FBX skeleton display
        if (fbxGroupRef.current) {
          fbxGroupRef.current.clear();
          fbx.scale.setScalar(0.01);
          fbx.rotation.y = Math.PI;
          fbxGroupRef.current.position.x = 2;
          fbxGroupRef.current.add(fbx);
          // addBoneAxes(fbx, 5)
          fbxGroupRef.current.visible =
            useEditorStore.getState().fbxDebugVisible[node.id] ?? false;
        }
        if (fbxHelperRef.current) {
          fbxHelperRef.current.clear();
          const helper = new THREE.SkeletonHelper(fbx);
          (helper.material as THREE.LineBasicMaterial).color.set(0x00ff88);
          (helper.material as THREE.LineBasicMaterial).depthTest = false;
          fbxHelperRef.current.add(helper);
          fbxHelperRef.current.visible =
            useEditorStore.getState().fbxDebugVisible[node.id] ?? false;
        }

        // Collect FBX bone world Qs via getWorldQuaternion — same as what SkeletonHelper reads.
        // updateWorldMatrix(true,true) propagates from parents down so world matrices are current.
        fbxGroupRef.current?.updateWorldMatrix(true, true);
        const fbxBoneWorldQ: Record<string, THREE.Quaternion> = {};
        const _wqTmp = new THREE.Quaternion();
        fbx.traverse((o) => {
          if (FBX_BONE_TO_VRM[o.name]) {
            o.getWorldQuaternion(_wqTmp);
            fbxBoneWorldQ[o.name] = _wqTmp.clone();
          }
        });
        // Log intermediate nodes between fbx root and pelvis to find hidden transforms
        {
          let cur: THREE.Object3D | null = null;
          fbx.traverse((o) => {
            if (o.name === 'pelvis' && !cur) cur = o as THREE.Object3D;
          });
          const path: string[] = [];
          let n = cur as THREE.Object3D | null;
          while (n && n !== fbx) {
            const q = n.quaternion;
            path.unshift(
              `${n.name || '?'} q=(${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)})`
            );
            n = n.parent as THREE.Object3D | null;
          }
          console.log('[fbxChain] fbx→pelvis:', path.join(' → '));
        }

        const baked = bakeRetargetedClip(
          fbx,
          clip,
          vrm,
          frontYawRef.current,
          loadTimeQ
        );
        const { vrmTracks, allTimes, outQVals, newCorrAxes, VRM_TO_FBX } =
          baked;
        corrAxesRef.current = newCorrAxes;

        // FBX display mixer — clipAction() captures node.quaternion as the PropertyMixer
        // origValue (what REST restores to). We create it here, after retargeting baked,
        // so play/update never runs during Phase 1.
        const fbxMixer = new THREE.AnimationMixer(fbx);
        fbxMixerRef.current = fbxMixer;
        const fbxAction = fbxMixer.clipAction(clip);
        fbxAction.reset().play();

        // Clamp duration. If the last keyframe value duplicates the first (a "closed loop"
        // where t=0 and t=lastKey hold the same pose), shorten to the second-to-last keyframe
        // so the loop wraps cleanly without a single-frame discontinuity at the boundary.
        let lastKeyTime =
          allTimes.length > 0 ? allTimes[allTimes.length - 1] : clip.duration;
        const lastIdx = allTimes.length - 1;
        if (lastIdx >= 1) {
          // Compare first and last baked quaternion for a representative bone (hips)
          const hipsVn = FBX_BONE_TO_VRM[VRM_TO_FBX.hips ?? ''] as
            | VRMHumanBoneName
            | undefined;
          const arr = hipsVn ? outQVals[hipsVn] : undefined;
          if (arr) {
            const dx = arr[0] - arr[lastIdx * 4];
            const dy = arr[1] - arr[lastIdx * 4 + 1];
            const dz = arr[2] - arr[lastIdx * 4 + 2];
            const dw = arr[3] - arr[lastIdx * 4 + 3];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw);
            if (dist < 1e-3) {
              lastKeyTime = allTimes[lastIdx - 1];
              console.log(
                `[clipDur] first==last detected (dist=${dist.toExponential(2)}), trimming duration to ${lastKeyTime.toFixed(3)}`
              );
            }
          }
        }
        const vrmDuration = Math.min(clip.duration, lastKeyTime);
        // Diagnostics: per-track time ranges to spot mismatches
        let minStart = Infinity,
          maxEnd = -Infinity;
        const trackTails: string[] = [];
        for (const t of clip.tracks) {
          const ts = t.times;
          if (ts.length < 2) continue;
          if (ts[0] < minStart) minStart = ts[0];
          if (ts[ts.length - 1] > maxEnd) maxEnd = ts[ts.length - 1];
          // Flag tracks whose end deviates from the consensus
          if (Math.abs(ts[ts.length - 1] - lastKeyTime) > 0.001) {
            trackTails.push(
              `${t.name}@[${ts[0].toFixed(3)}…${ts[ts.length - 1].toFixed(3)},n=${ts.length}]`
            );
          }
        }
        console.log(
          `[clipDur] orig=${clip.duration.toFixed(3)} consensusEnd=${lastKeyTime.toFixed(3)} actualSpan=[${minStart.toFixed(3)}…${maxEnd.toFixed(3)}] outliers:`,
          trackTails.slice(0, 10)
        );
        const vrmClip = new THREE.AnimationClip(
          clip.name,
          vrmDuration,
          vrmTracks
        );
        // Bind the clip mixer to a SHADOW skeleton, not `vrm.scene`. The mixer then
        // owns its write target exclusively, so the animation pose can never be
        // overwritten by (nor read back from) the composed pose on the real
        // skeleton. See ShadowSkeleton for the failure this prevents.
        const shadow = new ShadowSkeleton(
          vrm,
          VRM_BONE_NAMES as unknown as VRMHumanBoneName[]
        );
        // Fail loudly rather than silently rendering rest: if the baked tracks
        // don't resolve against the shadow hierarchy, every bone would sit at its
        // seeded rest pose and look like "the animation does nothing".
        const shadowNames = new Set(shadow.boneNames());
        const unresolved = vrmTracks
          .map((t) => t.name.split('.')[0])
          .filter((n) => !shadowNames.has(n));
        if (unresolved.length > 0) {
          console.error(
            `[anim] ${unresolved.length}/${vrmTracks.length} baked tracks do not ` +
              `resolve against the shadow skeleton (${shadow.size} bones) — the ` +
              `animation would render as rest. Unresolved: ${unresolved.slice(0, 8).join(', ')}`
          );
        }
        const vrmMixer = new THREE.AnimationMixer(shadow.root);
        vrmMixerRef.current = vrmMixer;
        const vrmAction = vrmMixer.clipAction(vrmClip);
        vrmAction.reset().play();
        // No initial seek here: the per-frame anchored drive (useFrame) sets
        // action.time from the active layer's startEpoch against the synced clock,
        // so the playhead is phase-accurate on the very first frame regardless of
        // this client's (possibly seconds-long) load latency. timeScale stays 1 —
        // speed is baked into the anchored time, and the mixer is stepped with
        // update(0) so it never free-runs out of phase.

        animEntryRef.current = {
          action: vrmAction,
          mixer: vrmMixer,
          vrmDuration,
          fbxAction,
          fbxMixer,
          fbxScene: fbx,
          duration: clip.duration,
        };

        // Install as an independent slot. Replacing an existing slot stops only
        // that slot's mixer, so the other source keeps playing across the swap.
        teardownSlot(slot);
        slotsRef.current[slot] = {
          url,
          shadow,
          mixer: vrmMixer,
          action: vrmAction,
          vrmDuration,
          duration: clip.duration,
        };
      });

      // Only cancel the in-flight load. Tearing the live clip down here is what
      // caused the rest-pose flash: it ran the instant the url changed, before
      // the replacement had baked. Teardown happens at the swap point instead.
      return () => {
        cancelled = true;
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node.filePath, teardownSlot]
  );

  // Idle slot — always loaded when an idle clip is configured. Kept resident even
  // while the base drives the avatar, so it is ready to be faded back to.
  const idleUrl = idle?.url ?? null;
  useEffect(() => {
    if (!idleUrl || !node.filePath || !vrmLoaded) {
      teardownSlot('idle');
      return;
    }
    return loadClipIntoSlot(idleUrl, 'idle');
  }, [idleUrl, node.filePath, vrmLoaded, loadClipIntoSlot, teardownSlot]);

  // Base slot — the loop tracking stacks onto. Also the landing slot for
  // scheduled one-shots for now: `animUrl` still resolves those through
  // `_resolveAvatarAnimation`'s hard switch, so a scheduled clip temporarily
  // replaces the base here. Giving `scheduled` its own slot is the follow-up.
  const baseSlotUrl = animUrl && animUrl !== idleUrl ? animUrl : null;
  useEffect(() => {
    if (!baseSlotUrl || !node.filePath || !vrmLoaded) {
      // Retire rather than tear down: React commits this effect BEFORE the next
      // frame, so an immediate teardown deleted the slot before useFrame could
      // freeze it as the fade's outgoing side. `fade.from` then pointed at a
      // missing slot, the freeze fell through to `clear()`, and crossfadeAnimPose
      // with a null `from` returns slerp(rest, to, k) — rest at k=0, not the
      // outgoing pose. The base→idle animation cross-fade was silently skipped and
      // the baseline cut in one frame. Marking it retired lets the frame loop take
      // its final pose and drop it once the fade settles.
      retireSlot('base');
      return;
    }
    return loadClipIntoSlot(baseSlotUrl, 'base');
  }, [baseSlotUrl, node.filePath, vrmLoaded, loadClipIntoSlot, retireSlot]);

  // Scheduled slot — a timeline one-shot, loaded only while its entry is active.
  // Deliberately NOT torn down the instant the entry retires: the frame loop needs
  // the clip resident to fade out of. It freezes the outgoing pose (FrozenPose) at
  // the moment the fade starts, so teardown here is safe even mid-fade.
  const schedSlotUrl = schedResolved.url;
  useEffect(() => {
    if (!schedSlotUrl || !node.filePath || !vrmLoaded) {
      teardownSlot('scheduled');
      return;
    }
    return loadClipIntoSlot(schedSlotUrl, 'scheduled');
  }, [schedSlotUrl, node.filePath, vrmLoaded, loadClipIntoSlot, teardownSlot]);

  // Evict this avatar's clip from the shared registry on unmount (the load
  // effect's cleanup no longer does — it only cancels in-flight loads).
  useEffect(() => teardownActiveAnim, [teardownActiveAnim]);

  const _boneStartWP = useRef(new THREE.Vector3());
  const _boneEndWP = useRef(new THREE.Vector3());
  const _boneDir = useRef(new THREE.Vector3());
  const _Y = new THREE.Vector3(0, 1, 0);
  const _shoulderWorld = useRef(new THREE.Vector3());
  const _wristWorld = useRef(new THREE.Vector3());
  const _correctedWrist = useRef(new THREE.Vector3());
  const _q = useRef(new THREE.Quaternion()).current;

  useFrame((_, delta) => {
    const vrm = vrmRef.current;
    const cyl = boneCylRef.current;
    if (cyl) {
      const hoveredBone = useEditorStore.getState()
        .hoveredBoneName as VRMHumanBoneName | null;
      const retarget = vmcRetargetRef.current;
      const startObj =
        hoveredBone && retarget ? retarget.vrmBoneObj[hoveredBone] : null;
      const childBone =
        hoveredBone && retarget
          ? (
              Object.entries(retarget.vrmBoneParent) as [
                VRMHumanBoneName,
                VRMHumanBoneName,
              ][]
            ).find(([, parent]) => parent === hoveredBone)?.[0]
          : null;
      const endObj =
        childBone && retarget ? retarget.vrmBoneObj[childBone] : null;

      if (startObj && endObj && groupRef.current) {
        startObj.getWorldPosition(_boneStartWP.current);
        endObj.getWorldPosition(_boneEndWP.current);
        groupRef.current.worldToLocal(_boneStartWP.current);
        groupRef.current.worldToLocal(_boneEndWP.current);
        _boneDir.current.subVectors(_boneEndWP.current, _boneStartWP.current);
        const length = _boneDir.current.length();
        cyl.position
          .addVectors(_boneStartWP.current, _boneEndWP.current)
          .multiplyScalar(0.5);
        cyl.scale.set(1, length, 1);
        cyl.quaternion.setFromUnitVectors(_Y, _boneDir.current.normalize());
        cyl.visible = true;
      } else {
        cyl.visible = false;
      }
    }

    // Pose gating is now driven by the bus, not by component presence.
    // The bus emits a merged frame whenever any producer publishes; when all
    // producers drop out it emits a single fallback frame with empty bones +
    // mode=additive, which trips `poseActive` off and the avatar ramps back
    // to pure animation. The mode flag selects composition (see Step 2):
    //   override → broadcast replaces animation
    //   additive → broadcast quats multiply onto animation quats
    //
    // Client-side safety net for pose updates that stop arriving
    // without a matching transition message (e.g. WS reconnect mid-deactivation).
    // The tracking sources themselves now hold their own grace period server-side
    // before declaring a loss, so this only covers the server→client leg.
    //
    // It reads the node's own grace period rather than a hardcoded window: at a
    // fixed 2s, any longer setting was overruled by this watchdog before the
    // server-side window had even elapsed, and the avatar dropped to idle early
    // anyway.
    const POSE_TIMEOUT_MS =
      Math.max(0.1, node.properties?.trackingGracePeriod ?? 2) * 1000;
    const lastPoseTime = getVmcPoseTime(node.id);
    const pose = getVmcPose(node.id);
    const poseMode = getVmcPoseBlendMode(node.id);
    const poseActive =
      pose != null &&
      Object.keys(pose).length > 0 &&
      lastPoseTime != null &&
      Date.now() - lastPoseTime < POSE_TIMEOUT_MS;

    // Base⇄idle swap keys off whether a genuine *tracking* source (VMC /
    // MediaPipe) is live for this node, NOT off raw pose presence. Ambient
    // producers like breathing keep publishing a pose forever, so `poseActive`
    // stays true even after real tracking drops — using it here would pin the
    // avatar to the base loop and never fall back to idle. Tracking sources
    // emit `vmc_tracking_state` (→ store.vmcTracking); ambient ones don't, so
    // they can't mask a loss.
    const store = useEditorStore.getState();
    const trackingLive = store.behaviors.some(
      (b) => b.nodeId === node.id && store.vmcTracking[b.id] === true
    );

    // Transition detection: reset filters + clear the applied pose when the
    // composition leaves the tracked path. Keyed on `trackingLive`, matching the
    // Step 2 gate — an ambient producer keeps `poseActive` true after tracking
    // drops, so watching that alone would never fire the reset and stale filter
    // state (and the last tracked pose) would leak into the straight idle.
    const trackedActive = trackedComposeActive(trackingLive, poseActive);
    if (trackingLive !== trackingActiveRef.current) {
      trackingActiveRef.current = trackingLive;
      setTrackingActive(trackingLive);
    }

    // Ramp blend weight: 0 = pure animation, 1 = pure broadcast pose.
    // Configured per-avatar via the VRM node's `blendTransitionTime` property.
    // Targets the *tracked* compose state, not raw pose presence: an ambient
    // producer holds `poseActive` true forever, which would pin the weight at 1
    // and stop it ever ramping down on tracking loss.
    const blendTime = Math.max(0, node.properties?.blendTransitionTime ?? 0.5);
    const BLEND_SPEED = blendTime > 0 ? 1 / blendTime : Infinity;
    const targetWeight = trackedActive ? 1 : 0;
    // The tracked-MODE weight ramps on the same clock. Previously the composition
    // switched branches instantly on `trackingLive` while only `blend` ramped, so at
    // the switchover the branches still differed by the section's Anim lever — every
    // section below Anim 1 jumped by exactly `1 - anim`. Sections at Anim 1 didn't
    // move (hence only *part* of the pose snapping), and each direction left `blend`
    // at a different point (hence the two directions snapping differently).
    // Ramping it makes the tracked⇄untracked boundary continuous. See
    // composeBonePose.
    const mw = modeWeightRef.current;
    modeWeightRef.current =
      mw === targetWeight
        ? mw
        : Math.max(
            0,
            Math.min(1, mw + Math.sign(targetWeight - mw) * BLEND_SPEED * delta)
          );
    const modeWeight = modeWeightRef.current;

    // Transition reset, fired on the modeWeight >0 → 0 edge — i.e. when the
    // fade-out has actually FINISHED, not when it starts.
    //
    // This used to key off `trackedActive` going false, which is the *first* frame
    // of the exit, while modeWeight was still ~1 and the tracked path was still
    // rendering at near-full weight. `BoneFilterBank.reset()` clears each One Euro
    // filter's `initialized` flag, so the next `filter()` call returns the raw
    // incoming sample verbatim instead of the smoothed one (oneEuroFilter.ts:39-43)
    // — a one-frame jump from smoothed to raw at full tracking weight, which the
    // ramp could not absorb because it had not started yet. And
    // `resetNormalizedPose()` wiped the very pose the in-flight ramp was reading.
    // Both are correct once the fade is over; neither is at its start.
    if (modeWeight === 0 && poseWasActiveRef.current) {
      boneFiltersRef.current.reset();
      vrm?.humanoid.resetNormalizedPose();
      // Release the held tracking pose too — the fade is over, and a stale pose
      // must not resurface when tracking next starts.
      trackedLatchRef.current.clear();
    }
    poseWasActiveRef.current = modeWeight > 0;

    // ── Step 1: animation (always runs, gives us the "animation raw pose") ──────
    // Clock-anchored drive: set each action's playhead from the active layer
    // against the synced clock, then step the mixer with update(0). The mixer
    // never free-runs, so every client (and every reload) stays in phase.
    //
    // EVERY loaded slot is ticked, not just the visible one. Each writes only its
    // own shadow skeleton, so this costs one interpolation per slot and keeps a
    // dormant source current — a slot that lagged behind would jump on the frame a
    // cross-fade started. Both clips are clock-anchored, so they stay in phase
    // with each other for free.
    const layer = activeLayerRef.current;
    const slots = slotsRef.current;
    const slotLayers = slotLayersRef.current;
    const reg = animEntryRef.current;
    const now = Date.now();
    if (reg && layer) {
      // FBX debug display (the side-by-side source rig), not a rotation source.
      reg.fbxAction.time = _anchoredTime(now, layer, reg.duration);
      reg.fbxMixer.update(0);
    }
    if (vrm) {
      // Drives the SHADOW skeletons only — the real bones are untouched here, so
      // the composition below is the sole writer of `vrm` bone rotations. Each
      // slot advances on its OWN layer: the loops are epoch-anchored while a
      // one-shot is anchored to its entry, so a shared layer would misphase it.
      let anyDriven = false;
      for (const name of Object.keys(slots) as ClipSlotName[]) {
        const slot = slots[name];
        const slotLayer = slotLayers[name] ?? layer;
        if (!slot || !slotLayer) continue;
        slot.action.time = _anchoredTime(now, slotLayer, slot.vrmDuration);
        slot.mixer.update(0);
        anyDriven = true;
      }
      if (!anyDriven) {
        // No clip active (or still loading) — keep the humanoid normalized so any
        // held/broadcast pose stays applied.
        (vrm.humanoid as unknown as { update?: () => void }).update?.();
      }
    }

    // ── Animation source selection + cross-fade ──────────────────────────────────
    //
    // Precedence: a scheduled one-shot outranks the loops; otherwise base (when
    // tracking is live and one is set) else idle. Changing source starts a fade
    // rather than cutting, which is only possible because every source stays
    // resident in its own slot.
    const fade = sourceFadeRef.current;
    // Retired slots are still loaded (so a fade can read them) but must not be
    // selected as the destination — otherwise the avatar would keep showing a
    // source the resolution has already moved away from.
    const retired = retiredSlotsRef.current;
    const live = (name: ClipSlotName) => !!slots[name] && !retired.has(name);
    const desiredSlot: ClipSlotName | null = live('scheduled')
      ? 'scheduled'
      : live('base')
        ? 'base'
        : live('idle')
          ? 'idle'
          : null;
    const fadeSeconds = Math.max(
      0,
      node.properties?.blendTransitionTime ?? 0.5
    );
    if (fade.retarget(desiredSlot)) {
      // A new fade began. Freeze the outgoing pose: its clip may be torn down
      // before the fade finishes (a retiring one-shot is unloaded as soon as its
      // entry stops resolving), and a frozen pose is the right thing for a clip
      // with nothing left to play anyway.
      const outgoing = fade.from ? slots[fade.from] : null;
      if (outgoing)
        frozenRef.current.captureFrom(
          outgoing.shadow,
          VRM_BONE_NAMES as unknown as VRMHumanBoneName[]
        );
      else frozenRef.current.clear();
    }
    fade.advance(delta, fadeSeconds);
    activeSlotRef.current = fade.to ?? 'idle';

    // Drop retired slots once no in-flight fade still reads them. Deferring the
    // teardown to here (rather than the effect that retired them) is what gives
    // the fade a real outgoing pose to blend from.
    if (retired.size > 0) {
      for (const name of [...retired]) {
        if (fade.fading && fade.from === name) continue; // still needed
        teardownSlot(name);
      }
    }

    // Resolve the two sides of the fade. The outgoing side prefers its live slot
    // (still loaded ⇒ keeps animating through the fade) and falls back to the
    // frozen pose once that clip is gone.
    const toShadow = fade.to ? (slots[fade.to]?.shadow ?? null) : null;
    const fromSlot = fade.from ? slots[fade.from] : null;
    const frozen = frozenRef.current;
    const fading = fade.fading;
    const fadeT = fade.progress;
    const animSource = toShadow;
    // Per-bone animation pose with the source cross-fade applied. Not fading ⇒ the
    // incoming source verbatim; fading ⇒ blended against the outgoing side (its
    // live slot while still loaded, else the pose frozen when the fade began).
    const _fadeQ = _fadeScratchQ;
    const animRotationFor = (
      name: VRMHumanBoneName,
      restQ: THREE.Quaternion
    ): THREE.Quaternion | null => {
      const to = toShadow?.rotation(name) ?? null;
      if (!fading) return to;
      const from =
        (fromSlot ? fromSlot.shadow.rotation(name) : null) ??
        frozen.rotation(name);
      if (!from && !to) return null;
      return crossfadeAnimPose(restQ, from, to, fadeT, _fadeQ);
    };
    const animHipsPositionFor = (
      restPos: THREE.Vector3
    ): THREE.Vector3 | null => {
      const to = toShadow?.hipsPosition() ?? null;
      if (!fading) return to;
      const from =
        (fromSlot ? fromSlot.shadow.hipsPosition() : null) ??
        frozen.hipsPosition();
      if (!from && !to) return null;
      return crossfadeHipsPosition(restPos, from, to, fadeT, _fadeScratchV);
    };

    // ── Step 2: broadcast pose composition ──────────────────────────────────────
    //
    // Gated on `trackingLive`, NOT on bus-pose presence. Ambient producers
    // (Breathing publishes additively and forever, independent of tracking) keep
    // `pose` non-null and `blend > 0` for the lifetime of the behavior, so a
    // `blend > 0 && pose` gate ran the weighted tracked path permanently and the
    // untracked idle path below could never be reached whenever an ambient
    // producer was attached. Ambient poses merge into the *tracked* pose only;
    // with no tracking the idle plays straight and they are not applied.
    // ── Step 2: unified composition ─────────────────────────────────────────────
    //
    // ONE path for tracked and untracked. `modeWeight` (0 = animation straight,
    // 1 = levers + tracking) selects between them continuously, so there is no
    // branch boundary left to snap across. The tracked side runs while the mode is
    // engaged *or still ramping down*, which is what keeps a fade-out rendering
    // after `trackingLive` has already gone false.
    // No `pose != null` requirement: the latch supplies the tracking data during a
    // fade-out, so the path keeps rendering even if the pose object disappears
    // entirely (producer removed rather than merely gone quiet).
    const wantTracked = trackedActive || modeWeight > 0;
    if (wantTracked && vrm) {
      // Build filtered broadcast normalized pose.
      const normalizedPose: VRMPose = {};
      const filters = boneFiltersRef.current;
      const latch = trackedLatchRef.current;
      // The bus's final frame carries EMPTY bones, so an exit would otherwise lose
      // the whole tracking term in one frame while modeWeight was still high.
      // Populated ⇒ latch it; empty/absent ⇒ replay the latch so the ramp has
      // something real to fade from.
      const posePopulated = pose != null && Object.keys(pose).length > 0;
      // Second-order "snappiness" runs *after* the One Euro filter (which keeps
      // absorbing jitter / uneven packet delivery). Disabled by default; reset
      // when off so re-enabling starts cleanly from the current pose.
      const dyn = node.properties?.poseDynamics ?? DEFAULT_POSE_DYNAMICS;
      const dynamics = boneDynamicsRef.current;
      if (!dyn.enabled) dynamics.reset();
      const sourceEntries: Array<[string, [number, number, number, number]]> =
        posePopulated
          ? (Object.entries(pose!) as Array<
              [string, [number, number, number, number]]
            >)
          : latch.names().map((n) => {
              const lq = latch.get(n)!;
              return [n, [lq.x, lq.y, lq.z, lq.w]] as [
                string,
                [number, number, number, number],
              ];
            });
      for (const [boneName, q] of sourceEntries) {
        _q.set(q[0], q[1], q[2], q[3]);
        // Skip the One Euro filter when replaying the latch: it is a held constant,
        // and re-filtering it would drift the pose while the fade runs.
        let s = posePopulated ? filters.filter(boneName, _q, delta) : _q;
        if (dyn.enabled) {
          s = dynamics.filter(
            boneName,
            s,
            delta,
            dyn.frequency,
            dyn.damping,
            dyn.response
          );
        }
        normalizedPose[boneName as VRMHumanBoneName] = {
          rotation: [s.x, s.y, s.z, s.w],
        };
      }
      // Latch the FILTERED pose, so a replay during the fade matches the last frame
      // actually rendered rather than the raw input.
      if (posePopulated)
        latch.update(
          normalizedPose as Record<
            string,
            { rotation: [number, number, number, number] }
          >
        );

      // Arm calibration writes absolute rotations from world-space targets, which
      // only makes sense when broadcast replaces animation. Skip in additive mode.
      if (poseMode === 'override') {
        const vmcCfg = vmcCompRef.current?.config as
          | Record<string, unknown>
          | undefined;
        const calib = (vmcCfg?.calibration ??
          DEFAULT_CALIBRATION) as VmcCalibration;
        for (const side of ['left', 'right'] as const) {
          const armCalib = calib[side];
          if (
            armCalib.scale === 1 &&
            armCalib.offset[0] === 0 &&
            armCalib.offset[1] === 0 &&
            armCalib.offset[2] === 0
          )
            continue;
          const upperArmName = (
            side === 'left' ? 'leftUpperArm' : 'rightUpperArm'
          ) as VRMHumanBoneName;
          const handName = (
            side === 'left' ? 'leftHand' : 'rightHand'
          ) as VRMHumanBoneName;
          const upperArmBone = vrm.humanoid.getRawBoneNode(upperArmName);
          const handBone = vrm.humanoid.getRawBoneNode(handName);
          if (!upperArmBone || !handBone) continue;
          upperArmBone.getWorldPosition(_shoulderWorld.current);
          handBone.getWorldPosition(_wristWorld.current);
          applyArmCalib(
            _wristWorld.current,
            _shoulderWorld.current,
            armCalib,
            _correctedWrist.current
          );
          const rot = upperArmNormRotFromTarget(
            _correctedWrist.current,
            upperArmBone,
            side === 'right'
          );
          normalizedPose[upperArmName] = {
            rotation: [rot.x, rot.y, rot.z, rot.w],
          };
        }
      }

      {
        // "Tracking stacks on animation" — the single composition path for BOTH
        // override producers (VMC/camera, which replace) and additive producers
        // (e.g. Breathing, which stacks). For every bone, stackBoneRotation
        // stacks the (scaled) broadcast delta on top of the (scaled) base
        // animation, per body section independently. Default sections
        // ({anim:1,track:1}) → base animation with the broadcast fully stacked
        // once ramped in; the partial-tracking sliders scale each layer. The
        // poseMode flag no longer selects a separate composition — an additive
        // producer used to route here into a slider-ignoring branch, which is
        // exactly why Breathing made the Anim/Track sliders appear inert.
        const allBones = VRM_BONE_NAMES as unknown as VRMHumanBoneName[];
        // Animation baseline comes from the SHADOW skeleton — a buffer only the
        // clip mixer writes. Reading `bone.quaternion` here would alias the buffer
        // this loop writes into, feeding the composed (tracked) pose back in as
        // its own baseline whenever the mixer skipped a write.
        // Bones paired with their bone objects; the animation rotation is resolved
        // later (it needs each bone's rest pose for the fade's null cases).
        const animQuats: Array<[VRMHumanBoneName, THREE.Object3D]> = [];
        for (const name of allBones) {
          const bone = vrm.humanoid.getRawBoneNode(name);
          if (bone) animQuats.push([name, bone]);
        }
        const broadcastSet = new Set(
          Object.keys(normalizedPose) as VRMHumanBoneName[]
        );

        const hipsBone = vrm.humanoid.getRawBoneNode('hips');

        // Rest raw quats (all bones), then broadcast-posed raw quats. Compose
        // per section with stackBoneRotation, exactly like the override branch:
        // the additive delta is stacked (scaled by the section Track weight) on
        // the base animation (scaled by the section Anim weight). At default
        // weights ({anim:1,track:1}) this equals the old `animQ · delta`, but
        // the partial-tracking sliders now bite in additive mode too. This
        // matters because Breathing always publishes *additively* (an always-on
        // producer), which pins poseMode to additive — so the old additive-only
        // composition made the sliders appear to do nothing whenever Breathing
        // (or any additive source) was attached.
        vrm.humanoid.resetNormalizedPose();
        (vrm.humanoid as unknown as { update?: () => void }).update?.();
        if (hipsBone) _hipsRestPos.copy(hipsBone.position);
        {
          const p = animHipsPositionFor(_hipsRestPos);
          _hipsAnimPos.copy(p ?? _hipsRestPos);
        }
        const restRaw = new Map<VRMHumanBoneName, THREE.Quaternion>();
        for (const [name, bone] of animQuats)
          restRaw.set(name, bone.quaternion.clone());

        vrm.humanoid.setNormalizedPose(normalizedPose);
        (vrm.humanoid as unknown as { update?: () => void }).update?.();
        const trackedRaw = new Map<VRMHumanBoneName, THREE.Quaternion>();
        for (const [name, bone] of animQuats) {
          if (broadcastSet.has(name))
            trackedRaw.set(name, bone.quaternion.clone());
        }

        const poseSourceLive = node.properties?.poseSource as
          | PoseSource
          | undefined;
        const animActive = !!((animSource || fading) && layer);
        for (const [name, bone] of animQuats) {
          const inf = sectionInfluenceForBone(name, poseSourceLive);
          const restQ = restRaw.get(name)!;
          const animQ = animRotationFor(name, restQ);
          // No source for this bone (clip not loaded / not animated) ⇒ rest.
          const animContribution = animActive && animQ ? animQ : restQ;
          const tracked = trackedRaw.get(name) ?? null;
          // NOTE: no `blend` factor here. `composeBonePose` already scales the
          // tracking term by `modeWeight`, and blend === modeWeight (identical
          // targets/speed/clamp), so multiplying by both faded tracking as
          // modeWeight² — a quadratic that collapses in its final third and reads
          // as a late snap. Linear is what the ramp is meant to be.
          const tw = tracked ? Math.max(0, Math.min(1, inf.track)) : 0;
          // modeWeight ramps the levers in (1 → inf.anim) and the tracking term
          // with them, so modeWeight=0 equals the straight-animation path exactly.
          composeBonePose(
            restQ,
            animContribution,
            tracked,
            inf.anim,
            tw,
            modeWeight,
            bone.quaternion
          );
        }
        if (hipsBone) {
          composeHipsPositionBlended(
            _hipsAnimPos,
            _hipsRestPos,
            sectionInfluenceForBone('leftUpperLeg', poseSourceLive).anim,
            animActive,
            modeWeight,
            hipsBone.position
          );
          applyHipShift(
            getVmcHipOffset(node.id),
            _hipsRestPos,
            hipsBone.position
          );
        }
      }
    } else if (vrm) {
      // No broadcast pose on the bus at all (`pose == null`) — nothing to compose
      // against, so the animation plays straight. This is NOT the untracked case:
      // that is now `modeWeight → 0` of the unified path above, which keeps
      // rendering while the mode ramps down. This branch only covers "there is no
      // pose object to read", e.g. before any producer has ever published.
      //
      // Equivalent to composeBonePose(..., mode = 0) by construction: animInf = 1,
      // no tracking term. Kept as its own loop only because it needs no
      // setNormalizedPose pass.
      const allBones = VRM_BONE_NAMES as unknown as VRMHumanBoneName[];
      // Animation baseline from the shadow skeleton, not the live bones — see the
      // unified path above and ShadowSkeleton for why reading `bone.quaternion`
      // here is unsafe.
      const animQuats: Array<[VRMHumanBoneName, THREE.Object3D]> = [];
      for (const name of allBones) {
        const bone = vrm.humanoid.getRawBoneNode(name);
        if (bone) animQuats.push([name, bone]);
      }
      const hipsBone = vrm.humanoid.getRawBoneNode('hips');

      // Rest raw quats (all bones).
      vrm.humanoid.resetNormalizedPose();
      (vrm.humanoid as unknown as { update?: () => void }).update?.();
      if (hipsBone) _hipsRestPos.copy(hipsBone.position);
      {
        const p = animHipsPositionFor(_hipsRestPos);
        _hipsAnimPos.copy(p ?? _hipsRestPos);
      }
      const restRaw = new Map<VRMHumanBoneName, THREE.Quaternion>();
      for (const [name, bone] of animQuats)
        restRaw.set(name, bone.quaternion.clone());

      // Same animActive guard as the tracked branch: without a clip there is no
      // snapshot, so fall back to rest. No tracked pose here, so the tracking
      // term is dropped (trackedQ = null).
      const animActive = !!((animSource || fading) && layer);
      for (const [name, bone] of animQuats) {
        const restQ = restRaw.get(name)!;
        const animQ = animRotationFor(name, restQ);
        const animContribution = animActive && animQ ? animQ : restQ;
        // animInf = 1: straight idle, unscaled by the partial-tracking sliders.
        stackBoneRotation(restQ, animContribution, null, 1, 0, bone.quaternion);
      }
      // Root motion plays at full strength too — same reasoning as the
      // rotations above (legs Anim must not shrink the idle's translation).
      if (hipsBone)
        composeHipsPosition(
          _hipsAnimPos,
          _hipsRestPos,
          1,
          animActive,
          hipsBone.position
        );
    }

    // ── Step 3: remaining VRM subsystems on the final blended pose ───────────────
    if (vrm) {
      const v = vrm as unknown as Record<
        string,
        { update: (d?: number) => void } | undefined
      >;

      // Pre-expressionManager.update() pass: drive expression preset names via setValue.
      // Whatever the bus has most recently emitted is authoritative — producers that
      // go inactive cause the bus to emit an empty blendshapes record, which is a
      // safe no-op here.
      // Morph-target names (Fcl_*, etc.) are deferred to after update() so they
      // aren't overwritten when expressionManager applies its tracked clip values.
      // Per-node default ("resting") expression weights are applied first as a
      // baseline, then the latest broadcast blendshapes are overlaid on top so
      // live capture overrides the defaults per-key. When the bus has no active
      // producer it emits an empty record, leaving the defaults in effect.
      const defaultExpr = node.properties?.defaultExpressions;
      const bs = getVmcBlendshapes(node.id) ?? null;
      if (vrm.expressionManager) {
        const morphMap = morphMapRef.current;
        const applied = new Set<string>();
        if (defaultExpr) {
          for (const [name, value] of Object.entries(defaultExpr)) {
            if (!morphMap.has(name)) {
              vrm.expressionManager.setValue(name, value);
              applied.add(name);
            }
          }
        }
        if (bs) {
          for (const [name, value] of Object.entries(bs)) {
            if (!morphMap.has(name)) {
              vrm.expressionManager.setValue(name, value);
              applied.add(name);
            }
          }
        }
        // Release any expression we drove last frame but no longer drive, so a
        // changed face-mapper config (or an inactive producer) reverts the
        // stale weight instead of freezing it. Dropped keys never overlap
        // defaultExpr (those are re-applied above every frame), so 0 is correct.
        for (const name of prevExprKeysRef.current)
          if (!applied.has(name)) vrm.expressionManager.setValue(name, 0);
        prevExprKeysRef.current = applied;
      }

      // ── Step 2.5: IK solve ──────────────────────────────────────────────────
      // Only when the component opts into IK. Otherwise arms are driven by pose_arms_to_bones quaternions.
      const useIk =
        (vmcCompRef.current?.config as { useIk?: boolean } | undefined)
          ?.useIk === true;
      if (vmcCompRef.current?.kind === 'mediapipe_tracker' && useIk) {
        const ikFrame = getIkTargets(node.id);
        const ikTime = getIkTargetsTime(node.id);
        const IK_TIMEOUT_MS = 2000;
        if (ikFrame && ikTime && Date.now() - ikTime < IK_TIMEOUT_MS) {
          // Resolve the reference bone world position
          const refBoneNode = vrm.humanoid.getRawBoneNode(
            ikFrame.referenceBone as VRMHumanBoneName
          );
          if (refBoneNode) {
            const refWorldPos = new THREE.Vector3();
            refBoneNode.getWorldPosition(refWorldPos);
            // Avatar's facing rotation: applies to chest-relative offsets so MP "subject front" maps
            // to avatar's front regardless of scene-level rotations on the VRM.
            const avatarOrient = new THREE.Quaternion();
            refBoneNode.getWorldQuaternion(avatarOrient);

            // Uniform scale: fit source shoulder width to target rig's shoulder width.
            // Both upper-arm bones' world positions are the avatar's shoulder joints.
            let scale = 1;
            const lUA = vrm.humanoid.getRawBoneNode(
              'leftUpperArm' as VRMHumanBoneName
            );
            const rUA = vrm.humanoid.getRawBoneNode(
              'rightUpperArm' as VRMHumanBoneName
            );
            const avatarLeftShoulderChestRel = new THREE.Vector3();
            const avatarRightShoulderChestRel = new THREE.Vector3();
            // Avatar shoulder offsets, expressed in the chest's LOCAL frame (so we can compare
            // them to source positions which are in the source subject's local chest frame).
            const avatarOrientInv = avatarOrient.clone().invert();
            if (lUA && rUA) {
              const lp = new THREE.Vector3();
              lUA.getWorldPosition(lp);
              const rp = new THREE.Vector3();
              rUA.getWorldPosition(rp);
              avatarLeftShoulderChestRel
                .copy(lp)
                .sub(refWorldPos)
                .applyQuaternion(avatarOrientInv);
              avatarRightShoulderChestRel
                .copy(rp)
                .sub(refWorldPos)
                .applyQuaternion(avatarOrientInv);
              if (
                ikFrame.sourceShoulderWidth &&
                ikFrame.sourceShoulderWidth > 1e-4
              ) {
                const avatarShoulderWidth = lp.distanceTo(rp);
                if (avatarShoulderWidth > 1e-4)
                  scale = avatarShoulderWidth / ikFrame.sourceShoulderWidth;
              }
            }

            // Per-side correction: align source shoulder (scaled) with avatar shoulder,
            // both expressed relative to the chest reference. This re-anchors arm motion
            // to the avatar's actual shoulder while keeping chest as the global frame origin.
            const leftCorrection = new THREE.Vector3();
            const rightCorrection = new THREE.Vector3();
            if (ikFrame.sourceLeftShoulder && lUA) {
              leftCorrection.set(
                avatarLeftShoulderChestRel.x -
                  ikFrame.sourceLeftShoulder[0] * scale,
                avatarLeftShoulderChestRel.y -
                  ikFrame.sourceLeftShoulder[1] * scale,
                avatarLeftShoulderChestRel.z -
                  ikFrame.sourceLeftShoulder[2] * scale
              );
            }
            if (ikFrame.sourceRightShoulder && rUA) {
              rightCorrection.set(
                avatarRightShoulderChestRel.x -
                  ikFrame.sourceRightShoulder[0] * scale,
                avatarRightShoulderChestRel.y -
                  ikFrame.sourceRightShoulder[1] * scale,
                avatarRightShoulderChestRel.z -
                  ikFrame.sourceRightShoulder[2] * scale
              );
            }

            for (const target of ikFrame.targets) {
              if (!target.position || target.confidence < 0.4) continue;
              if (target.chain.length < 2) continue;

              // Pick the side-specific correction. Fingers + arms on the left side use leftCorrection.
              const isLeft = target.bone.startsWith('left');
              const correction = isLeft ? leftCorrection : rightCorrection;

              // Build target in chest-local space (correction is already in chest-local).
              const targetLocal = new THREE.Vector3(
                target.position[0] * scale + correction.x,
                target.position[1] * scale + correction.y,
                target.position[2] * scale + correction.z
              );
              // Rotate from chest-local to world by the chest's world orientation, then add chest world position.
              const targetWorld = targetLocal
                .clone()
                .applyQuaternion(avatarOrient)
                .add(refWorldPos);

              if (target.chain.length === 2) {
                // Two-bone analytical IK: chain[0]=upper, chain[1]=lower (end-effector = bone)
                _solveTwoBoneIk(
                  vrm,
                  target.chain[0] as VRMHumanBoneName,
                  target.chain[1] as VRMHumanBoneName,
                  targetWorld
                );
              } else if (target.chain.length === 3) {
                // Three-bone: solve upper+lower to reach the wrist, then leave hand orientation
                _solveTwoBoneIk(
                  vrm,
                  target.chain[0] as VRMHumanBoneName,
                  target.chain[1] as VRMHumanBoneName,
                  targetWorld
                );
              }
              // Longer chains (fingers) are not IK-solved here — handled by quaternion mapper
            }
          }
        }
      }

      // Route the forearm roll onto the twist bone (no-op when none is set up).
      // After IK / setNormalizedPose so it reads the final lowerArm rotation,
      // before spring-bone / constraint updates so they see the twisted pose.
      driveForearmTwist(node.id);

      v['lookAt']?.update(delta);
      v['expressionManager']?.update();

      // Post-expressionManager.update() pass: write morph targets directly.
      // expressionManager.update() has already run, so these won't be overwritten.
      const bs2 = getVmcBlendshapes(node.id);
      const morphMap = morphMapRef.current;
      const appliedMorph = new Set<string>();
      if (bs2) {
        for (const [name, value] of Object.entries(bs2)) {
          const targets = morphMap.get(name);
          if (targets) {
            appliedMorph.add(name);
            for (const { mesh, index } of targets) {
              if (mesh.morphTargetInfluences)
                mesh.morphTargetInfluences[index] = value;
            }
          }
        }
      }
      // Zero any morph target we drove last frame but no longer drive, so a
      // changed face-mapper config (or an inactive producer) releases the stale
      // influence instead of leaving it frozen at its last value.
      for (const name of prevMorphKeysRef.current) {
        if (appliedMorph.has(name)) continue;
        const targets = morphMap.get(name);
        if (targets) {
          for (const { mesh, index } of targets) {
            if (mesh.morphTargetInfluences)
              mesh.morphTargetInfluences[index] = 0;
          }
        }
      }
      prevMorphKeysRef.current = appliedMorph;

      v['nodeConstraintManager']?.update(delta);
      vrm.springBoneManager?.update(delta);
      vrm.materials?.forEach((m) =>
        (m as unknown as { update?: (d: number) => void }).update?.(delta)
      );
    }
  });

  // vrmHelperRef is intentionally outside outerRef: SkeletonHelper uses
  // this.parent.matrixWorld as its reference frame, so placing it inside
  // outerRef would apply the node transform twice (once to the bones, once
  // to the helper geometry). At scene root it cancels correctly.
  return (
    <>
      <group
        ref={outerRef}
        position={[t.x, t.y, t.z]}
        rotation={[t.rx, t.ry, t.rz]}
        scale={[t.sx, t.sy, t.sz]}
      >
        <group ref={groupRef} />
        <group ref={fbxGroupRef} />
        <group ref={fbxHelperRef} />
        <mesh ref={boneCylRef} visible={false} renderOrder={999}>
          <cylinderGeometry args={[0.004, 0.004, 1, 6]} />
          <meshBasicMaterial color={0xffff00} depthTest={false} />
        </mesh>
        {children}
      </group>
      <group ref={vrmHelperRef} />
    </>
  );
}

// ── Light icon geometry (pre-computed, never changes) ──────────────────────────

const _SEGS = 32;
const _POINT_R = 0.09;
// Circle points (closed loop)
const POINT_CIRCLE_PTS = Array.from({ length: _SEGS + 1 }, (_, i) => {
  const a = (i / _SEGS) * Math.PI * 2;
  return [Math.cos(a) * _POINT_R, Math.sin(a) * _POINT_R, 0] as [
    number,
    number,
    number,
  ];
});
// 6 spokes radiating outward
const POINT_SPOKES = Array.from({ length: 6 }, (_, i) => {
  const a = (i / 6) * Math.PI * 2;
  return [
    [Math.cos(a) * (_POINT_R + 0.04), Math.sin(a) * (_POINT_R + 0.04), 0] as [
      number,
      number,
      number,
    ],
    [Math.cos(a) * (_POINT_R + 0.11), Math.sin(a) * (_POINT_R + 0.11), 0] as [
      number,
      number,
      number,
    ],
  ] as const;
});

const _DIR_R = 0.09;
const _DIR_LEN = 0.28;
// Directional: circle in XY plane
const DIR_CIRCLE_PTS = Array.from({ length: _SEGS + 1 }, (_, i) => {
  const a = (i / _SEGS) * Math.PI * 2;
  return [Math.cos(a) * _DIR_R, Math.sin(a) * _DIR_R, 0] as [
    number,
    number,
    number,
  ];
});
// 8 rays from circle perimeter along -Z (light direction)
const DIR_RAYS = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2;
  const x = Math.cos(a) * _DIR_R,
    y = Math.sin(a) * _DIR_R;
  return [
    [x, y, 0] as [number, number, number],
    [x, y, -_DIR_LEN] as [number, number, number],
  ] as const;
});

// Stylised speaker glyph for audio sources: a square body + a trapezoid cone,
// drawn in the XY plane and billboarded toward the camera. The outline is one
// closed polyline; the divider line is the shared body/cone edge so both the
// square and the trapezoid read clearly.
type Pt3 = [number, number, number];
const SPEAKER_OUTLINE_PTS: Pt3[] = [
  [-0.09, 0.04, 0], // body top-left
  [-0.03, 0.04, 0], // body top-right / cone near-top
  [0.07, 0.1, 0], // cone far-top
  [0.07, -0.1, 0], // cone far-bottom
  [-0.03, -0.04, 0], // body bottom-right / cone near-bottom
  [-0.09, -0.04, 0], // body bottom-left
  [-0.09, 0.04, 0], // close
];
const SPEAKER_DIVIDER_PTS: Pt3[] = [
  [-0.03, 0.04, 0],
  [-0.03, -0.04, 0],
];
// Two sound-wave arcs to the right of the cone.
const SPEAKER_WAVE_PTS: Pt3[][] = [0.11, 0.16].map((r) =>
  Array.from({ length: 9 }, (_, i) => {
    const a = -Math.PI / 4 + (i / 8) * (Math.PI / 2);
    return [Math.cos(a) * r + 0.04, Math.sin(a) * r, 0] as Pt3;
  })
);

function LightNode({
  node,
  viewerMode,
}: {
  node: StageObject;
  viewerMode?: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const t = useTransformWithOverride(node);
  const lc = node.components?.light as
    | {
        lightType?: string;
        color?: string;
        intensity?: number;
        castShadow?: boolean;
        shadowMapSize?: number;
        shadowBias?: number;
        shadowNormalBias?: number;
        shadowCameraSize?: number;
        shadowCameraFar?: number;
      }
    | undefined;
  const lightType = lc?.lightType ?? 'point';
  const color = lc?.color ?? '#ffffff';
  const intensity = lc?.intensity ?? 1;
  const iconColor = '#ffaa22';

  // Shadow casting is opt-in per light. These props are inert unless the
  // active camera (and thus the Canvas) has shadow maps enabled.
  const castShadow = lc?.castShadow ?? false;
  const shadowMapSize = lc?.shadowMapSize ?? 1024;
  const shadowBias = lc?.shadowBias ?? -0.0005;
  const shadowNormalBias = lc?.shadowNormalBias ?? 0.02;
  const shadowCameraSize = lc?.shadowCameraSize ?? 10; // directional ortho half-extent
  const shadowCameraFar = lc?.shadowCameraFar ?? 50;

  useEffect(() => {
    if (!groupRef.current) return;
    return registerNodeGroup(node.id, groupRef.current);
  }, [node.id]);

  return (
    <group
      ref={groupRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
    >
      {lightType === 'point' && (
        <pointLight
          color={color}
          intensity={intensity}
          castShadow={castShadow}
          shadow-mapSize-width={shadowMapSize}
          shadow-mapSize-height={shadowMapSize}
          shadow-bias={shadowBias}
          shadow-normalBias={shadowNormalBias}
          shadow-camera-near={0.1}
          shadow-camera-far={shadowCameraFar}
        />
      )}
      {lightType === 'directional' && (
        <directionalLight
          color={color}
          intensity={intensity}
          castShadow={castShadow}
          shadow-mapSize-width={shadowMapSize}
          shadow-mapSize-height={shadowMapSize}
          shadow-bias={shadowBias}
          shadow-normalBias={shadowNormalBias}
          shadow-camera-near={0.1}
          shadow-camera-far={shadowCameraFar}
          shadow-camera-left={-shadowCameraSize}
          shadow-camera-right={shadowCameraSize}
          shadow-camera-top={shadowCameraSize}
          shadow-camera-bottom={-shadowCameraSize}
        />
      )}
      {lightType === 'ambient' && (
        <ambientLight color={color} intensity={intensity} />
      )}
      {lightType === 'spot' && (
        <spotLight
          color={color}
          intensity={intensity}
          castShadow={castShadow}
          shadow-mapSize-width={shadowMapSize}
          shadow-mapSize-height={shadowMapSize}
          shadow-bias={shadowBias}
          shadow-normalBias={shadowNormalBias}
          shadow-camera-near={0.1}
          shadow-camera-far={shadowCameraFar}
        />
      )}

      {!viewerMode && lightType === 'point' && (
        <Billboard>
          <Line points={POINT_CIRCLE_PTS} color={iconColor} lineWidth={1.5} />
          {POINT_SPOKES.map((pts, i) => (
            <Line key={i} points={pts} color={iconColor} lineWidth={1.5} />
          ))}
        </Billboard>
      )}

      {!viewerMode && lightType === 'directional' && (
        <>
          <Line points={DIR_CIRCLE_PTS} color={iconColor} lineWidth={1.5} />
          {DIR_RAYS.map((pts, i) => (
            <Line key={i} points={pts} color={iconColor} lineWidth={1.5} />
          ))}
        </>
      )}

      {!viewerMode && (lightType === 'ambient' || lightType === 'spot') && (
        <Billboard>
          <Line points={POINT_CIRCLE_PTS} color={iconColor} lineWidth={1.5} />
        </Billboard>
      )}
    </group>
  );
}

function CameraNode({ node }: { node: StageObject }) {
  const { selectedNodeId } = useEditorStore();
  const isSelected = selectedNodeId === node.id;
  const groupRef = useRef<THREE.Group>(null);
  const t = useTransformWithOverride(node);
  const cc = node.components?.camera as
    | {
        projection?: 'perspective' | 'orthographic';
        fov?: number;
        near?: number;
        far?: number;
        orthoSize?: number;
      }
    | undefined;

  useEffect(() => {
    if (!groupRef.current) return;
    return registerNodeGroup(node.id, groupRef.current);
  }, [node.id]);

  const near = cc?.near ?? 0.1;
  const far = cc?.far ?? 100;
  const fov = cc?.fov ?? 50;
  const projection = cc?.projection ?? 'perspective';
  const orthoSize = cc?.orthoSize ?? 2;
  const aspect = 16 / 9;
  const tanHalf = Math.tan(((fov / 2) * Math.PI) / 180);
  // Near/far frustum half-extents. For perspective, near scales with distance;
  // for orthographic, both planes share the same size (parallel walls).
  const halfH = projection === 'perspective' ? near * tanHalf : orthoSize;
  const halfW =
    projection === 'perspective' ? halfH * aspect : orthoSize * aspect;
  const farH = projection === 'perspective' ? far * tanHalf : orthoSize;
  const farW =
    projection === 'perspective' ? farH * aspect : orthoSize * aspect;

  // Camera body — center is the true optical center at (0,0,0)
  const bW = 0.12,
    bH = 0.08,
    bD = 0.08;
  const frontZ = -bD / 2; // z of the front face

  const bodyGeo = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(bW, bH, bD)),
    []
  );
  useEffect(() => () => bodyGeo.dispose(), [bodyGeo]);

  // Near-plane corners (in camera space, center at origin)
  // Camera faces -Z, so near plane is at z = -near
  const nCorners: [number, number, number][] = [
    [-halfW, -halfH, -near],
    [halfW, -halfH, -near],
    [halfW, halfH, -near],
    [-halfW, halfH, -near],
  ];

  // Where the visible part of the frustum starts on the body's front face.
  // Perspective: ray from (0,0,0) → near-corner hits z=frontZ at scaled (cx, cy).
  //   Parametric: pos = t * corner → z = -t*near = frontZ → t = bD/(2*near).
  //   Only valid when near > bD/2 (near plane is outside the cube).
  // Orthographic: rays are parallel along -Z, so the front-face cut is just the
  //   near-frame's (x, y) at frontZ. Always "outside" because the body is short.
  const nearOutside = projection === 'orthographic' ? true : near > bD / 2;
  const cutCorners: [number, number, number][] =
    projection === 'orthographic'
      ? nCorners.map(([cx, cy]) => [cx, cy, frontZ])
      : (() => {
          const cutT = nearOutside ? bD / 2 / near : 1;
          return nCorners.map(([cx, cy]) => [cx * cutT, cy * cutT, frontZ]);
        })();

  const pyramidGeo = useMemo(() => {
    // 4 visible edges (cut surface → near corner) + near rect + optional cut rect
    const segs: number[] = [];
    const push = (a: [number, number, number], b: [number, number, number]) =>
      segs.push(...a, ...b);

    for (let i = 0; i < 4; i++) {
      push(cutCorners[i], nCorners[i]); // side edge
      push(nCorners[i], nCorners[(i + 1) % 4]); // near-plane perimeter
      if (nearOutside) push(cutCorners[i], cutCorners[(i + 1) % 4]); // cut rect
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(segs), 3)
    );
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [halfW, halfH, near, nearOutside, projection]);
  useEffect(() => () => pyramidGeo.dispose(), [pyramidGeo]);

  // Far-plane corners — perspective-correct, same rays as near corners scaled to far distance
  const farCorners: [number, number, number][] = [
    [-farW, -farH, -far],
    [farW, -farH, -far],
    [farW, farH, -far],
    [-farW, farH, -far],
  ];

  const color = '#00d4d4';

  return (
    <group
      ref={groupRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
      scale={[t.sx, t.sy, t.sz]}
    >
      {/* Body box wireframe */}
      <lineSegments geometry={bodyGeo}>
        <lineBasicMaterial color={color} />
      </lineSegments>

      {/* Frustum pyramid — clipped at the front face of the body */}
      <lineSegments geometry={pyramidGeo}>
        <lineBasicMaterial color={color} />
      </lineSegments>

      {/* Selection: dashed frustum — corner rays to far plane + center ray + far rect */}
      {/* Rays start at the cube surface so nothing is drawn inside the body */}
      {isSelected && (
        <>
          {/* Optical-axis center ray */}
          <Line
            points={[
              [0, 0, frontZ],
              [0, 0, -far],
            ]}
            color={color}
            lineWidth={1}
            dashed
            dashSize={0.5}
            gapSize={0.3}
          />
          {/* 4 corner rays from cube surface to far-plane corners */}
          {farCorners.map((end, i) => (
            <Line
              key={i}
              points={[cutCorners[i], end]}
              color={color}
              lineWidth={1}
              dashed
              dashSize={0.5}
              gapSize={0.3}
            />
          ))}
          {/* Far-plane rectangle */}
          <Line
            points={[...farCorners, farCorners[0]]}
            color={color}
            lineWidth={1}
            dashed
            dashSize={0.5}
            gapSize={0.3}
          />
        </>
      )}
    </group>
  );
}

interface BillboardConfig {
  facing: 'screen' | 'world';
  backface: 'none' | 'mirror' | 'unmirrored';
  width: number;
  height: number;
  alpha: number;
  textureUrl: string | null;
}

const BILLBOARD_DEFAULTS: BillboardConfig = {
  facing: 'world',
  backface: 'mirror',
  width: 1,
  height: 1,
  alpha: 1,
  textureUrl: null,
};

function BillboardNode({ node }: { node: StageObject }) {
  const outerRef = useRef<THREE.Group>(null);
  const billboardRef = useRef<THREE.Group>(null);
  const frontRef = useRef<THREE.Mesh>(null);
  const backRef = useRef<THREE.Mesh>(null);
  const t = useTransformWithOverride(node);
  useApplyOpacity(outerRef, t.opacity);
  const bc: BillboardConfig = {
    ...BILLBOARD_DEFAULTS,
    ...((node.components?.billboard ?? {}) as Partial<BillboardConfig>),
  };

  // Load texture imperatively and mark materials needsUpdate when it arrives
  const textureRef = useRef<THREE.Texture | null>(null);
  useEffect(() => {
    if (!bc.textureUrl) {
      textureRef.current = null;
      const applyNull = (m: THREE.Mesh | null) => {
        if (!m) return;
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.map = null;
        mat.needsUpdate = true;
      };
      applyNull(frontRef.current);
      applyNull(backRef.current);
      return;
    }
    let cancelled = false;
    const url = resolveParticleTextureUrl(bc.textureUrl);
    if (!url) {
      textureRef.current = null;
      return;
    }
    new THREE.TextureLoader().load(url, (tex) => {
      if (cancelled) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      textureRef.current = tex;
      const applyTex = (m: THREE.Mesh | null, t: THREE.Texture) => {
        if (!m) return;
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.map = t;
        mat.needsUpdate = true;
      };
      applyTex(frontRef.current, tex);
      if (bc.backface === 'mirror') {
        const mirror = tex.clone();
        mirror.repeat.set(-1, 1);
        mirror.offset.set(1, 0);
        mirror.needsUpdate = true;
        applyTex(backRef.current, mirror);
      } else {
        applyTex(backRef.current, tex);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bc.textureUrl, bc.backface]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!outerRef.current) return;
    return registerNodeGroup(node.id, outerRef.current);
  }, [node.id]);

  // Copy camera quaternion onto the inner group each frame when in screen-facing mode,
  // or reset to identity when in world mode so the node's own rotation applies cleanly.
  useFrame(({ camera }) => {
    if (!billboardRef.current) return;
    if (bc.facing === 'screen') {
      billboardRef.current.quaternion.copy(camera.quaternion);
    } else {
      billboardRef.current.quaternion.identity();
    }
  });

  const w = bc.width;
  const h = bc.height;

  const inner = (
    <group ref={billboardRef}>
      <mesh ref={frontRef}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={bc.alpha}
          side={THREE.FrontSide}
          depthWrite={false}
        />
      </mesh>
      {bc.backface !== 'none' && (
        <mesh ref={backRef} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial
            color="#ffffff"
            transparent
            opacity={bc.alpha}
            side={THREE.FrontSide}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );

  return (
    <group
      ref={outerRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
      scale={[t.sx, t.sy, t.sz]}
    >
      {inner}
    </group>
  );
}

interface VideoConfig {
  facing: 'screen' | 'world';
  backface: 'none' | 'mirror' | 'unmirrored';
  width: number;
  height: number;
  alpha: number;
  sourceUrl: string | null;
  autoplay: boolean;
  loop: boolean;
  onEnd: 'freeze' | 'hide';
  muted: boolean;
  volume: number;
  blendMode: VideoBlend3D;
  chromaKey?: Record<string, unknown>;
}

const VIDEO_DEFAULTS: VideoConfig = {
  facing: 'world',
  backface: 'none',
  width: 1.6,
  height: 0.9,
  alpha: 1,
  sourceUrl: null,
  autoplay: true,
  loop: true,
  onEnd: 'freeze',
  muted: true,
  volume: 1,
  blendMode: 'normal',
};

/** A flat-mounted plane textured with a live <video> element. Mirrors
 *  BillboardNode (facing / backface / size) but with playback config and a
 *  MediaHandle so the command bus / clip event lane can drive play/pause/etc.
 *  Flat-mounted (like billboards) so reparenting never remounts the element and
 *  loses playback position. */
function VideoNode({
  node,
  viewerMode,
}: {
  node: StageObject;
  viewerMode?: boolean;
}) {
  const outerRef = useRef<THREE.Group>(null);
  const billboardRef = useRef<THREE.Group>(null);
  const t = useTransformWithOverride(node);
  const audioPreview = useEditorStore((s) => s.editorAudioPreviewEnabled);
  const vc: VideoConfig = {
    ...VIDEO_DEFAULTS,
    ...((node.components?.video ?? {}) as Partial<VideoConfig>),
  };
  const chroma = readChroma(vc.chromaKey);

  // ShaderMaterials handle chroma key + opacity + blend (and UV-mirror the back
  // face). Created once; uniforms/blending pushed via effects below.
  const frontMat = useMemo(() => makeVideoMaterial(), []);
  const backMat = useMemo(() => makeVideoMaterial(), []);
  useEffect(() => {
    return () => {
      frontMat.dispose();
      backMat.dispose();
    };
  }, [frontMat, backMat]);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const textureRef = useRef<THREE.VideoTexture | null>(null);
  const [hidden, setHidden] = useState(false);

  // (Re)create the <video> element + texture when the source changes.
  useEffect(() => {
    setHidden(false);
    if (!vc.sourceUrl) {
      videoElRef.current?.pause();
      videoElRef.current = null;
      textureRef.current?.dispose();
      textureRef.current = null;
      frontMat.uniforms.map.value = null;
      backMat.uniforms.map.value = null;
      return;
    }
    const el = document.createElement('video');
    el.src = vc.sourceUrl;
    el.crossOrigin = 'anonymous';
    el.playsInline = true;
    el.loop = vc.loop;
    el.preload = 'auto';
    videoElRef.current = el;
    const tex = new THREE.VideoTexture(el);
    tex.colorSpace = THREE.SRGBColorSpace;
    textureRef.current = tex;
    frontMat.uniforms.map.value = tex;
    backMat.uniforms.map.value = tex;

    const onEnded = () => {
      if (el.loop) return;
      if (vc.onEnd === 'hide') setHidden(true);
      // 'freeze' leaves the element paused on its last frame (default).
    };
    el.addEventListener('ended', onEnded);
    return () => {
      el.removeEventListener('ended', onEnded);
      el.pause();
      tex.dispose();
    };
  }, [vc.sourceUrl, vc.loop, vc.onEnd, frontMat, backMat]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push chroma / opacity / blend / mirror into the materials.
  useEffect(() => {
    const opacity = Math.max(0, Math.min(1, t.opacity)) * vc.alpha;
    updateVideoMaterial(frontMat, { opacity, flipX: false, chroma });
    updateVideoMaterial(backMat, {
      opacity,
      flipX: vc.backface === 'mirror',
      chroma,
    });
    applyVideoBlend(frontMat, vc.blendMode);
    applyVideoBlend(backMat, vc.blendMode);
  }, [
    frontMat,
    backMat,
    t.opacity,
    vc.alpha,
    vc.backface,
    vc.blendMode,
    chroma.enabled,
    chroma.color,
    chroma.similarity,
    chroma.smoothness,
    chroma.spill,
  ]);

  // Apply audibility + volume. Video audio plays in the viewer, or in the
  // editor only when preview is enabled; honours the per-node muted flag.
  useEffect(() => {
    const el = videoElRef.current;
    if (!el) return;
    const audible = (viewerMode || audioPreview) && !vc.muted;
    el.muted = !audible;
    el.volume = Math.max(0, Math.min(1, vc.volume));
  }, [viewerMode, audioPreview, vc.muted, vc.volume, vc.sourceUrl]);

  // Autoplay on (re)mount / source change.
  useEffect(() => {
    const el = videoElRef.current;
    if (!el || !vc.autoplay) return;
    void el.play().catch(() => {
      /* autoplay may be blocked until a user gesture; ignore */
    });
  }, [vc.autoplay, vc.sourceUrl]);

  // Imperative playback handle for the media-command bus + clip event lane.
  useEffect(() => {
    return registerMedia(node.id, {
      play: () => void videoElRef.current?.play().catch(() => {}),
      pause: () => videoElRef.current?.pause(),
      stop: () => {
        const el = videoElRef.current;
        if (!el) return;
        el.pause();
        el.currentTime = 0;
        if (vc.onEnd === 'hide') setHidden(true);
      },
      restart: () => {
        const el = videoElRef.current;
        if (!el) return;
        setHidden(false);
        el.currentTime = 0;
        void el.play().catch(() => {});
      },
      seek: (sec: number) => {
        const el = videoElRef.current;
        if (el) el.currentTime = Math.max(0, sec);
      },
      setVolume: (v: number) => {
        const el = videoElRef.current;
        if (el) el.volume = Math.max(0, Math.min(1, v));
      },
      mute: () => {
        if (videoElRef.current) videoElRef.current.muted = true;
      },
      unmute: () => {
        if (videoElRef.current) videoElRef.current.muted = false;
      },
    });
  }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!outerRef.current) return;
    return registerNodeGroup(node.id, outerRef.current);
  }, [node.id]);

  useFrame(({ camera }) => {
    if (!billboardRef.current) return;
    if (vc.facing === 'screen') {
      billboardRef.current.quaternion.copy(camera.quaternion);
    } else {
      billboardRef.current.quaternion.identity();
    }
  });

  const w = vc.width;
  const h = vc.height;

  return (
    <group
      ref={outerRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
      scale={[t.sx, t.sy, t.sz]}
      visible={!hidden}
    >
      <group ref={billboardRef}>
        <mesh material={frontMat}>
          <planeGeometry args={[w, h]} />
        </mesh>
        {vc.backface !== 'none' && (
          <mesh material={backMat} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[w, h]} />
          </mesh>
        )}
      </group>
    </group>
  );
}

// One shared AudioListener per camera (Web Audio allows a single listener).
const _audioListeners = new WeakMap<THREE.Object3D, THREE.AudioListener>();
function getAudioListener(camera: THREE.Object3D): THREE.AudioListener {
  let l = _audioListeners.get(camera);
  if (!l) {
    l = new THREE.AudioListener();
    camera.add(l);
    _audioListeners.set(camera, l);
  }
  return l;
}

interface AudioCfg {
  audioType: 'simple' | 'directional';
  sourceUrl: string | null;
  autoplay: boolean;
  loop: boolean;
  volume: number;
  refDistance: number;
  rolloffFactor: number;
  maxDistance: number;
  coneInnerAngle: number;
  coneOuterAngle: number;
  coneOuterGain: number;
}

const AUDIO_DEFAULTS: AudioCfg = {
  audioType: 'simple',
  sourceUrl: null,
  autoplay: true,
  loop: false,
  volume: 1,
  refDistance: 1,
  rolloffFactor: 1,
  maxDistance: 100,
  coneInnerAngle: 360,
  coneOuterAngle: 360,
  coneOuterGain: 0,
};

/** A non-visual audio source. 'simple' = non-spatial THREE.Audio; 'directional'
 *  = spatial THREE.PositionalAudio positioned by the node transform. Audible in
 *  the viewer; in the editor only when audio preview is enabled. Registers a
 *  MediaHandle for the command bus / clip event lane. Draws a gizmo in editor. */
function AudioNode({
  node,
  viewerMode,
}: {
  node: StageObject;
  viewerMode?: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const t = useTransformWithOverride(node);
  const { camera } = useThree();
  const audioPreview = useEditorStore((s) => s.editorAudioPreviewEnabled);
  const ac: AudioCfg = {
    ...AUDIO_DEFAULTS,
    ...((node.components?.audio ?? {}) as Partial<AudioCfg>),
  };

  const soundRef = useRef<THREE.Audio | THREE.PositionalAudio | null>(null);
  // Desired loudness inputs; the effective gain is their product gated on
  // audibility, applied through applyVolume so play/mute/preview all compose.
  const desiredVolRef = useRef(ac.volume);
  const mutedRef = useRef(false);
  const audibleRef = useRef(false);
  desiredVolRef.current = ac.volume;
  audibleRef.current = viewerMode === true || audioPreview;

  const applyVolume = () => {
    const s = soundRef.current;
    if (!s) return;
    const v =
      audibleRef.current && !mutedRef.current ? desiredVolRef.current : 0;
    s.setVolume(Math.max(0, Math.min(1, v)));
  };

  useEffect(() => {
    if (!groupRef.current) return;
    return registerNodeGroup(node.id, groupRef.current);
  }, [node.id]);

  // (Re)create the sound when source / type changes.
  useEffect(() => {
    const group = groupRef.current;
    const listener = getAudioListener(camera);
    // Tear down any previous sound.
    const prev = soundRef.current;
    if (prev) {
      if (prev.isPlaying) prev.stop();
      prev.removeFromParent();
      soundRef.current = null;
    }
    if (!ac.sourceUrl || !group) return;

    const sound =
      ac.audioType === 'directional'
        ? new THREE.PositionalAudio(listener)
        : new THREE.Audio(listener);
    if (sound instanceof THREE.PositionalAudio) {
      sound.setRefDistance(ac.refDistance);
      sound.setRolloffFactor(ac.rolloffFactor);
      sound.setMaxDistance(ac.maxDistance);
      sound.setDirectionalCone(
        ac.coneInnerAngle,
        ac.coneOuterAngle,
        ac.coneOuterGain
      );
    }
    group.add(sound);
    soundRef.current = sound;

    let cancelled = false;
    new THREE.AudioLoader().load(ac.sourceUrl, (buffer) => {
      if (cancelled) return;
      sound.setBuffer(buffer);
      sound.setLoop(ac.loop);
      applyVolume();
      if (ac.autoplay) {
        // Resume a suspended context (editor may be suspended pre-gesture).
        void listener.context.resume?.().catch(() => {});
        if (!sound.isPlaying) sound.play();
      }
    });

    return () => {
      cancelled = true;
      if (sound.isPlaying) sound.stop();
      sound.removeFromParent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ac.sourceUrl,
    ac.audioType,
    ac.loop,
    ac.refDistance,
    ac.rolloffFactor,
    ac.maxDistance,
    ac.coneInnerAngle,
    ac.coneOuterAngle,
    ac.coneOuterGain,
    camera,
  ]);

  // React to audibility / volume changes.
  useEffect(() => {
    applyVolume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerMode, audioPreview, ac.volume]);

  // Media handle for the command bus / clip event lane.
  useEffect(() => {
    return registerMedia(node.id, {
      play: () => {
        const s = soundRef.current;
        if (!s || !s.buffer) return;
        void (s as THREE.Audio).context.resume?.().catch(() => {});
        if (!s.isPlaying) s.play();
      },
      pause: () => {
        const s = soundRef.current;
        if (s?.isPlaying) s.pause();
      },
      stop: () => {
        const s = soundRef.current;
        if (s?.isPlaying) s.stop();
      },
      restart: () => {
        const s = soundRef.current;
        if (!s || !s.buffer) return;
        if (s.isPlaying) s.stop();
        s.play();
      },
      seek: (sec: number) => {
        const s = soundRef.current;
        if (!s || !s.buffer) return;
        const wasPlaying = s.isPlaying;
        if (wasPlaying) s.stop();
        s.offset = Math.max(0, sec);
        if (wasPlaying) s.play();
      },
      setVolume: (v: number) => {
        desiredVolRef.current = Math.max(0, Math.min(1, v));
        applyVolume();
      },
      mute: () => {
        mutedRef.current = true;
        applyVolume();
      },
      unmute: () => {
        mutedRef.current = false;
        applyVolume();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const iconColor = ac.audioType === 'directional' ? '#22dd88' : '#22bbdd';

  return (
    <group
      ref={groupRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
    >
      {!viewerMode && (
        <Billboard>
          <Line
            points={SPEAKER_OUTLINE_PTS}
            color={iconColor}
            lineWidth={1.5}
          />
          <Line
            points={SPEAKER_DIVIDER_PTS}
            color={iconColor}
            lineWidth={1.5}
          />
          {/* Directional sources get the sound-wave arcs; simple ones don't. */}
          {ac.audioType === 'directional' &&
            SPEAKER_WAVE_PTS.map((pts, i) => (
              <Line key={i} points={pts} color={iconColor} lineWidth={1.5} />
            ))}
        </Billboard>
      )}
    </group>
  );
}

// Reusable scratch objects for InstancedMesh matrix composition
const _particlePos = new THREE.Vector3();
const _particleQuat = new THREE.Quaternion();
const _particleScale = new THREE.Vector3();
const _particleMat = new THREE.Matrix4();
const _particleColor = new THREE.Color();

// Per-instance alpha lives as a geometry attribute (instanceColor only gives RGB).
// The vertex shader forwards it; the fragment shader uses it for gl_FragColor.a.
const PARTICLE_INST_VERT = `
#include <common>
#include <fog_pars_vertex>
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vUv;
void main() {
  vColor = instanceColor;
  vAlpha = aAlpha;
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const PARTICLE_INST_FRAG = `
uniform sampler2D uTex;
uniform float uHasTex;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vUv;
void main() {
  vec4 texSample = uHasTex > 0.5 ? texture2D(uTex, vUv) : vec4(1.0);
  gl_FragColor = vec4(vColor * texSample.rgb, vAlpha * texSample.a);
}
`;

function makeInstancedParticleMaterial(
  texture: THREE.Texture | null,
  blending: THREE.Blending,
  depthWrite: boolean,
  depthTest: boolean
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: PARTICLE_INST_VERT,
    fragmentShader: PARTICLE_INST_FRAG,
    uniforms: {
      uTex: { value: texture ?? new THREE.Texture() },
      uHasTex: { value: texture ? 1.0 : 0.0 },
    },
    blending,
    depthWrite,
    depthTest,
    transparent: true,
  });
}

// --- Text scene-node kinds ----------------------------------------------------

/** Read the live text content for a text scene node, preferring the runtime
 *  override on `text.content` over the persisted `components.text.content`. */
function useTextContent(node: StageObject): string {
  const override = useEditorStore((s) => {
    const v = s.runtimeNodeOverrides[node.id]?.['text.content'];
    return typeof v === 'string' ? v : undefined;
  });
  if (override !== undefined) return override;
  const tc = (node.components?.text as { content?: string } | undefined)
    ?.content;
  return typeof tc === 'string' ? tc : '';
}

/** SDF text via troika-three-text. Crisp at any distance, no HTML. */
function TextTroikaNode({ node }: { node: StageObject }) {
  const outerRef = useRef<THREE.Group>(null);
  const billboardRef = useRef<THREE.Group>(null);
  const textRef = useRef<TroikaText | null>(null);
  const t = useTransformWithOverride(node);
  useApplyOpacity(outerRef, t.opacity);
  const content = useTextContent(node);
  const cfg = (node.components?.text ?? {}) as {
    fontSize?: number;
    color?: string;
    anchorX?: 'left' | 'center' | 'right';
    anchorY?: 'top' | 'middle' | 'bottom';
    maxWidth?: number;
    billboard?: boolean;
  };
  const camera = useThree((s) => s.camera);

  // Create the troika Text mesh once and attach into the group.
  useEffect(() => {
    const inst = new TroikaText();
    textRef.current = inst;
    billboardRef.current?.add(inst);
    return () => {
      billboardRef.current?.remove(inst);
      inst.dispose();
      textRef.current = null;
    };
  }, []);

  // Apply config + content; troika.sync() lazily updates the SDF.
  useEffect(() => {
    const inst = textRef.current;
    if (!inst) return;
    inst.text = content;
    inst.fontSize = cfg.fontSize ?? 0.2;
    inst.color = cfg.color ?? '#ffffff';
    inst.anchorX = cfg.anchorX ?? 'center';
    inst.anchorY = cfg.anchorY ?? 'middle';
    // 0 (or missing) = no wrap. The property panel uses 0 to mean "infinite"
    // so users can clear the field without typing a sentinel.
    inst.maxWidth = cfg.maxWidth && cfg.maxWidth > 0 ? cfg.maxWidth : Infinity;
    inst.sync();
  }, [
    content,
    cfg.fontSize,
    cfg.color,
    cfg.anchorX,
    cfg.anchorY,
    cfg.maxWidth,
  ]);

  useFrame(() => {
    if (cfg.billboard && billboardRef.current) {
      billboardRef.current.quaternion.copy(camera.quaternion);
    } else if (billboardRef.current) {
      billboardRef.current.quaternion.identity();
    }
  });

  return (
    <group
      ref={outerRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
      scale={[t.sx, t.sy, t.sz]}
    >
      <group ref={billboardRef} />
    </group>
  );
}

/** Text rendered into a CanvasTexture on a plane. Supports allowHtml via
 *  html2canvas (for emote rendering); otherwise rasterises plain text directly
 *  on a 2D canvas. */
function TextCanvasNode({ node }: { node: StageObject }) {
  const outerRef = useRef<THREE.Group>(null);
  const billboardRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const textureRef = useRef<THREE.CanvasTexture | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const t = useTransformWithOverride(node);
  useApplyOpacity(outerRef, t.opacity);
  const content = useTextContent(node);
  const cfg = (node.components?.text ?? {}) as {
    fontSize?: number;
    color?: string;
    padding?: number;
    allowHtml?: boolean;
    width?: number;
    height?: number;
    billboard?: boolean;
  };
  const planeW = cfg.width ?? 2;
  const planeH = cfg.height ?? 0.5;
  const camera = useThree((s) => s.camera);

  // One-time canvas + texture setup. Subsequent renders mutate in place so
  // the CanvasTexture object identity stays stable.
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(planeW * 256));
    canvas.height = Math.max(1, Math.round(planeH * 256));
    canvasRef.current = canvas;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    textureRef.current = tex;
    return () => {
      tex.dispose();
      textureRef.current = null;
      canvasRef.current = null;
    };
  }, [planeW, planeH]);

  // Re-rasterise whenever content or styling changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const tex = textureRef.current;
    if (!canvas || !tex) return;
    let cancelled = false;
    const fontSize = cfg.fontSize ?? 48;
    const color = cfg.color ?? '#ffffff';
    const padding = cfg.padding ?? 16;
    const draw = async () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (cfg.allowHtml && content.trim() !== '') {
        // Off-DOM render the sanitised HTML, then composite onto our canvas.
        const safe = DOMPurify.sanitize(content, TEXT_SANITIZE_OPTS);
        const host = document.createElement('div');
        host.style.position = 'fixed';
        host.style.left = '-99999px';
        host.style.top = '0';
        host.style.width = `${canvas.width}px`;
        host.style.height = `${canvas.height}px`;
        host.style.padding = `${padding}px`;
        host.style.color = color;
        host.style.fontSize = `${fontSize}px`;
        host.style.lineHeight = '1.2';
        host.style.wordBreak = 'break-word';
        host.innerHTML = safe;
        document.body.appendChild(host);
        try {
          // DOMPurify doesn't carry the `crossorigin` attribute through
          // (it's not in our allow-list and most servers don't accept it
          // anyway), so set it imperatively on every <img> before
          // html2canvas tries to read them. Also wait for each image to
          // finish loading — html2canvas captures synchronously and would
          // otherwise rasterise a blank where the emote should be.
          const imgs = Array.from(host.querySelectorAll('img'));
          for (const img of imgs) img.crossOrigin = 'anonymous';
          await Promise.all(
            imgs.map((img) => {
              if (img.complete && img.naturalWidth > 0)
                return Promise.resolve();
              return new Promise<void>((resolve) => {
                // Resolve on success OR failure — a single broken image
                // shouldn't block the whole render.
                img.addEventListener('load', () => resolve(), { once: true });
                img.addEventListener('error', () => resolve(), { once: true });
              });
            })
          );
          if (cancelled) return;
          const rendered = await html2canvas(host, {
            backgroundColor: null,
            width: canvas.width,
            height: canvas.height,
            scale: 1,
            logging: false,
            // useCORS asks images with crossorigin=anonymous so the
            // resulting canvas isn't tainted; allowTaint stays false so
            // we surface CORS failures explicitly instead of silently
            // producing a tainted (un-rasterisable) canvas.
            useCORS: true,
            allowTaint: false,
          });
          if (!cancelled) {
            ctx.drawImage(rendered, 0, 0);
            tex.needsUpdate = true;
          }
        } finally {
          document.body.removeChild(host);
        }
      } else {
        ctx.fillStyle = color;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textBaseline = 'top';
        // Naive word-wrap; good enough for short overlay text.
        const maxWidth = canvas.width - padding * 2;
        const words = content.split(/\s+/);
        const lines: string[] = [];
        let line = '';
        for (const w of words) {
          const test = line ? `${line} ${w}` : w;
          if (ctx.measureText(test).width > maxWidth && line) {
            lines.push(line);
            line = w;
          } else line = test;
        }
        if (line) lines.push(line);
        let y = padding;
        for (const l of lines) {
          ctx.fillText(l, padding, y);
          y += fontSize * 1.2;
        }
        tex.needsUpdate = true;
      }
    };
    void draw();
    return () => {
      cancelled = true;
    };
  }, [content, cfg.fontSize, cfg.color, cfg.padding, cfg.allowHtml]);

  useFrame(() => {
    if (cfg.billboard && billboardRef.current) {
      billboardRef.current.quaternion.copy(camera.quaternion);
    } else if (billboardRef.current) {
      billboardRef.current.quaternion.identity();
    }
  });

  return (
    <group
      ref={outerRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
      scale={[t.sx, t.sy, t.sz]}
    >
      <group ref={billboardRef}>
        <mesh ref={meshRef}>
          <planeGeometry args={[planeW, planeH]} />
          <meshBasicMaterial
            map={textureRef.current ?? undefined}
            transparent
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}

/** A data-channel feed rendered into a CanvasTexture on a plane — the in-scene
 *  (3D) analog of the 2D `feed` compose layer (ComposeLayerStack.FeedLayer).
 *  Subscribes to the data-channel bus by identity (GLOBAL ∪ this node's own id),
 *  renders the htm template into an off-screen React root, and rasterises it via
 *  html2canvas so emotes + arbitrary template markup composite into WebGL and
 *  recordings (like text_canvas). See dev-notes/modules/data-channels.md. */
function FeedCanvasNode({
  node,
  viewerMode,
}: {
  node: StageObject;
  viewerMode?: boolean;
}) {
  const outerRef = useRef<THREE.Group>(null);
  const billboardRef = useRef<THREE.Group>(null);
  const textureRef = useRef<THREE.CanvasTexture | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<Root | null>(null);
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null);
  const t = useTransformWithOverride(node);
  useApplyOpacity(outerRef, t.opacity);
  const camera = useThree((s) => s.camera);

  const cfg = (node.components?.feed ?? {}) as {
    template?: string;
    css?: string;
    width?: number;
    height?: number;
    padding?: number;
    fontSize?: number;
    color?: string;
    billboard?: boolean;
  };
  const planeW = cfg.width ?? 2;
  const planeH = cfg.height ?? 1.2;
  const template = typeof cfg.template === 'string' ? cfg.template : '';
  const css = typeof cfg.css === 'string' ? cfg.css : '';
  const compiled = useMemo(() => compileTemplate(template), [template]);

  // Fields visible to this node: GLOBAL ∪ its own id (own wins), mirroring the
  // 2D feed layer's consumer-by-identity model.
  const globalFields = useEditorStore((s) => s.dataChannels['']);
  const ownFields = useEditorStore((s) => s.dataChannels[node.id]);
  const channels = useMemo(
    () => ({ ...(globalFields ?? {}), ...(ownFields ?? {}) }),
    [globalFields, ownFields]
  );
  const scopeId = useMemo(
    () => `feed3d-${node.id.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [node.id]
  );

  // One-time canvas + texture + off-screen React host. Re-renders mutate the
  // canvas in place so the CanvasTexture identity stays stable.
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(planeW * 256));
    canvas.height = Math.max(1, Math.round(planeH * 256));
    canvasRef.current = canvas;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    textureRef.current = tex;
    setTexture(tex);

    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-99999px';
    host.style.top = '0';
    host.style.width = `${canvas.width}px`;
    host.style.height = `${canvas.height}px`;
    host.style.overflow = 'hidden';
    host.style.lineHeight = '1.2';
    host.style.wordBreak = 'break-word';
    host.setAttribute('data-feed-scope', scopeId);
    document.body.appendChild(host);
    hostRef.current = host;
    rootRef.current = createRoot(host);

    return () => {
      // Defer unmount: React forbids unmounting a root synchronously from within
      // a commit/cleanup phase.
      const root = rootRef.current;
      queueMicrotask(() => root?.unmount());
      host.remove();
      tex.dispose();
      textureRef.current = null;
      canvasRef.current = null;
      hostRef.current = null;
      rootRef.current = null;
    };
  }, [planeW, planeH, scopeId]);

  // Re-render the template + re-rasterise whenever data / template / styling
  // changes. Async because html2canvas + emote image loads are async.
  useEffect(() => {
    const canvas = canvasRef.current;
    const tex = textureRef.current;
    const host = hostRef.current;
    const root = rootRef.current;
    if (!canvas || !tex || !host || !root) return;
    let cancelled = false;

    const color = cfg.color ?? '#ffffff';
    const fontSize = cfg.fontSize ?? 28;
    const padding = cfg.padding ?? 16;
    host.style.color = color;
    host.style.fontSize = `${fontSize}px`;
    host.style.padding = `${padding}px`;
    host.style.boxSizing = 'border-box';
    const scopedCss = css
      ? `@scope ([data-feed-scope="${scopeId}"]) {\n${css}\n}`
      : '';

    const draw = async () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // Commit the template to the off-screen DOM synchronously so html2canvas
      // captures the up-to-date tree. A bad template renders as nothing
      // (FeedContent swallows the throw) and retries on the next update.
      flushSync(() => {
        root.render(
          <>
            {scopedCss && <style>{scopedCss}</style>}
            {compiled.render && (
              <FeedErrorBoundary key={template}>
                <FeedContent render={compiled.render} channels={channels} />
              </FeedErrorBoundary>
            )}
          </>
        );
      });

      // Emotes are <img>s; html2canvas captures synchronously, so wait for them
      // (set crossorigin first — DOMPurify strips it; see TextCanvasNode).
      const imgs = Array.from(host.querySelectorAll('img'));
      for (const img of imgs) img.crossOrigin = 'anonymous';
      await Promise.all(
        imgs.map((img) =>
          img.complete && img.naturalWidth > 0
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.addEventListener('load', () => resolve(), { once: true });
                img.addEventListener('error', () => resolve(), { once: true });
              })
        )
      );
      if (cancelled) return;
      const rendered = await html2canvas(host, {
        backgroundColor: null,
        width: canvas.width,
        height: canvas.height,
        scale: 1,
        logging: false,
        useCORS: true,
        allowTaint: false,
      });
      if (cancelled) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(rendered, 0, 0);
      tex.needsUpdate = true;
    };
    void draw();
    return () => {
      cancelled = true;
    };
  }, [
    channels,
    compiled,
    template,
    css,
    scopeId,
    cfg.color,
    cfg.fontSize,
    cfg.padding,
  ]);

  // Register the node's group so it's selectable and the transform gizmo can
  // attach (like billboard/particle/model flat mounts).
  useEffect(() => {
    if (!outerRef.current) return;
    return registerNodeGroup(node.id, outerRef.current);
  }, [node.id]);

  useFrame(() => {
    if (cfg.billboard && billboardRef.current) {
      billboardRef.current.quaternion.copy(camera.quaternion);
    } else if (billboardRef.current) {
      billboardRef.current.quaternion.identity();
    }
  });

  return (
    <group
      ref={outerRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
      scale={[t.sx, t.sy, t.sz]}
    >
      <group ref={billboardRef}>
        {/* Editor-only affordance: an empty feed (no data published yet)
            rasterises to a transparent texture and would be invisible, so show
            a faint outline + backing so it's visible and clickable while
            editing. Hidden in the viewer/stream output. */}
        {!viewerMode && (
          <mesh position={[0, 0, -0.001]}>
            <planeGeometry args={[planeW, planeH]} />
            <meshBasicMaterial
              color="#4488ff"
              transparent
              opacity={0.08}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        )}
        {texture && (
          <mesh>
            <planeGeometry args={[planeW, planeH]} />
            <meshBasicMaterial
              map={texture}
              transparent
              side={THREE.DoubleSide}
            />
          </mesh>
        )}
      </group>
    </group>
  );
}

function ParticleNode({ node }: { node: StageObject }) {
  const outerRef = useRef<THREE.Group>(null);
  // InstancedMesh for local-space; a scene-root InstancedMesh for world-space
  const localMeshRef = useRef<THREE.InstancedMesh>(null);
  const worldMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const t = useTransformWithOverride(node);
  useApplyOpacity(outerRef, t.opacity);
  const pc = mergeParticleConfig(
    (node.components?.particle ?? {}) as Record<string, unknown>
  );
  const isWorld = pc.simulationSpace === 'world';

  const pool = useRef<ParticlePool | null>(null);
  const { scene } = useThree();

  const blendingMap: Record<string, THREE.Blending> = {
    normal: THREE.NormalBlending,
    additive: THREE.AdditiveBlending,
    multiply: THREE.MultiplyBlending,
  };
  const blending = blendingMap[pc.blendMode] ?? THREE.AdditiveBlending;

  // (Re-)allocate pool when maxCount changes, preserving playing state
  useEffect(() => {
    const wasPlaying = pool.current?.playing ?? pc.playOnStart;
    const p = createParticlePool(pc.maxCount);
    p.playing = wasPlaying;
    pool.current = p;
  }, [pc.maxCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pool.current && pc.playOnStart && !pool.current.playing) {
      pool.current.playing = true;
      pool.current.burstFired = false;
    }
  }, [pc.playOnStart]);

  useEffect(() => {
    if (!outerRef.current) return;
    return registerNodeGroup(node.id, outerRef.current);
  }, [node.id]);

  // Texture loading
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    const url = resolveParticleTextureUrl(pc.textureUrl);
    if (!url) {
      setTexture(null);
      return;
    }
    let cancelled = false;
    new THREE.TextureLoader().load(url, (tex) => {
      if (!cancelled) {
        tex.colorSpace = THREE.SRGBColorSpace;
        setTexture(tex);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pc.textureUrl]);

  // Creates/replaces the InstancedMesh for the given space mode.
  // aAlpha is a per-instance float attribute on the PlaneGeometry — instanced attributes
  // are supported in WebGL2 (Three.js r152+) via InstancedBufferAttribute on the geometry.
  const buildMesh = (count: number): THREE.InstancedMesh => {
    const geo = new THREE.PlaneGeometry(1, 1);
    const alphaAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(count).fill(0),
      1
    );
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', alphaAttr);
    const mat = makeInstancedParticleMaterial(
      texture,
      blending,
      pc.depthWrite,
      pc.depthTest
    );
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // instanceColor provides per-instance RGB read by the vertex shader as `instanceColor`
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(count * 3).fill(1),
      3
    );
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // Hide all instances initially
    _particleMat.makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _particleMat);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  };

  // World-space InstancedMesh lives at scene root
  useEffect(() => {
    if (!isWorld) return;
    const mesh = buildMesh(pc.maxCount);
    worldMeshRef.current = mesh;
    scene.add(mesh);
    return () => {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.ShaderMaterial).dispose();
      worldMeshRef.current = null;
    };
  }, [isWorld, pc.maxCount, scene]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep world-space shader uniforms in sync every render
  useEffect(() => {
    const mesh = worldMeshRef.current;
    if (!mesh) return;
    const mat = mesh.material as THREE.ShaderMaterial;
    mat.uniforms.uTex.value = texture ?? new THREE.Texture();
    mat.uniforms.uHasTex.value = texture ? 1.0 : 0.0;
    mat.blending = blending;
    mat.depthWrite = pc.depthWrite;
    mat.depthTest = pc.depthTest;
    mat.needsUpdate = true;
  });

  const geoCountRef = useRef<number>(-1);
  const emitterWorld = useRef(new THREE.Vector3());

  useFrame(({ camera }, delta) => {
    if (!pool.current || !outerRef.current) return;

    // First frame after local-space mount: initialize instanceColor and shader on the R3F mesh
    if (
      !isWorld &&
      localMeshRef.current &&
      geoCountRef.current !== pc.maxCount
    ) {
      const mat = localMeshRef.current.material as THREE.ShaderMaterial;
      mat.uniforms.uTex.value = texture ?? new THREE.Texture();
      mat.uniforms.uHasTex.value = texture ? 1.0 : 0.0;
      if (!localMeshRef.current.instanceColor) {
        localMeshRef.current.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(pc.maxCount * 3).fill(1),
          3
        );
        localMeshRef.current.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      geoCountRef.current = pc.maxCount;
    }

    outerRef.current.getWorldPosition(emitterWorld.current);
    tickParticles(pool.current, pc, delta, emitterWorld.current, node.hidden);
    const p = pool.current;

    const mesh = isWorld ? worldMeshRef.current : localMeshRef.current;
    if (!mesh) return;

    const alphaAttr = mesh.geometry.attributes.aAlpha as
      | THREE.InstancedBufferAttribute
      | undefined;
    const camQuat = camera.getWorldQuaternion(_particleQuat);

    // Camera right/up in world space — used for velocity-aligned rotation
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camQuat);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camQuat);

    const invWorld = _particleMat.copy(outerRef.current.matrixWorld).invert();
    const yRatio = pc.sizeX > 0 ? pc.sizeY / pc.sizeX : 1;
    const _rot = new THREE.Quaternion();
    const _axis = new THREE.Vector3(0, 0, 1);
    const velocityMode = pc.rotationMode === 'velocity';

    for (let i = 0; i < p.maxCount; i++) {
      if (!p.active[i]) {
        mesh.setMatrixAt(i, _particleMat.makeScale(0, 0, 0));
        mesh.setColorAt(i, _particleColor.setRGB(0, 0, 0));
        if (alphaAttr) (alphaAttr.array as Float32Array)[i] = 0;
        continue;
      }
      const b = i * 3;
      _particlePos.set(p.positions[b], p.positions[b + 1], p.positions[b + 2]);
      if (!isWorld) _particlePos.applyMatrix4(invWorld);

      _particleScale.set(p.sizes[i], p.sizes[i] * yRatio, 1);

      let zAngle: number;
      if (velocityMode) {
        // Project velocity onto the camera plane to get screen-space direction,
        // then atan2 gives the rotation angle that aligns the particle's +Y with its velocity.
        const vx = p.velocities[b],
          vy = p.velocities[b + 1],
          vz = p.velocities[b + 2];
        const screenX = vx * camRight.x + vy * camRight.y + vz * camRight.z;
        const screenY = vx * camUp.x + vy * camUp.y + vz * camUp.z;
        zAngle = Math.atan2(-screenX, screenY); // align particle +Y with screen-space velocity
      } else {
        zAngle = p.rotations[i];
      }

      _rot.setFromAxisAngle(_axis, zAngle);
      mesh.setMatrixAt(
        i,
        _particleMat.compose(
          _particlePos,
          camQuat.clone().multiply(_rot),
          _particleScale
        )
      );

      mesh.setColorAt(
        i,
        _particleColor.setRGB(p.colors[b], p.colors[b + 1], p.colors[b + 2])
      );
      if (alphaAttr) (alphaAttr.array as Float32Array)[i] = p.alphas[i];
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (alphaAttr) alphaAttr.needsUpdate = true;
  });

  return (
    <group
      ref={outerRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
      scale={[t.sx, t.sy, t.sz]}
    >
      {!isWorld &&
        (() => {
          // Build the local-space geometry with the aAlpha instanced attribute already attached
          const geo = useMemo(() => {
            const g = new THREE.PlaneGeometry(1, 1);
            const a = new THREE.InstancedBufferAttribute(
              new Float32Array(pc.maxCount).fill(0),
              1
            );
            a.setUsage(THREE.DynamicDrawUsage);
            g.setAttribute('aAlpha', a);
            return g;
          }, [pc.maxCount]); // eslint-disable-line react-hooks/exhaustive-deps
          return (
            <instancedMesh
              ref={localMeshRef}
              args={[geo, undefined, pc.maxCount]}
              frustumCulled={false}
            >
              <shaderMaterial
                vertexShader={PARTICLE_INST_VERT}
                fragmentShader={PARTICLE_INST_FRAG}
                uniforms={{
                  uTex: { value: texture ?? new THREE.Texture() },
                  uHasTex: { value: texture ? 1.0 : 0.0 },
                }}
                blending={blending}
                depthWrite={pc.depthWrite}
                depthTest={pc.depthTest}
                transparent
              />
            </instancedMesh>
          );
        })()}
    </group>
  );
}

function GodrayCasterNode({ node }: { node: StageObject }) {
  const outerRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const t = useTransformWithOverride(node);
  useApplyOpacity(outerRef, t.opacity);
  const color = (node.components.godray as any)?.color ?? '#ffffff';
  const scale = (node.components.godray as any)?.scale ?? 0.3;

  useEffect(() => {
    if (!outerRef.current) return;
    return registerNodeGroup(node.id, outerRef.current);
  }, [node.id]);

  useEffect(() => {
    if (meshRef.current) godrayCasterRegistry.set(node.id, meshRef.current);
    return () => {
      godrayCasterRegistry.delete(node.id);
    };
  }, [node.id]);

  return (
    <group
      ref={outerRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
      scale={[t.sx, t.sy, t.sz]}
    >
      <mesh ref={meshRef}>
        <sphereGeometry args={[scale, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

function ModelNode({
  node,
  children,
}: {
  node: StageObject;
  children?: React.ReactNode;
}) {
  const outerRef = useRef<THREE.Group>(null);
  const innerRef = useRef<THREE.Group>(null);
  const t = useTransformWithOverride(node);
  useApplyMeshFlags(outerRef, t.opacity, t.castShadow, t.receiveShadow);
  const ext = node.filePath?.split('.').pop()?.toLowerCase();
  const isGlb = Boolean(node.filePath && (ext === 'glb' || ext === 'gltf'));
  // remote_object is an opaque wrapper around a peer's shared subtree — it has
  // no model of its own, so skip the no-model placeholder box (it would float
  // at the container origin alongside the projected content).
  const isContainer = node.kind === 'remote_object';

  useEffect(() => {
    if (!outerRef.current) return;
    return registerNodeGroup(node.id, outerRef.current);
  }, [node.id]);

  useEffect(() => {
    if (!isGlb) return;
    let cancelled = false;
    const loader = new GLTFLoader();
    loader.load(node.filePath!, (gltf) => {
      if (cancelled || !innerRef.current) return;
      innerRef.current.clear();
      innerRef.current.add(gltf.scene);
    });
    return () => {
      cancelled = true;
    };
  }, [node.filePath, isGlb]);

  return (
    <group
      ref={outerRef}
      position={[t.x, t.y, t.z]}
      rotation={[t.rx, t.ry, t.rz]}
      scale={[t.sx, t.sy, t.sz]}
    >
      {isGlb ? (
        <group ref={innerRef} />
      ) : isContainer ? null : (
        <mesh>
          <boxGeometry args={[0.5, 0.5, 0.5]} />
          <meshStandardMaterial color="#5588cc" />
        </mesh>
      )}
      {children}
    </group>
  );
}

function SceneInstanceContent({ sourceSceneId }: { sourceSceneId: string }) {
  const nodes = useEditorStore((s) => s.nodes);
  const runtimeOverrides = useEditorStore((s) => s.runtimeNodeOverrides);
  const sourceNodes = nodes.filter(
    (n) => n.rootSceneNodeId === sourceSceneId && n.kind !== 'scene'
  );
  const rootNodes = sourceNodes.filter((n) => !n.parentId);
  const visibleOverride = (id: string): boolean | undefined => {
    const v = runtimeOverrides[id]?.['visible'];
    return typeof v === 'boolean' ? v : undefined;
  };
  return (
    <group>
      {rootNodes.map((node) =>
        renderNodeElement(node, sourceNodes, true, visibleOverride)
      )}
    </group>
  );
}

function renderNodeElement(
  node: StageObject,
  allNodes?: StageObject[],
  viewerMode?: boolean,
  visibleOverride?: (id: string) => boolean | undefined
): React.ReactNode {
  const freeChildren = allNodes
    ? allNodes.filter((n) => n.parentId === node.id && !n.boneAttachment)
    : [];
  const boneChildren = allNodes
    ? allNodes.filter((n) => n.parentId === node.id && !!n.boneAttachment)
    : [];
  const childElements = freeChildren.map((c) =>
    renderNodeElement(c, allNodes, viewerMode, visibleOverride)
  );
  // Bone-attached children render as normal top-level nodes; BoneAttacher
  // re-parents each one's group under the target bone, so its transform is
  // preserved as bone-local (translation/rotation relative to bone space).
  const boneFollowers = boneChildren.flatMap((c) => [
    renderNodeElement(c, allNodes, viewerMode, visibleOverride),
    <BoneAttacher
      key={`ba-${c.id}`}
      avatarNodeId={node.id}
      boneName={c.boneAttachment!}
      nodeId={c.id}
    />,
  ]);

  // A graph-driven `visible` runtime override wins over the persisted `hidden`
  // flag when present. R3F group nesting cascades this to descendants.
  const ov = visibleOverride?.(node.id);
  const visible = typeof ov === 'boolean' ? ov : !node.hidden;
  if (node.kind === 'avatar')
    return (
      <>
        <group key={node.id} visible={visible}>
          <AvatarNode node={node}>{childElements}</AvatarNode>
        </group>
        {boneFollowers}
      </>
    );
  if (node.kind === 'light')
    return (
      <group key={node.id} visible={visible}>
        <LightNode node={node} viewerMode={viewerMode} />
      </group>
    );
  if (node.kind === 'audio')
    return (
      <group key={node.id} visible={visible}>
        <AudioNode node={node} viewerMode={viewerMode} />
      </group>
    );
  if (node.kind === 'camera')
    return (
      <group key={node.id} visible={visible}>
        <CameraNode node={node} />
      </group>
    );
  if (node.kind === 'godray_caster')
    return (
      <group key={node.id} visible={visible}>
        <GodrayCasterNode node={node} />
      </group>
    );
  // Group nodes are invisible transform containers — children inherit their
  // position. remote_object (a placed peer share) is the same: an opaque, empty
  // container whose transform drives the projected shared subtree below it.
  if (node.kind === 'group' || node.kind === 'remote_object')
    return (
      <group key={node.id} visible={visible}>
        <ModelNode node={node}>{childElements}</ModelNode>
      </group>
    );
  // Scene instance: render the source scene's nodes inside this node's transform (read-only)
  if (node.kind === 'scene_instance') {
    const sourceSceneId = (
      node.properties as Record<string, unknown> | undefined
    )?.sourceSceneId as string | undefined;
    if (!sourceSceneId) return null;
    return (
      <group key={node.id} visible={visible}>
        <ModelNode node={node}>
          <SceneInstanceContent sourceSceneId={sourceSceneId} />
        </ModelNode>
      </group>
    );
  }
  // Scene-root nodes (kind 'scene') ride the mesh so their properties reach the
  // frontend (broadcastTickHz, collab link), but they have no visual: a scene
  // root is its own root, so it slips past the active-scene filter and would
  // otherwise fall through to the default ModelNode placeholder (a stray cube at
  // the origin). It carries no model and no transform of its own — render nothing.
  if (node.kind === 'scene') return null;
  // particle, billboard, and text nodes are rendered flat in SceneNodes to keep
  // their React position stable across reparents (preserves particle pools,
  // billboard textures, troika SDF caches, and html2canvas-backed textures).
  if (node.kind === 'particle') return null;
  if (node.kind === 'billboard') return null;
  if (node.kind === 'video') return null;
  if (node.kind === 'text_troika') return null;
  if (node.kind === 'text_canvas') return null;
  if (node.kind === 'feed') return null;
  return (
    <group key={node.id} visible={visible}>
      <ModelNode node={node}>{childElements}</ModelNode>
    </group>
  );
}

export function SceneNodes({
  omitNodeId,
  omitKinds,
  viewerMode,
  sceneId,
}: {
  omitNodeId?: string;
  omitKinds?: string[];
  viewerMode?: boolean;
  /** Scene whose nodes to render. Defaults to the store's active scene. */
  sceneId?: string;
} = {}) {
  const { nodes, activeSceneId } = useEditorStore();
  const runtimeOverrides = useEditorStore((s) => s.runtimeNodeOverrides);
  const effectiveSceneId = sceneId ?? activeSceneId;
  const sceneNodes = nodes.filter(
    (n) =>
      n.rootSceneNodeId === effectiveSceneId &&
      n.id !== omitNodeId &&
      !omitKinds?.includes(n.kind)
  );
  const rootNodes = sceneNodes.filter((n) => !n.parentId);
  // Particle and billboard nodes are always rendered at the top level so their React
  // component instance never moves in the tree (reparenting in the scene graph would
  // otherwise unmount+remount them, destroying the particle pool).
  const flatParticles = sceneNodes.filter((n) => n.kind === 'particle');
  const flatBillboards = sceneNodes.filter((n) => n.kind === 'billboard');
  const flatVideos = sceneNodes.filter((n) => n.kind === 'video');
  const flatTextTroika = sceneNodes.filter((n) => n.kind === 'text_troika');
  const flatTextCanvas = sceneNodes.filter((n) => n.kind === 'text_canvas');
  const flatFeed = sceneNodes.filter((n) => n.kind === 'feed');

  // Hidden cascade for flat-mounted nodes: hierarchical kinds already inherit
  // `visible: false` from a hidden ancestor via R3F's <group> nesting, but
  // flat mounts (particles/billboards/text) are pulled out to the top level
  // so they break the chain. Recompute effective visibility by walking the
  // parentId chain in `nodes` (cycles guarded by a visited set).
  // A graph-driven `visible` runtime override wins over a node's persisted
  // `hidden` flag when present. Flat mounts break R3F's <group> nesting, so the
  // override (like the hidden flag) has to be re-walked up the parent chain.
  const nodeEffectiveVisible = (n: StageObject): boolean => {
    const v = runtimeOverrides[n.id]?.['visible'];
    return typeof v === 'boolean' ? v : !n.hidden;
  };
  const visibleOverride = (id: string): boolean | undefined => {
    const v = runtimeOverrides[id]?.['visible'];
    return typeof v === 'boolean' ? v : undefined;
  };

  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const isAncestorHidden = (n: StageObject): boolean => {
    const seen = new Set<string>();
    let cur: StageObject | undefined = n.parentId
      ? byId.get(n.parentId)
      : undefined;
    while (cur && !seen.has(cur.id)) {
      if (!nodeEffectiveVisible(cur)) return true;
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
  };
  const effectiveVisible = (n: StageObject) =>
    nodeEffectiveVisible(n) && !isAncestorHidden(n);

  return (
    <>
      {rootNodes.map((node) =>
        renderNodeElement(node, sceneNodes, viewerMode, visibleOverride)
      )}
      {flatParticles.map((node) => (
        <group key={node.id} visible={effectiveVisible(node)}>
          <ParticleNode node={node} />
        </group>
      ))}
      {flatBillboards.map((node) => (
        <group key={node.id} visible={effectiveVisible(node)}>
          <BillboardNode node={node} />
        </group>
      ))}
      {flatVideos.map((node) => (
        <group key={node.id} visible={effectiveVisible(node)}>
          <VideoNode node={node} viewerMode={viewerMode} />
        </group>
      ))}
      {flatTextTroika.map((node) => (
        <group key={node.id} visible={effectiveVisible(node)}>
          <TextTroikaNode node={node} />
        </group>
      ))}
      {flatTextCanvas.map((node) => (
        <group key={node.id} visible={effectiveVisible(node)}>
          <TextCanvasNode node={node} />
        </group>
      ))}
      {flatFeed.map((node) => (
        <group key={node.id} visible={effectiveVisible(node)}>
          <FeedCanvasNode node={node} viewerMode={viewerMode} />
        </group>
      ))}
    </>
  );
}

function TransformGizmo({
  mode,
  orbitRef,
}: {
  mode: GizmoMode;
  orbitRef: React.RefObject<any>;
}) {
  const { selectedNodeId, updateNode: storeUpdateNode } = useEditorStore();
  const group = selectedNodeId ? getNodeGroup(selectedNodeId) : null;
  // Throttle outgoing live previews to ~30 Hz; the gizmo fires onObjectChange
  // on every animation frame while dragging, which would otherwise spam the WS.
  const lastPreviewAtRef = useRef(0);
  if (!group) return null;

  const buildTransform = () => {
    const p = group.position,
      r = group.rotation,
      s = group.scale;
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      rx: r.x,
      ry: r.y,
      rz: r.z,
      sx: s.x,
      sy: s.y,
      sz: s.z,
    };
  };

  const onChange = () => {
    if (!selectedNodeId) return;
    const now = performance.now();
    if (now - lastPreviewAtRef.current < 33) return;
    lastPreviewAtRef.current = now;
    sendNodeTransformPreview(selectedNodeId, buildTransform());
  };

  const onEnd = () => {
    if (orbitRef.current) orbitRef.current.enabled = true;
    const node = useEditorStore
      .getState()
      .nodes.find((n) => n.id === selectedNodeId);
    if (!node) return;
    const transform = buildTransform();
    const components = {
      ...node.components,
      transform: { type: 'transform', ...transform },
    };
    storeUpdateNode(node.id, { components });
    api.updateNode(node.id, { components }).catch(() => {});
  };

  return (
    <TransformControls
      key={selectedNodeId ?? undefined}
      object={group}
      mode={mode}
      onMouseDown={() => {
        if (orbitRef.current) orbitRef.current.enabled = false;
      }}
      onObjectChange={onChange}
      onMouseUp={onEnd}
    />
  );
}

const GIZMO_BUTTONS: {
  mode: GizmoMode;
  icon: LucideIcon;
  titleKey: string;
}[] = [
  { mode: 'translate', icon: Move, titleKey: 'viewport.gizmo.translate' },
  { mode: 'rotate', icon: RotateCw, titleKey: 'viewport.gizmo.rotate' },
  { mode: 'scale', icon: Scaling, titleKey: 'viewport.gizmo.scale' },
];

function GizmoToolbar({
  mode,
  setMode,
}: {
  mode: GizmoMode;
  setMode: (m: GizmoMode) => void;
}) {
  const { t } = useTranslation('misc');
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        display: 'flex',
        gap: 2,
        background: '#0e0e18',
        border: '1px solid #2a2a3a',
        borderRadius: 6,
        padding: 3,
        zIndex: 10,
      }}
    >
      {GIZMO_BUTTONS.map(({ mode: m, icon: Icon, titleKey }) => (
        <button
          key={m}
          title={t(titleKey)}
          onClick={() => setMode(m)}
          style={{
            width: 30,
            height: 30,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 15,
            cursor: 'pointer',
            background: mode === m ? '#1e2e4a' : 'transparent',
            border: `1px solid ${mode === m ? '#3a5a9a' : 'transparent'}`,
            borderRadius: 4,
            color: mode === m ? '#7ab' : '#555',
            lineHeight: 1,
          }}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}

const _afRay = new THREE.Raycaster();
const _afBox = new THREE.Box3();
const _afVec = new THREE.Vector3();

function AutofocusDOF({ cfg }: { cfg: Record<string, unknown> }) {
  const { camera, scene } = useThree();
  const autofocus = (cfg.autofocus as boolean) ?? false;
  const afMode = (cfg.afMode as string) ?? 'point';
  const afPointX = (cfg.afPointX as number) ?? 0.5;
  const afPointY = (cfg.afPointY as number) ?? 0.5;
  const percentile = (cfg.afPercentile as number) ?? 15;
  const speed = (cfg.afSpeed as number) ?? 4;

  const spring = useRef({
    pos: (cfg.worldFocusDistance as number) ?? 3,
    vel: 0,
  });
  const scanTimer = useRef(0);
  const targetRef = useRef<number | null>(null);
  const dofRef = useRef<any>(null);
  const logTimer = useRef(0);

  useFrame((_, delta) => {
    logTimer.current += delta;
    const shouldLog = logTimer.current >= 2;
    if (shouldLog) logTimer.current = 0;

    const dofEffect = dofRef.current;
    const cam = camera as THREE.PerspectiveCamera;
    if (!autofocus) return;

    // Depth scan at ~10 Hz via bounding-box raycasting — no GPU render, no GL state touched
    scanTimer.current -= delta;
    if (scanTimer.current <= 0) {
      scanTimer.current = 0.1;

      // Collect world-space bounding boxes of visible, opaque, non-wireframe meshes
      const boxes: THREE.Box3[] = [];
      scene.traverse((obj) => {
        if (!(obj as THREE.Mesh).isMesh) return;
        const mesh = obj as THREE.Mesh;
        if (!mesh.visible) return;
        const mats = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        const hasOpaque = mats.some((m) => {
          if (!m || (m as THREE.Material).transparent) return false;
          if ((m as THREE.MeshBasicMaterial).wireframe) return false;
          if ((m as THREE.Material).opacity < 0.9) return false;
          return true;
        });
        if (!hasOpaque) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        if (!mesh.geometry.boundingBox) return;
        _afBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
        boxes.push(_afBox.clone());
      });

      if (shouldLog) console.log('[AF] boxes:', boxes.length);

      // Cast rays against those boxes from NDC sample points
      const sampleNDC =
        afMode === 'point'
          ? [new THREE.Vector2(afPointX * 2 - 1, (1 - afPointY) * 2 - 1)]
          : Array.from(
              { length: 16 },
              () =>
                new THREE.Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1)
            );

      const hits: number[] = [];
      for (const ndc of sampleNDC) {
        _afRay.setFromCamera(ndc, cam);
        let closest = Infinity;
        for (const box of boxes) {
          const hit = _afRay.ray.intersectBox(box, _afVec);
          if (hit !== null) {
            // COC shader uses length(viewPosition) — Euclidean distance from camera origin
            const dist = _afVec.distanceTo(cam.position);
            if (dist < closest) closest = dist;
          }
        }
        if (closest < Infinity) hits.push(closest);
      }

      let targetDist: number | null = null;
      if (afMode === 'point') {
        targetDist = hits[0] ?? null;
      } else if (hits.length > 0) {
        hits.sort((a, b) => a - b);
        targetDist = hits[Math.floor((percentile / 100) * (hits.length - 1))];
      }

      if (shouldLog)
        console.log('[AF] hits:', hits.length, 'targetDist:', targetDist);
      if (targetDist !== null) targetRef.current = targetDist;
    }

    // Spring convergence — write to cocMaterial.focusDistance directly
    if (!dofEffect) return;
    const targetDist = targetRef.current;
    if (targetDist === null) return;

    const s = spring.current;
    const diff = targetDist - s.pos;
    if (shouldLog)
      console.log(
        '[AF] spring pos=',
        s.pos.toFixed(2),
        'target=',
        targetDist.toFixed(2),
        'focusDistance=',
        dofEffect.cocMaterial?.focusDistance?.toFixed(2)
      );
    const acc = speed * speed * diff - 2 * speed * s.vel;
    s.vel += acc * delta;
    s.pos += s.vel * delta;
    dofEffect.cocMaterial.focusDistance = Math.max(cam.near, s.pos);
  }, 2);

  return (
    <DepthOfField
      ref={dofRef}
      worldFocusDistance={(cfg.worldFocusDistance as number) ?? 3}
      worldFocusRange={(cfg.worldFocusRange as number) ?? 2}
      bokehScale={(cfg.bokehScale as number) ?? 2}
    />
  );
}

function GodRaysSync({ effect }: { effect: GodRaysEffect }) {
  const { composer } = useContext(EffectComposerContext)!;
  useEffect(() => {
    const dt = (composer as any).depthTexture ?? null;
    if (dt) effect.setDepthTexture(dt);
  }, [effect, composer]);
  return null;
}

function NormalBufferSync({ effect }: { effect: DepthEdgeEffect }) {
  const { normalPass } = useContext(EffectComposerContext)!;
  useEffect(() => {
    effect.setNormalBuffer(normalPass?.texture ?? null);
  }, [effect, normalPass]);
  return null;
}

type SSAOParams = {
  intensity: number;
  radius: number;
  bias: number;
  rings: number;
  samples: number;
};
function SSAOEffectPrimitive({ params }: { params: SSAOParams }) {
  const { camera, normalPass, downSamplingPass } = useContext(
    EffectComposerContext
  )!;
  const effect = useMemo(
    () =>
      new SSAOEffect(camera, normalPass?.texture ?? undefined, {
        blendFunction: BlendFunction.MULTIPLY,
        normalDepthBuffer: downSamplingPass
          ? downSamplingPass.texture
          : undefined,
        depthAwareUpsampling: true,
        worldDistanceThreshold: 20,
        worldDistanceFalloff: 5,
        worldProximityThreshold: 0.3,
        worldProximityFalloff: 0.1,
        intensity: params.intensity,
        radius: params.radius,
        bias: params.bias,
        rings: params.rings,
        samples: params.samples,
      }),
    [camera, normalPass, downSamplingPass]
  );
  useEffect(() => {
    effect.intensity = params.intensity;
    effect.radius = params.radius;
    effect.ssaoMaterial.bias = params.bias;
    effect.rings = params.rings;
    effect.samples = params.samples;
  });
  return <primitive object={effect} dispose={null} />;
}

export function CameraEffects({
  forceNodeId,
  sceneId,
}: { forceNodeId?: string; sceneId?: string } = {}) {
  const { previewEffectsCamera, cameraEffects, nodes, activeSceneId } =
    useEditorStore();
  const effectiveSceneId = sceneId ?? activeSceneId;

  const effectsNodeId = forceNodeId ?? previewEffectsCamera;
  const activeEffects = effectsNodeId
    ? cameraEffects.filter((e) => e.nodeId === effectsNodeId && e.enabled)
    : [];

  const get = <T,>(kind: string, key: string, fallback: T): T => {
    const e = activeEffects.find((e) => e.kind === kind);
    return (e?.config[key] ?? fallback) as T;
  };
  const has = (kind: string) => activeEffects.some((e) => e.kind === kind);

  const [sunMesh, setSunMesh] = useState<THREE.Mesh | null>(null);
  useFrame(() => {
    const caster = nodes.find(
      (n) =>
        n.rootSceneNodeId === effectiveSceneId && n.kind === 'godray_caster'
    );
    const mesh = caster ? (godrayCasterRegistry.get(caster.id) ?? null) : null;
    if (mesh !== sunMesh) setSunMesh(mesh);
  });
  const godrayCaster = nodes.find(
    (n) => n.rootSceneNodeId === effectiveSceneId && n.kind === 'godray_caster'
  );
  const gr = (godrayCaster?.components.godray as Record<string, number>) ?? {};

  const { camera } = useThree();
  const godRays = useMemo(
    () =>
      sunMesh
        ? new GodRaysEffect(camera, sunMesh, {
            samples: gr.samples ?? 60,
            density: gr.density ?? 0.96,
            decay: gr.decay ?? 0.93,
            weight: gr.weight ?? 0.4,
            exposure: gr.exposure ?? 0.6,
            clampMax: gr.clampMax ?? 1.0,
            blur: true,
          })
        : null,
    // Re-create only when the sun mesh changes; param updates are handled imperatively below
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camera, sunMesh]
  );
  useEffect(() => {
    if (!godRays) return;
    const m = godRays.godRaysMaterial;
    m.density = gr.density ?? 0.96;
    m.decay = gr.decay ?? 0.93;
    m.weight = gr.weight ?? 0.4;
    m.exposure = gr.exposure ?? 0.6;
    m.maxIntensity = gr.clampMax ?? 1.0;
    m.samples = gr.samples ?? 60;
  });

  const depthEdge = useMemo(() => new DepthEdgeEffect(), []);
  useEffect(() => {
    depthEdge.setColor(get('fx_outline', 'color', '#000000') as string);
    depthEdge.setThreshold(get('fx_outline', 'threshold', 0.001) as number);
    depthEdge.setThickness(get('fx_outline', 'thickness', 1.0) as number);
    depthEdge.setAlpha(get('fx_outline', 'alpha', 1.0) as number);
    depthEdge.setNormalStrength(
      get('fx_outline', 'normalStrength', 1.0) as number
    );
    depthEdge.setBlendMode(get('fx_outline', 'blendMode', 'NORMAL') as any);
  });

  // Always mount the composer so it owns tone mapping — renderer has NoToneMapping set.
  return (
    <EffectComposer
      enableNormalPass={has('fx_ssao') || has('fx_outline')}
      frameBufferType={THREE.HalfFloatType}
      multisampling={0}
    >
      {has('fx_brightness_contrast') ? (
        <BrightnessContrast
          brightness={get('fx_brightness_contrast', 'brightness', 0)}
          contrast={get('fx_brightness_contrast', 'contrast', 0)}
        />
      ) : (
        <></>
      )}
      {has('fx_hue_saturation') ? (
        <HueSaturation
          hue={get('fx_hue_saturation', 'hue', 0)}
          saturation={get('fx_hue_saturation', 'saturation', 0)}
        />
      ) : (
        <></>
      )}
      {has('fx_sepia') ? (
        <Sepia intensity={get('fx_sepia', 'intensity', 1)} />
      ) : (
        <></>
      )}
      {has('fx_bloom') ? (
        <Bloom
          intensity={get('fx_bloom', 'intensity', 1)}
          luminanceThreshold={get('fx_bloom', 'luminanceThreshold', 0.9)}
          luminanceSmoothing={get('fx_bloom', 'luminanceSmoothing', 0.025)}
          mipmapBlur={get('fx_bloom', 'mipmapBlur', true)}
        />
      ) : (
        <></>
      )}
      {has('fx_depth_of_field') ? (
        <AutofocusDOF
          cfg={
            activeEffects.find((e) => e.kind === 'fx_depth_of_field')!.config
          }
        />
      ) : (
        <></>
      )}
      {has('fx_chromatic_aberration') ? (
        <ChromaticAberration
          offset={
            new THREE.Vector2(
              get('fx_chromatic_aberration', 'offsetX', 0.002),
              get('fx_chromatic_aberration', 'offsetY', 0.002)
            )
          }
          radialModulation={false}
          modulationOffset={0}
        />
      ) : (
        <></>
      )}
      {has('fx_ssao') ? (
        <SSAOEffectPrimitive
          params={{
            intensity: get('fx_ssao', 'intensity', 1.5) as number,
            radius: Math.min(
              1,
              Math.max(1e-6, get('fx_ssao', 'radius', 0.2) as number)
            ),
            bias: get('fx_ssao', 'bias', 0.025) as number,
            rings: get('fx_ssao', 'rings', 4) as number,
            samples: get('fx_ssao', 'samples', 30) as number,
          }}
        />
      ) : (
        <></>
      )}
      {has('fx_outline') ? (
        <>
          <primitive object={depthEdge} />
          <NormalBufferSync effect={depthEdge} />
        </>
      ) : (
        <></>
      )}
      {has('fx_vignette') ? (
        <Vignette
          offset={get('fx_vignette', 'offset', 0.5)}
          darkness={get('fx_vignette', 'darkness', 0.5)}
        />
      ) : (
        <></>
      )}
      {has('fx_noise') ? (
        <Noise opacity={get('fx_noise', 'opacity', 0.2)} />
      ) : (
        <></>
      )}
      {has('fx_scanline') ? (
        <Scanline
          density={get('fx_scanline', 'density', 1.25)}
          opacity={get('fx_scanline', 'opacity', 0.1)}
        />
      ) : (
        <></>
      )}
      {has('fx_pixelation') ? (
        <Pixelation granularity={get('fx_pixelation', 'granularity', 8)} />
      ) : (
        <></>
      )}
      {has('fx_ascii') ? (
        <ASCII
          characters={get('fx_ascii', 'characters', ' .:-+*=%@#')}
          fontSize={get('fx_ascii', 'fontSize', 54)}
          cellSize={get('fx_ascii', 'cellSize', 16)}
          color={get('fx_ascii', 'color', '#ffffff')}
          invert={get('fx_ascii', 'invert', false)}
        />
      ) : (
        <></>
      )}
      {has('fx_dot_screen') ? (
        <DotScreen
          angle={get('fx_dot_screen', 'angle', 1.57)}
          scale={get('fx_dot_screen', 'scale', 1.0)}
        />
      ) : (
        <></>
      )}
      {has('fx_glitch') ? (
        <Glitch
          delay={
            new THREE.Vector2(
              ...(get('fx_glitch', 'delay', [1.5, 3.5]) as [number, number])
            )
          }
          duration={
            new THREE.Vector2(
              ...(get('fx_glitch', 'duration', [0.06, 0.3]) as [number, number])
            )
          }
          strength={
            new THREE.Vector2(
              ...(get('fx_glitch', 'strength', [0.3, 1.0]) as [number, number])
            )
          }
          columns={get('fx_glitch', 'columns', 0.05)}
          ratio={get('fx_glitch', 'ratio', 0.85)}
        />
      ) : (
        <></>
      )}
      {has('fx_smaa') ? <SMAA /> : <></>}
      {has('fx_tilt_shift') ? (
        <TiltShift
          offset={get('fx_tilt_shift', 'offset', 0.0)}
          rotation={get('fx_tilt_shift', 'rotation', 0.0)}
          focusArea={get('fx_tilt_shift', 'focusArea', 0.4)}
          feather={get('fx_tilt_shift', 'feather', 0.3)}
        />
      ) : (
        <></>
      )}
      {has('fx_water') ? (
        <WaterEffect factor={get('fx_water', 'factor', 1.0)} />
      ) : (
        <></>
      )}
      {godRays ? (
        <>
          <primitive object={godRays} />
          <GodRaysSync effect={godRays} />
        </>
      ) : (
        <></>
      )}
      <ToneMapping mode={get('fx_tone_mapping', 'mode', 6) as any} />
    </EffectComposer>
  );
}

// ── Shadows ───────────────────────────────────────────────────────────────
// Shadows are enabled per-camera (each camera is its own composed view of the
// scene). The camera's quality maps to the renderer's shadow-map filter; the
// per-light `castShadow` flag and per-node cast/receive flags do the rest.

export type ShadowQuality = 'low' | 'medium' | 'high';

/** Maps a camera's shadow quality to the R3F `<Canvas shadows>` prop value
 *  (the global shadow-map filtering type). Returns `false` when disabled. */
export function canvasShadowsProp(
  enabled: boolean,
  quality: ShadowQuality | undefined
): false | 'basic' | 'percentage' | 'soft' {
  if (!enabled) return false;
  if (quality === 'low') return 'basic';
  if (quality === 'high') return 'soft';
  return 'percentage'; // medium / default → PCF
}

/** Invisible ground plane at y=0 that only renders the shadows cast onto it,
 *  leaving the rest of the floor (the Grid) untouched. Mount only when the
 *  view has shadows enabled. */
export function ShadowCatcher({
  opacity = 0.4,
  size = 100,
}: {
  opacity?: number;
  size?: number;
}) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[size, size]} />
      <shadowMaterial transparent opacity={opacity} />
    </mesh>
  );
}

/** Forces a material recompile + shadow-map refresh whenever the view's shadow
 *  enablement flips, so toggling shadows takes effect immediately instead of
 *  on the next unrelated material change. */
export function ShadowMaterialSync({ enabled }: { enabled: boolean }) {
  const { scene, gl } = useThree();
  useEffect(() => {
    gl.shadowMap.needsUpdate = true;
    scene.traverse((obj) => {
      const m = (obj as THREE.Mesh).material as
        | THREE.Material
        | THREE.Material[]
        | undefined;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
    });
  }, [enabled, scene, gl]);
  return null;
}

/** Selector: returns the effective shadow quality for the editor viewport, or
 *  null when no camera in the active scene has shadows enabled. The editor is a
 *  free authoring view (not a camera), so it previews shadows whenever any
 *  camera does, picking the highest requested quality. */
function useEditorShadowQuality(): ShadowQuality | null {
  return useEditorStore((s) => {
    let best: ShadowQuality | null = null;
    const rank = { low: 1, medium: 2, high: 3 } as const;
    for (const n of s.nodes) {
      if (n.kind !== 'camera' || n.rootSceneNodeId !== s.activeSceneId)
        continue;
      const cam = n.components?.camera as
        | { shadowsEnabled?: boolean; shadowQuality?: ShadowQuality }
        | undefined;
      if (!cam?.shadowsEnabled) continue;
      const q = cam.shadowQuality ?? 'medium';
      if (!best || rank[q] > rank[best]) best = q;
    }
    return best;
  });
}

export function Viewport() {
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const orbitRef = useRef<any>(null);
  const shadowQuality = useEditorShadowQuality();
  const shadowsEnabled = shadowQuality !== null;
  // Hide the viewport until the scene's avatar(s) have loaded and the first
  // pose frames settle, then fade in — avoids seeing models pop in one by one
  // and snap around when a scene is first opened.
  const fadeIn = useSceneFadeIn();

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#1a1a1a',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <Canvas
        camera={{ position: [0, 1.5, 5], fov: 50 }}
        gl={{ toneMapping: THREE.NoToneMapping }}
        shadows={canvasShadowsProp(shadowsEnabled, shadowQuality ?? undefined)}
        style={fadeIn}
      >
        <ambientLight intensity={0.4} />
        <directionalLight
          position={[5, 10, 5]}
          intensity={0.8}
          castShadow={shadowsEnabled}
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-bias={-0.0005}
          shadow-normalBias={0.02}
          shadow-camera-near={0.1}
          shadow-camera-far={50}
          shadow-camera-left={-10}
          shadow-camera-right={10}
          shadow-camera-top={10}
          shadow-camera-bottom={-10}
        />
        <SceneNodes />
        <TransformGizmo mode={gizmoMode} orbitRef={orbitRef} />
        <Grid infiniteGrid fadeDistance={30} fadeStrength={1} />
        {shadowsEnabled && <ShadowCatcher />}
        <ShadowMaterialSync enabled={shadowsEnabled} />
        <SafeEnvironment preset="city" />
        <OrbitControls ref={orbitRef} makeDefault />
        <CameraEffects />
      </Canvas>
      <GizmoToolbar mode={gizmoMode} setMode={setGizmoMode} />
      <AudioPreviewToggle />
    </div>
  );
}

/** Editor-only toggle to preview audio (audio nodes + unmuted video) in the
 *  viewport. Off by default so authoring stays quiet; the viewer/output always
 *  plays audio regardless of this. */
function AudioPreviewToggle() {
  const { t } = useTranslation('misc');
  const on = useEditorStore((s) => s.editorAudioPreviewEnabled);
  const setOn = useEditorStore((s) => s.setEditorAudioPreviewEnabled);
  return (
    <button
      title={on ? t('viewport.audio.on') : t('viewport.audio.off')}
      onClick={() => setOn(!on)}
      style={{
        position: 'absolute',
        bottom: 16,
        left: 120,
        width: 30,
        height: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 15,
        cursor: 'pointer',
        background: on ? '#1e2e4a' : '#0e0e18',
        border: `1px solid ${on ? '#3a5a9a' : '#2a2a3a'}`,
        borderRadius: 6,
        color: on ? '#7ab' : '#555',
        lineHeight: 1,
        zIndex: 10,
      }}
    >
      {on ? <Volume2 size={15} /> : <VolumeX size={15} />}
    </button>
  );
}
