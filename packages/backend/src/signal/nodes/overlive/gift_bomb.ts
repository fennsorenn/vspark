import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal';
import type {
  InputsOf,
  OutputsOf,
  NodeExecutionContext,
} from '@vspark/shared/signal';
import type { GiftBombEvent } from '@overlive/core';
import { handleOverliveEvent } from './_helpers.js';

/** Bulk gift-sub event — one gifter dropping N subs into a channel. */
@SignalNode({
  label: 'Overlive Gift Bomb',
  description:
    'Fires once per bulk gift sub event (one gifter, many recipients). For individual recipients see Overlive Subscription.',
  tags: ['overlive', 'input'],
  color: '#9146ff',
})
export class OverliveGiftBomb {
  static readonly kind = 'overlive_gift_bomb';
  static readonly inputPorts = [
    valuePort('account', 'Account'),
    valuePort('channel', 'String'),
    eventPort('event', 'Any'),
  ] as const;
  static readonly outputPorts = [
    eventPort('event', 'Trigger'),
    valuePort('gifterUsername', 'String'),
    valuePort('gifterDisplayName', 'String'),
    valuePort('count', 'Float'),
    valuePort('tier', 'String'),
    valuePort('totalGifts', 'Float'),
    valuePort('anonymous', 'Bool'),
  ] as const;

  static execute(
    inputs: InputsOf<typeof OverliveGiftBomb>,
    _config: unknown,
    ctx: NodeExecutionContext
  ): OutputsOf<typeof OverliveGiftBomb> {
    return handleOverliveEvent<
      GiftBombEvent,
      {
        gifterUsername: string;
        gifterDisplayName: string;
        count: number;
        tier: string;
        totalGifts: number;
        anonymous: boolean;
      }
    >(
      inputs,
      ctx,
      (e) => ({
        gifterUsername: e.data.gifter.username,
        gifterDisplayName: e.data.gifter.displayName,
        count: e.data.count,
        tier: e.data.tier,
        totalGifts: e.data.totalGifts ?? 0,
        anonymous: e.data.anonymous,
      }),
      {
        gifterUsername: '',
        gifterDisplayName: '',
        count: 0,
        tier: '',
        totalGifts: 0,
        anonymous: false,
      }
    ) as OutputsOf<typeof OverliveGiftBomb>;
  }
}
