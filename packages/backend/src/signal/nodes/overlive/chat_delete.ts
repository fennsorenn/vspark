import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { DeleteMessageEvent } from '@overlive/core'
import { handleOverliveEvent } from './_helpers.js'

@SignalNode({
  label:       'Overlive Chat Delete',
  description: 'Fires when a moderator deletes a chat message.',
  tags:        ['overlive', 'input'],
  color:       '#9146ff',
})
export class OverliveChatDelete {
  static readonly kind = 'overlive_chat_delete'
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    eventPort('event',   'Any'),
  ] as const
  static readonly outputPorts = [
    eventPort('event',         'Trigger'),
    valuePort('messageId',     'String'),
    valuePort('username',      'String'),
    valuePort('text',          'String'),
    valuePort('moderatorName', 'String'),
  ] as const

  static execute(
    inputs: InputsOf<typeof OverliveChatDelete>,
    _config: unknown,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof OverliveChatDelete> {
    return handleOverliveEvent<DeleteMessageEvent, {
      messageId: string; username: string; text: string; moderatorName: string
    }>(
      inputs,
      ctx,
      (e) => ({
        messageId:     e.data.messageId,
        username:      e.data.username,
        text:          e.data.text ?? '',
        moderatorName: e.data.moderator?.username ?? '',
      }),
      { messageId: '', username: '', text: '', moderatorName: '' },
    ) as OutputsOf<typeof OverliveChatDelete>
  }
}
