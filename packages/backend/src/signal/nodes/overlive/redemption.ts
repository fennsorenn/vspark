import { SignalNode, type Event } from '@vspark/shared/signal';
import { Node, type Emitter } from '@vspark/shared/node';
import { eventIn, valueIn, valueOut, eventOut } from '@vspark/shared/node_decorators';
import type { RedemptionEvent } from '@overlive/core';

interface RedemptionOut {
  username: string;
  displayName: string;
  currencyKind: string;
  amount: number;
  rewardTitle: string;
  rewardId: string;
  message: string;
}

const EMPTY: RedemptionOut = {
  username: '',
  displayName: '',
  currencyKind: '',
  amount: 0,
  rewardTitle: '',
  rewardId: '',
  message: '',
};

/**
 * Fires when a viewer spends bits, channel points, or tips a configured
 * account. Use `currencyKind` to restrict to one of bits / channel_points /
 * tip / superchat; use `rewardId` to restrict to a specific channel-points
 * reward (only meaningful for `channel_points`).
 */
@SignalNode({
  label: 'Overlive Redemption',
  description:
    'Bits, channel point redemption, tip, or superchat — all surfaced as a single event with a currency discriminator.',
  tags: ['overlive', 'input'],
  color: '#9146ff',
})
export class OverliveRedemption extends Node {
  static readonly kind = 'overlive_redemption';

  // Public node surface: routing inputs the editor / OverliveManager reads.
  @valueIn('account', 'Account') account!: () => unknown;
  @valueIn('channel', 'String') channel!: () => string | undefined;
  @valueIn('currencyKind', 'String') currencyKind!: () => string | undefined; // '' | 'bits' | 'channel_points' | 'tip' | 'superchat'
  @valueIn('rewardId', 'String') rewardId!: () => string | undefined; // '' = any

  @eventOut('event', 'Trigger') event!: Emitter<void>;

  @valueOut('username', 'String') usernameOut = (): string => this._out().username;
  @valueOut('displayName', 'String') displayNameOut = (): string => this._out().displayName;
  @valueOut('currencyKind', 'String') currencyKindOut = (): string => this._out().currencyKind;
  @valueOut('amount', 'Float') amountOut = (): number => this._out().amount;
  @valueOut('rewardTitle', 'String') rewardTitleOut = (): string => this._out().rewardTitle;
  @valueOut('rewardId', 'String') rewardIdOut = (): string => this._out().rewardId;
  @valueOut('message', 'String') messageOut = (): string => this._out().message;

  @eventIn('event', 'Any')
  onEvent(ev: Event<unknown>): void {
    const cfg = (this.config ?? {}) as { currencyKind?: string; rewardId?: string };
    const wantKind = (cfg.currencyKind ?? '').trim();
    const wantReward = (cfg.rewardId ?? '').trim();
    const payload = ev?.payload as RedemptionEvent | undefined;
    if (payload === undefined) {
      this.event.emit(undefined);
      return;
    }
    if (wantKind && payload.data.currency.kind !== wantKind) return;
    if (
      wantReward &&
      payload.data.currency.kind === 'channel_points' &&
      payload.data.currency.rewardId !== wantReward
    )
      return;

    const c = payload.data.currency;
    const amount =
      c.kind === 'bits' ||
      c.kind === 'channel_points' ||
      c.kind === 'tip' ||
      c.kind === 'superchat'
        ? c.amount
        : 0;
    const rewardTitle = c.kind === 'channel_points' ? c.rewardTitle : '';
    const rewardId = c.kind === 'channel_points' ? c.rewardId : '';
    this.setState({
      username: payload.data.username,
      displayName: payload.data.displayName,
      currencyKind: c.kind,
      amount,
      rewardTitle,
      rewardId,
      message: payload.data.message ?? '',
    } satisfies RedemptionOut);
    this.event.emit(undefined);
  }

  private _out(): RedemptionOut {
    return this.getState<RedemptionOut>() ?? EMPTY;
  }
}
