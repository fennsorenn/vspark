import { SignalNode, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';
import {
  DEFAULT_EYE_RANGES,
  eyeRangesForNode,
  type EyeRanges,
} from '../../vrm/lookAt.js';

/** Default physical eye range (degrees): a tracked eye turned this far maps to
 *  the model's full eye range. (Decided by the user, 2026-10-06.) */
export const DEFAULT_EYE_INPUT_MAX_DEG = 30;

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

/**
 * Scale one tracked eye rotation into the model's eye range.
 *
 * The rotation is split into pitch (X) and yaw (Y) — roll is dropped, eyes
 * don't roll — and each is mapped linearly: `inputMaxDeg` of tracked rotation
 * becomes the model's full range in that direction, and anything beyond is
 * clamped. Direction → range pairing mirrors three-vrm's VRMLookAtBoneApplier
 * (+X ↔ verticalUp; left eye +Y ↔ horizontalOuter, right eye +Y ↔
 * horizontalInner), so the limits land where the model author put them.
 */
export function mapEyeRotation(
  q: Quaternion,
  side: 'left' | 'right',
  ranges: EyeRanges,
  inputMaxDeg: number
): Quaternion {
  const max = inputMaxDeg > 0 ? inputMaxDeg : DEFAULT_EYE_INPUT_MAX_DEG;
  const { pitch, yaw } = q.toEuler();
  const scale = (angleRad: number, rangeDeg: number) =>
    Math.sign(angleRad) *
    rangeDeg *
    Math.min(Math.abs(angleRad * RAD2DEG) / max, 1) *
    DEG2RAD;
  const outPitch = scale(
    pitch,
    pitch >= 0 ? ranges.verticalUp : ranges.verticalDown
  );
  const outward = side === 'left' ? yaw >= 0 : yaw < 0;
  const outYaw = scale(
    yaw,
    outward ? ranges.horizontalOuter : ranges.horizontalInner
  );
  return Quaternion.fromEuler(outPitch, outYaw, 0);
}

const EYES: Array<[VRMBoneName, 'left' | 'right']> = [
  ['leftEye', 'left'],
  ['rightEye', 'right'],
];

@SignalNode({
  label: 'Eye Range Map',
  description:
    "Scales tracked eye rotations into the avatar model's own eye range (its VRM look-at limits), so raw physical eye angles don't roll the iris under the eyelids. Other bones pass through.",
  tags: ['mocap'],
  color: '#3a5a7a',
})
export class EyeRangeMap extends Node {
  static readonly kind = 'eye_range_map';

  @valueIn('pose', 'NormalizedPose') poseIn!: () => NormalizedPose | undefined;
  /** The avatar whose model supplies the ranges. */
  @valueIn('nodeId', 'SceneNode') nodeIdIn!: () => string | undefined;
  @valueIn('enabled', 'Bool') enabledIn!: () => boolean | undefined;
  /** Tracked eye rotation (degrees) that maps to the model's full range. */
  @valueIn('inputMaxDeg', 'Float') inputMaxDegIn!: () => number | undefined;

  @valueOut('pose', 'NormalizedPose')
  pose = (): NormalizedPose | undefined => {
    const pose = this.poseIn();
    if (!pose || !this.enabledIn()) return pose;
    if (!EYES.some(([bone]) => pose.get(bone))) return pose;

    const nodeId = this.nodeIdIn();
    const ranges =
      (nodeId ? eyeRangesForNode(nodeId) : null) ?? DEFAULT_EYE_RANGES;
    // Expression-type look-at drives look* expressions, not eye bones; there
    // is no bone range to map into, so leave the rotations alone.
    if (ranges.type !== 'bone') return pose;

    const max = this.inputMaxDegIn() ?? DEFAULT_EYE_INPUT_MAX_DEG;
    let out = pose;
    for (const [bone, side] of EYES) {
      const q = pose.get(bone);
      if (!q) continue;
      out = out.with(bone, mapEyeRotation(q, side, ranges, max));
    }
    return out;
  };
}
