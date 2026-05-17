import { SignalNode, eventPort, mkEvent } from '@vspark/shared/signal'
import type { OutputsOf, NodeExecutionContext, Blendshapes } from '@vspark/shared/signal'

@SignalNode({
  label:       'Lipsync Source',
  description: 'Entry point for viseme weights pushed from the browser mic analyser. Fired by LipsyncManager on each analysis frame.',
  tags:        ['input'],
  color:       '#4a7a5a',
  internal:    true,
})
export class LipsyncSource {
  static readonly kind        = 'lipsync_source'
  static readonly inputPorts  = [] as const
  static readonly outputPorts = [eventPort('visemes', 'Blendshapes')] as const

  static execute(
    _inputs: Record<string, unknown>,
    _config: unknown,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof LipsyncSource> {
    const bs = ctx.getState<Blendshapes | null>() ?? null
    if (!bs) return {} as OutputsOf<typeof LipsyncSource>
    return { visemes: mkEvent(bs) }
  }
}
