import { useRef, useEffect, useState, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Grid, Environment, Line, TransformControls, Billboard } from '@react-three/drei'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import type { VRM, VRMHumanBoneName, VRMPose } from '@pixiv/three-vrm'
import { useEditorStore } from '../../store/editorStore'
import type { NodeRecord, NodeComponent } from '../../store/editorStore'

import { animRegistry } from '../../animRegistry'
import { getVmcPose, getVmcPoseTime, getVmcBlendshapes } from '../../vmcPoseStore'
import { vrmRegistry } from '../../vrmRegistry'
import { applyArmCalib, upperArmNormRotFromTarget, DEFAULT_CALIBRATION } from '../../calibration'
import type { VmcCalibration } from '../../calibration'
import { VRM_BONE_NAMES } from '@vspark/shared/signal'
import { api } from '../../api/client'
import { BoneFilterBank } from '../../oneEuroFilter'

type GizmoMode = 'translate' | 'rotate' | 'scale'

// Maps nodeId → outermost Three.js group, used to attach TransformControls
const nodeGroupRegistry = new Map<string, THREE.Group>()

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

function AvatarNode({ node }: { node: NodeRecord }) {
  const outerRef      = useRef<THREE.Group>(null)
  const groupRef      = useRef<THREE.Group>(null)
  const fbxGroupRef   = useRef<THREE.Group>(null)
  const vrmHelperRef  = useRef<THREE.Group>(null)
  const fbxHelperRef  = useRef<THREE.Group>(null)
  const boneCylRef = useRef<THREE.Mesh>(null)
  const bindPoseGroupRef = useRef<THREE.Group>(null)
  const fbxMixerRef   = useRef<THREE.AnimationMixer | null>(null)
  const vrmMixerRef   = useRef<THREE.AnimationMixer | null>(null)
  const vrmRef        = useRef<VRM | null>(null)
  const corrAxesRef   = useRef<THREE.Object3D[]>([])
  const vmcCompRef    = useRef<NodeComponent | null>(null)
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

  // Track active VMC receiver component without causing useFrame re-subscription
  const vmcComp = useEditorStore((s) =>
    s.nodeComponentsFor(node.id).find((c) => c.kind === 'vmc_receiver' && c.enabled) ?? null
  )
  useEffect(() => { vmcCompRef.current = vmcComp }, [vmcComp])

  const { setVrmBonesForNode, clearVrmBonesForNode,
          setVrmExpressionsForNode, clearVrmExpressionsForNode,
          setVrmMorphTargetsForNode, clearVrmMorphTargetsForNode } = useEditorStore()

  // name → all meshes+indices that have that morph target
  type MorphEntry = { mesh: THREE.SkinnedMesh; index: number }
  const morphMapRef = useRef<Map<string, MorphEntry[]>>(new Map())

  const animComp = node.components?.animation as { idleUrl?: string } | undefined
  const animUrl = animComp?.idleUrl ?? null

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

      // 1. Hips: full 3-axis basis alignment.
      const hipsFbxName = VRM_TO_FBX.hips
      const spineFbxName = VRM_TO_FBX.spine
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
        // Apply rot in world to hips: newWQ = rot × oldWQ
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
                const vR = new THREE.Vector3().crossVectors(vU, vF).normalize()
                const vMat = new THREE.Matrix4().makeBasis(vR, vU, vF)
                const fF = fMid.clone().normalize()
                const fS = fLit.clone().normalize()
                const fU = new THREE.Vector3().crossVectors(fF, fS).normalize().multiplyScalar(-1)
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

      // --- Bind-pose VRM copy: load a second VRM to the right, apply FBX bind world Qs ---
      // Uses getWorldQuaternion() values (same as SkeletonHelper), compensated for VRM scene rotation.
      if (bindPoseGroupRef.current && node.filePath) {
        bindPoseGroupRef.current.clear()
        new GLTFLoader().register(p => new VRMLoaderPlugin(p)).load(node.filePath, (gltf2) => {
          if (!bindPoseGroupRef.current) return
          const vrm2 = gltf2.userData.vrm as VRM | undefined
          if (!vrm2) return
          vrm2.scene.rotation.y = Math.PI
          bindPoseGroupRef.current.add(vrm2.scene)

          // Pose the VRM in the FBX bind/A-pose using direction-based swing retargeting.
          //
          // Different rigs orient bones with different local axes (e.g. UE4 Y+ along bone,
          // VRM world-aligned). Setting bone world Qs to match FBX world Qs would twist the
          // skinned mesh because each rig's mesh was bound to its OWN rest orientations.
          //
          // The fix: compute the bone "direction" (vector from bone to its first rig child)
          // in world space for both VRM rest and FBX bind. Build a swing quaternion that
          // rotates VRM rest direction onto FBX bind direction. Apply it to the VRM bone in
          // world space, then decompose to local for the bone.
          //
          // No twist component is recovered — this gives the visual A-pose shape without
          // axial roll information.
          vrm2.scene.updateMatrixWorld(true)

          // Preferred child for direction computation. For trunk bones with multiple
          // rig children (e.g. spine→chest+shoulders, chest→neck+shoulders), we must
          // pick the canonical downstream bone or the swing direction becomes ambiguous
          // and can rotate the whole upper body sideways.
          const PREFERRED_VRM_CHILD: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>> = {
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
          }

          // Build FBX child by inverting FBX_BONE_TO_VRM + PREFERRED_VRM_CHILD.
          // Only consider FBX bones that actually exist in THIS FBX (fbxBindWQ has them).
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
          // Fallback for bones not in the preferred map: first rig child
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
            // fallback
            for (const candidate of allVRMBoneNames) {
              if (vrmBoneParent[candidate] === n) { vrmChild[n] = candidate; break }
            }
          }

          // Find the FBX bone node positions for direction computation
          const fbxBoneNode: Record<string, THREE.Object3D> = {}
          fbx.traverse(o => { if (FBX_BONE_TO_VRM[o.name] && !fbxBoneNode[o.name]) fbxBoneNode[o.name] = o })

          const _vrmChildLocalPos = new THREE.Vector3()
          const _fbxChildLocalPos = new THREE.Vector3()
          const _vrmDir = new THREE.Vector3()
          const _fbxDir = new THREE.Vector3()
          const _swing = new THREE.Quaternion()
          const _pWQ = new THREE.Quaternion()

          // Debug: dump childmaps for arms/legs
          console.log('[childmap] upperarm_l →', fbxChild['upperarm_l'], 'leftUpperArm →', vrmChild['leftUpperArm'])
          console.log('[childmap] thigh_l →', fbxChild['thigh_l'], 'leftUpperLeg →', vrmChild['leftUpperLeg'])
          console.log('[childmap] spine_01 →', fbxChild['spine_01'])
          // Handle the rig root (pelvis/hips) specially. Single-direction swing only
          // constrains 2 of 3 axes; for the root we need full orientation. Build an
          // orthonormal basis from (up = to spine, right = right-thigh→left-thigh) for
          // both rigs and compute the rotation that aligns FBX basis to VRM rest basis.
          {
            const hipsVn: VRMHumanBoneName = 'hips'
            const hipsBone = vrm2.humanoid.getRawBoneNode(hipsVn)
            const hipsFbx = VRM_TO_FBX[hipsVn]
            const spineVn: VRMHumanBoneName = 'spine'
            const spineBone = vrm2.humanoid.getRawBoneNode(spineVn)
            const spineFbx = VRM_TO_FBX[spineVn]
            const lThighVn: VRMHumanBoneName = 'leftUpperLeg'
            const rThighVn: VRMHumanBoneName = 'rightUpperLeg'
            const lThighBone = vrm2.humanoid.getRawBoneNode(lThighVn)
            const rThighBone = vrm2.humanoid.getRawBoneNode(rThighVn)
            const lThighFbx = VRM_TO_FBX[lThighVn]
            const rThighFbx = VRM_TO_FBX[rThighVn]
            if (hipsBone && hipsFbx && spineBone && spineFbx && lThighBone && rThighBone && lThighFbx && rThighFbx) {
              const vUp = new THREE.Vector3().copy(spineBone.position).normalize()
              const vRight = new THREE.Vector3().subVectors(lThighBone.position, rThighBone.position).normalize()
              // Bring vrm vectors into world space via hips current world Q (= rest, since
              // we haven't touched it yet).
              const hipsWQ = new THREE.Quaternion()
              hipsBone.getWorldQuaternion(hipsWQ)
              vUp.applyQuaternion(hipsWQ)
              vRight.applyQuaternion(hipsWQ)
              const vForward = new THREE.Vector3().crossVectors(vRight, vUp).normalize()
              const vRight2 = new THREE.Vector3().crossVectors(vUp, vForward).normalize()
              const vrmBasis = new THREE.Matrix4().makeBasis(vRight2, vUp, vForward)

              const fUp = new THREE.Vector3().copy(fbxBoneNode[spineFbx]!.position).normalize()
              const fRight = new THREE.Vector3().subVectors(fbxBoneNode[lThighFbx]!.position, fbxBoneNode[rThighFbx]!.position).normalize()
              fUp.applyQuaternion(fbxBindWQ[hipsFbx]!)
              fRight.applyQuaternion(fbxBindWQ[hipsFbx]!)
              const fForward = new THREE.Vector3().crossVectors(fRight, fUp).normalize()
              const fRight2 = new THREE.Vector3().crossVectors(fUp, fForward).normalize()
              const fbxBasis = new THREE.Matrix4().makeBasis(fRight2, fUp, fForward)

              // Rotation that maps vrm basis → fbx basis: fbxBasis × vrmBasisInv
              const vrmBasisInv = vrmBasis.clone().invert()
              const rotMat = new THREE.Matrix4().multiplyMatrices(fbxBasis, vrmBasisInv)
              const fullRot = new THREE.Quaternion().setFromRotationMatrix(rotMat)

              const hipsParentWQ = new THREE.Quaternion()
              if (hipsBone.parent) hipsBone.parent.getWorldQuaternion(hipsParentWQ)
              const newLocal = hipsParentWQ.clone().invert().multiply(fullRot).multiply(hipsParentWQ).multiply(hipsBone.quaternion)
              hipsBone.quaternion.copy(newLocal)
              hipsBone.updateMatrixWorld(true)
              console.log(`[hipsBasis] vrmRight=(${vRight2.x.toFixed(2)},${vRight2.y.toFixed(2)},${vRight2.z.toFixed(2)}) vrmFwd=(${vForward.x.toFixed(2)},${vForward.y.toFixed(2)},${vForward.z.toFixed(2)}) fbxRight=(${fRight2.x.toFixed(2)},${fRight2.y.toFixed(2)},${fRight2.z.toFixed(2)}) fbxFwd=(${fForward.x.toFixed(2)},${fForward.y.toFixed(2)},${fForward.z.toFixed(2)})`)
            }
          }

          for (const mb of bonesInOrder) {
            const vn = FBX_BONE_TO_VRM[mb] as VRMHumanBoneName
            const bone2 = vrm2.humanoid.getRawBoneNode(vn)
            const fbxNode = fbxBoneNode[mb]
            if (!bone2 || !fbxNode) { if (mb === 'upperarm_l' || mb === 'thigh_l') console.log(`[skip] ${mb} bone2=${!!bone2} fbxNode=${!!fbxNode}`); continue }
            // Skip the hips/pelvis — already handled above with full basis alignment.
            if (vn === 'hips') continue
            const childMb = fbxChild[mb]
            const childVn = vrmChild[vn]
            const parentWQ = new THREE.Quaternion()
            if (bone2.parent) bone2.parent.getWorldQuaternion(parentWQ)

            if (mb === 'upperarm_l' || mb === 'thigh_l') console.log(`[loop] ${mb} childMb=${childMb} childVn=${childVn} hasChildren=${!!(childMb && childVn)}`)

            if (childMb && childVn) {
              const vrmChildBone = vrm2.humanoid.getRawBoneNode(childVn)
              const fbxChildNode = fbxBoneNode[childMb]
              if (!vrmChildBone || !fbxChildNode) continue
              _vrmChildLocalPos.copy(vrmChildBone.position)
              _fbxChildLocalPos.copy(fbxChildNode.position)
              if (_vrmChildLocalPos.lengthSq() < 1e-10 || _fbxChildLocalPos.lengthSq() < 1e-10) continue

              _vrmDir.copy(_vrmChildLocalPos).normalize()
              bone2.getWorldQuaternion(_pWQ)
              _vrmDir.applyQuaternion(_pWQ)

              _fbxDir.copy(_fbxChildLocalPos).normalize()
              _fbxDir.applyQuaternion(fbxBindWQ[mb]!)

              _swing.setFromUnitVectors(_vrmDir, _fbxDir)

              if (mb === 'upperarm_l' || mb === 'thigh_l' || mb === 'spine_01' || mb === 'lowerarm_l') {
                console.log(`[swing] ${mb}→${childMb} vrmDir=(${_vrmDir.x.toFixed(2)},${_vrmDir.y.toFixed(2)},${_vrmDir.z.toFixed(2)}) fbxDir=(${_fbxDir.x.toFixed(2)},${_fbxDir.y.toFixed(2)},${_fbxDir.z.toFixed(2)}) swing=(${_swing.x.toFixed(3)},${_swing.y.toFixed(3)},${_swing.z.toFixed(3)},${_swing.w.toFixed(3)}) childVn=${childVn}`)
              }

              const newLocalQ = parentWQ.clone().invert().multiply(_swing).multiply(parentWQ).multiply(bone2.quaternion)
              bone2.quaternion.copy(newLocalQ)
              bone2.updateMatrixWorld(true)

              // For hands, the single-axis swing leaves the roll unconstrained, twisting
              // the wrist. Do a full basis alignment using two child fingers (middle +
              // little) to lock the palm orientation.
              const isHand = vn === 'leftHand' || vn === 'rightHand'
              if (isHand) {
                const middleVn = (vn === 'leftHand' ? 'leftMiddleProximal' : 'rightMiddleProximal') as VRMHumanBoneName
                const littleVn = (vn === 'leftHand' ? 'leftLittleProximal' : 'rightLittleProximal') as VRMHumanBoneName
                const middleFbx = VRM_TO_FBX[middleVn]
                const littleFbx = VRM_TO_FBX[littleVn]
                const middleVrm = vrm2.humanoid.getRawBoneNode(middleVn)
                const littleVrm = vrm2.humanoid.getRawBoneNode(littleVn)
                const middleNodeFbx = middleFbx ? fbxBoneNode[middleFbx] : null
                const littleNodeFbx = littleFbx ? fbxBoneNode[littleFbx] : null
                if (middleVrm && littleVrm && middleNodeFbx && littleNodeFbx) {
                  const handWQv = new THREE.Quaternion()
                  bone2.getWorldQuaternion(handWQv)
                  const vMid = middleVrm.position.clone().normalize().applyQuaternion(handWQv)
                  const vLit = littleVrm.position.clone().normalize().applyQuaternion(handWQv)
                  const fMid = middleNodeFbx.position.clone().normalize().applyQuaternion(fbxBindWQ[mb]!)
                  const fLit = littleNodeFbx.position.clone().normalize().applyQuaternion(fbxBindWQ[mb]!)
                  const vF = vMid.clone().normalize()
                  const vS = vLit.clone().normalize()
                  const vU = new THREE.Vector3().crossVectors(vF, vS).normalize()
                  const vR = new THREE.Vector3().crossVectors(vU, vF).normalize()
                  const vMat = new THREE.Matrix4().makeBasis(vR, vU, vF)
                  const fF = fMid.clone().normalize()
                  const fS = fLit.clone().normalize()
                  const fU = new THREE.Vector3().crossVectors(fF, fS).normalize().multiplyScalar(-1)
                  const fR = new THREE.Vector3().crossVectors(fU, fF).normalize()
                  const fMat = new THREE.Matrix4().makeBasis(fR, fU, fF)
                  const rot = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().multiplyMatrices(fMat, vMat.invert()))
                  const pWQh = new THREE.Quaternion()
                  if (bone2.parent) bone2.parent.getWorldQuaternion(pWQh)
                  const fixed = pWQh.clone().invert().multiply(rot).multiply(pWQh).multiply(bone2.quaternion)
                  bone2.quaternion.copy(fixed)
                  bone2.updateMatrixWorld(true)
                }
              }
            } else {
              // Leaf bone (no rig child): keep the VRM rest local Q (head, feet, finger tips).
              if (vrmBindLocalQ[vn]) bone2.quaternion.copy(vrmBindLocalQ[vn]!)
            }
            bone2.updateMatrixWorld(true)
          }
          vrm2.scene.updateMatrixWorld(true)
        })
      }

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
          const parentFBXWQ = fbxPN ? curFBXWQ[fbxPN] : IDQ
          curFBXWQ[mb].copy(parentFBXWQ).multiply(_q)
          _delta.copy(curFBXWQ[mb]).multiply(fbxBindWQInv[mb]!).multiply(vrmAposeWQ[vn] ?? vrmBindWQ[vn]!)
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
          _v.sub(fbxRestPos).multiplyScalar(0.01).add(vrmRestPos)
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

      const vrmClip  = new THREE.AnimationClip(clip.name, clip.duration, vrmTracks)
      const vrmMixer = new THREE.AnimationMixer(vrm.scene)
      vrmMixerRef.current = vrmMixer
      const vrmAction = vrmMixer.clipAction(vrmClip)
      vrmAction.reset().play()

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
    const poseActive    = !trackingLost && pose != null && lastPoseTime != null && (Date.now() - lastPoseTime) < poseTimeoutMs

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

      // Pre-expressionManager.update() pass: drive expression preset names via setValue.
      // Morph-target names (Fcl_*, etc.) are deferred to after update() so they
      // aren't overwritten when expressionManager applies its tracked clip values.
      const bs = getVmcBlendshapes(node.id)
      if (bs && vrm.expressionManager) {
        const morphMap = morphMapRef.current
        for (const [name, value] of Object.entries(bs)) {
          if (!morphMap.has(name)) vrm.expressionManager.setValue(name, value)
        }
      }
    }

    // ── Step 3: remaining VRM subsystems on the final blended pose ───────────────
    if (vrm) {
      const v = vrm as unknown as Record<string, { update: (d?: number) => void } | undefined>
      v['lookAt']?.update(delta)
      v['expressionManager']?.update()

      // Post-expressionManager.update() pass: write morph targets directly.
      // expressionManager.update() has already run, so these won't be overwritten.
      if (blend > 0) {
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
      </group>
      <group ref={vrmHelperRef} />
      <group ref={bindPoseGroupRef} position={[2, 0, 0]} />
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

function ModelNode({ node }: { node: NodeRecord }) {
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
    </group>
  )
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

  return (
    <>
      {sceneNodes.map((node) => {
        if (node.kind === 'avatar') return <AvatarNode key={node.id} node={node} />
        if (node.kind === 'light') return <LightNode key={node.id} node={node} viewerMode={viewerMode} />
        if (node.kind === 'camera') return <CameraNode key={node.id} node={node} />
        return <ModelNode key={node.id} node={node} />
      })}
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

export function Viewport() {
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate')
  const orbitRef = useRef<any>(null)

  return (
    <div style={{ width: '100%', height: '100%', background: '#1a1a1a', overflow: 'hidden', position: 'relative' }}>
      <Canvas camera={{ position: [0, 1.5, 5], fov: 50 }}>
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 10, 5]} intensity={0.8} />
        <SceneNodes />
        <TransformGizmo mode={gizmoMode} orbitRef={orbitRef} />
        <Grid infiniteGrid fadeDistance={30} fadeStrength={1} />
        <Environment preset="city" />
        <OrbitControls ref={orbitRef} makeDefault />
      </Canvas>
      <GizmoToolbar mode={gizmoMode} setMode={setGizmoMode} />
    </div>
  )
}
