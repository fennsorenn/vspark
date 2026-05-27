import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { RaidEvent } from '@overlive/core'
import { handleOverliveEvent } from './_helpers.js'

/** Incoming raid — another channel raids the configured channel. */
@SignalNode({
  label:       'Overlive Raid',
  description: 'Fires when another channel raids the configured account.',
  tags:        ['overlive', 'input'],
  color:       '#9146ff',
})
export class OverliveRaid {
  static readonly kind = 'overlive_raid'
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    eventPort('event',   'Any'),
  ] as const
  static readonly outputPorts = [
    eventPort('event',           'Trigger'),
    valuePort('fromUsername',    'String'),
    valuePort('fromDisplayName', 'String'),
    valuePort('viewerCount',     'Float'),
  ] as const

  static execute(
    inputs: InputsOf<typeof OverliveRaid>,
    _config: unknown,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof OverliveRaid> {
    return handleOverliveEvent<RaidEvent, {
      fromUsername: string; fromDisplayName: string; viewerCount: number
    }>(
      inputs,
      ctx,
      (e) => ({
        fromUsername:    e.data.from.username,
        fromDisplayName: e.data.from.displayName,
        viewerCount:     e.data.viewerCount,
      }),
      { fromUsername: '', fromDisplayName: '', viewerCount: 0 },
    ) as OutputsOf<typeof OverliveRaid>
  }
}
