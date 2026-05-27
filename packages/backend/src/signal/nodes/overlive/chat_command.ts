import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { ChatCommandEvent } from '@overlive/core'
import { handleOverliveEvent } from './_helpers.js'

/**
 * Chat commands — messages starting with the configured prefix (default `!`).
 * Use `command` to restrict to a specific command name (case-insensitive,
 * without the prefix). The `args` output is space-joined for convenience;
 * downstream nodes can split on whitespace.
 */
@SignalNode({
  label:       'Overlive Chat Command',
  description: 'Fires when a chat message starts with the command prefix. Set "command" to filter to a single command name.',
  tags:        ['overlive', 'input'],
  color:       '#9146ff',
})
export class OverliveChatCommand {
  static readonly kind = 'overlive_chat_command'
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    valuePort('command', 'String'),   // '' = any
    eventPort('event',   'Any'),
  ] as const
  static readonly outputPorts = [
    eventPort('event',         'Trigger'),
    valuePort('username',      'String'),
    valuePort('displayName',   'String'),
    valuePort('command',       'String'),
    valuePort('args',          'String'),  // space-joined
    valuePort('text',          'String'),
    valuePort('isMod',         'Bool'),
    valuePort('isSub',         'Bool'),
    valuePort('isBroadcaster', 'Bool'),
  ] as const

  static execute(
    inputs: InputsOf<typeof OverliveChatCommand>,
    config: { command?: string } | null | undefined,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof OverliveChatCommand> {
    const wantCommand = (config?.command ?? '').trim().toLowerCase()
    return handleOverliveEvent<ChatCommandEvent, {
      username: string; displayName: string; command: string; args: string
      text: string; isMod: boolean; isSub: boolean; isBroadcaster: boolean
    }>(
      inputs,
      ctx,
      (e) => ({
        username:      e.data.username,
        displayName:   e.data.displayName,
        command:       e.data.command,
        args:          e.data.args.join(' '),
        text:          e.data.text,
        isMod:         e.data.isMod,
        isSub:         e.data.isSub,
        isBroadcaster: e.data.isBroadcaster,
      }),
      { username: '', displayName: '', command: '', args: '', text: '',
        isMod: false, isSub: false, isBroadcaster: false },
      (e) => !wantCommand || e.data.command.toLowerCase() === wantCommand,
    ) as OutputsOf<typeof OverliveChatCommand>
  }
}
