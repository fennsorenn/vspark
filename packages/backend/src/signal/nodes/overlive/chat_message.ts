import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { ChatMessageEvent } from '@overlive/core';
import { tokensToHtml } from '@overlive/emotes';

interface ChatMessageOut {
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

const EMPTY: ChatMessageOut = {
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
};

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
export class OverliveChatMessage extends Node {
  static readonly kind = 'overlive_chat_message';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('username', 'String') username = (): string => this._out().username;
  @valueOut('displayName', 'String') displayName = (): string => this._out().displayName;
  @valueOut('text', 'String') text = (): string => this._out().text;
  @valueOut('html', 'String') html = (): string => this._out().html;
  @valueOut('color', 'String') color = (): string => this._out().color;
  @valueOut('isMod', 'Bool') isMod = (): boolean => this._out().isMod;
  @valueOut('isSub', 'Bool') isSub = (): boolean => this._out().isSub;
  @valueOut('isBroadcaster', 'Bool') isBroadcaster = (): boolean => this._out().isBroadcaster;
  @valueOut('isAction', 'Bool') isAction = (): boolean => this._out().isAction;
  @valueOut('isHighlighted', 'Bool') isHighlighted = (): boolean => this._out().isHighlighted;
  @valueOut('cheerAmount', 'Float') cheerAmount = (): number => this._out().cheerAmount;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as ChatMessageEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    this.setState({
      username: payload.data.username,
      displayName: payload.data.displayName,
      text: payload.data.text,
      html: tokensToHtml(payload.data.tokens ?? [], payload.data.text),
      color: payload.data.color ?? '',
      isMod: payload.data.isMod,
      isSub: payload.data.isSub,
      isBroadcaster: payload.data.isBroadcaster,
      isAction: payload.data.isAction,
      isHighlighted: payload.data.isHighlighted,
      cheerAmount: payload.data.cheerAmount ?? 0,
    } satisfies ChatMessageOut);
    this.event.emit(undefined);
  }

  private _out(): ChatMessageOut {
    return this.getState<ChatMessageOut>() ?? EMPTY;
  }
}
