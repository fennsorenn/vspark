import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { IkTargetFrame } from '@vspark/shared/types'
import { WSSync } from '../../ws/index.js'

let _ws: WSSync | null = null
export function initIkBroadcast(ws: WSSync): void { _ws = ws }

@SignalNode({
  label:       'IK Broadcast',
  description: 'Broadcasts an IkTargetFrame to all WebSocket clients as a pose_ik_targets message. Reference bone is set by the upstream IK targets node config.',
  tags:        ['output'],
  color:       '#7a3a9a',
})
export class IkBroadcast {
  static readonly kind        = 'ik_broadcast'
  static readonly inputPorts  = [
    eventPort('trigger', 'Trigger'),
    valuePort('targets', 'IkTargets'),
    valuePort('nodeId',  'EntityId'),
    valuePort('enabled', 'Bool'),
  ] as const
  static readonly outputPorts = [] as const

  static execute(
    inputs: InputsOf<typeof IkBroadcast>,
    _config: unknown,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof IkBroadcast> {
    const enabled = (inputs.enabled as boolean | null | undefined) ?? true
    if (!enabled) return {}
    const nodeId  = inputs.nodeId  as string       | undefined
    const targets = inputs.targets as IkTargetFrame | undefined
    if (!nodeId || !targets) return {}
    _ws?.broadcast('pose_ik_targets', { ...targets, nodeId })
    return {}
  }
}
