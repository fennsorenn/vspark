import { SignalNode, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'

@SignalNode({
  label:       'Time',
  description: 'Lazily outputs the current time in seconds (Date.now() / 1000). Pulls a fresh value on every evaluation — no setup required.',
  tags:        ['source', 'math'],
  color:       '#4a7a5a',
})
export class Time {
  static readonly kind        = 'time'
  static readonly inputPorts  = [] as const
  static readonly outputPorts = [
    valuePort('seconds', 'Float'),
  ] as const

  static execute(
    _inputs: InputsOf<typeof Time>,
    _config: unknown,
    _ctx:    NodeExecutionContext,
  ): OutputsOf<typeof Time> {
    return { seconds: Date.now() / 1000 }
  }
}
