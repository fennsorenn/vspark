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

interface FeedConfig {
  maxLength?: number;
}

/** Default cap on emitted messages when neither the `maxLength` input nor config
 *  sets one. The manager ring-buffer is the hard upper bound above this. */
const DEFAULT_MAX_LENGTH = 50;

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
  /** Max messages to keep/emit (newest kept). Falls back to config.maxLength,
   *  then DEFAULT_MAX_LENGTH. The manager buffer is the hard upper bound. */
  @valueIn('maxLength', 'Float') maxLength!: () => number | undefined;

  @eventOut('update', 'Trigger') update!: Emitter<void>;

  @valueOut('messages', 'Any') messages = (): ChatFeedItem[] => this._items();

  /** The OverliveManager delivers the current buffer snapshot here on each new
   *  chat message (newest last). */
  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const items = ev?.payload as ChatFeedItem[] | undefined;
    const all = Array.isArray(items) ? items : [];
    const cfg = (this.config ?? {}) as FeedConfig;
    const max = this.maxLength() ?? cfg.maxLength ?? DEFAULT_MAX_LENGTH;
    const trimmed =
      max > 0 && all.length > max ? all.slice(all.length - max) : all;
    this.setState({ messages: trimmed } satisfies FeedState);
    this.update.emit(undefined);
  }

  private _items(): ChatFeedItem[] {
    return this.getState<FeedState>()?.messages ?? [];
  }
}
