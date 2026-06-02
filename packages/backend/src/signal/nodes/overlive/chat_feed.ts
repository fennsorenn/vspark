import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import {
  eventIn,
  valueIn,
  valueOut,
  eventOut,
} from '@vspark/shared/node_decorators';
import type { ChatFeedItem } from '../../../overlive/manager.js';

interface FeedState {
  messages: ChatFeedItem[];
}

/**
 * Accumulating chat history view. Where `overlive_chat_message` is a thin view
 * over the *latest* message, this is a thin view over the OverliveManager's
 * durable per-account ring-buffer: on each new message the manager delivers the
 * whole current buffer here, which fires `update` and exposes it on `messages`.
 *
 * Typical wiring: `update` → `set_data.fire`, `messages` → `set_data.data`,
 * with `set_data.channel = 'chat'`. The frontend `feed` compose layer subscribed
 * to that channel renders each message through a user template.
 *
 * History lives in the manager (survives graph reconcile); this node holds only
 * the last delivered snapshot in node state, which the manager re-sends in full
 * on the next message.
 */
@SignalNode({
  label: 'Overlive Chat Feed',
  description:
    'Accumulating chat history. Fires `update` and exposes the recent messages list as the buffer changes.',
  tags: ['overlive', 'input'],
  color: '#9146ff',
})
export class OverliveChatFeed extends Node {
  static readonly kind = 'overlive_chat_feed';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('update', 'Trigger') update!: Emitter<void>;

  @valueOut('messages', 'Any') messages = (): ChatFeedItem[] => this._items();

  /** The OverliveManager delivers the current buffer snapshot here on each new
   *  chat message (newest last). */
  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const items = ev?.payload as ChatFeedItem[] | undefined;
    this.setState({
      messages: Array.isArray(items) ? items : [],
    } satisfies FeedState);
    this.update.emit(undefined);
  }

  private _items(): ChatFeedItem[] {
    return this.getState<FeedState>()?.messages ?? [];
  }
}
