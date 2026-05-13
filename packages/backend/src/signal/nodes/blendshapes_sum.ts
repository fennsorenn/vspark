import { SignalNode, listPort, valuePort, Blendshapes } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'

/**
 * Additively merges any number of Blendshapes sources (clamped to [0,1]).
 * The `sources` list port accepts multiple incoming value connections — each
 * connected mapper feeds into the same port and all contributions are summed.
 */
@SignalNode({
  label:       'Blendshapes Sum',
  description: 'Additively merges blendshape sources. Connect any number of mapper outputs to the sources list port.',
  tags:        ['mapping', 'face'],
  color:       '#5a4a2a',
})
export class BlendshapesSum {
  static readonly kind        = 'blendshapes_sum'
  static readonly inputPorts  = [listPort('sources', 'Blendshapes')] as const
  static readonly outputPorts = [valuePort('blendshapes', 'Blendshapes')] as const

  static execute(
    inputs: InputsOf<typeof BlendshapesSum>,
    _config: unknown,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof BlendshapesSum> {
    const accum: Record<string, number> = {}
    for (const bs of (inputs.sources as Blendshapes[])) {
      for (const [name, val] of bs.entries()) {
        accum[name as string] = Math.min(1, (accum[name as string] ?? 0) + val)
      }
    }
    return { blendshapes: Blendshapes.fromRecord(accum) }
  }
}
