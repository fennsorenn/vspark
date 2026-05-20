import { useRef, useEffect, useState, useMemo, useContext } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Grid, Environment, Line, TransformControls, Billboard } from '@react-three/drei'
import {
  EffectComposer, Bloom, Vignette, ToneMapping,
  BrightnessContrast, HueSaturation, Sepia, DepthOfField,
  ChromaticAberration, Pixelation, Noise, Scanline,
  EffectComposerContext,
  ASCII, DotScreen, Glitch, SMAA, TiltShift, WaterEffect,
} from '@react-three/postprocessing'
import { SSAOEffect, BlendFunction } from 'postprocessing'
import { DepthEdgeEffect } from './DepthEdgeEffect'
import { GodRaysEffectFixed as GodRaysEffect } from './GodRaysEffectFixed'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import type { VRM, VRMHumanBoneName, VRMPose } from '@pixiv/three-vrm'
import { useEditorStore } from '../../store/editorStore'
import type { NodeRecord, NodeComponent } from '../../store/editorStore'

import { animRegistry } from '../../animRegistry'
import { getVmcPose, getVmcPoseTime, getVmcPoseBlendMode, getVmcBlendshapes } from '../../vmcPoseStore'
import { getIkTargets, getIkTargetsTime } from '../../ikTargetStore'
import { vrmRegistry } from '../../vrmRegistry'
import { applyArmCalib, upperArmNormRotFromTarget, DEFAULT_CALIBRATION } from '../../calibration'
import type { VmcCalibration } from '../../calibration'
import { VRM_BONE_NAMES } from '@vspark/shared/signal'
import { api } from '../../api/client'
import { BoneFilterBank } from '../../oneEuroFilter'
import { mergeParticleConfig, createParticlePool, tickParticles } from '../../particleUtils'
import type { ParticlePool } from '../../particleUtils'

type GizmoMode = 'translate' | 'rotate' | 'scale'

// Maps nodeId → outermost Three.js group, used to attach TransformControls
const nodeGroupRegistry = new Map<string, THREE.Group>()

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
  midBoneName:  VRMHumanBoneName,
  targetWorld:  THREE.Vector3,
): void {
  const rootBone = vrm.humanoid.getRawBoneNode(rootBoneName)
  const midBone  = vrm.humanoid.getRawBoneNode(midBoneName)
  if (!rootBone || !midBone) return
  const rootParent = rootBone.parent
  if (!rootParent) return

  const tipBone = midBone.children.find(c => c instanceof THREE.Bone) as THREE.Bone | undefined

  // ── 1. Rest-pose bone vectors in parent space ─────────────────────────────
  // We use the *current* local position of midBone as the rest offset from root
  // (bones in a skeleton are typically translated, not at origin). Similarly for tip.
  // We assume bone translations are constant; only rotations vary.
  const restU = midBone.position.clone()  // mid offset in root's local space
                                          // ≡ root→mid direction (scaled) in root's REST local frame
  if (restU.lengthSq() < 1e-9) return
  const lenAB = restU.length()
  restU.normalize()

  // restV: tip offset in mid's local space (i.e. mid→tip in mid's rest frame).
  let restV: THREE.Vector3
  let lenBC: number
  if (tipBone) {
    restV = tipBone.position.clone()
    lenBC = restV.length()
    if (lenBC < 1e-9) return
    restV.normalize()
  } else {
    // No tip bone — assume forearm continues along upper arm direction
    restV = restU.clone()
    lenBC = lenAB
  }

  // ── 2. Convert target into parent space ──────────────────────────────────
  // posA in parent space = rootBone's local position (since rootBone is a child of rootParent).
  // But for the math we just need (target - posA_world) expressed in parent space.
  const parentWorldInv = new THREE.Matrix4().copy(rootParent.matrixWorld).invert()
  const targetParent = targetWorld.clone().applyMatrix4(parentWorldInv)
  // root's position in parent space = rootBone.position (local).
  const rootInParent = rootBone.position.clone()
  const toTarget = targetParent.clone().sub(rootInParent)
  let lenAT = toTarget.length()
  if (lenAT < 1e-6) return
  const maxReach = lenAB + lenBC - 1e-4
  if (lenAT > maxReach) lenAT = maxReach
  const tDir = toTarget.normalize()  // root→target direction, in parent space

  // ── 3. Cosine rule ────────────────────────────────────────────────────────
  const cosA = (lenAB*lenAB + lenAT*lenAT - lenBC*lenBC) / (2*lenAB*lenAT)
  const angA = Math.acos(Math.max(-1, Math.min(1, cosA)))

  // ── 4. Bend axis ──────────────────────────────────────────────────────────
  // Pole hint in parent space: elbows should bend "behind" the chest. The chest's local
  // -Z is "behind", so in parent space we want -Z. We also want a small -Y so the elbow
  // points slightly down. We orthogonalise this against tDir to get the in-plane pole.
  const poleHint = new THREE.Vector3(0, -0.3, -1).normalize()
  const poleProj = poleHint.clone().sub(tDir.clone().multiplyScalar(poleHint.dot(tDir)))
  let poleDir: THREE.Vector3
  if (poleProj.lengthSq() < 1e-6) {
    // Target direction parallel to hint — fall back to using the current restU's perp
    const fallback = restU.clone().sub(tDir.clone().multiplyScalar(restU.dot(tDir)))
    poleDir = fallback.lengthSq() > 1e-6 ? fallback.normalize() : new THREE.Vector3(0, -1, 0)
  } else {
    poleDir = poleProj.normalize()
  }
  // bendAxis = cross(tDir, poleDir) — rotating tDir by +angA around bendAxis bends TOWARD pole.
  const bendAxis = new THREE.Vector3().crossVectors(tDir, poleDir).normalize()
  if (bendAxis.lengthSq() < 1e-6) return

  // ── 5. Desired upper-arm direction in parent space ───────────────────────
  // Rotate tDir by angA around bendAxis (away from straight-at-target, toward pole).
  // Actually: root→mid direction = rotate tDir by -angA around bendAxis (the elbow's outside angle).
  // The triangle has vertex A; the angle at A is between sides AB and AT. So AB direction is
  // tDir rotated by angA AWAY from AT direction toward the side opposite the pole.
  // We want the elbow on the pole side, so AB should rotate by -angA around bendAxis
  // (since bendAxis was constructed as cross(tDir, poleDir), rotating tDir by +ang around it
  // moves toward poleDir).
  const qRotU = new THREE.Quaternion().setFromAxisAngle(bendAxis, angA)
  const desiredU = tDir.clone().applyQuaternion(qRotU).normalize()

  // Root local rotation: rotates restU → desiredU.
  const rootLocalQ = new THREE.Quaternion().setFromUnitVectors(restU, desiredU)
  rootBone.quaternion.copy(rootLocalQ)
  rootBone.updateWorldMatrix(true, false)

  // ── 6. Mid bone ──────────────────────────────────────────────────────────
  // Desired mid→tip direction in parent space:
  // The elbow is at A + desiredU * lenAB. The tip is at target (clamped to lenAT).
  // So mid→tip direction (parent space) = (rootInParent + tDir*lenAT) - (rootInParent + desiredU*lenAB)
  //                                     = tDir*lenAT - desiredU*lenAB, then normalize.
  const desiredVparent = tDir.clone().multiplyScalar(lenAT).sub(desiredU.clone().multiplyScalar(lenAB))
  if (desiredVparent.lengthSq() < 1e-6) return
  desiredVparent.normalize()

  // We need this in the mid bone's parent space, which is the now-rotated rootBone's local space.
  // desiredVparent is in rootParent space. To get it in rootBone's local space:
  //   v_rootLocal = inv(rootLocalQ) * desiredVparent
  const desiredVrootLocal = desiredVparent.clone().applyQuaternion(rootLocalQ.clone().invert())

  // Mid local rotation: rotates restV → desiredVrootLocal (both in mid's parent / root's local space).
  const midLocalQ = new THREE.Quaternion().setFromUnitVectors(restV, desiredVrootLocal)
  midBone.quaternion.copy(midLocalQ)
  midBone.updateWorldMatrix(true, false)
}

/** Imperatively parents a node's group into a VRM bone so it follows the bone's transform. */
function BoneAttacher({ avatarNodeId, boneName, nodeId }: {
  avatarNodeId: string
  boneName: string
  nodeId: string
}) {
  const { scene } = useThree()
  useEffect(() => {
    const group = nodeGroupRegistry.get(nodeId)
    const vrm = vrmRegistry.get(avatarNodeId)
    if (!group || !vrm) return
    const bone = vrm.humanoid.getRawBoneNode(boneName as VRMHumanBoneName)
    if (!bone) return
    // Zero out stored world-space offset — position is now bone-local
    group.position.set(0, 0, 0)
    group.quaternion.identity()
    bone.add(group)
    return () => {
      // Restore to scene root on detach so Three.js doesn't orphan it
      scene.add(group)
    }
  })
  return null
}

// Maps nodeId → sun mesh, used by the implicit GodRays postprocessing pass
const godrayCasterRegistry = new Map<string, THREE.Mesh>()

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
}

// UE4 / Unreal Engine Mannequin skeleton
const UE4_TO_VRM: Record<string, VRMHumanBoneName> = {
  pelvis:        'hips',
  spine_01:      'spine',
  spine_02:      'chest',
  spine_03:      'upperChest',
  neck_01:       'neck',
  head:          'head',
  clavicle_l:    'leftShoulder',
  upperarm_l:    'leftUpperArm',
  lowerarm_l:    'leftLowerArm',
  hand_l:        'leftHand',
  clavicle_r:    'rightShoulder',
  upperarm_r:    'rightUpperArm',
  lowerarm_r:    'rightLowerArm',
  hand_r:        'rightHand',
  thigh_l:       'leftUpperLeg',
  calf_l:        'leftLowerLeg',
  foot_l:        'leftFoot',
  ball_l:        'leftToes',
  thigh_r:       'rightUpperLeg',
  calf_r:        'rightLowerLeg',
  foot_r:        'rightFoot',
  ball_r:        'rightToes',
  thumb_01_l:    'leftThumbMetacarpal',
  thumb_02_l:    'leftThumbProximal',
  thumb_03_l:    'leftThumbDistal',
  index_01_l:    'leftIndexProximal',
  index_02_l:    'leftIndexIntermediate',
  index_03_l:    'leftIndexDistal',
  middle_01_l:   'leftMiddleProximal',
  middle_02_l:   'leftMiddleIntermediate',
  middle_03_l:   'leftMiddleDistal',
  ring_01_l:     'leftRingProximal',
  ring_02_l:     'leftRingIntermediate',
  ring_03_l:     'leftRingDistal',
  pinky_01_l:    'leftLittleProximal',
  pinky_02_l:    'leftLittleIntermediate',
  pinky_03_l:    'leftLittleDistal',
  thumb_01_r:    'rightThumbMetacarpal',
  thumb_02_r:    'rightThumbProximal',
  thumb_03_r:    'rightThumbDistal',
  index_01_r:    'rightIndexProximal',
  index_02_r:    'rightIndexIntermediate',
  index_03_r:    'rightIndexDistal',
  middle_01_r:   'rightMiddleProximal',
  middle_02_r:   'rightMiddleIntermediate',
  middle_03_r:   'rightMiddleDistal',
  ring_01_r:     'rightRingProximal',
  ring_02_r:     'rightRingIntermediate',
  ring_03_r:     'rightRingDistal',
  pinky_01_r:    'rightLittleProximal',
  pinky_02_r:    'rightLittleIntermediate',
  pinky_03_r:    'rightLittleDistal',
}

// Combined map used at runtime — whichever bones are present in the FBX win.
const FBX_BONE_TO_VRM: Record<string, VRMHumanBoneName> = { ...MIXAMO_TO_VRM, ...UE4_TO_VRM }
// Hips bone names across all supported rigs (used for root position track).
const HIPS_BONE_NAMES = new Set(['mixamorigHips', 'pelvis'])


interface VmcRetarget {
  bonesInOrder: VRMHumanBoneName[]
  vrmBoneObj: Partial<Record<VRMHumanBoneName, THREE.Object3D>>
  vrmBoneParent: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>>
  vrmBindWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>
  vrmBindWQInv: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>
  curUnityWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>
  curVRMWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>>
  normalizedPose: VRMPose
  _q: THREE.Quaternion; _delta: THREE.Quaternion; _inv: THREE.Quaternion
}

function buildVmcRetarget(vrm: VRM): VmcRetarget {
  const allNames = VRM_BONE_NAMES as unknown as VRMHumanBoneName[]

  const vrmBoneObj: Partial<Record<VRMHumanBoneName, THREE.Object3D>> = {}
  for (const n of allNames) { const b = vrm.humanoid.getRawBoneNode(n); if (b) vrmBoneObj[n] = b }

  const nodeToName = new Map<THREE.Object3D, VRMHumanBoneName>()
  for (const [n, b] of Object.entries(vrmBoneObj)) nodeToName.set(b!, n as VRMHumanBoneName)

  const vrmBoneParent: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>> = {}
  for (const n of allNames) {
    const b = vrmBoneObj[n]; if (!b) continue
    let par = b.parent, limit = 64
    while (par && limit-- > 0) { const m = nodeToName.get(par); if (m) { vrmBoneParent[n] = m; break } par = par.parent }
  }

  const depthCache: Record<string, number> = {}
  const getDepth = (n: VRMHumanBoneName): number => {
    if (depthCache[n] !== undefined) return depthCache[n]
    return (depthCache[n] = vrmBoneParent[n] ? getDepth(vrmBoneParent[n]!) + 1 : 0)
  }
  const bonesInOrder = allNames.filter(n => vrmBoneObj[n]).sort((a, b) => getDepth(a) - getDepth(b))

  // VRM bind world Qs — same as FBX retargeting phase 2
  const vrmBindWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {}
  const vrmBindWQInv: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {}
  for (const vn of bonesInOrder) {
    const bone = vrmBoneObj[vn]!
    const pWQ = vrmBoneParent[vn] ? vrmBindWQ[vrmBoneParent[vn]!] : undefined
    const wq = pWQ ? pWQ.clone().multiply(bone.quaternion) : bone.quaternion.clone()
    vrmBindWQ[vn] = wq; vrmBindWQInv[vn] = wq.clone().invert()
  }

  const curUnityWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {}
  const curVRMWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {}
  for (const vn of bonesInOrder) { curUnityWQ[vn] = new THREE.Quaternion(); curVRMWQ[vn] = new THREE.Quaternion() }

  return { bonesInOrder, vrmBoneObj, vrmBoneParent, vrmBindWQ, vrmBindWQInv, curUnityWQ, curVRMWQ,
    normalizedPose: {},
    _q: new THREE.Quaternion(), _delta: new THREE.Quaternion(), _inv: new THREE.Quaternion() }
}

function addBoneAxes(root: THREE.Object3D, size: number) {
  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return
    const axes = new THREE.AxesHelper(size)
    const mat = axes.material as THREE.Material | THREE.Material[]
    const setDepth = (m: THREE.Material) => { m.depthTest = false; m.depthWrite = false }
    Array.isArray(mat) ? mat.forEach(setDepth) : setDepth(mat)
    axes.renderOrder = 999
    obj.add(axes)
  })
}
void addBoneAxes // retained for debugging — re-enable calls above when needed

interface Transform {
  x: number; y: number; z: number
  rx: number; ry: number; rz: number
  sx: number; sy: number; sz: number
}

function getTransform(node: NodeRecord): Transform {
  const t = node.components?.transform as Partial<Transform> | undefined
  return {
    x: t?.x ?? 0, y: t?.y ?? 0, z: t?.z ?? 0,
    rx: t?.rx ?? 0, ry: t?.ry ?? 0, rz: t?.rz ?? 0,
    sx: t?.sx ?? 1, sy: t?.sy ?? 1, sz: t?.sz ?? 1,
  }
}

function AvatarNode({ node, children }: { node: NodeRecord; children?: React.ReactNode }) {
  const outerRef      = useRef<THREE.Group>(null)
  const groupRef      = useRef<THREE.Group>(null)
  const fbxGroupRef   = useRef<THREE.Group>(null)
  const vrmHelperRef  = useRef<THREE.Group>(null)
  const fbxHelperRef  = useRef<THREE.Group>(null)
  const boneCylRef = useRef<THREE.Mesh>(null)
  const fbxMixerRef   = useRef<THREE.AnimationMixer | null>(null)
  const vrmMixerRef   = useRef<THREE.AnimationMixer | null>(null)
  const vrmRef        = useRef<VRM | null>(null)
  const corrAxesRef   = useRef<THREE.Object3D[]>([])
  const vmcCompRef        = useRef<NodeComponent | null>(null)
  const lipsyncCompRef    = useRef<NodeComponent | null>(null)
  const vmcRetargetRef  = useRef<VmcRetarget | null>(null)
  const boneFiltersRef    = useRef(new BoneFilterBank())
  const poseWasActiveRef  = useRef(false)
  const blendWeightRef    = useRef(0)  // 0 = animation, 1 = VMC
  const [vrmLoaded, setVrmLoaded] = useState(false)
  const t = getTransform(node)

  const showBoneHelper = useEditorStore((s) => s.boneListExpanded[node.id] ?? false)
  const showFbxDebug   = useEditorStore((s) => s.fbxDebugVisible[node.id]  ?? false)

  useEffect(() => {
    if (outerRef.current) nodeGroupRegistry.set(node.id, outerRef.current)
    return () => { nodeGroupRegistry.delete(node.id) }
  }, [node.id])

  useEffect(() => {
    if (vrmHelperRef.current) vrmHelperRef.current.visible = showBoneHelper
  }, [showBoneHelper])

  useEffect(() => {
    if (fbxGroupRef.current)  fbxGroupRef.current.visible  = showFbxDebug
    if (fbxHelperRef.current) fbxHelperRef.current.visible = showFbxDebug
  }, [showFbxDebug])

  // Track active pose-driving component without causing useFrame re-subscription
  const vmcComp = useEditorStore((s) =>
    s.nodeComponentsFor(node.id).find((c) =>
      (c.kind === 'vmc_receiver' || c.kind === 'mediapipe_tracker') && c.enabled
    ) ?? null
  )
  useEffect(() => { vmcCompRef.current = vmcComp }, [vmcComp])

  // Track active blendshape-driving component (lipsync, face tracking)
  const lipsyncComp = useEditorStore((s) =>
    s.nodeComponentsFor(node.id).find((c) =>
      (c.kind === 'lipsync_processor' || c.kind === 'mediapipe_tracker') && c.enabled
    ) ?? null
  )
  useEffect(() => { lipsyncCompRef.current = lipsyncComp }, [lipsyncComp])

  const { setVrmBonesForNode, clearVrmBonesForNode,
          setVrmExpressionsForNode, clearVrmExpressionsForNode,
          setVrmMorphTargetsForNode, clearVrmMorphTargetsForNode } = useEditorStore()

  // name → all meshes+indices that have that morph target
  type MorphEntry = { mesh: THREE.SkinnedMesh; index: number }
  const morphMapRef = useRef<Map<string, MorphEntry[]>>(new Map())

  const animComp = node.components?.animation as { idleUrl?: string; speed?: number; offset?: number } | undefined
  const animUrl = animComp?.idleUrl ?? null
  const animSpeed = animComp?.speed ?? 1
  const animOffset = animComp?.offset ?? 0

  // --- VRM load ---
  useEffect(() => {
    if (!node.filePath) return
    let cancelled = false
    setVrmLoaded(false)

    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    loader.load(node.filePath, (gltf) => {
      if (cancelled || !groupRef.current) return
      const vrm = gltf.userData.vrm as VRM | undefined
      const vrmScene = gltf.scene

      vrmRef.current = vrm ?? null
      vrmScene.rotation.y = Math.PI
      groupRef.current.clear()
      groupRef.current.add(vrmScene)

      if (vrmHelperRef.current) {
        vrmHelperRef.current.clear()
        const vrmHelper = new THREE.SkeletonHelper(vrmScene)
        ;(vrmHelper.material as THREE.LineBasicMaterial).color.set(0x00ffff)
        ;(vrmHelper.material as THREE.LineBasicMaterial).depthTest = false
        vrmHelperRef.current.add(vrmHelper)
        vrmHelperRef.current.visible = useEditorStore.getState().boneListExpanded[node.id] ?? false
      }
      // addBoneAxes(vrmScene, 0.05)

      if (vrm) {
        vmcRetargetRef.current = buildVmcRetarget(vrm)
        setVrmBonesForNode(node.id, Object.keys(vrm.humanoid.humanBones))

        // Expressions
        const exprMap = (vrm.expressionManager as unknown as { expressionMap?: Record<string, unknown> } | null)?.expressionMap
        setVrmExpressionsForNode(node.id, exprMap ? Object.keys(exprMap).sort() : [])

        // Morph targets — walk every SkinnedMesh in the scene
        const morphMap = new Map<string, Array<{ mesh: THREE.SkinnedMesh; index: number }>>()
        vrm.scene.traverse((obj) => {
          const mesh = obj as THREE.SkinnedMesh
          if (!mesh.isSkinnedMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return
          for (const [name, idx] of Object.entries(mesh.morphTargetDictionary)) {
            if (!morphMap.has(name)) morphMap.set(name, [])
            morphMap.get(name)!.push({ mesh, index: idx })
          }
        })
        morphMapRef.current = morphMap
        setVrmMorphTargetsForNode(node.id, [...morphMap.keys()].sort())

        vrmRegistry.set(node.id, vrm)
      }
      setVrmLoaded(true)
    })

    return () => {
      cancelled = true
      setVrmLoaded(false)
      vrmMixerRef.current?.stopAllAction()
      vrmMixerRef.current = null
      vrmRef.current = null
      vmcRetargetRef.current = null
      boneFiltersRef.current.reset()
      vrmHelperRef.current?.clear()
      clearVrmBonesForNode(node.id)
      clearVrmExpressionsForNode(node.id)
      clearVrmMorphTargetsForNode(node.id)
      morphMapRef.current.clear()
      vrmRegistry.delete(node.id)
    }
  }, [node.filePath])

  // --- Animation load ---
  useEffect(() => {
    if (!animUrl || !node.filePath || !vrmLoaded) return
    let cancelled = false

    const ext = animUrl.split('?')[0].split('.').pop()?.toLowerCase()
    if (ext !== 'fbx') return

    new FBXLoader().load(animUrl, (fbx) => {
      if (cancelled) return
      const clip = fbx.animations[0]
      if (!clip) return
      const vrm = vrmRef.current
      if (!vrm) return

      // Snapshot bone local quaternions at load time (A-pose / bind pose for animation-only FBX).
      const loadTimeQ: Record<string, THREE.Quaternion> = {}
      fbx.traverse(o => { if (FBX_BONE_TO_VRM[o.name]) loadTimeQ[o.name] = o.quaternion.clone() })

      // Snapshot bone WORLD quaternions at load time, in FBX-local space (before fbx.rotation.y
      // is set and before adding to fbxGroup). These include the 'root' node's coordinate-
      // system correction (Z-up→Y-up) but not any display transforms.
      fbx.updateWorldMatrix(true, true)
      const loadTimeWQ: Record<string, THREE.Quaternion> = {}
      const _wqLoad = new THREE.Quaternion()
      fbx.traverse(o => {
        if (FBX_BONE_TO_VRM[o.name]) { o.getWorldQuaternion(_wqLoad); loadTimeWQ[o.name] = _wqLoad.clone() }
      })

      // FBXLoader's coordinate-system correction (e.g. Z-up→Y-up for UE4), captured before
      // we overwrite fbx.rotation.y with our display flip.  For Y-up FBX (Mixamo) this is
      // identity, so conjugating the world-space delta by it is a no-op for Mixamo.

      // FBX skeleton display
      if (fbxGroupRef.current) {
        fbxGroupRef.current.clear()
        fbx.scale.setScalar(0.01)
        fbx.rotation.y = Math.PI
        fbxGroupRef.current.position.x = 2
        fbxGroupRef.current.add(fbx)
        // addBoneAxes(fbx, 5)
        fbxGroupRef.current.visible = useEditorStore.getState().fbxDebugVisible[node.id] ?? false
      }
      if (fbxHelperRef.current) {
        fbxHelperRef.current.clear()
        const helper = new THREE.SkeletonHelper(fbx)
        ;(helper.material as THREE.LineBasicMaterial).color.set(0x00ff88)
        ;(helper.material as THREE.LineBasicMaterial).depthTest = false
        fbxHelperRef.current.add(helper)
        fbxHelperRef.current.visible = useEditorStore.getState().fbxDebugVisible[node.id] ?? false
      }

      // Collect FBX bone world Qs via getWorldQuaternion — same as what SkeletonHelper reads.
      // updateWorldMatrix(true,true) propagates from parents down so world matrices are current.
      fbxGroupRef.current?.updateWorldMatrix(true, true)
      const fbxBoneWorldQ: Record<string, THREE.Quaternion> = {}
      const _wqTmp = new THREE.Quaternion()
      fbx.traverse(o => {
        if (FBX_BONE_TO_VRM[o.name]) {
          o.getWorldQuaternion(_wqTmp)
          fbxBoneWorldQ[o.name] = _wqTmp.clone()
        }
      })
      // Log intermediate nodes between fbx root and pelvis to find hidden transforms
      {
        let cur: THREE.Object3D | null = null
        fbx.traverse(o => { if (o.name === 'pelvis' && !cur) cur = o as THREE.Object3D })
        const path: string[] = []
        let n = cur as THREE.Object3D | null
        while (n && n !== fbx) {
          const q = n.quaternion
          path.unshift(`${n.name||'?'} q=(${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)})`)
          n = n.parent as THREE.Object3D | null
        }
        console.log('[fbxChain] fbx→pelvis:', path.join(' → '))
      }

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
      let skeleton: THREE.Skeleton | null = null
      fbx.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skeleton) skeleton = (o as THREE.SkinnedMesh).skeleton })
      let fbxHipsNode: THREE.Object3D | null = null
      fbx.traverse(o => { if (HIPS_BONE_NAMES.has(o.name) && !fbxHipsNode) fbxHipsNode = o })

      const fbxBindWQ:        Record<string, THREE.Quaternion> = {}
      const fbxBindWQInv:     Record<string, THREE.Quaternion> = {}
      const fbxRestLocalQ:    Record<string, THREE.Quaternion> = {}
      const fbxBoneParent:  Record<string, string | null>    = {}
      if (skeleton) {
        // Skinned FBX: use boneInverses for exact bind world Qs.
        const sk = skeleton as THREE.Skeleton
        const _tp = new THREE.Vector3(), _tq = new THREE.Quaternion(), _ts = new THREE.Vector3()
        for (let i = 0; i < sk.bones.length; i++) {
          const bone = sk.bones[i]
          if (!FBX_BONE_TO_VRM[bone.name]) continue
          sk.boneInverses[i].clone().invert().decompose(_tp, _tq, _ts)
          const wq = _tq.clone().normalize()
          fbxBindWQ[bone.name]    = wq
          fbxBindWQInv[bone.name] = wq.clone().invert()
          let par = bone.parent as THREE.Bone | null
          while (par && !FBX_BONE_TO_VRM[par.name ?? '']) par = par.parent as THREE.Bone | null
          fbxBoneParent[bone.name] = par?.name ?? null
        }
        // Bind-local Qs for skinned FBX: parentBindWQ⁻¹ × childBindWQ (from boneInverses).
        // bone.quaternion is unreliable for skinned FBX (reflects animated frame, not bind pose).
        for (const name of Object.keys(fbxBindWQ)) {
          const pn = fbxBoneParent[name]
          fbxRestLocalQ[name] = pn
            ? fbxBindWQ[pn]!.clone().invert().multiply(fbxBindWQ[name]!)
            : fbxBindWQ[name]!.clone()
        }
      } else {
        // Animation-only FBX (no SkinnedMesh): Three.js places bones at their bind
        // pose on load, so we chain local quaternions root→leaf for the world Qs.
        const rigNodes: Record<string, THREE.Object3D> = {}
        fbx.traverse(o => { if (FBX_BONE_TO_VRM[o.name]) rigNodes[o.name] = o })
        for (const [name, node] of Object.entries(rigNodes)) {
          let par = node.parent
          while (par && !rigNodes[par.name]) par = par.parent
          fbxBoneParent[name] = par?.name ?? null
        }
        const depthOf = (n: string): number => {
          let d = 0, cur: string | null = fbxBoneParent[n]
          while (cur) { d++; cur = fbxBoneParent[cur] }
          return d
        }
        const curWQ: Record<string, THREE.Quaternion> = {}
        for (const name of Object.keys(rigNodes).sort((a, b) => depthOf(a) - depthOf(b))) {
          const localQ = loadTimeQ[name] ?? rigNodes[name].quaternion
          const pWQ = fbxBoneParent[name] ? curWQ[fbxBoneParent[name]!] : undefined
          const wq  = pWQ ? pWQ.clone().multiply(localQ) : localQ.clone()
          curWQ[name]         = wq
          fbxBindWQ[name]     = wq.clone()
          fbxBindWQInv[name]  = wq.clone().invert()
          fbxRestLocalQ[name] = localQ.clone()
        }
      }

      // --- Phase 2: VRM bind world Qs (chain product, no scene rotation) ---
      const allVRMBoneNames = [...new Set(Object.values(FBX_BONE_TO_VRM) as VRMHumanBoneName[])]
      const vrmBoneObj: Partial<Record<VRMHumanBoneName, THREE.Object3D>> = {}
      for (const n of allVRMBoneNames) { const b = vrm.humanoid.getRawBoneNode(n); if (b) vrmBoneObj[n] = b }

      const vrmNodeToName = new Map<THREE.Object3D, VRMHumanBoneName>()
      for (const n of allVRMBoneNames) { const b = vrmBoneObj[n]; if (b) vrmNodeToName.set(b, n) }
      const vrmBoneParent: Partial<Record<VRMHumanBoneName, VRMHumanBoneName | null>> = {}
      for (const n of allVRMBoneNames) {
        const b = vrmBoneObj[n]; if (!b) continue
        let par = b.parent, found: VRMHumanBoneName | null = null, limit = 64
        while (par && limit-- > 0) { const m = vrmNodeToName.get(par); if (m) { found = m; break } par = par.parent }
        vrmBoneParent[n] = found
      }

      const depthCache: Record<string, number> = {}
      const getDepth = (mb: string): number => {
        if (depthCache[mb] !== undefined) return depthCache[mb]
        const p = fbxBoneParent[mb]; let d = 0, limit = 64
        let cur = p; while (cur && limit-- > 0) { d++; cur = fbxBoneParent[cur] }
        return (depthCache[mb] = d)
      }
      const bonesInOrder = (Object.keys(FBX_BONE_TO_VRM) as string[])
        .filter(mb => fbxBindWQ[mb] && vrmBoneObj[FBX_BONE_TO_VRM[mb] as VRMHumanBoneName])
        .sort((a, b) => getDepth(a) - getDepth(b))

      const vrmBindWQ:    Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {}
      const vrmBindWQInv: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {}
      for (const mb of bonesInOrder) {
        const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName
        const bone = vrmBoneObj[vn]!
        const pn = vrmBoneParent[vn]
        const pWQ = pn ? vrmBindWQ[pn] : undefined
        const wq = pWQ ? pWQ.clone().multiply(bone.quaternion) : bone.quaternion.clone()
        vrmBindWQ[vn]    = wq
        vrmBindWQInv[vn] = wq.clone().invert()
      }

      // VRM bind-local Qs: vrmParentBindWQ⁻¹ × vrmBoneBindWQ
      const vrmBindLocalQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {}
      for (const mb of bonesInOrder) {
        const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName
        const vpn = vrmBoneParent[vn]
        vrmBindLocalQ[vn] = vpn
          ? vrmBindWQ[vpn]!.clone().invert().multiply(vrmBindWQ[vn]!)
          : vrmBindWQ[vn]!.clone()
      }

      // Log bind world Qs for arm bones to verify A-pose vs T-pose
      for (const [mb, vn] of [['upperarm_l','leftUpperArm'],['upperarm_r','rightUpperArm']] as const) {
        const fq = fbxBindWQ[mb]; const vq = vrmBindWQ[vn as VRMHumanBoneName]
        if (fq) console.log(`[bindWQ] fbx ${mb} = (${fq.x.toFixed(3)},${fq.y.toFixed(3)},${fq.z.toFixed(3)},${fq.w.toFixed(3)})`)
        if (vq) console.log(`[bindWQ] vrm ${vn} = (${vq.x.toFixed(3)},${vq.y.toFixed(3)},${vq.z.toFixed(3)},${vq.w.toFixed(3)})`)
      }

      // --- A-pose correction: compute per-bone VRM world Q after applying the FBX A-pose ---
      // See memory:fbx-apose-retargeting. This is the same algorithm used in the bind-pose
      // visualization, but computed purely from data (positions + world Qs) without
      // touching any live Three.js objects, so it's available synchronously for Phase 4.
      const vrmAposeWQ:    Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {}
      const vrmAposeWQInv: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {}

      const PREFERRED_VRM_CHILD: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>> = {
        hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head',
        leftShoulder: 'leftUpperArm', rightShoulder: 'rightUpperArm',
        leftUpperArm: 'leftLowerArm', rightUpperArm: 'rightLowerArm',
        leftLowerArm: 'leftHand', rightLowerArm: 'rightHand',
        leftUpperLeg: 'leftLowerLeg', rightUpperLeg: 'rightLowerLeg',
        leftLowerLeg: 'leftFoot', rightLowerLeg: 'rightFoot',
        leftFoot: 'leftToes', rightFoot: 'rightToes',
      }
      const VRM_TO_FBX: Partial<Record<VRMHumanBoneName, string>> = {}
      for (const [fb, vb] of Object.entries(FBX_BONE_TO_VRM)) {
        if (!fbxBindWQ[fb]) continue
        if (!VRM_TO_FBX[vb as VRMHumanBoneName]) VRM_TO_FBX[vb as VRMHumanBoneName] = fb
      }
      const fbxChild: Record<string, string | null> = {}
      for (const name of Object.keys(fbxBindWQ)) {
        const vn = FBX_BONE_TO_VRM[name] as VRMHumanBoneName | undefined
        const preferredV = vn ? PREFERRED_VRM_CHILD[vn] : undefined
        fbxChild[name] = preferredV ? (VRM_TO_FBX[preferredV] ?? null) : null
      }
      for (const name of Object.keys(fbxBindWQ)) {
        if (fbxChild[name]) continue
        for (const candidate of Object.keys(fbxBindWQ)) {
          if (fbxBoneParent[candidate] === name) { fbxChild[name] = candidate; break }
        }
      }
      const vrmChild: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>> = {}
      for (const n of allVRMBoneNames) {
        const preferred = PREFERRED_VRM_CHILD[n]
        if (preferred && vrmBoneObj[preferred]) { vrmChild[n] = preferred; continue }
        for (const candidate of allVRMBoneNames) {
          if (vrmBoneParent[candidate] === n) { vrmChild[n] = candidate; break }
        }
      }
      const fbxBoneNode: Record<string, THREE.Object3D> = {}
      fbx.traverse(o => { if (FBX_BONE_TO_VRM[o.name] && !fbxBoneNode[o.name]) fbxBoneNode[o.name] = o })

      // Detect the FBX's "up axis" by looking at which world axis the hips→spine
      // direction most aligns with. UE4 has root with 90°X (Z-up→Y-up baked in) →
      // spine points +Y. UE5 has identity root → spine points +Z (Z-up native).
      // Build a coordinate-fix rotation that brings whatever the FBX considers "up"
      // back to world +Y. Apply this fix to ALL fbxBindWQ values.
      const hipsFbxName = VRM_TO_FBX.hips
      const spineFbxName = VRM_TO_FBX.spine
      const fbxCoordFix = new THREE.Quaternion()
      if (hipsFbxName && spineFbxName && fbxBindWQ[hipsFbxName] && fbxBoneNode[spineFbxName]) {
        const fbxSpineDir = fbxBoneNode[spineFbxName].position.clone().normalize()
          .applyQuaternion(fbxBindWQ[hipsFbxName]!)
        // Find the world axis closest to fbxSpineDir
        const ax = Math.abs(fbxSpineDir.x), ay = Math.abs(fbxSpineDir.y), az = Math.abs(fbxSpineDir.z)
        let majorAxis = new THREE.Vector3(0, 1, 0)
        if (ax > ay && ax > az) majorAxis.set(Math.sign(fbxSpineDir.x), 0, 0)
        else if (az > ay) majorAxis.set(0, 0, Math.sign(fbxSpineDir.z))
        else majorAxis.set(0, Math.sign(fbxSpineDir.y), 0)
        // Rotation that maps majorAxis → world +Y
        fbxCoordFix.setFromUnitVectors(majorAxis, new THREE.Vector3(0, 1, 0))
        console.log(`[fbxCoordFix] spineDir=(${fbxSpineDir.x.toFixed(2)},${fbxSpineDir.y.toFixed(2)},${fbxSpineDir.z.toFixed(2)}) major=(${majorAxis.x.toFixed(0)},${majorAxis.y.toFixed(0)},${majorAxis.z.toFixed(0)}) fix=(${fbxCoordFix.x.toFixed(3)},${fbxCoordFix.y.toFixed(3)},${fbxCoordFix.z.toFixed(3)},${fbxCoordFix.w.toFixed(3)})`)
        // Apply the fix to all fbxBindWQ values: newWQ = fix × oldWQ
        for (const k of Object.keys(fbxBindWQ)) {
          const fixed = fbxCoordFix.clone().multiply(fbxBindWQ[k])
          fbxBindWQ[k].copy(fixed)
          fbxBindWQInv[k].copy(fixed).invert()
        }
      }

      // 1. Hips: full 3-axis basis alignment.
      const lThighFbxName = VRM_TO_FBX.leftUpperLeg
      const rThighFbxName = VRM_TO_FBX.rightUpperLeg
      if (hipsFbxName && spineFbxName && lThighFbxName && rThighFbxName &&
          vrmBoneObj.hips && vrmBoneObj.spine && vrmBoneObj.leftUpperLeg && vrmBoneObj.rightUpperLeg &&
          fbxBoneNode[spineFbxName] && fbxBoneNode[lThighFbxName] && fbxBoneNode[rThighFbxName]) {
        const hipsBindWQ = vrmBindWQ.hips!
        const vUp = vrmBoneObj.spine.position.clone().normalize().applyQuaternion(hipsBindWQ)
        const vRight = new THREE.Vector3().subVectors(vrmBoneObj.leftUpperLeg.position, vrmBoneObj.rightUpperLeg.position).normalize().applyQuaternion(hipsBindWQ)
        const vForward = new THREE.Vector3().crossVectors(vRight, vUp).normalize()
        const vRight2 = new THREE.Vector3().crossVectors(vUp, vForward).normalize()
        const vrmBasis = new THREE.Matrix4().makeBasis(vRight2, vUp, vForward)

        const hipsFbxWQ = fbxBindWQ[hipsFbxName]!
        const fUp = fbxBoneNode[spineFbxName].position.clone().normalize().applyQuaternion(hipsFbxWQ)
        const fRight = new THREE.Vector3().subVectors(fbxBoneNode[lThighFbxName].position, fbxBoneNode[rThighFbxName].position).normalize().applyQuaternion(hipsFbxWQ)
        const fForward = new THREE.Vector3().crossVectors(fRight, fUp).normalize()
        const fRight2 = new THREE.Vector3().crossVectors(fUp, fForward).normalize()
        const fbxBasis = new THREE.Matrix4().makeBasis(fRight2, fUp, fForward)

        const fullRot = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().multiplyMatrices(fbxBasis, vrmBasis.clone().invert()))
        vrmAposeWQ.hips = fullRot.clone().multiply(hipsBindWQ)
      } else {
        vrmAposeWQ.hips = vrmBindWQ.hips?.clone()
      }

      // 2. Other non-hips, non-leaf bones: single-axis swing aligning child direction.
      // Process root→leaf using bonesInOrder.
      for (const mb of bonesInOrder) {
        const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName
        if (vn === 'hips') continue
        const bindWQ = vrmBindWQ[vn]
        if (!bindWQ) continue
        const childMb = fbxChild[mb]
        const childVn = vrmChild[vn]

        // Start from bind WQ, then apply parent's accumulated swing in world space.
        // The parent's "extra rotation" beyond bind = vrmAposeWQ[parent] × vrmBindWQInv[parent].
        const vpn = vrmBoneParent[vn]
        const parentExtra = vpn && vrmAposeWQ[vpn] && vrmBindWQInv[vpn]
          ? vrmAposeWQ[vpn]!.clone().multiply(vrmBindWQInv[vpn]!)
          : new THREE.Quaternion()
        const swungBoneBindWQ = parentExtra.clone().multiply(bindWQ)

        if (childMb && childVn && vrmBoneObj[childVn] && fbxBoneNode[childMb]) {
          const vrmChildPos = vrmBoneObj[childVn]!.position
          const fbxChildPos = fbxBoneNode[childMb].position
          if (vrmChildPos.lengthSq() > 1e-10 && fbxChildPos.lengthSq() > 1e-10) {
            const vrmDir = vrmChildPos.clone().normalize().applyQuaternion(swungBoneBindWQ)
            const fbxDir = fbxChildPos.clone().normalize().applyQuaternion(fbxBindWQ[mb]!)
            const swing = new THREE.Quaternion().setFromUnitVectors(vrmDir, fbxDir)
            // newWQ = swing × swungBoneBindWQ
            const newWQ = swing.multiply(swungBoneBindWQ)

            // Hand basis correction
            const isHand = vn === 'leftHand' || vn === 'rightHand'
            if (isHand) {
              const middleVn = (vn === 'leftHand' ? 'leftMiddleProximal' : 'rightMiddleProximal') as VRMHumanBoneName
              const littleVn = (vn === 'leftHand' ? 'leftLittleProximal' : 'rightLittleProximal') as VRMHumanBoneName
              const middleFbx = VRM_TO_FBX[middleVn]
              const littleFbx = VRM_TO_FBX[littleVn]
              if (vrmBoneObj[middleVn] && vrmBoneObj[littleVn] && middleFbx && littleFbx && fbxBoneNode[middleFbx] && fbxBoneNode[littleFbx]) {
                const vMid = vrmBoneObj[middleVn]!.position.clone().normalize().applyQuaternion(newWQ)
                const vLit = vrmBoneObj[littleVn]!.position.clone().normalize().applyQuaternion(newWQ)
                const fMid = fbxBoneNode[middleFbx].position.clone().normalize().applyQuaternion(fbxBindWQ[mb]!)
                const fLit = fbxBoneNode[littleFbx].position.clone().normalize().applyQuaternion(fbxBindWQ[mb]!)
                const vF = vMid.clone().normalize()
                const vS = vLit.clone().normalize()
                const vU = new THREE.Vector3().crossVectors(vF, vS).normalize()
                // Ensure vU and fU both point the same anatomical direction (palm normal
                // = downward in world for A-pose). Use fU's sign as the reference and
                // match vU to it so both bases represent the same palm orientation.
                const fF = fMid.clone().normalize()
                const fS = fLit.clone().normalize()
                const fU = new THREE.Vector3().crossVectors(fF, fS).normalize()
                // Canonical palm normal: whichever of ±fU points more downward (-Y)
                if (fU.y > 0) fU.multiplyScalar(-1)
                // Match vU chirality to fU
                if (vU.dot(fU) < 0) vU.multiplyScalar(-1)
                const vR = new THREE.Vector3().crossVectors(vU, vF).normalize()
                const vMat = new THREE.Matrix4().makeBasis(vR, vU, vF)
                const fR = new THREE.Vector3().crossVectors(fU, fF).normalize()
                const fMat = new THREE.Matrix4().makeBasis(fR, fU, fF)
                const handRot = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().multiplyMatrices(fMat, vMat.invert()))
                vrmAposeWQ[vn] = handRot.multiply(newWQ)
                continue
              }
            }
            vrmAposeWQ[vn] = newWQ
            continue
          }
        }
        // Leaf or no valid child: just inherit parent extra (= swungBoneBindWQ)
        vrmAposeWQ[vn] = swungBoneBindWQ
      }

      for (const vn of Object.keys(vrmAposeWQ) as VRMHumanBoneName[]) {
        if (vrmAposeWQ[vn]) vrmAposeWQInv[vn] = vrmAposeWQ[vn]!.clone().invert()
      }
      console.log('[apose] computed corrections for', Object.keys(vrmAposeWQ).length, 'bones')

      // --- Phase 3: Create interpolants, collect keyframe times ---
      const qInterp: Record<string, THREE.Interpolant> = {}
      let hipsPosTrack: THREE.KeyframeTrack | null = null
      for (const track of clip.tracks) {
        const d = track.name.indexOf('.'), bone = track.name.slice(0, d), prop = track.name.slice(d + 1)
        if (prop === 'quaternion') qInterp[bone] = track.createInterpolant()
        if (prop === 'position' && HIPS_BONE_NAMES.has(bone)) hipsPosTrack = track
      }
      const refTrack = clip.tracks.find(t => t.name.endsWith('.quaternion'))
      const allTimes  = refTrack ? Array.from(refTrack.times) : []

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
      const outQVals: Partial<Record<VRMHumanBoneName, Float32Array>> = {}
      for (const mb of bonesInOrder)
        outQVals[FBX_BONE_TO_VRM[mb] as VRMHumanBoneName] = new Float32Array(allTimes.length * 4)

      const curFBXWQ: Record<string, THREE.Quaternion> = {}
      const curVRMWQ: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {}
      for (const mb of bonesInOrder) {
        curFBXWQ[mb] = new THREE.Quaternion()
        curVRMWQ[FBX_BONE_TO_VRM[mb] as VRMHumanBoneName] = new THREE.Quaternion()
      }

      const IDQ    = new THREE.Quaternion()
      const _q     = new THREE.Quaternion()
      const _delta = new THREE.Quaternion()
      const _inv   = new THREE.Quaternion()

      // Compute FBX world Qs at animation frame 0 — this becomes the reference pose
      // for retargeting. Many FBX animations (notably UE4 retargets) have a rig 'bind'
      // pose that differs from the visually-expected A-pose at the animation start.
      // Using frame 0 as the reference means "FBX frame 0 → VRM T-pose", and subsequent
      // frames are deltas from there. For Mixamo this is ~identical to using the bind
      // pose (frame 0 of idle ≈ T-pose ≈ bind), so no regression.
      const fbxRefWQ:    Record<string, THREE.Quaternion> = {}
      const fbxRefWQInv: Record<string, THREE.Quaternion> = {}
      if (allTimes.length > 0) {
        const t0 = allTimes[0]
        const sortedBones = [...bonesInOrder]
        // bonesInOrder is already in parent-before-child order (sort by depth happens earlier)
        for (const mb of sortedBones) {
          let lq: THREE.Quaternion
          if (qInterp[mb]) {
            const r = qInterp[mb].evaluate(t0)
            lq = new THREE.Quaternion(r[0], r[1], r[2], r[3]).normalize()
          } else {
            lq = (fbxRestLocalQ[mb] ?? new THREE.Quaternion()).clone()
          }
          const fbxPN = fbxBoneParent[mb]
          const parentWQ = fbxPN ? fbxRefWQ[fbxPN] : IDQ
          const wq = parentWQ.clone().multiply(lq)
          fbxRefWQ[mb] = wq
          fbxRefWQInv[mb] = wq.clone().invert()
        }
      } else {
        for (const mb of bonesInOrder) {
          fbxRefWQ[mb] = fbxBindWQ[mb]!.clone()
          fbxRefWQInv[mb] = fbxBindWQInv[mb]!.clone()
        }
      }

      // Log frame-0 track Q vs loadTimeQ for arm bones
      for (const mb of ['upperarm_l', 'upperarm_r']) {
        const lq = fbxRestLocalQ[mb]
        const interp = qInterp[mb]
        if (lq && interp && allTimes.length > 0) {
          const r = interp.evaluate(allTimes[0])
          const tq = new THREE.Quaternion(r[0], r[1], r[2], r[3]).normalize()
          console.log(`[frame0] ${mb} loadTimeQ=(${lq.x.toFixed(3)},${lq.y.toFixed(3)},${lq.z.toFixed(3)},${lq.w.toFixed(3)}) trackQ[0]=(${tq.x.toFixed(3)},${tq.y.toFixed(3)},${tq.z.toFixed(3)},${tq.w.toFixed(3)})`)
        }
      }

      for (let ti = 0; ti < allTimes.length; ti++) {
        const t = allTimes[ti]
        for (const mb of bonesInOrder) {
          const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName
          if (qInterp[mb]) {
            const r = qInterp[mb].evaluate(t)
            _q.set(r[0], r[1], r[2], r[3]).normalize()
          } else {
            _q.copy(IDQ)
          }
          const fbxPN = fbxBoneParent[mb]
          const parentFBXWQ = fbxPN ? curFBXWQ[fbxPN] : fbxCoordFix
          curFBXWQ[mb].copy(parentFBXWQ).multiply(_q)
          _delta.copy(curFBXWQ[mb]).multiply(fbxBindWQInv[mb]!).multiply(vrmAposeWQ[vn] ?? vrmBindWQ[vn]!)
          if ((ti === 0 || ti === allTimes.length - 1 || ti === allTimes.length - 2) && (mb === 'upperarm_l' || mb === 'upperarm_r')) {
            const fwq2 = curFBXWQ[mb]; const bwq2 = fbxBindWQ[mb]!
            console.log(`[ph4 ti=${ti}/${allTimes.length-1} t=${t.toFixed(3)}] ${mb} curFBXWQ=(${fwq2.x.toFixed(3)},${fwq2.y.toFixed(3)},${fwq2.z.toFixed(3)},${fwq2.w.toFixed(3)}) bind=(${bwq2.x.toFixed(3)},${bwq2.y.toFixed(3)},${bwq2.z.toFixed(3)},${bwq2.w.toFixed(3)})`)
          }
          if (ti === 0 && (mb === 'upperarm_l' || mb === 'upperarm_r')) {
            const fwq = curFBXWQ[mb]; const bwq = fbxBindWQ[mb]!
            // angle of delta (how much frame0 rotated from bind)
            const dAngle = 2 * Math.acos(Math.min(1, Math.abs(_delta.w))) * 180 / Math.PI
            // angle of bind (how rotated bind itself is from identity)
            const bAngle = 2 * Math.acos(Math.min(1, Math.abs(bwq.w))) * 180 / Math.PI
            console.log(`[ph4 ti=0] ${mb} bind=(${bwq.x.toFixed(3)},${bwq.y.toFixed(3)},${bwq.z.toFixed(3)},${bwq.w.toFixed(3)})[${bAngle.toFixed(1)}°] frame0=(${fwq.x.toFixed(3)},${fwq.y.toFixed(3)},${fwq.z.toFixed(3)},${fwq.w.toFixed(3)}) delta[${dAngle.toFixed(1)}°]`)
          }
          curVRMWQ[vn]!.copy(_delta)
          const vrmPN = vrmBoneParent[vn]
          const parentVRMWQ = vrmPN ? curVRMWQ[vrmPN] : IDQ
          _inv.copy(parentVRMWQ ?? IDQ).invert()
          _q.copy(_inv).multiply(_delta)
          const base = ti * 4, arr = outQVals[vn]!
          arr[base] = _q.x; arr[base+1] = _q.y; arr[base+2] = _q.z; arr[base+3] = _q.w
        }
      }

      // --- Phase 5: Build VRM tracks ---
      const vrmTracks: THREE.KeyframeTrack[] = []
      const newCorrAxes: THREE.Object3D[] = []
      const _v = new THREE.Vector3()

      for (const mb of bonesInOrder) {
        const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName
        const bone = vrmBoneObj[vn]; if (!bone) continue
        vrmTracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, allTimes, outQVals[vn]!))
      }

      // Hips position
      if (hipsPosTrack && fbxHipsNode) {
        const fbxRestPos = (fbxHipsNode as THREE.Object3D).position.clone()
        const vrmHipsBone = vrmBoneObj['hips']
        const vrmRestPos  = vrmHipsBone ? vrmHipsBone.position.clone() : new THREE.Vector3()
        const values = new Float32Array(hipsPosTrack.values.length)
        for (let i = 0; i < hipsPosTrack.values.length; i += 3) {
          _v.set(hipsPosTrack.values[i], hipsPosTrack.values[i+1], hipsPosTrack.values[i+2])
          // Delta from FBX rest, in FBX coordinate frame
          _v.sub(fbxRestPos)
          // Map FBX coord frame → VRM coord frame (e.g. Z-up → Y-up)
          _v.applyQuaternion(fbxCoordFix)
          _v.multiplyScalar(0.01).add(vrmRestPos)
          values[i] = _v.x; values[i+1] = _v.y; values[i+2] = _v.z
        }
        vrmTracks.push(new THREE.VectorKeyframeTrack(
          `${vrmHipsBone!.name}.position`, Array.from(hipsPosTrack.times), values
        ))
      }

      corrAxesRef.current = newCorrAxes

      // FBX display mixer — clipAction() captures node.quaternion as the PropertyMixer
      // origValue (what REST restores to). We create it here, after retargeting baked,
      // so play/update never runs during Phase 1.
      const fbxMixer = new THREE.AnimationMixer(fbx)
      fbxMixerRef.current = fbxMixer
      const fbxAction = fbxMixer.clipAction(clip)
      fbxAction.reset().play()

      // Clamp duration. If the last keyframe value duplicates the first (a "closed loop"
      // where t=0 and t=lastKey hold the same pose), shorten to the second-to-last keyframe
      // so the loop wraps cleanly without a single-frame discontinuity at the boundary.
      let lastKeyTime = allTimes.length > 0 ? allTimes[allTimes.length - 1] : clip.duration
      const lastIdx = allTimes.length - 1
      if (lastIdx >= 1) {
        // Compare first and last baked quaternion for a representative bone (hips)
        const hipsVn = FBX_BONE_TO_VRM[VRM_TO_FBX.hips ?? ''] as VRMHumanBoneName | undefined
        const arr = hipsVn ? outQVals[hipsVn] : undefined
        if (arr) {
          const dx = arr[0] - arr[lastIdx*4]
          const dy = arr[1] - arr[lastIdx*4+1]
          const dz = arr[2] - arr[lastIdx*4+2]
          const dw = arr[3] - arr[lastIdx*4+3]
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz + dw*dw)
          if (dist < 1e-3) {
            lastKeyTime = allTimes[lastIdx - 1]
            console.log(`[clipDur] first==last detected (dist=${dist.toExponential(2)}), trimming duration to ${lastKeyTime.toFixed(3)}`)
          }
        }
      }
      const vrmDuration = Math.min(clip.duration, lastKeyTime)
      // Diagnostics: per-track time ranges to spot mismatches
      let minStart = Infinity, maxEnd = -Infinity
      const trackTails: string[] = []
      for (const t of clip.tracks) {
        const ts = t.times
        if (ts.length < 2) continue
        if (ts[0] < minStart) minStart = ts[0]
        if (ts[ts.length - 1] > maxEnd) maxEnd = ts[ts.length - 1]
        // Flag tracks whose end deviates from the consensus
        if (Math.abs(ts[ts.length - 1] - lastKeyTime) > 0.001) {
          trackTails.push(`${t.name}@[${ts[0].toFixed(3)}…${ts[ts.length-1].toFixed(3)},n=${ts.length}]`)
        }
      }
      console.log(`[clipDur] orig=${clip.duration.toFixed(3)} consensusEnd=${lastKeyTime.toFixed(3)} actualSpan=[${minStart.toFixed(3)}…${maxEnd.toFixed(3)}] outliers:`, trackTails.slice(0, 10))
      const vrmClip  = new THREE.AnimationClip(clip.name, vrmDuration, vrmTracks)
      const vrmMixer = new THREE.AnimationMixer(vrm.scene)
      vrmMixerRef.current = vrmMixer
      const vrmAction = vrmMixer.clipAction(vrmClip)
      vrmAction.reset().play()
      vrmAction.time = animOffset % vrmDuration
      fbxAction.time = animOffset % clip.duration
      vrmAction.timeScale = animSpeed
      fbxAction.timeScale = animSpeed

      animRegistry.set(node.id, {
        action: vrmAction, mixer: vrmMixer,
        fbxAction, fbxMixer, fbxScene: fbx,
        duration: clip.duration,
      })
    })

    return () => {
      cancelled = true
      fbxMixerRef.current?.stopAllAction()
      fbxMixerRef.current = null
      vrmMixerRef.current?.stopAllAction()
      vrmMixerRef.current = null
      corrAxesRef.current.forEach(g => g.removeFromParent())
      corrAxesRef.current = []
      fbxGroupRef.current?.clear()
      fbxHelperRef.current?.clear()
      animRegistry.delete(node.id)
    }
  }, [node.filePath, animUrl, vrmLoaded])

  useEffect(() => {
    const entry = animRegistry.get(node.id)
    if (!entry) return
    entry.action.timeScale = animSpeed
    entry.fbxAction.timeScale = animSpeed
  }, [animSpeed, node.id])

  const _boneStartWP   = useRef(new THREE.Vector3())
  const _boneEndWP     = useRef(new THREE.Vector3())
  const _boneDir       = useRef(new THREE.Vector3())
  const _Y             = new THREE.Vector3(0, 1, 0)
  const _shoulderWorld = useRef(new THREE.Vector3())
  const _wristWorld    = useRef(new THREE.Vector3())
  const _correctedWrist = useRef(new THREE.Vector3())
  const _q             = useRef(new THREE.Quaternion()).current

  useFrame((_, delta) => {
    const vrm = vrmRef.current
    const cyl = boneCylRef.current
    if (cyl) {
      const hoveredBone = useEditorStore.getState().hoveredBoneName as VRMHumanBoneName | null
      const retarget = vmcRetargetRef.current
      const startObj = hoveredBone && retarget ? retarget.vrmBoneObj[hoveredBone] : null
      const childBone = hoveredBone && retarget
        ? (Object.entries(retarget.vrmBoneParent) as [VRMHumanBoneName, VRMHumanBoneName][])
            .find(([, parent]) => parent === hoveredBone)?.[0]
        : null
      const endObj = childBone && retarget ? retarget.vrmBoneObj[childBone] : null

      if (startObj && endObj && groupRef.current) {
        startObj.getWorldPosition(_boneStartWP.current)
        endObj.getWorldPosition(_boneEndWP.current)
        groupRef.current.worldToLocal(_boneStartWP.current)
        groupRef.current.worldToLocal(_boneEndWP.current)
        _boneDir.current.subVectors(_boneEndWP.current, _boneStartWP.current)
        const length = _boneDir.current.length()
        cyl.position.addVectors(_boneStartWP.current, _boneEndWP.current).multiplyScalar(0.5)
        cyl.scale.set(1, length, 1)
        cyl.quaternion.setFromUnitVectors(_Y, _boneDir.current.normalize())
        cyl.visible = true
      } else {
        cyl.visible = false
      }
    }

    const vc = vmcCompRef.current
    const cfg = vc?.config as Record<string, unknown> | undefined
    const poseTimeoutMs = ((cfg?.poseTimeout as number | undefined) ?? 2) * 1000
    const lastPoseTime  = vc ? getVmcPoseTime(node.id) : null
    const pose          = vc ? getVmcPose(node.id) : null
    const trackingLost  = vc ? useEditorStore.getState().vmcTracking[vc.id] === false : false
    const poseBlendMode = vc ? getVmcPoseBlendMode(node.id) : 'override'
    // In additive mode the merged broadcast pose is meant to let the animation
    // clip show through (e.g. on tracking loss the bus publishes identity-ish
    // values with mode=additive). We treat this as "broadcast contributes
    // nothing on top of the animation" — the simplest interpretation that
    // matches the "animation shows through again" intent.
    const poseActive    = poseBlendMode === 'override'
                          && !trackingLost
                          && pose != null
                          && lastPoseTime != null
                          && (Date.now() - lastPoseTime) < poseTimeoutMs

    // Transition detection: reset filters when VMC goes inactive.
    if (!poseActive && poseWasActiveRef.current) {
      boneFiltersRef.current.reset()
      vrm?.humanoid.resetNormalizedPose()
    }
    poseWasActiveRef.current = poseActive

    // Ramp blend weight: 0 = pure animation, 1 = pure VMC.
    const blendTime = Math.max(0, (cfg?.blendTime as number | undefined) ?? 0.3)
    const BLEND_SPEED = blendTime > 0 ? 1 / blendTime : Infinity
    const targetWeight = poseActive ? 1 : 0
    const w = blendWeightRef.current
    blendWeightRef.current = w === targetWeight ? w
      : Math.max(0, Math.min(1, w + Math.sign(targetWeight - w) * BLEND_SPEED * delta))
    const blend = blendWeightRef.current

    // ── Step 1: animation (always runs, gives us the "animation raw pose") ──────
    fbxMixerRef.current?.update(delta)
    if (vrm) {
      ;(vrm.humanoid as unknown as { update?: () => void }).update?.()
      vrmMixerRef.current?.update(delta)
    }

    // ── Step 2: VMC blend (skipped entirely when blend === 0) ───────────────────
    if (blend > 0 && pose && vrm) {
      // Build filtered VMC normalized pose.
      const normalizedPose: VRMPose = {}
      const filters = boneFiltersRef.current
      for (const [boneName, q] of Object.entries(pose)) {
        _q.set(q[0], q[1], q[2], q[3])
        const s = filters.filter(boneName, _q, delta)
        normalizedPose[boneName as VRMHumanBoneName] = { rotation: [s.x, s.y, s.z, s.w] }
      }

      // Arm position calibration (client-side, requires world positions).
      const calib = (cfg?.calibration ?? DEFAULT_CALIBRATION) as VmcCalibration
      for (const side of ['left', 'right'] as const) {
        const armCalib = calib[side]
        if (armCalib.scale === 1 && armCalib.offset[0] === 0 && armCalib.offset[1] === 0 && armCalib.offset[2] === 0) continue
        const upperArmName = (side === 'left' ? 'leftUpperArm' : 'rightUpperArm') as VRMHumanBoneName
        const handName     = (side === 'left' ? 'leftHand'     : 'rightHand')     as VRMHumanBoneName
        const upperArmBone = vrm.humanoid.getRawBoneNode(upperArmName)
        const handBone     = vrm.humanoid.getRawBoneNode(handName)
        if (!upperArmBone || !handBone) continue
        upperArmBone.getWorldPosition(_shoulderWorld.current)
        handBone.getWorldPosition(_wristWorld.current)
        applyArmCalib(_wristWorld.current, _shoulderWorld.current, armCalib, _correctedWrist.current)
        const rot = upperArmNormRotFromTarget(_correctedWrist.current, upperArmBone, side === 'right')
        normalizedPose[upperArmName] = { rotation: [rot.x, rot.y, rot.z, rot.w] }
      }

      if (blend >= 1) {
        // Pure VMC — skip the per-bone slerp.
        vrm.humanoid.setNormalizedPose(normalizedPose)
        ;(vrm.humanoid as unknown as { update?: () => void }).update?.()
      } else {
        // Blend — save animation raw quaternions, apply VMC, slerp back by (1-blend).
        const allBones = VRM_BONE_NAMES as unknown as VRMHumanBoneName[]
        const animQuats: Array<[THREE.Object3D, THREE.Quaternion]> = []
        for (const name of allBones) {
          const bone = vrm.humanoid.getRawBoneNode(name)
          if (bone) animQuats.push([bone, bone.quaternion.clone()])
        }
        vrm.humanoid.setNormalizedPose(normalizedPose)
        ;(vrm.humanoid as unknown as { update?: () => void }).update?.()
        for (const [bone, animQ] of animQuats) {
          bone.quaternion.slerp(animQ, 1 - blend)
        }
      }

    }

    // ── Step 3: remaining VRM subsystems on the final blended pose ───────────────
    if (vrm) {
      const v = vrm as unknown as Record<string, { update: (d?: number) => void } | undefined>



      // Pre-expressionManager.update() pass: drive expression preset names via setValue.
      // Runs whenever a blendshape-driving component is active (lipsync, face tracking, VMC).
      // Morph-target names (Fcl_*, etc.) are deferred to after update() so they
      // aren't overwritten when expressionManager applies its tracked clip values.
      const bsActive = lipsyncCompRef.current != null || vmcCompRef.current != null
      const bs = bsActive ? getVmcBlendshapes(node.id) : null
      if (bs && vrm.expressionManager) {
        const morphMap = morphMapRef.current
        for (const [name, value] of Object.entries(bs)) {
          if (!morphMap.has(name)) vrm.expressionManager.setValue(name, value)
        }
      }

      // ── Step 2.5: IK solve ──────────────────────────────────────────────────
      // Only when the component opts into IK. Otherwise arms are driven by pose_arms_to_bones quaternions.
      const useIk = (vmcCompRef.current?.config as { useIk?: boolean } | undefined)?.useIk === true
      if (vmcCompRef.current?.kind === 'mediapipe_tracker' && useIk) {
        const ikFrame = getIkTargets(node.id)
        const ikTime  = getIkTargetsTime(node.id)
        const IK_TIMEOUT_MS = 2000
        if (ikFrame && ikTime && (Date.now() - ikTime) < IK_TIMEOUT_MS) {
          // Resolve the reference bone world position
          const refBoneNode = vrm.humanoid.getRawBoneNode(ikFrame.referenceBone as VRMHumanBoneName)
          if (refBoneNode) {
            const refWorldPos = new THREE.Vector3()
            refBoneNode.getWorldPosition(refWorldPos)
            // Avatar's facing rotation: applies to chest-relative offsets so MP "subject front" maps
            // to avatar's front regardless of scene-level rotations on the VRM.
            const avatarOrient = new THREE.Quaternion()
            refBoneNode.getWorldQuaternion(avatarOrient)

            // Uniform scale: fit source shoulder width to target rig's shoulder width.
            // Both upper-arm bones' world positions are the avatar's shoulder joints.
            let scale = 1
            const lUA = vrm.humanoid.getRawBoneNode('leftUpperArm' as VRMHumanBoneName)
            const rUA = vrm.humanoid.getRawBoneNode('rightUpperArm' as VRMHumanBoneName)
            const avatarLeftShoulderChestRel  = new THREE.Vector3()
            const avatarRightShoulderChestRel = new THREE.Vector3()
            // Avatar shoulder offsets, expressed in the chest's LOCAL frame (so we can compare
            // them to source positions which are in the source subject's local chest frame).
            const avatarOrientInv = avatarOrient.clone().invert()
            if (lUA && rUA) {
              const lp = new THREE.Vector3(); lUA.getWorldPosition(lp)
              const rp = new THREE.Vector3(); rUA.getWorldPosition(rp)
              avatarLeftShoulderChestRel.copy(lp).sub(refWorldPos).applyQuaternion(avatarOrientInv)
              avatarRightShoulderChestRel.copy(rp).sub(refWorldPos).applyQuaternion(avatarOrientInv)
              if (ikFrame.sourceShoulderWidth && ikFrame.sourceShoulderWidth > 1e-4) {
                const avatarShoulderWidth = lp.distanceTo(rp)
                if (avatarShoulderWidth > 1e-4) scale = avatarShoulderWidth / ikFrame.sourceShoulderWidth
              }
            }

            // Per-side correction: align source shoulder (scaled) with avatar shoulder,
            // both expressed relative to the chest reference. This re-anchors arm motion
            // to the avatar's actual shoulder while keeping chest as the global frame origin.
            const leftCorrection  = new THREE.Vector3()
            const rightCorrection = new THREE.Vector3()
            if (ikFrame.sourceLeftShoulder && lUA) {
              leftCorrection.set(
                avatarLeftShoulderChestRel.x  - ikFrame.sourceLeftShoulder[0]  * scale,
                avatarLeftShoulderChestRel.y  - ikFrame.sourceLeftShoulder[1]  * scale,
                avatarLeftShoulderChestRel.z  - ikFrame.sourceLeftShoulder[2]  * scale,
              )
            }
            if (ikFrame.sourceRightShoulder && rUA) {
              rightCorrection.set(
                avatarRightShoulderChestRel.x - ikFrame.sourceRightShoulder[0] * scale,
                avatarRightShoulderChestRel.y - ikFrame.sourceRightShoulder[1] * scale,
                avatarRightShoulderChestRel.z - ikFrame.sourceRightShoulder[2] * scale,
              )
            }

            for (const target of ikFrame.targets) {
              if (!target.position || target.confidence < 0.4) continue
              if (target.chain.length < 2) continue

              // Pick the side-specific correction. Fingers + arms on the left side use leftCorrection.
              const isLeft  = target.bone.startsWith('left')
              const correction = isLeft ? leftCorrection : rightCorrection

              // Build target in chest-local space (correction is already in chest-local).
              const targetLocal = new THREE.Vector3(
                target.position[0] * scale + correction.x,
                target.position[1] * scale + correction.y,
                target.position[2] * scale + correction.z,
              )
              // Rotate from chest-local to world by the chest's world orientation, then add chest world position.
              const targetWorld = targetLocal.clone().applyQuaternion(avatarOrient).add(refWorldPos)

              if (target.chain.length === 2) {
                // Two-bone analytical IK: chain[0]=upper, chain[1]=lower (end-effector = bone)
                _solveTwoBoneIk(vrm, target.chain[0] as VRMHumanBoneName, target.chain[1] as VRMHumanBoneName, targetWorld)
              } else if (target.chain.length === 3) {
                // Three-bone: solve upper+lower to reach the wrist, then leave hand orientation
                _solveTwoBoneIk(vrm, target.chain[0] as VRMHumanBoneName, target.chain[1] as VRMHumanBoneName, targetWorld)
              }
              // Longer chains (fingers) are not IK-solved here — handled by quaternion mapper
            }
          }
        }
      }

      v['lookAt']?.update(delta)
      v['expressionManager']?.update()

      // Post-expressionManager.update() pass: write morph targets directly.
      // expressionManager.update() has already run, so these won't be overwritten.
      if (bsActive) {
        const bs2 = getVmcBlendshapes(node.id)
        if (bs2) {
          const morphMap = morphMapRef.current
          for (const [name, value] of Object.entries(bs2)) {
            const targets = morphMap.get(name)
            if (targets) {
              for (const { mesh, index } of targets) {
                if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = value
              }
            }
          }
        }
      }

      v['nodeConstraintManager']?.update(delta)
      vrm.springBoneManager?.update(delta)
      vrm.materials?.forEach((m) => (m as unknown as { update?: (d: number) => void }).update?.(delta))
    }
  })

  // vrmHelperRef is intentionally outside outerRef: SkeletonHelper uses
  // this.parent.matrixWorld as its reference frame, so placing it inside
  // outerRef would apply the node transform twice (once to the bones, once
  // to the helper geometry). At scene root it cancels correctly.
  return (
    <>
      <group ref={outerRef} position={[t.x, t.y, t.z]} rotation={[t.rx, t.ry, t.rz]} scale={[t.sx, t.sy, t.sz]}>
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
  )
}

// ── Light icon geometry (pre-computed, never changes) ──────────────────────────

const _SEGS = 32
const _POINT_R = 0.09
// Circle points (closed loop)
const POINT_CIRCLE_PTS = Array.from({ length: _SEGS + 1 }, (_, i) => {
  const a = (i / _SEGS) * Math.PI * 2
  return [Math.cos(a) * _POINT_R, Math.sin(a) * _POINT_R, 0] as [number, number, number]
})
// 6 spokes radiating outward
const POINT_SPOKES = Array.from({ length: 6 }, (_, i) => {
  const a = (i / 6) * Math.PI * 2
  return [
    [Math.cos(a) * (_POINT_R + 0.04), Math.sin(a) * (_POINT_R + 0.04), 0] as [number, number, number],
    [Math.cos(a) * (_POINT_R + 0.11), Math.sin(a) * (_POINT_R + 0.11), 0] as [number, number, number],
  ] as const
})

const _DIR_R = 0.09
const _DIR_LEN = 0.28
// Directional: circle in XY plane
const DIR_CIRCLE_PTS = Array.from({ length: _SEGS + 1 }, (_, i) => {
  const a = (i / _SEGS) * Math.PI * 2
  return [Math.cos(a) * _DIR_R, Math.sin(a) * _DIR_R, 0] as [number, number, number]
})
// 8 rays from circle perimeter along -Z (light direction)
const DIR_RAYS = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2
  const x = Math.cos(a) * _DIR_R, y = Math.sin(a) * _DIR_R
  return [
    [x, y, 0] as [number, number, number],
    [x, y, -_DIR_LEN] as [number, number, number],
  ] as const
})

function LightNode({ node, viewerMode }: { node: NodeRecord; viewerMode?: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  const t = getTransform(node)
  const lc = node.components?.light as { lightType?: string; color?: string; intensity?: number } | undefined
  const lightType = lc?.lightType ?? 'point'
  const color = lc?.color ?? '#ffffff'
  const intensity = lc?.intensity ?? 1
  const iconColor = '#ffaa22'

  useEffect(() => {
    if (groupRef.current) nodeGroupRegistry.set(node.id, groupRef.current)
    return () => { nodeGroupRegistry.delete(node.id) }
  }, [node.id])

  return (
    <group ref={groupRef} position={[t.x, t.y, t.z]} rotation={[t.rx, t.ry, t.rz]}>
      {lightType === 'point'       && <pointLight       color={color} intensity={intensity} />}
      {lightType === 'directional' && <directionalLight color={color} intensity={intensity} />}
      {lightType === 'ambient'     && <ambientLight     color={color} intensity={intensity} />}
      {lightType === 'spot'        && <spotLight        color={color} intensity={intensity} />}

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
  )
}

function CameraNode({ node }: { node: NodeRecord }) {
  const { selectedNodeId } = useEditorStore()
  const isSelected = selectedNodeId === node.id
  const groupRef = useRef<THREE.Group>(null)
  const t = getTransform(node)
  const cc = node.components?.camera as { fov?: number; near?: number; far?: number } | undefined

  useEffect(() => {
    if (groupRef.current) nodeGroupRegistry.set(node.id, groupRef.current)
    return () => { nodeGroupRegistry.delete(node.id) }
  }, [node.id])

  const near   = cc?.near ?? 0.1
  const far    = cc?.far  ?? 100
  const fov    = cc?.fov  ?? 50
  const aspect = 16 / 9
  const tanHalf = Math.tan((fov / 2) * Math.PI / 180)
  const halfH  = near * tanHalf
  const halfW  = halfH * aspect
  const farH   = far  * tanHalf
  const farW   = farH * aspect

  // Camera body — center is the true optical center at (0,0,0)
  const bW = 0.12, bH = 0.08, bD = 0.08
  const frontZ = -bD / 2  // z of the front face

  const bodyGeo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(bW, bH, bD)), [])
  useEffect(() => () => bodyGeo.dispose(), [bodyGeo])

  // Near-plane corners (in camera space, center at origin)
  // Camera faces -Z, so near plane is at z = -near
  const nCorners: [number, number, number][] = [
    [-halfW, -halfH, -near],
    [ halfW, -halfH, -near],
    [ halfW,  halfH, -near],
    [-halfW,  halfH, -near],
  ]

  // Where each ray from (0,0,0) → nCorner exits the front face (z = frontZ).
  // Parametric: pos = t * corner → z = -t*near = frontZ → t = (-frontZ)/near = bD/(2*near)
  // Only valid when near > bD/2 (near plane is outside the cube).
  const nearOutside = near > bD / 2
  const cutT = nearOutside ? (bD / 2) / near : 1
  const cutCorners: [number, number, number][] = nCorners.map(
    ([cx, cy]) => [cx * cutT, cy * cutT, frontZ],
  )

  const pyramidGeo = useMemo(() => {
    // 4 visible edges (cut surface → near corner) + near rect + optional cut rect
    const segs: number[] = []
    const push = (a: [number,number,number], b: [number,number,number]) =>
      segs.push(...a, ...b)

    for (let i = 0; i < 4; i++) {
      push(cutCorners[i], nCorners[i])                  // side edge
      push(nCorners[i], nCorners[(i + 1) % 4])          // near-plane perimeter
      if (nearOutside) push(cutCorners[i], cutCorners[(i + 1) % 4])  // cut rect
    }

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3))
    return g
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [halfW, halfH, near, nearOutside, cutT])
  useEffect(() => () => pyramidGeo.dispose(), [pyramidGeo])

  // Far-plane corners — perspective-correct, same rays as near corners scaled to far distance
  const farCorners: [number, number, number][] = [
    [-farW, -farH, -far],
    [ farW, -farH, -far],
    [ farW,  farH, -far],
    [-farW,  farH, -far],
  ]

  const color = '#00d4d4'

  return (
    <group ref={groupRef} position={[t.x, t.y, t.z]} rotation={[t.rx, t.ry, t.rz]} scale={[t.sx, t.sy, t.sz]}>
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
            points={[[0, 0, frontZ], [0, 0, -far]]}
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
  )
}

interface BillboardConfig {
  facing: 'screen' | 'world'
  backface: 'none' | 'mirror' | 'unmirrored'
  width: number
  height: number
  alpha: number
  textureUrl: string | null
}

const BILLBOARD_DEFAULTS: BillboardConfig = {
  facing: 'screen',
  backface: 'none',
  width: 1,
  height: 1,
  alpha: 1,
  textureUrl: null,
}

function BillboardNode({ node }: { node: NodeRecord }) {
  const outerRef   = useRef<THREE.Group>(null)
  const billboardRef = useRef<THREE.Group>(null)
  const frontRef   = useRef<THREE.Mesh>(null)
  const backRef    = useRef<THREE.Mesh>(null)
  const t = getTransform(node)
  const bc: BillboardConfig = { ...BILLBOARD_DEFAULTS, ...((node.components?.billboard ?? {}) as Partial<BillboardConfig>) }

  // Load texture imperatively and mark materials needsUpdate when it arrives
  const textureRef = useRef<THREE.Texture | null>(null)
  useEffect(() => {
    if (!bc.textureUrl) {
      textureRef.current = null
      const applyNull = (m: THREE.Mesh | null) => {
        if (!m) return
        const mat = m.material as THREE.MeshBasicMaterial
        mat.map = null
        mat.needsUpdate = true
      }
      applyNull(frontRef.current)
      applyNull(backRef.current)
      return
    }
    let cancelled = false
    new THREE.TextureLoader().load(bc.textureUrl, (tex) => {
      if (cancelled) { tex.dispose(); return }
      tex.colorSpace = THREE.SRGBColorSpace
      textureRef.current = tex
      const applyTex = (m: THREE.Mesh | null, t: THREE.Texture) => {
        if (!m) return
        const mat = m.material as THREE.MeshBasicMaterial
        mat.map = t
        mat.needsUpdate = true
      }
      applyTex(frontRef.current, tex)
      if (bc.backface === 'mirror') {
        const mirror = tex.clone()
        mirror.repeat.set(-1, 1)
        mirror.offset.set(1, 0)
        mirror.needsUpdate = true
        applyTex(backRef.current, mirror)
      } else {
        applyTex(backRef.current, tex)
      }
    })
    return () => { cancelled = true }
  }, [bc.textureUrl, bc.backface]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (outerRef.current) nodeGroupRegistry.set(node.id, outerRef.current)
    return () => { nodeGroupRegistry.delete(node.id) }
  }, [node.id])

  // Copy camera quaternion onto the inner group each frame when in screen-facing mode,
  // or reset to identity when in world mode so the node's own rotation applies cleanly.
  useFrame(({ camera }) => {
    if (!billboardRef.current) return
    if (bc.facing === 'screen') {
      billboardRef.current.quaternion.copy(camera.quaternion)
    } else {
      billboardRef.current.quaternion.identity()
    }
  })

  const w = bc.width
  const h = bc.height

  const inner = (
    <group ref={billboardRef}>
      <mesh ref={frontRef}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={bc.alpha} side={THREE.FrontSide} depthWrite={false} />
      </mesh>
      {bc.backface !== 'none' && (
        <mesh ref={backRef} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={bc.alpha} side={THREE.FrontSide} depthWrite={false} />
        </mesh>
      )}
    </group>
  )

  return (
    <group ref={outerRef} position={[t.x, t.y, t.z]} rotation={[t.rx, t.ry, t.rz]} scale={[t.sx, t.sy, t.sz]}>
      {inner}
    </group>
  )
}

// Reusable scratch objects for InstancedMesh matrix composition
const _particlePos   = new THREE.Vector3()
const _particleQuat  = new THREE.Quaternion()
const _particleScale = new THREE.Vector3()
const _particleMat   = new THREE.Matrix4()
const _particleColor = new THREE.Color()

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
`

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
`

function makeInstancedParticleMaterial(
  texture: THREE.Texture | null,
  blending: THREE.Blending,
  depthWrite: boolean,
  depthTest: boolean,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: PARTICLE_INST_VERT,
    fragmentShader: PARTICLE_INST_FRAG,
    uniforms: {
      uTex:    { value: texture ?? new THREE.Texture() },
      uHasTex: { value: texture ? 1.0 : 0.0 },
    },
    blending,
    depthWrite,
    depthTest,
    transparent: true,
  })
}

function ParticleNode({ node }: { node: NodeRecord }) {
  const outerRef = useRef<THREE.Group>(null)
  // InstancedMesh for local-space; a scene-root InstancedMesh for world-space
  const localMeshRef  = useRef<THREE.InstancedMesh>(null)
  const worldMeshRef  = useRef<THREE.InstancedMesh | null>(null)
  const t = getTransform(node)
  const pc = mergeParticleConfig((node.components?.particle ?? {}) as Record<string, unknown>)
  const isWorld = pc.simulationSpace === 'world'

  const pool = useRef<ParticlePool | null>(null)
  const { scene } = useThree()

  const blendingMap: Record<string, THREE.Blending> = {
    normal: THREE.NormalBlending,
    additive: THREE.AdditiveBlending,
    multiply: THREE.MultiplyBlending,
  }
  const blending = blendingMap[pc.blendMode] ?? THREE.AdditiveBlending

  // (Re-)allocate pool when maxCount changes, preserving playing state
  useEffect(() => {
    const wasPlaying = pool.current?.playing ?? pc.playOnStart
    const p = createParticlePool(pc.maxCount)
    p.playing = wasPlaying
    pool.current = p
  }, [pc.maxCount]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pool.current && pc.playOnStart && !pool.current.playing) {
      pool.current.playing = true
      pool.current.burstFired = false
    }
  }, [pc.playOnStart])

  useEffect(() => {
    if (outerRef.current) nodeGroupRegistry.set(node.id, outerRef.current)
    return () => { nodeGroupRegistry.delete(node.id) }
  }, [node.id])

  // Texture loading
  const [texture, setTexture] = useState<THREE.Texture | null>(null)
  useEffect(() => {
    if (!pc.textureUrl) { setTexture(null); return }
    let cancelled = false
    new THREE.TextureLoader().load(pc.textureUrl, (tex) => { if (!cancelled) { tex.colorSpace = THREE.SRGBColorSpace; setTexture(tex) } })
    return () => { cancelled = true }
  }, [pc.textureUrl])

  // Creates/replaces the InstancedMesh for the given space mode.
  // aAlpha is a per-instance float attribute on the PlaneGeometry — instanced attributes
  // are supported in WebGL2 (Three.js r152+) via InstancedBufferAttribute on the geometry.
  const buildMesh = (count: number): THREE.InstancedMesh => {
    const geo = new THREE.PlaneGeometry(1, 1)
    const alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(0), 1)
    alphaAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aAlpha', alphaAttr)
    const mat = makeInstancedParticleMaterial(texture, blending, pc.depthWrite, pc.depthTest)
    const mesh = new THREE.InstancedMesh(geo, mat, count)
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // instanceColor provides per-instance RGB read by the vertex shader as `instanceColor`
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3)
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    // Hide all instances initially
    _particleMat.makeScale(0, 0, 0)
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _particleMat)
    mesh.instanceMatrix.needsUpdate = true
    return mesh
  }

  // World-space InstancedMesh lives at scene root
  useEffect(() => {
    if (!isWorld) return
    const mesh = buildMesh(pc.maxCount)
    worldMeshRef.current = mesh
    scene.add(mesh)
    return () => {
      scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.ShaderMaterial).dispose()
      worldMeshRef.current = null
    }
  }, [isWorld, pc.maxCount, scene]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep world-space shader uniforms in sync every render
  useEffect(() => {
    const mesh = worldMeshRef.current
    if (!mesh) return
    const mat = mesh.material as THREE.ShaderMaterial
    mat.uniforms.uTex.value    = texture ?? new THREE.Texture()
    mat.uniforms.uHasTex.value = texture ? 1.0 : 0.0
    mat.blending   = blending
    mat.depthWrite = pc.depthWrite
    mat.depthTest  = pc.depthTest
    mat.needsUpdate = true
  })

  const geoCountRef = useRef<number>(-1)
  const emitterWorld = useRef(new THREE.Vector3())

  useFrame(({ camera }, delta) => {
    if (!pool.current || !outerRef.current) return

    // First frame after local-space mount: initialize instanceColor and shader on the R3F mesh
    if (!isWorld && localMeshRef.current && geoCountRef.current !== pc.maxCount) {
      const mat = localMeshRef.current.material as THREE.ShaderMaterial
      mat.uniforms.uTex.value    = texture ?? new THREE.Texture()
      mat.uniforms.uHasTex.value = texture ? 1.0 : 0.0
      if (!localMeshRef.current.instanceColor) {
        localMeshRef.current.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(pc.maxCount * 3).fill(1), 3,
        )
        localMeshRef.current.instanceColor.setUsage(THREE.DynamicDrawUsage)
      }
      geoCountRef.current = pc.maxCount
    }

    outerRef.current.getWorldPosition(emitterWorld.current)
    tickParticles(pool.current, pc, delta, emitterWorld.current, node.hidden)
    const p = pool.current

    const mesh = isWorld ? worldMeshRef.current : localMeshRef.current
    if (!mesh) return

    const alphaAttr = mesh.geometry.attributes.aAlpha as THREE.InstancedBufferAttribute | undefined
    const camQuat = camera.getWorldQuaternion(_particleQuat)

    // Camera right/up in world space — used for velocity-aligned rotation
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camQuat)
    const camUp    = new THREE.Vector3(0, 1, 0).applyQuaternion(camQuat)

    const invWorld = _particleMat.copy(outerRef.current.matrixWorld).invert()
    const yRatio = pc.sizeX > 0 ? pc.sizeY / pc.sizeX : 1
    const _rot = new THREE.Quaternion()
    const _axis = new THREE.Vector3(0, 0, 1)
    const velocityMode = pc.rotationMode === 'velocity'

    for (let i = 0; i < p.maxCount; i++) {
      if (!p.active[i]) {
        mesh.setMatrixAt(i, _particleMat.makeScale(0, 0, 0))
        mesh.setColorAt(i, _particleColor.setRGB(0, 0, 0))
        if (alphaAttr) (alphaAttr.array as Float32Array)[i] = 0
        continue
      }
      const b = i * 3
      _particlePos.set(p.positions[b], p.positions[b+1], p.positions[b+2])
      if (!isWorld) _particlePos.applyMatrix4(invWorld)

      _particleScale.set(p.sizes[i], p.sizes[i] * yRatio, 1)

      let zAngle: number
      if (velocityMode) {
        // Project velocity onto the camera plane to get screen-space direction,
        // then atan2 gives the rotation angle that aligns the particle's +Y with its velocity.
        const vx = p.velocities[b], vy = p.velocities[b+1], vz = p.velocities[b+2]
        const screenX = vx * camRight.x + vy * camRight.y + vz * camRight.z
        const screenY = vx * camUp.x    + vy * camUp.y    + vz * camUp.z
        zAngle = Math.atan2(-screenX, screenY)  // align particle +Y with screen-space velocity
      } else {
        zAngle = p.rotations[i]
      }

      _rot.setFromAxisAngle(_axis, zAngle)
      mesh.setMatrixAt(i, _particleMat.compose(
        _particlePos,
        camQuat.clone().multiply(_rot),
        _particleScale,
      ))

      mesh.setColorAt(i, _particleColor.setRGB(p.colors[b], p.colors[b+1], p.colors[b+2]))
      if (alphaAttr) (alphaAttr.array as Float32Array)[i] = p.alphas[i]
    }

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    if (alphaAttr) alphaAttr.needsUpdate = true
  })

  return (
    <group ref={outerRef} position={[t.x, t.y, t.z]} rotation={[t.rx, t.ry, t.rz]} scale={[t.sx, t.sy, t.sz]}>
      {!isWorld && (() => {
        // Build the local-space geometry with the aAlpha instanced attribute already attached
        const geo = useMemo(() => {
          const g = new THREE.PlaneGeometry(1, 1)
          const a = new THREE.InstancedBufferAttribute(new Float32Array(pc.maxCount).fill(0), 1)
          a.setUsage(THREE.DynamicDrawUsage)
          g.setAttribute('aAlpha', a)
          return g
        }, [pc.maxCount]) // eslint-disable-line react-hooks/exhaustive-deps
        return (
          <instancedMesh ref={localMeshRef} args={[geo, undefined, pc.maxCount]} frustumCulled={false}>
            <shaderMaterial
              vertexShader={PARTICLE_INST_VERT}
              fragmentShader={PARTICLE_INST_FRAG}
              uniforms={{ uTex: { value: texture ?? new THREE.Texture() }, uHasTex: { value: texture ? 1.0 : 0.0 } }}
              blending={blending}
              depthWrite={pc.depthWrite}
              depthTest={pc.depthTest}
              transparent
            />
          </instancedMesh>
        )
      })()}
    </group>
  )
}

function GodrayCasterNode({ node }: { node: NodeRecord }) {
  const outerRef = useRef<THREE.Group>(null)
  const meshRef = useRef<THREE.Mesh>(null)
  const t = getTransform(node)
  const color = (node.components.godray as any)?.color ?? '#ffffff'
  const scale = (node.components.godray as any)?.scale ?? 0.3

  useEffect(() => {
    if (outerRef.current) nodeGroupRegistry.set(node.id, outerRef.current)
    return () => { nodeGroupRegistry.delete(node.id) }
  }, [node.id])

  useEffect(() => {
    if (meshRef.current) godrayCasterRegistry.set(node.id, meshRef.current)
    return () => { godrayCasterRegistry.delete(node.id) }
  }, [node.id])

  return (
    <group ref={outerRef} position={[t.x, t.y, t.z]} rotation={[t.rx, t.ry, t.rz]} scale={[t.sx, t.sy, t.sz]}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[scale, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  )
}

function ModelNode({ node, children }: { node: NodeRecord; children?: React.ReactNode }) {
  const outerRef = useRef<THREE.Group>(null)
  const innerRef = useRef<THREE.Group>(null)
  const t = getTransform(node)
  const ext = node.filePath?.split('.').pop()?.toLowerCase()
  const isGlb = Boolean(node.filePath && (ext === 'glb' || ext === 'gltf'))

  useEffect(() => {
    if (outerRef.current) nodeGroupRegistry.set(node.id, outerRef.current)
    return () => { nodeGroupRegistry.delete(node.id) }
  }, [node.id])

  useEffect(() => {
    if (!isGlb) return
    let cancelled = false
    const loader = new GLTFLoader()
    loader.load(node.filePath!, (gltf) => {
      if (cancelled || !innerRef.current) return
      innerRef.current.clear()
      innerRef.current.add(gltf.scene)
    })
    return () => { cancelled = true }
  }, [node.filePath, isGlb])

  return (
    <group ref={outerRef} position={[t.x, t.y, t.z]} rotation={[t.rx, t.ry, t.rz]} scale={[t.sx, t.sy, t.sz]}>
      {isGlb ? <group ref={innerRef} /> : (
        <mesh>
          <boxGeometry args={[0.5, 0.5, 0.5]} />
          <meshStandardMaterial color="#5588cc" />
        </mesh>
      )}
      {children}
    </group>
  )
}

function renderNodeElement(
  node: NodeRecord,
  allNodes?: NodeRecord[],
  viewerMode?: boolean,
): React.ReactNode {
  const freeChildren = allNodes
    ? allNodes.filter((n) => n.parentId === node.id && !n.boneAttachment)
    : []
  const boneChildren = allNodes
    ? allNodes.filter((n) => n.parentId === node.id && !!n.boneAttachment)
    : []
  const childElements = freeChildren.map((c) => renderNodeElement(c, allNodes, viewerMode))
  // Bone-attached children render as normal top-level nodes; BoneFollower syncs their position each frame
  const boneFollowers = boneChildren.flatMap((c) => [
    renderNodeElement(c, allNodes, viewerMode),
    <BoneAttacher key={`ba-${c.id}`} avatarNodeId={node.id} boneName={c.boneAttachment!} nodeId={c.id} />,
  ])

  const visible = !node.hidden
  if (node.kind === 'avatar') return <><group key={node.id} visible={visible}><AvatarNode node={node}>{childElements}</AvatarNode></group>{boneFollowers}</>
  if (node.kind === 'light') return <group key={node.id} visible={visible}><LightNode node={node} viewerMode={viewerMode} /></group>
  if (node.kind === 'camera') return <group key={node.id} visible={visible}><CameraNode node={node} /></group>
  if (node.kind === 'godray_caster') return <group key={node.id} visible={visible}><GodrayCasterNode node={node} /></group>
  // particle and billboard are rendered flat in SceneNodes to keep their React position stable across reparents
  if (node.kind === 'particle') return null
  if (node.kind === 'billboard') return null
  return <group key={node.id} visible={visible}><ModelNode node={node}>{childElements}</ModelNode></group>
}

export function SceneNodes({ omitNodeId, omitKinds, viewerMode }: {
  omitNodeId?: string; omitKinds?: string[]; viewerMode?: boolean
} = {}) {
  const { nodes, activeSceneId } = useEditorStore()
  const sceneNodes = nodes.filter((n) =>
    n.sceneId === activeSceneId &&
    n.id !== omitNodeId &&
    !omitKinds?.includes(n.kind)
  )
  const rootNodes = sceneNodes.filter((n) => !n.parentId)
  // Particle and billboard nodes are always rendered at the top level so their React
  // component instance never moves in the tree (reparenting in the scene graph would
  // otherwise unmount+remount them, destroying the particle pool).
  const flatParticles = sceneNodes.filter((n) => n.kind === 'particle')
  const flatBillboards = sceneNodes.filter((n) => n.kind === 'billboard')

  return (
    <>
      {rootNodes.map((node) => renderNodeElement(node, sceneNodes, viewerMode))}
      {flatParticles.map((node) => <group key={node.id} visible={!node.hidden}><ParticleNode node={node} /></group>)}
      {flatBillboards.map((node) => <group key={node.id} visible={!node.hidden}><BillboardNode node={node} /></group>)}
    </>
  )
}

function TransformGizmo({ mode, orbitRef }: { mode: GizmoMode; orbitRef: React.RefObject<any> }) {
  const { selectedNodeId, updateNode: storeUpdateNode } = useEditorStore()
  const group = selectedNodeId ? nodeGroupRegistry.get(selectedNodeId) : undefined
  if (!group) return null

  const onEnd = () => {
    if (orbitRef.current) orbitRef.current.enabled = true
    const node = useEditorStore.getState().nodes.find(n => n.id === selectedNodeId)
    if (!node) return
    const p = group.position, r = group.rotation, s = group.scale
    const transform = { x: p.x, y: p.y, z: p.z, rx: r.x, ry: r.y, rz: r.z, sx: s.x, sy: s.y, sz: s.z }
    const components = { ...node.components, transform: { type: 'transform', ...transform } }
    storeUpdateNode(node.id, { components })
    api.updateNode(node.id, { components }).catch(() => {})
  }

  return (
    <TransformControls
      key={selectedNodeId ?? undefined}
      object={group}
      mode={mode}
      onMouseDown={() => { if (orbitRef.current) orbitRef.current.enabled = false }}
      onMouseUp={onEnd}
    />
  )
}

const GIZMO_BUTTONS: { mode: GizmoMode; icon: string; title: string }[] = [
  { mode: 'translate', icon: '↔', title: 'Translate' },
  { mode: 'rotate',    icon: '○', title: 'Rotate' },
  { mode: 'scale',     icon: '□', title: 'Scale' },
]

function GizmoToolbar({ mode, setMode }: { mode: GizmoMode; setMode: (m: GizmoMode) => void }) {
  return (
    <div style={{
      position: 'absolute', bottom: 16, left: 16,
      display: 'flex', gap: 2,
      background: '#0e0e18', border: '1px solid #2a2a3a',
      borderRadius: 6, padding: 3, zIndex: 10,
    }}>
      {GIZMO_BUTTONS.map(({ mode: m, icon, title }) => (
        <button
          key={m}
          title={title}
          onClick={() => setMode(m)}
          style={{
            width: 30, height: 30,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 15, cursor: 'pointer',
            background: mode === m ? '#1e2e4a' : 'transparent',
            border: `1px solid ${mode === m ? '#3a5a9a' : 'transparent'}`,
            borderRadius: 4,
            color: mode === m ? '#7ab' : '#555',
            lineHeight: 1,
          }}
        >
          {icon}
        </button>
      ))}
    </div>
  )
}

const _afRay = new THREE.Raycaster()
const _afBox = new THREE.Box3()
const _afVec = new THREE.Vector3()

function AutofocusDOF({ cfg }: { cfg: Record<string, unknown> }) {
  const { camera, scene } = useThree()
  const autofocus  = (cfg.autofocus   as boolean) ?? false
  const afMode     = (cfg.afMode      as string)  ?? 'point'
  const afPointX   = (cfg.afPointX    as number)  ?? 0.5
  const afPointY   = (cfg.afPointY    as number)  ?? 0.5
  const percentile = (cfg.afPercentile as number)  ?? 15
  const speed      = (cfg.afSpeed     as number)  ?? 4

  const spring     = useRef({ pos: (cfg.worldFocusDistance as number) ?? 3, vel: 0 })
  const scanTimer  = useRef(0)
  const targetRef  = useRef<number | null>(null)
  const dofRef     = useRef<any>(null)
  const logTimer   = useRef(0)

  useFrame((_, delta) => {
    logTimer.current += delta
    const shouldLog = logTimer.current >= 2
    if (shouldLog) logTimer.current = 0

    const dofEffect = dofRef.current
    const cam = camera as THREE.PerspectiveCamera
    if (!autofocus) return

    // Depth scan at ~10 Hz via bounding-box raycasting — no GPU render, no GL state touched
    scanTimer.current -= delta
    if (scanTimer.current <= 0) {
      scanTimer.current = 0.1

      // Collect world-space bounding boxes of visible, opaque, non-wireframe meshes
      const boxes: THREE.Box3[] = []
      scene.traverse((obj) => {
        if (!(obj as THREE.Mesh).isMesh) return
        const mesh = obj as THREE.Mesh
        if (!mesh.visible) return
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        const hasOpaque = mats.some((m) => {
          if (!m || (m as THREE.Material).transparent) return false
          if ((m as THREE.MeshBasicMaterial).wireframe) return false
          if ((m as THREE.Material).opacity < 0.9) return false
          return true
        })
        if (!hasOpaque) return
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
        if (!mesh.geometry.boundingBox) return
        _afBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
        boxes.push(_afBox.clone())
      })

      if (shouldLog) console.log('[AF] boxes:', boxes.length)

      // Cast rays against those boxes from NDC sample points
      const sampleNDC = afMode === 'point'
        ? [new THREE.Vector2(afPointX * 2 - 1, (1 - afPointY) * 2 - 1)]
        : Array.from({ length: 16 }, () => new THREE.Vector2(Math.random() * 2 - 1, Math.random() * 2 - 1))

      const hits: number[] = []
      for (const ndc of sampleNDC) {
        _afRay.setFromCamera(ndc, cam)
        let closest = Infinity
        for (const box of boxes) {
          const hit = _afRay.ray.intersectBox(box, _afVec)
          if (hit !== null) {
            // COC shader uses length(viewPosition) — Euclidean distance from camera origin
            const dist = _afVec.distanceTo(cam.position)
            if (dist < closest) closest = dist
          }
        }
        if (closest < Infinity) hits.push(closest)
      }

      let targetDist: number | null = null
      if (afMode === 'point') {
        targetDist = hits[0] ?? null
      } else if (hits.length > 0) {
        hits.sort((a, b) => a - b)
        targetDist = hits[Math.floor((percentile / 100) * (hits.length - 1))]
      }

      if (shouldLog) console.log('[AF] hits:', hits.length, 'targetDist:', targetDist)
      if (targetDist !== null) targetRef.current = targetDist
    }

    // Spring convergence — write to cocMaterial.focusDistance directly
    if (!dofEffect) return
    const targetDist = targetRef.current
    if (targetDist === null) return

    const s = spring.current
    const diff = targetDist - s.pos
    if (shouldLog) console.log('[AF] spring pos=', s.pos.toFixed(2), 'target=', targetDist.toFixed(2), 'focusDistance=', dofEffect.cocMaterial?.focusDistance?.toFixed(2))
    const acc = speed * speed * diff - 2 * speed * s.vel
    s.vel += acc * delta
    s.pos += s.vel * delta
    dofEffect.cocMaterial.focusDistance = Math.max(cam.near, s.pos)
  }, 2)

  return (
    <DepthOfField
      ref={dofRef}
      worldFocusDistance={(cfg.worldFocusDistance as number) ?? 3}
      worldFocusRange={(cfg.worldFocusRange as number) ?? 2}
      bokehScale={(cfg.bokehScale as number) ?? 2}
    />
  )
}


function GodRaysSync({ effect }: { effect: GodRaysEffect }) {
  const { composer } = useContext(EffectComposerContext)!
  useEffect(() => {
    const dt = (composer as any).depthTexture ?? null
    if (dt) effect.setDepthTexture(dt)
  }, [effect, composer])
  return null
}

function NormalBufferSync({ effect }: { effect: DepthEdgeEffect }) {
  const { normalPass } = useContext(EffectComposerContext)!
  useEffect(() => {
    effect.setNormalBuffer(normalPass?.texture ?? null)
  }, [effect, normalPass])
  return null
}

type SSAOParams = { intensity: number; radius: number; bias: number; rings: number; samples: number }
function SSAOEffectPrimitive({ params }: { params: SSAOParams }) {
  const { camera, normalPass, downSamplingPass } = useContext(EffectComposerContext)!
  const effect = useMemo(() => new SSAOEffect(camera, normalPass?.texture ?? undefined, {
    blendFunction: BlendFunction.MULTIPLY,
    normalDepthBuffer: downSamplingPass ? downSamplingPass.texture : undefined,
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
  }), [camera, normalPass, downSamplingPass])
  useEffect(() => {
    effect.intensity = params.intensity
    effect.radius = params.radius
    effect.ssaoMaterial.bias = params.bias
    effect.rings = params.rings
    effect.samples = params.samples
  })
  return <primitive object={effect} dispose={null} />
}

export function CameraEffects({ forceNodeId }: { forceNodeId?: string } = {}) {
  const { previewEffectsCamera, cameraEffects, nodes, activeSceneId } = useEditorStore()

  const effectsNodeId = forceNodeId ?? previewEffectsCamera
  const activeEffects = effectsNodeId
    ? cameraEffects.filter((e) => e.nodeId === effectsNodeId && e.enabled)
    : []

  const get = <T,>(kind: string, key: string, fallback: T): T => {
    const e = activeEffects.find((e) => e.kind === kind)
    return ((e?.config[key]) ?? fallback) as T
  }
  const has = (kind: string) => activeEffects.some((e) => e.kind === kind)

  const [sunMesh, setSunMesh] = useState<THREE.Mesh | null>(null)
  useFrame(() => {
    const caster = nodes.find((n) => n.sceneId === activeSceneId && n.kind === 'godray_caster')
    const mesh = caster ? godrayCasterRegistry.get(caster.id) ?? null : null
    if (mesh !== sunMesh) setSunMesh(mesh)
  })
  const godrayCaster = nodes.find((n) => n.sceneId === activeSceneId && n.kind === 'godray_caster')
  const gr = (godrayCaster?.components.godray as Record<string, number>) ?? {}

  const { camera } = useThree()
  const godRays = useMemo(
    () => sunMesh ? new GodRaysEffect(camera, sunMesh, {
      samples:  gr.samples  ?? 60,
      density:  gr.density  ?? 0.96,
      decay:    gr.decay    ?? 0.93,
      weight:   gr.weight   ?? 0.4,
      exposure: gr.exposure ?? 0.6,
      clampMax: gr.clampMax ?? 1.0,
      blur: true,
    }) : null,
    // Re-create only when the sun mesh changes; param updates are handled imperatively below
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camera, sunMesh]
  )
  useEffect(() => {
    if (!godRays) return
    const m = godRays.godRaysMaterial
    m.density  = gr.density  ?? 0.96
    m.decay    = gr.decay    ?? 0.93
    m.weight   = gr.weight   ?? 0.4
    m.exposure = gr.exposure ?? 0.6
    m.maxIntensity = gr.clampMax ?? 1.0
    m.samples  = gr.samples  ?? 60
  })

  const depthEdge = useMemo(() => new DepthEdgeEffect(), [])
  useEffect(() => {
    depthEdge.setColor(get('fx_outline', 'color', '#000000') as string)
    depthEdge.setThreshold(get('fx_outline', 'threshold', 0.001) as number)
    depthEdge.setThickness(get('fx_outline', 'thickness', 1.0) as number)
    depthEdge.setAlpha(get('fx_outline', 'alpha', 1.0) as number)
    depthEdge.setNormalStrength(get('fx_outline', 'normalStrength', 1.0) as number)
    depthEdge.setBlendMode(get('fx_outline', 'blendMode', 'NORMAL') as any)
  })

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
      ) : <></>}
      {has('fx_hue_saturation') ? (
        <HueSaturation
          hue={get('fx_hue_saturation', 'hue', 0)}
          saturation={get('fx_hue_saturation', 'saturation', 0)}
        />
      ) : <></>}
      {has('fx_sepia') ? (
        <Sepia intensity={get('fx_sepia', 'intensity', 1)} />
      ) : <></>}
      {has('fx_bloom') ? (
        <Bloom
          intensity={get('fx_bloom', 'intensity', 1)}
          luminanceThreshold={get('fx_bloom', 'luminanceThreshold', 0.9)}
          luminanceSmoothing={get('fx_bloom', 'luminanceSmoothing', 0.025)}
          mipmapBlur={get('fx_bloom', 'mipmapBlur', true)}
        />
      ) : <></>}
      {has('fx_depth_of_field') ? (
        <AutofocusDOF cfg={activeEffects.find((e) => e.kind === 'fx_depth_of_field')!.config} />
      ) : <></>}
      {has('fx_chromatic_aberration') ? (
        <ChromaticAberration
          offset={new THREE.Vector2(
            get('fx_chromatic_aberration', 'offsetX', 0.002),
            get('fx_chromatic_aberration', 'offsetY', 0.002),
          )}
          radialModulation={false}
          modulationOffset={0}
        />
      ) : <></>}
      {has('fx_ssao') ? (
        <SSAOEffectPrimitive params={{
          intensity: get('fx_ssao', 'intensity', 1.5) as number,
          radius: Math.min(1, Math.max(1e-6, get('fx_ssao', 'radius', 0.2) as number)),
          bias: get('fx_ssao', 'bias', 0.025) as number,
          rings: get('fx_ssao', 'rings', 4) as number,
          samples: get('fx_ssao', 'samples', 30) as number,
        }} />
      ) : <></>}
      {has('fx_outline') ? (
        <>
          <primitive object={depthEdge} />
          <NormalBufferSync effect={depthEdge} />
        </>
      ) : <></>}
      {has('fx_vignette') ? (
        <Vignette
          offset={get('fx_vignette', 'offset', 0.5)}
          darkness={get('fx_vignette', 'darkness', 0.5)}
        />
      ) : <></>}
      {has('fx_noise') ? (
        <Noise opacity={get('fx_noise', 'opacity', 0.2)} />
      ) : <></>}
      {has('fx_scanline') ? (
        <Scanline
          density={get('fx_scanline', 'density', 1.25)}
          opacity={get('fx_scanline', 'opacity', 0.1)}
        />
      ) : <></>}
      {has('fx_pixelation') ? (
        <Pixelation granularity={get('fx_pixelation', 'granularity', 8)} />
      ) : <></>}
      {has('fx_ascii') ? (
        <ASCII
          characters={get('fx_ascii', 'characters', ' .:-+*=%@#')}
          fontSize={get('fx_ascii', 'fontSize', 54)}
          cellSize={get('fx_ascii', 'cellSize', 16)}
          color={get('fx_ascii', 'color', '#ffffff')}
          invert={get('fx_ascii', 'invert', false)}
        />
      ) : <></>}
      {has('fx_dot_screen') ? (
        <DotScreen
          angle={get('fx_dot_screen', 'angle', 1.57)}
          scale={get('fx_dot_screen', 'scale', 1.0)}
        />
      ) : <></>}
      {has('fx_glitch') ? (
        <Glitch
          delay={new THREE.Vector2(...(get('fx_glitch', 'delay', [1.5, 3.5]) as [number, number]))}
          duration={new THREE.Vector2(...(get('fx_glitch', 'duration', [0.06, 0.3]) as [number, number]))}
          strength={new THREE.Vector2(...(get('fx_glitch', 'strength', [0.3, 1.0]) as [number, number]))}
          columns={get('fx_glitch', 'columns', 0.05)}
          ratio={get('fx_glitch', 'ratio', 0.85)}
        />
      ) : <></>}
      {has('fx_smaa') ? <SMAA /> : <></>}
      {has('fx_tilt_shift') ? (
        <TiltShift
          offset={get('fx_tilt_shift', 'offset', 0.0)}
          rotation={get('fx_tilt_shift', 'rotation', 0.0)}
          focusArea={get('fx_tilt_shift', 'focusArea', 0.4)}
          feather={get('fx_tilt_shift', 'feather', 0.3)}
        />
      ) : <></>}
      {has('fx_water') ? (
        <WaterEffect factor={get('fx_water', 'factor', 1.0)} />
      ) : <></>}
      {godRays ? (
        <>
          <primitive object={godRays} />
          <GodRaysSync effect={godRays} />
        </>
      ) : <></>}
      <ToneMapping mode={get('fx_tone_mapping', 'mode', 6) as any} />
    </EffectComposer>
  )
}

export function Viewport() {
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate')
  const orbitRef = useRef<any>(null)

  return (
    <div style={{ width: '100%', height: '100%', background: '#1a1a1a', overflow: 'hidden', position: 'relative' }}>
      <Canvas camera={{ position: [0, 1.5, 5], fov: 50 }} gl={{ toneMapping: THREE.NoToneMapping }}>
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 10, 5]} intensity={0.8} />
        <SceneNodes />
        <TransformGizmo mode={gizmoMode} orbitRef={orbitRef} />
        <Grid infiniteGrid fadeDistance={30} fadeStrength={1} />
        <Environment preset="city" />
        <OrbitControls ref={orbitRef} makeDefault />
        <CameraEffects />
      </Canvas>
      <GizmoToolbar mode={gizmoMode} setMode={setGizmoMode} />
    </div>
  )
}
