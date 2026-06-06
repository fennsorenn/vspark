import { SignalNode, mkEvent } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventOut, valueOut } from '@vspark/shared/node_decorators';
import type { NormalizedPose, InterceptorFrame } from '@vspark/shared/signal';
import { poseInterceptorRegistry } from '../pose_interceptor_registry.js';

interface OnPoseBroadcastState {
  frame: InterceptorFrame | null;
}

/**
 * Intercepts the pose before broadcast. The interceptor registry injects an
 * InterceptorFrame into node state (via the manager's setNodeState) and fires `trigger`;
 * downstream pulls `frame` / `pose` (value outputs read from that state). Wiring is set up
 * out-of-band by `OnPoseBroadcast.register(...)`.
 */
@SignalNode({
  label: 'Intercept Pose',
  description:
    'Intercepts the pose before it is broadcast. Wire trigger into your processing pipeline and frame into a Pose Interceptor Broadcast node at the end. Priority controls order; higher runs first.',
  tags: ['interceptor'],
  color: '#4a6a9f',
})
export class OnPoseBroadcast extends Node {
  static readonly kind = 'on_pose_broadcast';

  @eventOut('trigger', 'Trigger') trigger!: Emitter<void>;

  @valueOut('frame', 'InterceptorFrame')
  frame = (): InterceptorFrame | undefined =>
    this.getState<OnPoseBroadcastState>()?.frame ?? undefined;

  @valueOut('pose', 'NormalizedPose')
  pose = (): NormalizedPose | undefined =>
    this.getState<OnPoseBroadcastState>()?.frame?.pose ?? undefined;

  /**
   * Wire this node into the interceptor registry for the given scene nodeId. The host
   * passes setNodeState (to inject the InterceptorFrame before firing trigger) and
   * fireEvent. Returns an unregister function for graph teardown. Unchanged from the
   * pre-Phase-2 model.
   */
  static register(
    sceneNodeId: string,
    graphNodeId: string,
    priority: number,
    setNodeState: (graphNodeId: string, state: unknown) => void,
    fireEvent: (graphNodeId: string, port: string, value: unknown) => void
  ): () => void {
    return poseInterceptorRegistry.register(sceneNodeId, {
      priority,
      fire: (_nodeId: string, pose: NormalizedPose, prio: number) => {
        const frame: InterceptorFrame = {
          nodeId: sceneNodeId,
          pose,
          priority: prio,
        };
        setNodeState(graphNodeId, { frame } satisfies OnPoseBroadcastState);
        fireEvent(graphNodeId, 'trigger', mkEvent(undefined));
      },
    });
  }
}
