import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
import type { ChatMessageEvent } from '@overlive/core';
import { tokensToHtml } from '@overlive/emotes';
import { handleOverliveEvent } from './_helpers.js';

/**
 * Plain chat messages. Commands (messages starting with the configured
 * prefix, default `!`) are routed to `overlive_chat_command` instead.
 *
 * `html` output renders the message tokens to an XSS-safe HTML string
 * with emote `<img>` tags (when emotes resolve). `text` is the raw
 * message string.
 */
@SignalNode({
  label: 'Overlive Chat Message',
  description:
    'Plain chat messages. Outputs both raw text and an HTML-rendered string with inline emote <img>s.',
  tags: ['overlive', 'input'],
  color: '#9146ff',
})
export class OverliveChatMessage {
  static readonly kind = 'overlive_chat_message';
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    eventPort('event', 'Any'),
  ] as const;
  static readonly outputPorts = [
    eventPort('event', 'Trigger'),
    valuePort('username', 'String'),
    valuePort('displayName', 'String'),
    valuePort('text', 'String'),
    valuePort('html', 'String'),
    valuePort('color', 'String'),
    valuePort('isMod', 'Bool'),
    valuePort('isSub', 'Bool'),
    valuePort('isBroadcaster', 'Bool'),
    valuePort('isAction', 'Bool'),
    valuePort('isHighlighted', 'Bool'),
    valuePort('cheerAmount', 'Float'),
  ] as const;

  static execute(
    inputs: InputsOf<typeof OverliveChatMessage>,
    _config: unknown,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof OverliveChatMessage> {
    return handleOverliveEvent<
      ChatMessageEvent,
      {
        username: string;
        displayName: string;
        text: string;
        html: string;
        color: string;
        isMod: boolean;
        isSub: boolean;
        isBroadcaster: boolean;
        isAction: boolean;
        isHighlighted: boolean;
        cheerAmount: number;
      }
    >(
      inputs,
      ctx,
      (e) => ({
        username: e.data.username,
        displayName: e.data.displayName,
        text: e.data.text,
        html: tokensToHtml(e.data.tokens ?? [], e.data.text),
        color: e.data.color ?? '',
        isMod: e.data.isMod,
        isSub: e.data.isSub,
        isBroadcaster: e.data.isBroadcaster,
        isAction: e.data.isAction,
        isHighlighted: e.data.isHighlighted,
        cheerAmount: e.data.cheerAmount ?? 0,
      }),
      {
        username: '',
        displayName: '',
        text: '',
        html: '',
        color: '',
        isMod: false,
        isSub: false,
        isBroadcaster: false,
        isAction: false,
        isHighlighted: false,
        cheerAmount: 0,
      }
    ) as OutputsOf<typeof OverliveChatMessage>;
  }
}
