import { SignalNode, mkEvent } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventOut, valueOut } from '@vspark/shared/node_decorators';
import type {
  Blendshapes,
  BlendshapeInterceptorFrame,
} from '@vspark/shared/signal';
import { blendshapeInterceptorRegistry } from '../blendshape_interceptor_registry.js';

interface OnBlendshapesBroadcastState {
  frame: BlendshapeInterceptorFrame | null;
}

/**
 * Intercepts the merged blendshape frame before broadcast — the blendshape twin
 * of `on_pose_broadcast`. The interceptor registry injects a
 * `BlendshapeInterceptorFrame` into node state (via the manager's setNodeState)
 * and fires `trigger`; downstream pulls `frame` / `blendshapes` (value outputs
 * read from that state). Wiring is set up out-of-band by
 * `OnBlendshapesBroadcast.register(...)`.
 */
@SignalNode({
  label: 'Intercept Blendshapes',
  description:
    'Intercepts VRM expression weights before they are broadcast. Wire trigger into your processing pipeline and frame into a Send Intercepted Blendshapes node at the end. Priority controls order; higher runs first.',
  tags: ['output'],
  color: '#7a3a6a',
})
export class OnBlendshapesBroadcast extends Node {
  static readonly kind = 'on_blendshapes_broadcast';

  @eventOut('trigger', 'Trigger') trigger!: Emitter<void>;

  @valueOut('frame', 'BlendshapeInterceptorFrame')
  frame = (): BlendshapeInterceptorFrame | undefined =>
    this.getState<OnBlendshapesBroadcastState>()?.frame ?? undefined;

  @valueOut('blendshapes', 'Blendshapes')
  blendshapes = (): Blendshapes | undefined =>
    this.getState<OnBlendshapesBroadcastState>()?.frame?.blendshapes ??
    undefined;

  /**
   * Wire this node into the blendshape interceptor registry for the given scene
   * nodeId. The host passes setNodeState (to inject the frame before firing
   * trigger) and fireEvent. Returns an unregister function for graph teardown.
   */
  static register(
    sceneNodeId: string,
    graphNodeId: string,
    priority: number,
    setNodeState: (graphNodeId: string, state: unknown) => void,
    fireEvent: (graphNodeId: string, port: string, value: unknown) => void
  ): () => void {
    return blendshapeInterceptorRegistry.register(sceneNodeId, {
      priority,
      fire: (_nodeId: string, blendshapes: Blendshapes, prio: number) => {
        const frame: BlendshapeInterceptorFrame = {
          nodeId: sceneNodeId,
          blendshapes,
          priority: prio,
        };
        setNodeState(graphNodeId, {
          frame,
        } satisfies OnBlendshapesBroadcastState);
        fireEvent(graphNodeId, 'trigger', mkEvent(undefined));
      },
    });
  }
}
