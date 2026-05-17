import {
  SignalNode, valuePort,
  Blendshapes,
} from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import { ARKIT_SHAPES, ARKIT_TO_VRM, ARKIT_TO_FCL } from '@vspark/shared/arkit'

export { ARKIT_SHAPES, ARKIT_TO_VRM, ARKIT_TO_FCL }
export type ArkitShape = typeof ARKIT_SHAPES[number]

export type ArkitMapperMode = 'expressions' | 'fcl' | 'passthrough'

export interface ArkitVrmMapperConfig {
  mode?: ArkitMapperMode
}

// ──────────────────────────────────────────────────────────────────────────────
// Node
// ──────────────────────────────────────────────────────────────────────────────

@SignalNode({
  label:       'ARKit → VRM Mapper',
  description: 'Maps raw ARKit 52-shape weights to VRM expression names, or passes them through unchanged for direct morph-target driving.',
  tags:        ['mapping', 'face'],
  color:       '#5a3a2a',
})
export class ArkitVrmMapper {
  static readonly kind        = 'arkit_vrm_mapper'
  static readonly inputPorts  = [
    valuePort('arkit',   'ArkitBlendshapes'),
    valuePort('enabled', 'Bool'),
    valuePort('mapping', 'MappingTable'),
  ] as const
  static readonly outputPorts = [valuePort('blendshapes', 'Blendshapes')] as const

  static execute(
    inputs: InputsOf<typeof ArkitVrmMapper>,
    config: ArkitVrmMapperConfig,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof ArkitVrmMapper> {
    if ((inputs.enabled as boolean | undefined) === false) {
      return { blendshapes: Blendshapes.fromRecord({}) }
    }

    const arkit = inputs.arkit as Blendshapes | undefined
    if (!arkit) return { blendshapes: Blendshapes.fromRecord({}) }

    const mode          = config.mode ?? 'expressions'
    const customMapping = inputs.mapping as Record<string, [string, number][]> | null | undefined

    const builtinTable: Partial<Record<string, [string, number][]>> =
      mode === 'fcl' ? ARKIT_TO_FCL : mode === 'expressions' ? ARKIT_TO_VRM : {}
    const effectiveTable = customMapping ? { ...builtinTable, ...customMapping } : builtinTable

    if (mode === 'passthrough' && !customMapping) return { blendshapes: arkit }

    const accum: Record<string, number> = {}
    for (const [arkitName, weight] of arkit.entries()) {
      const mappings = effectiveTable[arkitName]
      if (mode === 'passthrough' && !mappings) { accum[arkitName] = (accum[arkitName] ?? 0) + weight; continue }
      if (!mappings) continue
      for (const [target, scale] of mappings) accum[target] = (accum[target] ?? 0) + weight * scale
    }
    const clamped: Record<string, number> = {}
    for (const [k, v] of Object.entries(accum)) clamped[k] = Math.min(1, Math.max(0, v))
    return { blendshapes: Blendshapes.fromRecord(clamped) }
  }
}
