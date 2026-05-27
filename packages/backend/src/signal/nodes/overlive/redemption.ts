import { SignalNode, eventPort, valuePort } from '@vspark/shared/signal'
import type { InputsOf, OutputsOf, NodeExecutionContext } from '@vspark/shared/signal'
import type { RedemptionEvent } from '@overlive/core'
import { handleOverliveEvent } from './_helpers.js'

/**
 * Fires when a viewer spends bits, channel points, or tips a configured
 * account. Use `currencyKind` to restrict to one of bits / channel_points /
 * tip / superchat; use `rewardId` to restrict to a specific channel-points
 * reward (only meaningful for `channel_points`).
 */
@SignalNode({
  label:       'Overlive Redemption',
  description: 'Bits, channel point redemption, tip, or superchat — all surfaced as a single event with a currency discriminator.',
  tags:        ['overlive', 'input'],
  color:       '#9146ff',
})
export class OverliveRedemption {
  static readonly kind = 'overlive_redemption'
  static readonly inputPorts = [
    valuePort('account',      'Account'),
    valuePort('channel',      'String'),
    valuePort('currencyKind', 'String'),  // '' | 'bits' | 'channel_points' | 'tip' | 'superchat'
    valuePort('rewardId',     'String'),  // '' = any
    eventPort('event',        'Any'),
  ] as const
  static readonly outputPorts = [
    eventPort('event',         'Trigger'),
    valuePort('username',      'String'),
    valuePort('displayName',   'String'),
    valuePort('currencyKind',  'String'),
    valuePort('amount',        'Float'),
    valuePort('rewardTitle',   'String'),
    valuePort('rewardId',      'String'),
    valuePort('message',       'String'),
  ] as const

  static execute(
    inputs: InputsOf<typeof OverliveRedemption>,
    config: { currencyKind?: string; rewardId?: string } | null | undefined,
    ctx: NodeExecutionContext,
  ): OutputsOf<typeof OverliveRedemption> {
    const wantKind   = (config?.currencyKind ?? '').trim()
    const wantReward = (config?.rewardId     ?? '').trim()
    return handleOverliveEvent<RedemptionEvent, {
      username:     string
      displayName:  string
      currencyKind: string
      amount:       number
      rewardTitle:  string
      rewardId:     string
      message:      string
    }>(
      inputs,
      ctx,
      (e) => {
        const c = e.data.currency
        const amount = c.kind === 'bits' || c.kind === 'channel_points' || c.kind === 'tip' || c.kind === 'superchat'
          ? c.amount : 0
        const rewardTitle = c.kind === 'channel_points' ? c.rewardTitle : ''
        const rewardId    = c.kind === 'channel_points' ? c.rewardId    : ''
        return {
          username:     e.data.username,
          displayName:  e.data.displayName,
          currencyKind: c.kind,
          amount,
          rewardTitle,
          rewardId,
          message:      e.data.message ?? '',
        }
      },
      { username: '', displayName: '', currencyKind: '', amount: 0, rewardTitle: '', rewardId: '', message: '' },
      (e) => {
        if (wantKind && e.data.currency.kind !== wantKind) return false
        if (wantReward && e.data.currency.kind === 'channel_points' && e.data.currency.rewardId !== wantReward) return false
        return true
      },
    ) as OutputsOf<typeof OverliveRedemption>
  }
}
