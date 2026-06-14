import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { SubscriptionEvent } from '@overlive/core';

interface SubscriptionOut {
  username: string;
  displayName: string;
  tier: string;
  months: number;
  isFirst: boolean;
  isResub: boolean;
  isGift: boolean;
  message: string;
}

const EMPTY: SubscriptionOut = {
  username: '',
  displayName: '',
  tier: '',
  months: 0,
  isFirst: false,
  isResub: false,
  isGift: false,
  message: '',
};

/** Subscription event (new sub, resub message, or gifted sub recipient). */
@SignalNode({
  label: 'Overlive Subscription',
  description:
    'Fires on new subs, resubs, and gifted subs (recipients). For bulk gifts see Overlive Gift Bomb.',
  tags: ["overlive"],
  color: '#9146ff',
})
export class OverliveSubscription extends Node {
  static readonly kind = 'overlive_subscription';

  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;
  @valueIn('tier', 'String') tier!: () => string | undefined; // '' | 'tier1' | 'tier2' | 'tier3' | 'prime'
  @valueIn('isGift', 'String') isGift!: () => string | undefined; // '' | 'true' | 'false'

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('username', 'String') usernameOut = (): string => this._out().username;
  @valueOut('displayName', 'String') displayNameOut = (): string => this._out().displayName;
  @valueOut('tier', 'String') tierOut = (): string => this._out().tier;
  @valueOut('months', 'Float') monthsOut = (): number => this._out().months;
  @valueOut('isFirst', 'Bool') isFirstOut = (): boolean => this._out().isFirst;
  @valueOut('isResub', 'Bool') isResubOut = (): boolean => this._out().isResub;
  @valueOut('isGift', 'Bool') isGiftOut = (): boolean => this._out().isGift;
  @valueOut('message', 'String') messageOut = (): string => this._out().message;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const cfg = (this.config ?? {}) as { tier?: string; isGift?: string };
    const wantTier = (cfg.tier ?? '').trim();
    const wantIsGift = (cfg.isGift ?? '').trim();
    const payload = ev?.payload as SubscriptionEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    if (wantTier && payload.data.tier !== wantTier) return;
    if (wantIsGift === 'true' && !payload.data.isGift) return;
    if (wantIsGift === 'false' && payload.data.isGift) return;

    this.setState({
      username: payload.data.username,
      displayName: payload.data.displayName,
      tier: payload.data.tier,
      months: payload.data.months,
      isFirst: payload.data.isFirst,
      isResub: payload.data.isResub,
      isGift: payload.data.isGift,
      message: payload.data.message ?? '',
    } satisfies SubscriptionOut);
    this.event.emit(undefined);
  }

  private _out(): SubscriptionOut {
    return this.getState<SubscriptionOut>() ?? EMPTY;
  }
}
