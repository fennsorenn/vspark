import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { StreamOnlineEvent } from '@overlive/core';

interface StreamOnlineOut {
  title: string;
  category: string;
  language: string;
}

const EMPTY: StreamOnlineOut = { title: '', category: '', language: '' };

@SignalNode({
  label: 'Overlive Stream Online',
  description:
    'Fires when the configured account goes live. Title may be empty until the platform populates stream info.',
  tags: ["overlive"],
  color: '#9146ff',
})
export class OverliveStreamOnline extends Node {
  static readonly kind = 'overlive_stream_online';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('title', 'String') title = (): string => this._out().title;
  @valueOut('category', 'String') category = (): string => this._out().category;
  @valueOut('language', 'String') language = (): string => this._out().language;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as StreamOnlineEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    this.setState({
      title: payload.data.title ?? '',
      category: payload.data.category ?? '',
      language: payload.data.language ?? '',
    } satisfies StreamOnlineOut);
    this.event.emit(undefined);
  }

  private _out(): StreamOnlineOut {
    return this.getState<StreamOnlineOut>() ?? EMPTY;
  }
}
