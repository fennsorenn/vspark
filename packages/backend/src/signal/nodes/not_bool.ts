import { SignalNode, valuePort } from '@vspark/shared/signal'
import type { InputsOf, NodeExecutionContext, OutputsOf } from '@vspark/shared/signal'

@SignalNode({
  label:       'NOT',
  description: 'Boolean negation. Outputs !value. Treats null/undefined as false (so output defaults to true).',
  tags:        ['logic'],
  color:       '#3a3a3a',
})
export class NotBool {
  static readonly kind        = 'not_bool'
  static readonly inputPorts  = [valuePort('value', 'Bool')] as const
  static readonly outputPorts = [valuePort('result', 'Bool')] as const

  static execute(
    inputs: InputsOf<typeof NotBool>,
    _config: unknown,
    _ctx: NodeExecutionContext,
  ): OutputsOf<typeof NotBool> {
    const v = inputs.value as boolean | null | undefined
    return { result: !(v ?? false) }
  }
}
