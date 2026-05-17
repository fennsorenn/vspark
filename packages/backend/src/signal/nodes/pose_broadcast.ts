import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext, NormalizedPose } from '@vspark/shared/signal'
import type { WSSync } from '../../ws/index.js'
import { poseInterceptorRegistry } from '../pose_interceptor_registry.js'

let _ws: WSSync | null = null
export function initPoseBroadcast(ws: WSSync): void { _ws = ws }

export function broadcastPose(nodeId: string, pose: NormalizedPose): void {
  _ws?.broadcast('vmc_pose', { nodeId, bones: pose.toRecord() })
}

@SignalNode({
  label:       'Pose Broadcast',
  description: 'Broadcasts the processed NormalizedPose to all WebSocket clients. If pose interceptor components are active for this node, they run first in priority order (highest first).',
  tags:        ['output'],
  color:       '#7a3a6a',
})
export class PoseBroadcast {
  static readonly kind        = 'pose_broadcast'
  static readonly inputPorts  = [
    eventPort('trigger', 'Trigger'),
    valuePort('pose',    'NormalizedPose'),
    valuePort('nodeId',  'EntityId'),
  ] as const
  static readonly outputPorts = [] as const

  static execute(
    inputs: InputsOf<typeof PoseBroadcast>,
    _config: unknown,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof PoseBroadcast> {
    const nodeId = inputs.nodeId as string | undefined
    const pose   = inputs.pose   as NormalizedPose | undefined
    if (!nodeId || !pose) return {}
    if (!poseInterceptorRegistry.start(nodeId, pose)) {
      broadcastPose(nodeId, pose)
    }
    return {}
  }
}
