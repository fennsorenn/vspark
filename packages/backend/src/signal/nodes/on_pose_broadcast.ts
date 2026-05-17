import { SignalNode, eventPort, valuePort, mkEvent } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext, NormalizedPose } from '@vspark/shared/signal'
import type { InterceptorFrame } from '@vspark/shared/signal'
import { poseInterceptorRegistry } from '../pose_interceptor_registry.js'

interface OnPoseBroadcastState {
  frame: InterceptorFrame | null
}

@SignalNode({
  label:       'On Pose Broadcast',
  description: 'Intercepts the pose before it is broadcast. Wire trigger into your processing pipeline and frame into a Pose Interceptor Broadcast node at the end. Priority controls order; higher runs first.',
  tags:        ['interceptor'],
  color:       '#4a6a9f',
})
export class OnPoseBroadcast {
  static readonly kind        = 'on_pose_broadcast'
  static readonly inputPorts  = [] as const
  static readonly outputPorts = [
    eventPort('trigger', 'Trigger'),
    valuePort('frame',   'InterceptorFrame'),
    valuePort('pose',    'NormalizedPose'),
  ] as const

  static execute(
    _inputs: InputsOf<typeof OnPoseBroadcast>,
    _config: unknown,
    ctx:     NodeExecutionContext,
  ): OutputsOf<typeof OnPoseBroadcast> {
    const state = ctx.getState<OnPoseBroadcastState>()
    const frame = state?.frame ?? null
    if (!frame) return {} as OutputsOf<typeof OnPoseBroadcast>
    return { trigger: mkEvent(undefined), frame, pose: frame.pose }
  }

  /**
   * Called by the component host after the graph is built to wire this node
   * into the interceptor registry for the given scene nodeId.
   *
   * The host must pass a `setNodeState` callback so the registry can inject
   * the InterceptorFrame before firing the trigger event.
   * Returns an unregister function that must be called on graph teardown.
   */
  static register(
    sceneNodeId:  string,
    graphNodeId:  string,
    priority:     number,
    setNodeState: (graphNodeId: string, state: unknown) => void,
    fireEvent:    (graphNodeId: string, port: string, value: unknown) => void,
  ): () => void {
    return poseInterceptorRegistry.register(sceneNodeId, {
      priority,
      fire: (_nodeId: string, pose: NormalizedPose, prio: number) => {
        const frame: InterceptorFrame = { nodeId: sceneNodeId, pose, priority: prio }
        // Write frame into node state first so execute() can read it when triggered.
        setNodeState(graphNodeId, { frame })
        fireEvent(graphNodeId, 'trigger', mkEvent(undefined))
      },
    })
  }
}
