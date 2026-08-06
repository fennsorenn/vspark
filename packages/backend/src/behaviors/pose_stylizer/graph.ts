import type { GraphDescriptor } from '@vspark/shared/signal';

/**
 * Stylized tracking pipeline (pose interceptor).
 *
 * Splices into the avatar's pose stream between whatever produced it (VMC, camera
 * tracking, …) and the broadcast:
 *
 *   Intercept Pose ──┬─→ Style Drivers ─→ Stylize Pose ─→ Send Intercepted Pose
 *                    └────────────────────↗
 *
 * The pose is tapped twice on purpose: `Style Drivers` reads it to summarise the
 * performance, while `Stylize Pose` needs the original as the base to blend
 * against and as the carrier for every bone the rig does not own.
 *
 * Every knob is surfaced as a `behavior_config` (Behavior Settings) node so
 * they are visible on the graph rather than read from config behind the nodes'
 * backs — same convention as the manual-calibration graph. Because node config
 * resolves live per access, edits in the properties panel hot-apply without a
 * graph rebuild.
 *
 * Interceptor registration (scene-node binding + priority) is wired out-of-band by
 * the manager via `OnPoseBroadcast.register`.
 *
 * Priority 8 puts the stylizer AHEAD of manual calibration (5) in the chain: the
 * pose is stylized first, and any manual per-bone trim the user has dialled in
 * then applies to the stylized result, which is the pose they can actually see.
 */
export const POSE_STYLIZER_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label: 'Stylized Tracking',
  readonly: true,
  nodes: [
    {
      id: 'intercept',
      kind: 'on_pose_broadcast',
      position: { x: -360, y: 0 },
      defaultConfig: { priority: 8 },
    },
    {
      id: 'cfg_response',
      kind: 'behavior_config',
      position: { x: -360, y: 200 },
      defaultConfig: { field: 'response', defaultValue: {} },
    },
    {
      id: 'cfg_amount',
      kind: 'behavior_config',
      position: { x: -360, y: 300 },
      defaultConfig: { field: 'amount', defaultValue: 1 },
    },
    {
      id: 'cfg_strength',
      kind: 'behavior_config',
      position: { x: -360, y: 380 },
      defaultConfig: { field: 'strength', defaultValue: 1 },
    },
    {
      id: 'cfg_lag',
      kind: 'behavior_config',
      position: { x: -360, y: 460 },
      // null (not a number) so an unset lag falls through to the preset's base.
      defaultConfig: { field: 'lag', defaultValue: null },
    },
    {
      id: 'cfg_preset',
      kind: 'behavior_config',
      position: { x: -360, y: 540 },
      defaultConfig: { field: 'preset', defaultValue: 'follow' },
    },
    {
      id: 'cfg_rig',
      kind: 'behavior_config',
      position: { x: -360, y: 620 },
      defaultConfig: { field: 'rig', defaultValue: null },
    },
    {
      id: 'cfg_rest_unmapped',
      kind: 'behavior_config',
      position: { x: -360, y: 700 },
      defaultConfig: { field: 'restUnmapped', defaultValue: false },
    },
    {
      id: 'drivers',
      kind: 'pose_style_drivers',
      position: { x: 0, y: 120 },
    },
    {
      id: 'stylize',
      kind: 'pose_stylize',
      position: { x: 340, y: 0 },
    },
    {
      id: 'send',
      kind: 'pose_interceptor_broadcast',
      position: { x: 700, y: 0 },
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
    // Pose tap 1: summarise the performance into drivers
    {
      fromNodeId: 'intercept',
      fromPort: 'pose',
      toNodeId: 'drivers',
      toPort: 'pose',
      kind: 'value',
    },
    // Pose tap 2: the base to blend against / carry unmapped bones
    {
      fromNodeId: 'intercept',
      fromPort: 'pose',
      toNodeId: 'stylize',
      toPort: 'pose',
      kind: 'value',
    },
    {
      fromNodeId: 'drivers',
      fromPort: 'drivers',
      toNodeId: 'stylize',
      toPort: 'drivers',
      kind: 'value',
    },
    // Behavior settings
    {
      fromNodeId: 'cfg_response',
      fromPort: 'value',
      toNodeId: 'drivers',
      toPort: 'response',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_amount',
      fromPort: 'value',
      toNodeId: 'stylize',
      toPort: 'amount',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_strength',
      fromPort: 'value',
      toNodeId: 'stylize',
      toPort: 'strength',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_lag',
      fromPort: 'value',
      toNodeId: 'stylize',
      toPort: 'lag',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_preset',
      fromPort: 'value',
      toNodeId: 'stylize',
      toPort: 'preset',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_preset',
      fromPort: 'value',
      toNodeId: 'drivers',
      toPort: 'preset',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_rig',
      fromPort: 'value',
      toNodeId: 'stylize',
      toPort: 'rig',
      kind: 'value',
    },
    {
      fromNodeId: 'cfg_rest_unmapped',
      fromPort: 'value',
      toNodeId: 'stylize',
      toPort: 'restUnmapped',
      kind: 'value',
    },
    {
      fromNodeId: 'stylize',
      fromPort: 'pose',
      toNodeId: 'send',
      toPort: 'pose',
      kind: 'value',
    },
  ],
};

export function makePoseStylizerGraphDescriptor(
  behaviorId: string
): GraphDescriptor {
  return {
    ...POSE_STYLIZER_TEMPLATE,
    id: `pose_stylizer:${behaviorId}`,
  };
}
