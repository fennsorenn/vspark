import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { AdEndEvent } from '@overlive/core';

interface AdEndOut {
  durationSeconds: number;
}

const EMPTY: AdEndOut = { durationSeconds: 0 };

@SignalNode({
  label: 'Overlive Ad End',
  description: 'Fires when an ad break ends.',
  tags: ["overlive"],
  color: '#9146ff',
})
export class OverliveAdEnd extends Node {
  static readonly kind = 'overlive_ad_end';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('durationSeconds', 'Float') durationSeconds = (): number => this._out().durationSeconds;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as AdEndEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    this.setState({
      durationSeconds: payload.data.durationSeconds,
    } satisfies AdEndOut);
    this.event.emit(undefined);
  }

  private _out(): AdEndOut {
    return this.getState<AdEndOut>() ?? EMPTY;
  }
}
