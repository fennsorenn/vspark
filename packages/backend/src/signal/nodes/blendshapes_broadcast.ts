import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { WSSync } from '../../ws/index.js'

let _ws: WSSync | null = null
export function initBlendshapesBroadcast(ws: WSSync): void { _ws = ws }

@SignalNode({
  label:       'Blendshapes Broadcast',
  description: 'Broadcasts VRM expression weights to all WebSocket clients, addressed to the scene entity node.',
  tags:        ['output'],
  color:       '#7a3a6a',
})
export class BlendshapesBroadcast {
  static readonly kind        = 'blendshapes_broadcast'
  static readonly inputPorts  = [
    eventPort('trigger',     'Trigger'),
    valuePort('blendshapes', 'Blendshapes'),
    valuePort('nodeId',      'EntityId'),
  ] as const
  static readonly outputPorts = [] as const

  static execute(
    inputs: InputsOf<typeof BlendshapesBroadcast>,
    _config: unknown,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof BlendshapesBroadcast> {
    const nodeId      = inputs.nodeId      as string | undefined
    const blendshapes = inputs.blendshapes as import('@vspark/shared/signal').Blendshapes | undefined
    if (!nodeId || !blendshapes) return {}
    _ws?.broadcast('vmc_blendshapes', { nodeId, blendshapes: blendshapes.toRecord() })
    return {}
  }
}
