import { SignalNode, valuePort } from '@vspark/shared/signal'
import type { OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'

export interface SceneEntityConfig { nodeId: string }

@SignalNode({
  label:       'Scene Entity',
  description: 'Provides the ID of the scene node this component is attached to. Use as input to model property nodes.',
  tags:        ['context'],
  color:       '#2a2a4a',
  internal:    true,
})
export class SceneEntity {
  static readonly kind        = 'scene_entity'
  static readonly inputPorts  = [] as const
  static readonly outputPorts = [valuePort('nodeId', 'EntityId')] as const

  static execute(_: Record<string, never>, config: SceneEntityConfig, _ctx: NodeExecutionContext): OutputsOf<typeof SceneEntity> {
    return { nodeId: config.nodeId }
  }
}
