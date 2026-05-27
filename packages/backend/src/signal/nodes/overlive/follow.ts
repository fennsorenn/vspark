import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { FollowEvent } from '@overlive/core'
import { handleOverliveEvent } from './_helpers.js'

@SignalNode({
  label:       'Overlive Follow',
  description: 'Fires when a viewer follows the configured account.',
  tags:        ['overlive', 'input'],
  color:       '#9146ff',
})
export class OverliveFollow {
  static readonly kind = 'overlive_follow'
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    eventPort('event',   'Any'),
  ] as const
  static readonly outputPorts = [
    eventPort('event',       'Trigger'),
    valuePort('username',    'String'),
    valuePort('displayName', 'String'),
  ] as const

  static execute(
    inputs: InputsOf<typeof OverliveFollow>,
    _config: unknown,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof OverliveFollow> {
    return handleOverliveEvent<FollowEvent, { username: string; displayName: string }>(
      inputs,
      ctx,
      (e) => ({ username: e.data.username, displayName: e.data.displayName }),
      { username: '', displayName: '' },
    ) as OutputsOf<typeof OverliveFollow>
  }
}
