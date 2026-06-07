import { SignalNode, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

@SignalNode({
  label: 'Pose Apply Bone',
  description:
    'Applies a quaternion rotation to one bone of a NormalizedPose. mode "multiply" adds a delta on top of the existing rotation; "set" replaces it.',
  tags: ["mocap"],
  color: '#5b7a3a',
})
export class PoseApplyBone extends Node {
  static readonly kind = 'pose_apply_bone';

  @valueIn('pose', 'NormalizedPose') pose!: () => NormalizedPose | undefined;
  @valueIn('quaternion', 'Quaternion') quaternion!: () => Quaternion | undefined;
  @valueIn('bone', 'String') bone!: () => string | undefined;
  @valueIn('mode', 'String') mode!: () => string | undefined;

  @valueOut('pose', 'NormalizedPose')
  poseOut = (): NormalizedPose => {
    const quaternion = this.quaternion();
    const bone = (this.bone() ?? '') as VRMBoneName;
    const mode = this.mode() ?? 'multiply';
    // When upstream pose is absent (e.g. this node is a slot producer building a delta-only
    // pose from identity), start from an empty pose rather than bailing out.
    const pose = this.pose() ?? new NormalizedPose();

    if (!quaternion || !bone) return pose;

    const existing = pose.get(bone) ?? Quaternion.IDENTITY;
    const applied = mode === 'set' ? quaternion : existing.multiply(quaternion);

    return pose.with(bone, applied);
  };
}
