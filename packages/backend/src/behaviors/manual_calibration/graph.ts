import type { GraphDescriptor } from '@vspark/shared/signal';

/**
 * Manual calibration pipeline (pose interceptor).
 *
 * Splices into the avatar's pose stream:
 *
 *   Intercept Pose → Manual Calibration → Send Intercepted Pose
 *
 * The `pose_manual_calibration` node applies per-bone, per-axis multiplier +
 * offset (config supplied by the manager as `{ calibrations }`). The interceptor
 * registration (scene-node binding + priority) is wired out-of-band by the
 * manager via `OnPoseBroadcast.register`, mirroring the VMC receiver.
 */
export const MANUAL_CALIBRATION_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label: 'Manual Calibration',
  readonly: true,
  nodes: [
    {
      id: 'intercept',
      kind: 'on_pose_broadcast',
      position: { x: -300, y: 0 },
      defaultConfig: { priority: 5 },
    },
    {
      id: 'calib',
      kind: 'pose_manual_calibration',
      position: { x: 60, y: 0 },
    },
    {
      id: 'send',
      kind: 'pose_interceptor_broadcast',
      position: { x: 420, y: 0 },
    },
  ],
  edges: [
    // Event: intercept trigger → terminal trigger
    {
      fromNodeId: 'intercept',
      fromPort: 'trigger',
      toNodeId: 'send',
      toPort: 'trigger',
    },
    // Carry the interceptor frame (nodeId + priority) to the terminal
    {
      fromNodeId: 'intercept',
      fromPort: 'frame',
      toNodeId: 'send',
      toPort: 'frame',
      kind: 'value',
    },
    // Pose: intercept → calibration → terminal
    {
      fromNodeId: 'intercept',
      fromPort: 'pose',
      toNodeId: 'calib',
      toPort: 'pose',
      kind: 'value',
    },
    {
      fromNodeId: 'calib',
      fromPort: 'pose',
      toNodeId: 'send',
      toPort: 'pose',
      kind: 'value',
    },
  ],
};

export function makeManualCalibrationGraphDescriptor(
  behaviorId: string
): GraphDescriptor {
  return {
    ...MANUAL_CALIBRATION_TEMPLATE,
    id: `manual_calibration:${behaviorId}`,
  };
}
