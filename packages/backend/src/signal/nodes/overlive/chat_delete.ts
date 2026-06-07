import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { DeleteMessageEvent } from '@overlive/core';

interface ChatDeleteOut {
  messageId: string;
  username: string;
  text: string;
  moderatorName: string;
}

const EMPTY: ChatDeleteOut = {
  messageId: '',
  username: '',
  text: '',
  moderatorName: '',
};

@SignalNode({
  label: 'Overlive Chat Delete',
  description: 'Fires when a moderator deletes a chat message.',
  tags: ["overlive"],
  color: '#9146ff',
})
export class OverliveChatDelete extends Node {
  static readonly kind = 'overlive_chat_delete';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('messageId', 'String') messageId = (): string => this._out().messageId;
  @valueOut('username', 'String') username = (): string => this._out().username;
  @valueOut('text', 'String') text = (): string => this._out().text;
  @valueOut('moderatorName', 'String') moderatorName = (): string => this._out().moderatorName;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as DeleteMessageEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    this.setState({
      messageId: payload.data.messageId,
      username: payload.data.username,
      text: payload.data.text ?? '',
      moderatorName: payload.data.moderator?.username ?? '',
    } satisfies ChatDeleteOut);
    this.event.emit(undefined);
  }

  private _out(): ChatDeleteOut {
    return this.getState<ChatDeleteOut>() ?? EMPTY;
  }
}
