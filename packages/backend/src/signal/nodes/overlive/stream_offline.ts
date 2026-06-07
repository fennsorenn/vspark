import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, eventOut } from '@vspark/shared/node_decorators';
import type { StreamOfflineEvent } from '@overlive/core';

@SignalNode({
  label: 'Overlive Stream Offline',
  description: 'Fires when the configured account goes offline.',
  tags: ["overlive"],
  color: '#9146ff',
})
export class OverliveStreamOffline extends Node {
  static readonly kind = 'overlive_stream_offline';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as StreamOfflineEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    this.event.emit(undefined);
  }
}
