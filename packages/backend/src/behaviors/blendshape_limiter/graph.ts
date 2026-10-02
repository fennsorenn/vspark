import type { GraphDescriptor } from '@vspark/shared/signal';

/**
 * Expression limits pipeline (blendshape interceptor).
 *
 * Splices into the avatar's blendshape stream:
 *
 *   Intercept Blendshapes → Expression Limits → Send Intercepted Blendshapes
 *
 * The rule set is exposed as a `behavior_config` (Behavior Settings) node
 * reading the behavior's `limits` field and wired into the Expression Limits
 * node — so the input is visible on the graph, not pulled from config behind the
 * node's back. The interceptor registration (scene-node binding + priority) is
 * wired out-of-band by the manager via `OnBlendshapesBroadcast.register`,
 * mirroring the manual calibration behavior.
 *
 * Priority 5 matches the manual-calibration default: the limiter is a corrective
 * pass, so anything a user adds later at a higher priority runs first and the
 * limiter still gets the last word before broadcast.
 */
export const BLENDSHAPE_LIMITER_TEMPLATE: Omit<GraphDescriptor, 'id'> = {
  label: 'Expression Limits',
  readonly: true,
  nodes: [
    {
      id: 'intercept',
      kind: 'on_blendshapes_broadcast',
      position: { x: -300, y: 0 },
      defaultConfig: { priority: 5 },
    },
    {
      id: 'cfg_limits',
      kind: 'behavior_config',
      position: { x: -300, y: 160 },
      defaultConfig: { field: 'limits', defaultValue: {} },
    },
    {
      id: 'limits',
      kind: 'blendshape_limits',
      position: { x: 60, y: 0 },
    },
    {
      id: 'send',
      kind: 'blendshapes_interceptor_broadcast',
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
    // Blendshapes: intercept → limits → terminal
    {
      fromNodeId: 'intercept',
      fromPort: 'blendshapes',
      toNodeId: 'limits',
      toPort: 'blendshapes',
      kind: 'value',
    },
    // Behavior settings: the rule set → limits node
    {
      fromNodeId: 'cfg_limits',
      fromPort: 'value',
      toNodeId: 'limits',
      toPort: 'limits',
      kind: 'value',
    },
    {
      fromNodeId: 'limits',
      fromPort: 'blendshapes',
      toNodeId: 'send',
      toPort: 'blendshapes',
      kind: 'value',
    },
  ],
};

export function makeBlendshapeLimiterGraphDescriptor(
  behaviorId: string
): GraphDescriptor {
  return {
    ...BLENDSHAPE_LIMITER_TEMPLATE,
    id: `blendshape_limiter:${behaviorId}`,
  };
}
