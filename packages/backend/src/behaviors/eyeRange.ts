import type { GraphDescriptor } from '@vspark/shared/signal';
import { DEFAULT_EYE_INPUT_MAX_DEG } from '../signal/nodes/eye_range_map.js';

/** Behavior-config fields of the eye range stage (shared by every receiver). */
export const EYE_RANGE_ENABLED_FIELD = 'eyeRange.enabled';
export const EYE_RANGE_MAX_FIELD = 'eyeRange.inputMaxDeg';

/**
 * Insert the eye range stage (signal/nodes/eye_range_map.ts) at the end of a
 * receiver's bone chain: `<from>.pose → pose_out.pose` becomes
 * `<from>.pose → eye_range.pose → pose_out.pose`, with its two settings read
 * from the behavior config and the avatar from `scene_entity`.
 *
 * `defaultEnabled` is the receiver's default: on for sources that send raw
 * physical eye angles (iFacialMocap), off where senders usually fit the eyes to
 * the model already (VMC) — those keep their previous behaviour unless the user
 * opts in. (Decided by the user, 2026-10-06.)
 */
export function withEyeRangeStage(
  template: Omit<GraphDescriptor, 'id'>,
  opts: { fromNodeId: string; defaultEnabled: boolean }
): Omit<GraphDescriptor, 'id'> {
  const isChainEnd = (e: GraphDescriptor['edges'][number]) =>
    e.fromNodeId === opts.fromNodeId &&
    e.fromPort === 'pose' &&
    e.toNodeId === 'pose_out' &&
    e.toPort === 'pose';
  if (!template.edges.some(isChainEnd))
    throw new Error(
      `withEyeRangeStage: no ${opts.fromNodeId}.pose → pose_out.pose edge`
    );
  return {
    ...template,
    nodes: [
      ...template.nodes,
      {
        id: 'cfg_eye_range_en',
        kind: 'behavior_config',
        position: { x: 560, y: -80 },
        defaultConfig: {
          field: EYE_RANGE_ENABLED_FIELD,
          defaultValue: opts.defaultEnabled,
        },
      },
      {
        id: 'cfg_eye_range_max',
        kind: 'behavior_config',
        position: { x: 560, y: -160 },
        defaultConfig: {
          field: EYE_RANGE_MAX_FIELD,
          defaultValue: DEFAULT_EYE_INPUT_MAX_DEG,
        },
      },
      { id: 'eye_range', kind: 'eye_range_map', position: { x: 800, y: 80 } },
    ],
    edges: [
      ...template.edges.filter((e) => !isChainEnd(e)),
      {
        fromNodeId: opts.fromNodeId,
        fromPort: 'pose',
        toNodeId: 'eye_range',
        toPort: 'pose',
        kind: 'value',
      },
      {
        fromNodeId: 'eye_range',
        fromPort: 'pose',
        toNodeId: 'pose_out',
        toPort: 'pose',
        kind: 'value',
      },
      {
        fromNodeId: 'scene_entity',
        fromPort: 'nodeId',
        toNodeId: 'eye_range',
        toPort: 'nodeId',
        kind: 'value',
      },
      {
        fromNodeId: 'cfg_eye_range_en',
        fromPort: 'value',
        toNodeId: 'eye_range',
        toPort: 'enabled',
        kind: 'value',
      },
      {
        fromNodeId: 'cfg_eye_range_max',
        fromPort: 'value',
        toNodeId: 'eye_range',
        toPort: 'inputMaxDeg',
        kind: 'value',
      },
    ],
  };
}
