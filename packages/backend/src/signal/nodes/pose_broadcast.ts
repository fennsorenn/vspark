import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { WSSync } from '../../ws/index.js'

let _ws: WSSync | null = null
export function initPoseBroadcast(ws: WSSync): void { _ws = ws }

@SignalNode({
  label:       'Pose Broadcast',
  description: 'Broadcasts the processed NormalizedPose to all WebSocket clients, addressed to the scene entity node.',
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
    const pose   = inputs.pose   as import('@vspark/shared/signal').NormalizedPose | undefined
    if (!nodeId || !pose) return {}
    _ws?.broadcast('vmc_pose', { nodeId, bones: pose.toRecord() })
    return {}
  }
}
