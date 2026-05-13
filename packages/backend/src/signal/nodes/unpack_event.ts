import { SignalNode, eventPort, valuePort, mkEvent } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext, Event } from '@vspark/shared/signal'

@SignalNode({
  label:       'Unpack Event',
  description: 'Splits an event into a trigger and its payload value. Connect the trigger to broadcast nodes and pull the value from downstream processors.',
  tags:        ['utility'],
  color:       '#3a3a5a',
})
export class UnpackEvent {
  static readonly kind        = 'unpack_event'
  static readonly inputPorts  = [eventPort('event', 'Any')] as const
  static readonly outputPorts = [
    eventPort('trigger', 'Trigger'),
    valuePort('value',   'Any'),
  ] as const

  static execute(
    inputs: InputsOf<typeof UnpackEvent>,
    _config: unknown,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof UnpackEvent> {
    if (ctx.triggeredPort === 'event') {
      const evt     = inputs.event as Event<unknown>
      const payload = evt?.payload ?? null
      ctx.setState(payload)
      return { trigger: mkEvent(undefined, evt?.timestamp), value: payload } as OutputsOf<typeof UnpackEvent>
    }
    // Pull path — return the last stored payload.
    const payload = ctx.getState<unknown>() ?? null
    return { trigger: mkEvent(undefined), value: payload } as OutputsOf<typeof UnpackEvent>
  }
}
