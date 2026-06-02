import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import {
  eventIn,
  valueIn,
  valueOut,
  eventOut,
} from '@vspark/shared/node_decorators';
import type { ChatFeedMessage } from '@vspark/shared';

/**
 * A thin VIEW over the OverliveManager's per-project chat ring-buffer — the
 * durable, accumulating counterpart of `overlive_chat_message` (which only
 * exposes the latest message). The store owns the list (node state is rebuilt on
 * reconcile, the wrong place for durable history); the manager pushes each new
 * chat line into its buffer and fires `update` into this node carrying the whole
 * buffer snapshot, which we cache in state and surface as `messages`.
 *
 * Wire `messages` (a `List<ChatFeedMessage>`, carried as `Any`) into `set_data`
 * to publish it to a data channel, then render it through a `feed` compose
 * layer. The graph stays in the path so chat can be filtered/transformed/gated
 * before render.
 *
 * Account/channel inputs mirror `overlive_chat_message` for routing/filtering.
 *
 * See dev-notes/modules/data-channels.md.
 */
@SignalNode({
  label: 'Overlive Chat Feed',
  description:
    'Accumulating list of recent chat messages (List<ChatFeedMessage>) + an update event. Feed it into set_data for a scrolling chat overlay.',
  tags: ['overlive', 'input'],
  color: '#9146ff',
})
export class OverliveChatFeed extends Node {
  static readonly kind = 'overlive_chat_feed';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('update', 'Trigger') update!: Emitter<void>;

  /** The buffer, newest-last. Typed `Any` (no List<T> tag in the type map);
   *  carries a `ChatFeedMessage[]`. */
  @valueOut('messages', 'Any') messages = (): ChatFeedMessage[] =>
    this.getState<ChatFeedMessage[]>() ?? [];

  /** Fired by OverliveManager.routeEvent on each chat message, with the current
   *  ring-buffer snapshot as the payload. */
  @eventIn('update', 'Any')
  onUpdate(ev: Event<unknown>): void {
    const buffer = ev?.payload as ChatFeedMessage[] | undefined;
    this.setState(Array.isArray(buffer) ? buffer : []);
    this.update.emit(undefined);
  }
}
