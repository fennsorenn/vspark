import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { StreamOfflineEvent } from '@overlive/core'
import { handleOverliveEvent } from './_helpers.js'

@SignalNode({
  label:       'Overlive Stream Offline',
  description: 'Fires when the configured account goes offline.',
  tags:        ['overlive', 'input'],
  color:       '#9146ff',
})
export class OverliveStreamOffline {
  static readonly kind = 'overlive_stream_offline'
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    eventPort('event',   'Any'),
  ] as const
  static readonly outputPorts = [
    eventPort('event', 'Trigger'),
  ] as const

  static execute(
    inputs: InputsOf<typeof OverliveStreamOffline>,
    _config: unknown,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof OverliveStreamOffline> {
    return handleOverliveEvent<StreamOfflineEvent, Record<string, never>>(
      inputs,
      ctx,
      () => ({}),
      {},
    ) as OutputsOf<typeof OverliveStreamOffline>
  }
}
