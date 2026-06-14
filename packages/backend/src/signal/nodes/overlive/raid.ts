import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { RaidEvent } from '@overlive/core';

interface RaidOut {
  fromUsername: string;
  fromDisplayName: string;
  viewerCount: number;
}

const EMPTY: RaidOut = {
  fromUsername: '',
  fromDisplayName: '',
  viewerCount: 0,
};

/** Incoming raid — another channel raids the configured channel. */
@SignalNode({
  label: 'Overlive Raid',
  description: 'Fires when another channel raids the configured account.',
  tags: ["overlive"],
  color: '#9146ff',
})
export class OverliveRaid extends Node {
  static readonly kind = 'overlive_raid';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('fromUsername', 'String') fromUsername = (): string => this._out().fromUsername;
  @valueOut('fromDisplayName', 'String') fromDisplayName = (): string => this._out().fromDisplayName;
  @valueOut('viewerCount', 'Float') viewerCount = (): number => this._out().viewerCount;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as RaidEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    this.setState({
      fromUsername: payload.data.from.username,
      fromDisplayName: payload.data.from.displayName,
      viewerCount: payload.data.viewerCount,
    } satisfies RaidOut);
    this.event.emit(undefined);
  }

  private _out(): RaidOut {
    return this.getState<RaidOut>() ?? EMPTY;
  }
}
