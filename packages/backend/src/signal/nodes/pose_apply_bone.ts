import {
  SignalNode,
  valuePort,
  NormalizedPose,
  Quaternion,
} from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
  VRMBoneName,
} from '@vspark/shared/signal';

@SignalNode({
  label: 'Pose Apply Bone',
  description:
    'Applies a quaternion rotation to one bone of a NormalizedPose. mode "multiply" adds a delta on top of the existing rotation; "set" replaces it.',
  tags: ['pose'],
  color: '#5b7a3a',
})
export class PoseApplyBone {
  static readonly kind = 'pose_apply_bone';
  static readonly inputPorts = [
    valuePort('pose', 'NormalizedPose'),
    valuePort('quaternion', 'Quaternion'),
    valuePort('bone', 'String'),
    valuePort('mode', 'String'),
  ] as const;
  static readonly outputPorts = [valuePort('pose', 'NormalizedPose')] as const;

  static execute(
    inputs: InputsOf<typeof PoseApplyBone>,
    _config: unknown,
    _ctx: NodeExecutionContext
  ): OutputsOf<typeof PoseApplyBone> {
    const quaternion = inputs.quaternion as Quaternion | undefined;
    const bone = ((inputs.bone as string | undefined) ?? '') as VRMBoneName;
    const mode = (inputs.mode as string | undefined) ?? 'multiply';
    // When upstream pose is absent (e.g. this node is a slot producer building a delta-only
    // pose from identity), start from an empty pose rather than bailing out.
    const pose =
      (inputs.pose as NormalizedPose | undefined) ?? new NormalizedPose();

    if (!quaternion || !bone) return { pose };

    const existing = pose.get(bone) ?? Quaternion.IDENTITY;
    const applied = mode === 'set' ? quaternion : existing.multiply(quaternion);

    return { pose: pose.with(bone, applied) };
  }
}
