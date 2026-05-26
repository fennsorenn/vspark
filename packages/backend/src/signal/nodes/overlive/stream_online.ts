import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { StreamOnlineEvent } from '@overlive/core'
import { handleOverliveEvent } from './_helpers.js'

@SignalNode({
  label:       'Overlive Stream Online',
  description: 'Fires when the configured account goes live. Title may be empty until the platform populates stream info.',
  tags:        ['overlive', 'input'],
  color:       '#9146ff',
})
export class OverliveStreamOnline {
  static readonly kind = 'overlive_stream_online'
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    eventPort('event',   'Any'),
  ] as const
  static readonly outputPorts = [
    eventPort('event',    'Trigger'),
    valuePort('title',    'String'),
    valuePort('category', 'String'),
    valuePort('language', 'String'),
  ] as const

  static execute(
    inputs: InputsOf<typeof OverliveStreamOnline>,
    _config: unknown,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof OverliveStreamOnline> {
    return handleOverliveEvent<StreamOnlineEvent, { title: string; category: string; language: string }>(
      inputs,
      ctx,
      (e) => ({
        title:    e.data.title ?? '',
        category: e.data.category ?? '',
        language: e.data.language ?? '',
      }),
      { title: '', category: '', language: '' },
    ) as OutputsOf<typeof OverliveStreamOnline>
  }
}
