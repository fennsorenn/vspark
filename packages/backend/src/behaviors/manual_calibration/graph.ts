import type { GraphDescriptor } from '@vspark/shared/signal';

/**
 * Manual calibration pipeline (pose interceptor).
 *
 * Splices into the avatar's pose stream:
 *
 *   Intercept Pose → Manual Calibration → Send Intercepted Pose
 *
 * The per-bone calibration map is exposed as a `behavior_config` (Behavior
 * Settings) node reading the behavior's `calibrations` field and wired into the
 * Manual Calibration node — so the input is visible on the graph, not pulled
 * from config behind the node's back. The interceptor registration (scene-node
 * binding + priority) is wired out-of-band by the manager via
 * `OnPoseBroadcast.register`, mirroring the VMC receiver.
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
      id: 'cfg_calibrations',
      kind: 'behavior_config',
      position: { x: -300, y: 160 },
      defaultConfig: { field: 'calibrations', defaultValue: {} },
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
    // Behavior settings: per-bone calibration map → calibration node
    {
      fromNodeId: 'cfg_calibrations',
      fromPort: 'value',
      toNodeId: 'calib',
      toPort: 'calibrations',
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
