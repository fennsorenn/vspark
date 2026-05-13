import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'

/**
 * Emits a Trigger event when fired externally via graph.fire(nodeId, 'trigger', event).
 * The `button` value input names the button label shown in the component's property panel —
 * wire it or set it statically. execute() is a no-op; the node is fired from, not delivered to.
 */
@SignalNode({
  label:       'Component Trigger',
  description: 'Emits a trigger event when its button is pressed in the component property panel.',
  tags:        ['input'],
  color:       '#3a3a5a',
})
export class ManualTrigger {
  static readonly kind        = 'component_trigger'
  static readonly inputPorts  = [valuePort('button', 'String')] as const
  static readonly outputPorts = [eventPort('trigger', 'Trigger')] as const

  static execute(
    _inputs: InputsOf<typeof ManualTrigger>,
    __:      unknown,
    ___:     NodeExecutionContext,
  ): OutputsOf<typeof ManualTrigger> {
    return {} as OutputsOf<typeof ManualTrigger>
  }
}
