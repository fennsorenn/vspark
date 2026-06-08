import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { GiftBombEvent } from '@overlive/core';

interface GiftBombOut {
  gifterUsername: string;
  gifterDisplayName: string;
  count: number;
  tier: string;
  totalGifts: number;
  anonymous: boolean;
}

const EMPTY: GiftBombOut = {
  gifterUsername: '',
  gifterDisplayName: '',
  count: 0,
  tier: '',
  totalGifts: 0,
  anonymous: false,
};

/** Bulk gift-sub event — one gifter dropping N subs into a channel. */
@SignalNode({
  label: 'Overlive Gift Bomb',
  description:
    'Fires once per bulk gift sub event (one gifter, many recipients). For individual recipients see Overlive Subscription.',
  tags: ["overlive"],
  color: '#9146ff',
})
export class OverliveGiftBomb extends Node {
  static readonly kind = 'overlive_gift_bomb';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('gifterUsername', 'String') gifterUsername = (): string => this._out().gifterUsername;
  @valueOut('gifterDisplayName', 'String') gifterDisplayName = (): string => this._out().gifterDisplayName;
  @valueOut('count', 'Float') count = (): number => this._out().count;
  @valueOut('tier', 'String') tier = (): string => this._out().tier;
  @valueOut('totalGifts', 'Float') totalGifts = (): number => this._out().totalGifts;
  @valueOut('anonymous', 'Bool') anonymous = (): boolean => this._out().anonymous;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const payload = ev?.payload as GiftBombEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    this.setState({
      gifterUsername: payload.data.gifter.username,
      gifterDisplayName: payload.data.gifter.displayName,
      count: payload.data.count,
      tier: payload.data.tier,
      totalGifts: payload.data.totalGifts ?? 0,
      anonymous: payload.data.anonymous,
    } satisfies GiftBombOut);
    this.event.emit(undefined);
  }

  private _out(): GiftBombOut {
    return this.getState<GiftBombOut>() ?? EMPTY;
  }
}
