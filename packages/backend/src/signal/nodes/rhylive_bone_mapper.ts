import {
  SignalNode,
  valuePort,
  BoneRotations,
  NormalizedPose,
  Quaternion,
} from '@vspark/shared/signal';
import type {
  VRMBoneName,
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';

// ──────────────────────────────────────────────────────────────────────────────
// Mapping tables
// ──────────────────────────────────────────────────────────────────────────────

const VMC_TO_VRM: Readonly<Record<string, VRMBoneName>> = {
  Hips: 'hips',
  Spine: 'spine',
  Chest: 'chest',
  UpperChest: 'upperChest',
  Neck: 'neck',
  Head: 'head',
  Jaw: 'jaw',
  LeftEye: 'leftEye',
  RightEye: 'rightEye',
  LeftShoulder: 'leftShoulder',
  LeftUpperArm: 'leftUpperArm',
  LeftLowerArm: 'leftLowerArm',
  LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder',
  RightUpperArm: 'rightUpperArm',
  RightLowerArm: 'rightLowerArm',
  RightHand: 'rightHand',
  LeftUpperLeg: 'leftUpperLeg',
  LeftLowerLeg: 'leftLowerLeg',
  LeftFoot: 'leftFoot',
  LeftToes: 'leftToes',
  RightUpperLeg: 'rightUpperLeg',
  RightLowerLeg: 'rightLowerLeg',
  RightFoot: 'rightFoot',
  RightToes: 'rightToes',
  LeftThumbProximal: 'leftThumbMetacarpal',
  LeftThumbIntermediate: 'leftThumbProximal',
  LeftThumbDistal: 'leftThumbDistal',
  LeftIndexProximal: 'leftIndexProximal',
  LeftIndexIntermediate: 'leftIndexIntermediate',
  LeftIndexDistal: 'leftIndexDistal',
  LeftMiddleProximal: 'leftMiddleProximal',
  LeftMiddleIntermediate: 'leftMiddleIntermediate',
  LeftMiddleDistal: 'leftMiddleDistal',
  LeftRingProximal: 'leftRingProximal',
  LeftRingIntermediate: 'leftRingIntermediate',
  LeftRingDistal: 'leftRingDistal',
  LeftLittleProximal: 'leftLittleProximal',
  LeftLittleIntermediate: 'leftLittleIntermediate',
  LeftLittleDistal: 'leftLittleDistal',
  RightThumbProximal: 'rightThumbMetacarpal',
  RightThumbIntermediate: 'rightThumbProximal',
  RightThumbDistal: 'rightThumbDistal',
  RightIndexProximal: 'rightIndexProximal',
  RightIndexIntermediate: 'rightIndexIntermediate',
  RightIndexDistal: 'rightIndexDistal',
  RightMiddleProximal: 'rightMiddleProximal',
  RightMiddleIntermediate: 'rightMiddleIntermediate',
  RightMiddleDistal: 'rightMiddleDistal',
  RightRingProximal: 'rightRingProximal',
  RightRingIntermediate: 'rightRingIntermediate',
  RightRingDistal: 'rightRingDistal',
  RightLittleProximal: 'rightLittleProximal',
  RightLittleIntermediate: 'rightLittleIntermediate',
  RightLittleDistal: 'rightLittleDistal',
};

const MIRROR_VMC: Readonly<Record<string, string>> = {
  LeftUpperArm: 'RightUpperArm',
  RightUpperArm: 'LeftUpperArm',
  LeftLowerArm: 'RightLowerArm',
  RightLowerArm: 'LeftLowerArm',
  LeftHand: 'RightHand',
  RightHand: 'LeftHand',
  LeftUpperLeg: 'RightUpperLeg',
  RightUpperLeg: 'LeftUpperLeg',
  LeftLowerLeg: 'RightLowerLeg',
  RightLowerLeg: 'LeftLowerLeg',
  LeftFoot: 'RightFoot',
  RightFoot: 'LeftFoot',
  LeftShoulder: 'RightShoulder',
  RightShoulder: 'LeftShoulder',
  LeftThumbProximal: 'RightThumbProximal',
  RightThumbProximal: 'LeftThumbProximal',
  LeftThumbIntermediate: 'RightThumbIntermediate',
  RightThumbIntermediate: 'LeftThumbIntermediate',
  LeftThumbDistal: 'RightThumbDistal',
  RightThumbDistal: 'LeftThumbDistal',
  LeftIndexProximal: 'RightIndexProximal',
  RightIndexProximal: 'LeftIndexProximal',
  LeftIndexIntermediate: 'RightIndexIntermediate',
  RightIndexIntermediate: 'LeftIndexIntermediate',
  LeftIndexDistal: 'RightIndexDistal',
  RightIndexDistal: 'LeftIndexDistal',
  LeftMiddleProximal: 'RightMiddleProximal',
  RightMiddleProximal: 'LeftMiddleProximal',
  LeftMiddleIntermediate: 'RightMiddleIntermediate',
  RightMiddleIntermediate: 'LeftMiddleIntermediate',
  LeftMiddleDistal: 'RightMiddleDistal',
  RightMiddleDistal: 'LeftMiddleDistal',
  LeftRingProximal: 'RightRingProximal',
  RightRingProximal: 'LeftRingProximal',
  LeftRingIntermediate: 'RightRingIntermediate',
  RightRingIntermediate: 'LeftRingIntermediate',
  LeftRingDistal: 'RightRingDistal',
  RightRingDistal: 'LeftRingDistal',
  LeftLittleProximal: 'RightLittleProximal',
  RightLittleProximal: 'LeftLittleProximal',
  LeftLittleIntermediate: 'RightLittleIntermediate',
  RightLittleIntermediate: 'LeftLittleIntermediate',
  LeftLittleDistal: 'RightLittleDistal',
  RightLittleDistal: 'LeftLittleDistal',
};

// ──────────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────────

@SignalNode({
  label: 'RhyLive Bone Mapper',
  description:
    'Maps Unity HumanBodyBones to VRM bone names and corrects RhyLive coordinate conventions.',
  tags: ['input', 'mocap'],
  color: '#2a5a4a',
})
export class RhyliveBoneMapper {
  static readonly kind = 'rhylive_bone_mapper';
  static readonly inputPorts = [
    valuePort('bones', 'BoneRotations'),
    valuePort('mirror', 'Bool'),
  ] as const;
  static readonly outputPorts = [valuePort('pose', 'NormalizedPose')] as const;

  static execute(
    inputs: InputsOf<typeof RhyliveBoneMapper>,
    _config: unknown,
    _ctx: NodeExecutionContext
  ): OutputsOf<typeof RhyliveBoneMapper> {
    const bones = inputs.bones as BoneRotations | undefined;
    const mirror = (inputs.mirror as boolean | undefined) ?? false;
    if (!bones) return {} as OutputsOf<typeof RhyliveBoneMapper>;

    const entries: Array<readonly [VRMBoneName, Quaternion]> = [];
    for (const [vmcName] of bones.entries()) {
      const vrmName = VMC_TO_VRM[vmcName];
      if (!vrmName) continue;
      const srcName = mirror ? (MIRROR_VMC[vmcName] ?? vmcName) : vmcName;
      const q = bones.get(srcName);
      if (!q || !q.isValid) continue;
      entries.push([vrmName, new Quaternion(q.x, -q.y, -q.z, q.w)] as const);
    }
    return { pose: new NormalizedPose(entries) };
  }
}

export function applyBoneMapping(
  bones: BoneRotations,
  mirror = false
): NormalizedPose {
  const noopCtx: NodeExecutionContext = {
    triggeredPort: '',
    getState: () => ({}) as never,
    setState: () => {},
  };
  return RhyliveBoneMapper.execute(
    { bones, mirror } as InputsOf<typeof RhyliveBoneMapper>,
    {},
    noopCtx
  ).pose as NormalizedPose;
}
