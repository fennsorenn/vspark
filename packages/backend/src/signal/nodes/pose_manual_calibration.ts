import { SignalNode, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

/** Per-bone, per-axis gain + bias. `multiplier` is unitless; `offset` is in DEGREES. */
export interface BoneCalibration {
  multiplier?: [number, number, number];
  offset?: [number, number, number];
}

const DEG2RAD = Math.PI / 180;

/**
 * Manual per-bone pose calibration.
 *
 * For each configured bone, the incoming rotation is decomposed into intrinsic
 * ZYX Euler angles (pitch=X, yaw=Y, roll=Z), then each axis is remapped:
 *
 *   angle' = angle × multiplier + offset
 *
 * `multiplier` scales how far a rotation travels along that axis (2 = twice as
 * far); `offset` shifts the neutral ("0") position (stored in degrees). The
 * angles are recomposed back into a quaternion.
 *
 * Caveat: per-axis scaling is inherently an Euler-space operation, so it is
 * order-dependent (ZYX) and degrades near the yaw = ±90° gimbal singularity —
 * expected behaviour for a manual fine-tuning knob.
 *
 * Designed to sit inside a pose interceptor chain: wire `pose` from an
 * `on_pose_broadcast` node and the output into a `pose_interceptor_broadcast`.
 */
@SignalNode({
  label: 'Manual Calibration',
  description:
    'Per-bone, per-axis multiplier + offset. multiplier scales rotation along an axis (2 = twice as far); offset (degrees) shifts the neutral 0. Bones without an entry pass through.',
  tags: ['calibration'],
  color: '#4a5a9f',
})
export class PoseManualCalibration extends Node {
  static readonly kind = 'pose_manual_calibration';

  @valueIn('pose', 'NormalizedPose') poseIn!: () => NormalizedPose | undefined;
  // Unconnected — the engine auto-resolves this against the live behavior config
  // (`config.calibrations`) on every pull, so UI edits hot-apply without a graph
  // rebuild. Reading `this.config` instead would snapshot at graph-build time.
  @valueIn('calibrations', 'Any') calibrationsIn!: () =>
    | Record<string, BoneCalibration>
    | undefined;

  @valueOut('pose', 'NormalizedPose')
  pose = (): NormalizedPose | undefined => {
    const pose = this.poseIn();
    if (!pose) return undefined;

    const calibrations = this.calibrationsIn();
    if (!calibrations || Object.keys(calibrations).length === 0) return pose;

    return pose.map((q, bone: VRMBoneName) => {
      const cal = calibrations[bone as string];
      if (!cal || !q.isValid) return q;

      const mul = cal.multiplier;
      const off = cal.offset;
      const mx = mul?.[0] ?? 1;
      const my = mul?.[1] ?? 1;
      const mz = mul?.[2] ?? 1;
      const ox = (off?.[0] ?? 0) * DEG2RAD;
      const oy = (off?.[1] ?? 0) * DEG2RAD;
      const oz = (off?.[2] ?? 0) * DEG2RAD;

      // Identity calibration → leave the rotation untouched (avoids needless
      // decompose/recompose drift on bones the user added but left at defaults).
      if (mx === 1 && my === 1 && mz === 1 && ox === 0 && oy === 0 && oz === 0)
        return q;

      const { pitch, yaw, roll } = q.toEuler();
      return Quaternion.fromEuler(
        pitch * mx + ox,
        yaw * my + oy,
        roll * mz + oz
      );
    });
  };
}
