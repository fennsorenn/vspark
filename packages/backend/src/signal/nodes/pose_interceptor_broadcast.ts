import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext, NormalizedPose, InterceptorFrame } from '@vspark/shared/signal'
import { poseInterceptorRegistry } from '../pose_interceptor_registry.js'
import { broadcastBus } from '../../broadcast/bus.js'

@SignalNode({
  label:       'Pose Interceptor Broadcast',
  description: 'Advances the pose interceptor chain. Wire the frame from On Pose Broadcast and the (optionally modified) pose, then connect trigger from the end of your pipeline.',
  tags:        ['interceptor', 'output'],
  color:       '#4a6a9f',
})
export class PoseInterceptorBroadcast {
  static readonly kind        = 'pose_interceptor_broadcast'
  static readonly inputPorts  = [
    eventPort('trigger', 'Trigger'),
    valuePort('frame',   'InterceptorFrame'),
    valuePort('pose',    'NormalizedPose'),
  ] as const
  static readonly outputPorts = [] as const

  static execute(
    inputs:  InputsOf<typeof PoseInterceptorBroadcast>,
    _config: unknown,
    _ctx:    NodeExecutionContext,
  ): OutputsOf<typeof PoseInterceptorBroadcast> {
    const frame = inputs.frame as InterceptorFrame | undefined
    const pose  = inputs.pose  as NormalizedPose  | undefined
    if (!frame || !pose) return {}
    poseInterceptorRegistry.advance(frame.nodeId, frame.priority, pose, (nodeId, finalPose) => {
      broadcastBus.emitMergedPose(nodeId, finalPose)
    })
    return {}
  }
}
