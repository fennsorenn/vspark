import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext, NormalizedPose } from '@vspark/shared/signal'
import type { AnimationBlendMode } from '@vspark/shared'
import type { WSSync } from '../../ws/index.js'
import { broadcastBus } from '../../broadcast/bus.js'

let _ws: WSSync | null = null
export function initPoseBroadcast(ws: WSSync): void {
  _ws = ws
  broadcastBus.init(ws)
}

/** Legacy direct emit, retained for any caller that needs to bypass the bus.
 *  All graph nodes should publish through the bus instead. */
export function broadcastPose(nodeId: string, pose: NormalizedPose): void {
  _ws?.broadcast('vmc_pose', { nodeId, bones: pose.toRecord() })
}

@SignalNode({
  label:       'Pose Broadcast',
  description: 'Publishes the processed NormalizedPose to the Broadcast Bus. The bus composes slots from all producers attached to this entity and emits a merged pose on each scene tick.',
  tags:        ['output'],
  color:       '#7a3a6a',
})
export class PoseBroadcast {
  static readonly kind        = 'pose_broadcast'
  static readonly inputPorts  = [
    eventPort('trigger',            'Trigger'),
    valuePort('pose',               'NormalizedPose'),
    valuePort('nodeId',             'EntityId'),
    valuePort('componentId',        'String'),
    valuePort('priority',           'Float'),
    valuePort('animationBlendMode', 'String'),
  ] as const
  static readonly outputPorts = [] as const

  static execute(
    inputs: InputsOf<typeof PoseBroadcast>,
    _config: unknown,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof PoseBroadcast> {
    const nodeId      = inputs.nodeId      as string | undefined
    const componentId = inputs.componentId as string | undefined
    const pose        = inputs.pose        as NormalizedPose | undefined
    if (!nodeId || !componentId || !pose) return {}
    const priority = _asPriority(inputs.priority)
    const mode     = _asMode(inputs.animationBlendMode)
    broadcastBus.publishBones(nodeId, componentId, pose, priority, mode)
    return {}
  }
}

function _asPriority(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return 0
}

function _asMode(v: unknown): AnimationBlendMode {
  return v === 'additive' ? 'additive' : 'override'
}
