import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { AdStartEvent } from '@overlive/core';

interface AdStartOut {
  durationSeconds: number;
  isAutomatic: boolean;
}

const EMPTY: AdStartOut = { durationSeconds: 0, isAutomatic: false };

@SignalNode({
  label: 'Overlive Ad Start',
  description: 'Fires at the beginning of an ad break.',
  tags: ['overlive', 'input'],
  color: '#9146ff',
})
export class OverliveAdStart extends Node {
  static readonly kind = 'overlive_ad_start';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('durationSeconds', 'Float') durationSeconds = (): number => this._out().durationSeconds;
  @valueOut('isAutomatic', 'Bool') isAutomatic = (): boolean => this._out().isAutomatic;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as AdStartEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    this.setState({
      durationSeconds: payload.data.durationSeconds,
      isAutomatic: payload.data.isAutomatic,
    } satisfies AdStartOut);
    this.event.emit(undefined);
  }

  private _out(): AdStartOut {
    return this.getState<AdStartOut>() ?? EMPTY;
  }
}
