import { SignalNode, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'

export interface ArkitMapperConfigConfig {
  enabled?: boolean
  mapping?: Record<string, [string, number][]> | null
}

@SignalNode({
  label:       'ARKit Mapper Config',
  description: 'Supplies the enabled flag and optional custom mapping table to an ARKit VRM mapper node.',
  tags:        ['config', 'face'],
  color:       '#3a2a1a',
  internal:    true,
})
export class ArkitMapperConfig {
  static readonly kind        = 'arkit_mapper_config'
  static readonly inputPorts  = [] as const
  static readonly outputPorts = [
    valuePort('enabled', 'Bool'),
    valuePort('mapping', 'MappingTable'),
  ] as const

  static execute(
    _inputs: InputsOf<typeof ArkitMapperConfig>,
    config: ArkitMapperConfigConfig,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof ArkitMapperConfig> {
    return {
      enabled: config.enabled ?? true,
      mapping: config.mapping ?? null,
    }
  }
}
