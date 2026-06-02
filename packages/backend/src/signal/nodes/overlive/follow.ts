import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { FollowEvent } from '@overlive/core';

interface FollowOut {
  username: string;
  displayName: string;
}

const EMPTY: FollowOut = { username: '', displayName: '' };

@SignalNode({
  label: 'Overlive Follow',
  description: 'Fires when a viewer follows the configured account.',
  tags: ['overlive', 'input'],
  color: '#9146ff',
})
export class OverliveFollow extends Node {
  static readonly kind = 'overlive_follow';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('username', 'String') username = (): string => this._out().username;
  @valueOut('displayName', 'String') displayName = (): string => this._out().displayName;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as FollowEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    this.setState({
      username: payload.data.username,
      displayName: payload.data.displayName,
    } satisfies FollowOut);
    this.event.emit(undefined);
  }

  private _out(): FollowOut {
    return this.getState<FollowOut>() ?? EMPTY;
  }
}
