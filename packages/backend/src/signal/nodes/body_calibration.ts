import { SignalNode, NormalizedPose, Quaternion } from '@vspark/shared/signal';
import type { VRMBoneName } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut, eventIn } from '@vspark/shared/node_decorators';

interface CalibrationState {
  bodyOffsets: Record<string, [number, number, number, number]>;
}

const EMPTY_STATE: CalibrationState = { bodyOffsets: {} };

export interface BodyCalibConfig {
  /**
   * Optional whitelist of VRM bone names this node captures and corrects.
   * When set, capture only stores offsets for listed bones, and apply only
   * corrects those bones — others pass through unchanged.
   * When absent, all bones are captured and corrected.
   */
  boneFilter?: readonly string[];
  /**
   * Optional pairs of [leftBone, rightBone] for symmetric body parts. On capture, if only
   * one side has a valid quaternion (e.g. the user could only present one hand because the
   * other was needed to click the button), the missing side is filled with the X-axis-mirrored
   * quaternion from the captured side. Both sides captured → both kept as-is.
   */
  mirrorPairs?: readonly (readonly [string, string])[];
}

/**
 * Removes neutral-pose bias from a configurable set of bones.
 *
 * Triggers:
 *   capture — snapshot the current incoming pose as the neutral reference
 *   reset   — clear all offsets, pass through pose unmodified
 *
 * Correction formula: q_out = offset⁻¹ × q_in. The corrected pose is a PULL output
 * (`pose`) computed from the current input + stored offsets; capture/reset are event
 * handlers that mutate the stored offsets.
 *
 * Multiple instances can be chained in the graph for independent per-region
 * calibration (e.g. head chain, left arm, right arm) by setting boneFilter.
 */
@SignalNode({
  label: 'Body Calibration',
  description:
    'Removes neutral-pose bias. Use capture/reset triggers to calibrate.',
  tags: ["mocap"],
  color: '#4a5a9f',
})
export class BodyCalibration extends Node {
  static readonly kind = 'body_calibration';

  @valueIn('pose', 'NormalizedPose') poseIn!: () => NormalizedPose | undefined;
  @valueIn('mirrorSource', 'String') mirrorSource!: () =>
    | string
    | null
    | undefined;

  @valueOut('pose', 'NormalizedPose')
  pose = (): NormalizedPose | undefined => {
    const pose = this.poseIn();
    if (!pose) return undefined;
    const { bodyOffsets } = this.getState<CalibrationState>() ?? EMPTY_STATE;
    if (!bodyOffsets || Object.keys(bodyOffsets).length === 0) return pose;

    return pose.map((q, bone: VRMBoneName) => {
      const raw = bodyOffsets[bone as string];
      if (!raw) return q;
      const offset = Quaternion.fromArray(
        raw as [number, number, number, number]
      );
      return offset.isValid ? offset.invert().multiply(q) : q;
    });
  };

  @eventIn('capture', 'Trigger')
  onCapture(): void {
    const config = this.config as BodyCalibConfig;
    const filter = config.boneFilter ? new Set(config.boneFilter) : null;
    const pose = this.poseIn();
    if (!pose) return;

    const bodyOffsets: Record<string, [number, number, number, number]> = {};
    for (const [bone, q] of pose.entries()) {
      if (filter && !filter.has(bone as string)) continue;
      if (!q.isValid) continue;
      bodyOffsets[bone as string] = q.toArray();
    }
    // Symmetric fill across left/right pairs. X-axis mirror for unit quaternions:
    // (x, y, z, w) → (x, -y, -z, w).
    if (config.mirrorPairs) {
      const src = this.mirrorSource() as 'left' | 'right' | null | undefined;
      let mirrored = 0;
      for (const [a, b] of config.mirrorPairs) {
        const leftName = a;
        const rightName = b;
        const hasL = leftName in bodyOffsets;
        const hasR = rightName in bodyOffsets;

        if (src === 'left' && hasL) {
          const [x, y, z, w] = bodyOffsets[leftName];
          bodyOffsets[rightName] = [x, -y, -z, w];
          mirrored++;
        } else if (src === 'right' && hasR) {
          const [x, y, z, w] = bodyOffsets[rightName];
          bodyOffsets[leftName] = [x, -y, -z, w];
          mirrored++;
        } else if (hasL && !hasR) {
          const [x, y, z, w] = bodyOffsets[leftName];
          bodyOffsets[rightName] = [x, -y, -z, w];
          mirrored++;
        } else if (hasR && !hasL) {
          const [x, y, z, w] = bodyOffsets[rightName];
          bodyOffsets[leftName] = [x, -y, -z, w];
          mirrored++;
        }
      }
      if (mirrored > 0)
        console.log(
          `[BodyCalibration] Mirrored ${mirrored} offsets (source=${src ?? 'auto'})`
        );
    }
    this.setState({ bodyOffsets } satisfies CalibrationState);
    console.log(
      `[BodyCalibration] Captured ${Object.keys(bodyOffsets).length} bone offsets`
    );
  }

  @eventIn('reset', 'Trigger')
  onReset(): void {
    this.setState(EMPTY_STATE);
  }
}
